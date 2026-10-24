// 账号相关路由：登录身份、邀请码、凭据与恢复密钥、账号管理、退出登录。
//
// 从 worker/index.ts 拆出来。这一组的共同点是「都在改账号本身」，
// 且大量用到 ctx.currentJti（注销 / 退出时要把当前令牌拉黑）。
import { ApiError, errorResponse } from "../lib/apiError";
import {expiredCookieHeaders} from "../httpUtils";
import type { AuthCredentialsInput, RecoveryKeyInput } from "../types";
import type { NavigationAPI } from "../../src/API/navigationApi";
import type { RouteCtx } from "./types";
import { readJsonBody } from "./jsonBody";
import { enforceWriteGuard, writeBucket } from "../loginGuard";

/**
 * 当前登录身份（账号 id + 账号名 + 角色），取不到返回 null。
 *
 * 抽出来是因为它有两个调用方：auth/me 自己，以及 bootstrap?full=1
 * （把「我是谁」并进首屏那一次请求）。两处各写一份的话，
 * 将来改身份的形状一定会有一次漏改 —— 那会比慢更糟（本地数据会串账号）。
 */
export async function currentUserIdentity(
    api: NavigationAPI
): Promise<{ id: number; username: string; role: string } | null> {
    const uid = api.getCurrentUserId();
    if (uid === null) {
        // 未启用鉴权 / 老令牌：没有账号概念，返回一个 guest 身份让界面照常工作。
        // id 给 0：稳定、不可变，本地数据据此归到「无账号」这一档。
        return { id: 0, username: "guest", role: "owner" };
    }
    const user = await api.getUserById(uid);
    if (!user) return null;
    return { id: uid, username: user.username, role: user.role };
}

export async function handleAccountRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        path,
        method,
        api,
        ip,
        // ⚠️ 必须解构出来传给 writeBucket：它的第三参默认 false，
        // 不传的话自托管（反代后面）所有用户会共用 `unknown` 一个桶 ——
        // 限速会从「防爆破」变成「随机误伤一整片人」。
        trustXFF,
        secureCookie,
        currentJti,
        currentTokenExp,
        
    } = ctx;

    /**
     * 写操作限速闸门：本模块的九条写路由全都在**改账号本身**
     * （退出 / 邀请码 / 沉睡扫描 / 吊销设备 / 账号状态 / 注销 / 改凭据 / 改恢复密钥）。
     * 令牌泄露后，这些是攻击者最省事的持久化手段，成本却和一次普通读差不多。
     *
     * 与 data.ts 同构：放行返回 null，撞上限速返回已经填好 Retry-After 的 429。
     * GET 一律不过闸（读不消耗写入配额，也不该因为「多刷了几次页面」就锁人）。
     */
    const writeGate = (): Promise<Response | null> =>
        enforceWriteGuard(api, writeBucket(request, api.getCurrentUserId(), trustXFF));

    // 退出登录：把这张令牌拉黑（服务端真正失效）+ 清掉浏览器 cookie
    if (path === "logout" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        if (currentJti) {
            await api.blacklistToken(currentJti, currentTokenExp);
        }
        await api.writeAudit("logout", "", ip);
        const headers = new Headers({ "Cache-Control": "no-store" });
        for (const cookie of expiredCookieHeaders(secureCookie)) {
            headers.append("Set-Cookie", cookie);
        }
        return Response.json({ success: true }, { headers });
    }

    // 当前登录身份（账号 id + 账号名 + 角色）。前端拿它显示「当前账号：xxx」，
    // 也用它给浏览器本地数据（离线队列 / 撤销快照 / 偏好）划分账号边界 ——
    // 只给账号名是不够的：改名之后同一个人的本地数据会认不出来，换个人登录则会串在一起。
    if (path === "auth/me" && method === "GET") {
        const me = await currentUserIdentity(api);
        if (!me) {
            // 样板：新的统一错误形状（code + message）。客户端 src/API/apiError.ts
            // 同时认旧形状，所以这个端点换了形状也不需要前后端同时上线。
            return errorResponse(ApiError.unauthenticated("账号不存在或已被注销"));
        }
        return Response.json(me);
    }

    // 生成邀请码（站点所有者，30 分钟有效）
    //
    // 只放开给 owner：邀请码是唯一的注册入口，普通账号也能随手生成的话，
    // 一个人就能不断拉人来占资源，而且互相之间不知道谁请谁，事后无从追溯。
    if (path === "auth/invite" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录，无法生成邀请码"));
        }
        const me = await api.getUserById(uid);
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("只有站点所有者可以生成邀请码"));
        }
        const result = await api.createInvite(uid);
        await api.writeAudit(
            result.success ? "auth.invite" : "auth.invite.failed",
            "",
            ip,
            result.success ? `邀请码 ${result.code}` : result.message
        );
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    // 账号列表（仅 owner）：含每个账号的沉睡治理状态，给「账号管理」里那份清单用。
    // 普通账号调它会被拒 —— 账号名与活跃时间属于别人的隐私。
    if (path === "users" && method === "GET") {
        const uid = api.getCurrentUserId();
        const me = uid !== null ? await api.getUserById(uid) : null;
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以查看账号列表"));
        }
        const users = await api.listUsers();
        return Response.json({ success: true, users });
    }

    /**
     * 手动触发一次沉睡账号扫描（仅 owner）。
     *
     * 例行扫描挂在每周 cron 上，但 owner 刚改完阈值、或想立刻看清「谁会被停用 / 清除」时，
     * 等一周太久了。这里给一个即时入口，判定逻辑与 cron 完全同一份（sweepInactiveUsers）——
     * 宁可复用也不另写，否则两边口径迟早跑偏（界面显示 180 天、手动跑的却是别的阈值）。
     *
     * ⚠️ 必须排在下面 users/:id/status 之前：那条是 startsWith("users/")，
     * 会把 "sweep" 当成 :id 去 parseInt，直接回「路径无效」。
     */
    if (path === "users/sweep" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录，无法扫描账号"));
        }
        const me = await api.getUserById(uid);
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以扫描账号"));
        }
        const result = await api.sweepInactiveUsers();
        await api.writeAudit(
            "auth.inactive.sweep.manual",
            me.username,
            ip,
            `停用 ${result.disabled} 个、清除 ${result.deleted} 个`
        );
        return Response.json({ success: true, ...result });
    }

    // ============ 登录设备（会话）============
    // JWT 是无状态的，"改密 / 注销"只能把某个账号的令牌整体作废 —— 电脑丢了、或怀疑
    // 某台设备被人用过时，主人没法只踢那一台。有了会话表就能按 jti 精确吊销：
    // 拉黑（真正让令牌失效）+ 删行（列表里消失），别的设备完全不受影响。
    // 只列当前账号自己的会话：user_id 条件写在 SQL 里，猜到别人的 jti 也踢不动。

    /** 会话列表：当前账号登录过的设备 */
    if (path === "sessions" && method === "GET") {
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录，没有登录设备可管理"));
        }
        const sessions = await api.listSessions(uid, currentJti || "");
        return Response.json({ success: true, sessions });
    }

    /** 吊销某一台设备 */
    if (path.startsWith("sessions/") && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const jti = decodeURIComponent(path.slice("sessions/".length));
        const uid = api.getCurrentUserId();
        if (uid === null || !jti) {
            return errorResponse(ApiError.badRequest("参数无效"));
        }
        const result = await api.revokeSession(uid, jti);
        await api.writeAudit(
            result.success ? "auth.session.revoke" : "auth.session.revoke.failed",
            "",
            ip,
            result.message || jti
        );
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    /**
     * 退出其它设备：除当前这台之外全部吊销。
     * currentJti 为空（脚本客户端走 Authorization 头）时等于全部吊销 ——
     * 那种场景本来就没有「当前设备」可言。
     */
    if (path === "sessions/revoke-others" && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录"));
        }
        const result = await api.revokeOtherSessions(uid, currentJti || "");
        await api.writeAudit(
            result.success
                ? "auth.session.revokeOthers"
                : "auth.session.revokeOthers.failed",
            "",
            ip,
            `吊销 ${result.revoked} 台`
        );
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    // 改某个账号的状态（仅 owner）：
    //   active   = 豁免沉睡治理（清停用时间 + 刷新活跃时间，否则转头又被判沉睡）
    //   disabled = 手动停用
    if (path.startsWith("users/") && method === "POST") {
        const limited = await writeGate();
        if (limited) return limited;
        const matched = /^users\/(\d+)\/status$/.exec(path);
        if (!matched) {
            return errorResponse(ApiError.badRequest("路径无效"));
        }
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录，无法管理账号"));
        }
        const me = await api.getUserById(uid);
        if (!me || me.role !== "owner") {
            return errorResponse(ApiError.forbidden("仅站点所有者可以管理账号"));
        }
        const targetId = parseInt(matched[1], 10);
        const body = (await readJsonBody(request)) as { status?: string };
        const status = body.status === "disabled" ? "disabled" : "active";
        const result = await api.setUserStatus(targetId, status, uid);
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    // 注销账号：删掉账号名下所有数据 + 账号本身
    if (path === "account" && method === "DELETE") {
        const limited = await writeGate();
        if (limited) return limited;
        const body = (await readJsonBody(request)) as {
            currentPassword?: string;
        };
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return errorResponse(ApiError.badRequest("当前站点未启用登录，无法注销账号"));
        }
        // 注销不可逆，且会把自己的数据全清掉，所以必须再验一次密码：
        // 只凭会话就允许注销，等于捡到一台已登录的电脑就能毁掉整个账号。
        const currentPassword =
            typeof body.currentPassword === "string" ? body.currentPassword : "";
        if (!(await api.verifyPasswordOfUser(uid, currentPassword))) {
            await api.writeAudit(
                "auth.deleteAccount.failed",
                "",
                ip,
                "当前密码不正确"
            );
            return errorResponse(ApiError.forbidden("当前密码不正确"));
        }

        const result = await api.deleteAccount(uid);
        await api.writeAudit(
            result.success ? "auth.deleteAccount" : "auth.deleteAccount.failed",
            "",
            ip,
            result.message
        );
        if (result.success) {
            // 账号都没了，当前令牌必须一起作废
            if (currentJti) await api.blacklistToken(currentJti, currentTokenExp);
            const headers = new Headers({ "Cache-Control": "no-store" });
            for (const cookie of expiredCookieHeaders(secureCookie)) {
                headers.append("Set-Cookie", cookie);
            }
            return Response.json(result, { headers });
        }
        return Response.json(result, { status: 400 });
    }

    // 修改管理员账号密码（保存在数据库中，重新部署不会被覆盖）
    if (path === "auth/credentials" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;
        const data = await readJsonBody<AuthCredentialsInput>(request);

        const username = typeof data.username === "string" ? data.username.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        const currentPassword =
            typeof data.currentPassword === "string" ? data.currentPassword : "";

        if (!username && !password) {
            return errorResponse(ApiError.badRequest("请填写新的管理员账号或新密码"));
        }

        // 多账号后改的是「当前账号」的凭据：账号名不能和别人撞，密码只写哈希。
        // currentPassword 校验放在服务端内部做（那里才知道该跟哪个哈希比）。
        const result = await api.updateCurrentCredentials(username, password, currentPassword);
        await api.writeAudit(
            result.success ? "auth.credentials" : "auth.credentials.failed",
            username || "",
            ip,
            result.message
        );
        return Response.json(
            {
                success: result.success,
                message: result.message,
            },
            { status: result.success ? 200 : 403 }
        );
    }

    // 保存 / 更换恢复公钥（网页端「生成并下载私钥」时调用）
    // 必须校验当前密码：否则拿到会话的人能塞进自己的公钥，留一个改密也清不掉的后门。
    else if (path === "auth/recovery-key" && method === "PUT") {
        const limited = await writeGate();
        if (limited) return limited;
        const data = (await readJsonBody(request)) as RecoveryKeyInput;
        const publicKey =
            typeof data.publicKey === "string" ? data.publicKey.trim() : "";
        const currentPassword =
            typeof data.currentPassword === "string" ? data.currentPassword : "";

        const result = await api.setRecoveryPublicKey(
            publicKey,
            currentPassword,
            ip
        );
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    return null;
}
