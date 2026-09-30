// 账号相关路由：登录身份、邀请码、凭据与恢复密钥、账号管理、退出登录。
//
// 从 worker/index.ts 拆出来。这一组的共同点是「都在改账号本身」，
// 且大量用到 ctx.currentJti（注销 / 退出时要把当前令牌拉黑）。
import {expiredCookieHeaders} from "../httpUtils";
import type { AuthCredentialsInput, RecoveryKeyInput } from "../types";
import type { RouteCtx } from "./types";

export async function handleAccountRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        path,
        method,
        api,
        ip,
        secureCookie,
        currentJti,
        currentTokenExp,
        
    } = ctx;

    // 退出登录：把这张令牌拉黑（服务端真正失效）+ 清掉浏览器 cookie
    if (path === "logout" && method === "POST") {
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

    // 当前登录身份（账号名 + 角色）。前端拿它显示「当前账号：xxx」。
    if (path === "auth/me" && method === "GET") {
        const uid = api.getCurrentUserId();
        if (uid === null) {
            // 未启用鉴权 / 老令牌：没有账号概念，返回一个 guest 身份让界面照常工作
            return Response.json({ username: "guest", role: "owner" });
        }
        const user = await api.getUserById(uid);
        if (!user) {
            return Response.json(
                { success: false, message: "账号不存在或已被注销" },
                { status: 401 }
            );
        }
        return Response.json({ username: user.username, role: user.role });
    }

    // 生成邀请码（站点所有者，30 分钟有效）
    //
    // 只放开给 owner：邀请码是唯一的注册入口，普通账号也能随手生成的话，
    // 一个人就能不断拉人来占资源，而且互相之间不知道谁请谁，事后无从追溯。
    if (path === "auth/invite" && method === "POST") {
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return Response.json(
                { success: false, message: "当前站点未启用登录，无法生成邀请码" },
                { status: 400 }
            );
        }
        const me = await api.getUserById(uid);
        if (!me || me.role !== "owner") {
            return Response.json(
                { success: false, message: "只有站点所有者可以生成邀请码" },
                { status: 403 }
            );
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
            return Response.json(
                { success: false, message: "仅站点所有者可以查看账号列表" },
                { status: 403 }
            );
        }
        const users = await api.listUsers();
        return Response.json({ success: true, users });
    }

    // 改某个账号的状态（仅 owner）：
    //   active   = 豁免沉睡治理（清停用时间 + 刷新活跃时间，否则转头又被判沉睡）
    //   disabled = 手动停用
    if (path.startsWith("users/") && method === "POST") {
        const matched = /^users\/(\d+)\/status$/.exec(path);
        if (!matched) {
            return Response.json({ success: false, message: "路径无效" }, { status: 400 });
        }
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return Response.json(
                { success: false, message: "当前站点未启用登录，无法管理账号" },
                { status: 400 }
            );
        }
        const me = await api.getUserById(uid);
        if (!me || me.role !== "owner") {
            return Response.json(
                { success: false, message: "仅站点所有者可以管理账号" },
                { status: 403 }
            );
        }
        const targetId = parseInt(matched[1], 10);
        const body = (await request.json().catch(() => ({}))) as { status?: string };
        const status = body.status === "disabled" ? "disabled" : "active";
        const result = await api.setUserStatus(targetId, status, uid);
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    // 注销账号：删掉账号名下所有数据 + 账号本身
    if (path === "account" && method === "DELETE") {
        const body = (await request.json().catch(() => ({}))) as {
            currentPassword?: string;
        };
        const uid = api.getCurrentUserId();
        if (uid === null) {
            return Response.json(
                { success: false, message: "当前站点未启用登录，无法注销账号" },
                { status: 400 }
            );
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
            return Response.json(
                { success: false, message: "当前密码不正确" },
                { status: 403 }
            );
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
        const data = (await request.json()) as AuthCredentialsInput;

        const username = typeof data.username === "string" ? data.username.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        const currentPassword =
            typeof data.currentPassword === "string" ? data.currentPassword : "";

        if (!username && !password) {
            return Response.json(
                { success: false, message: "请填写新的管理员账号或新密码" },
                { status: 400 }
            );
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
        const data = (await request.json().catch(() => ({}))) as RecoveryKeyInput;
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
