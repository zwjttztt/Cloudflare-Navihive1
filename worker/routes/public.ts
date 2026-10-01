// 公开路由：不需要登录就能调的那一批。
//
// 从 worker/index.ts 拆出来。它们必须排在鉴权中间件**之前**（见 index.ts 的分发顺序），
// 理由各不相同，注释都留在原处 —— 图标是浏览器 <img> 带不上 Authorization，
// CSP 上报同理，登录 / 注册 / 恢复则是「还没登录才要用的」。
import { DEFAULT_TOKEN_TTL, REMEMBER_TOKEN_TTL, type LoginRequest } from "../../src/API/http";
import { handleCspReport } from "../csp";
import { reportError } from "../errorReport";
import { proxyIcon } from "../icon";
import {
    bumpGuard,
    clientBucket,
    computeLockAfterFailure,
    INIT_BASE_LOCK_MS,
    INIT_FREE_ATTEMPTS,
    INIT_GUARD_KEY,
    INIT_MAX_LOCK_MS,
    LOGIN_BASE_LOCK_MS,
    LOGIN_FREE_ATTEMPTS,
    LOGIN_GUARD_KEY,
    LOGIN_MAX_LOCK_MS,
    RECOVER_BASE_LOCK_MS,
    RECOVER_FREE_ATTEMPTS,
    RECOVER_GUARD_KEY,
    RECOVER_MAX_LOCK_MS,
    REGISTER_BASE_LOCK_MS,
    REGISTER_FREE_ATTEMPTS,
    REGISTER_GUARD_KEY,
    REGISTER_MAX_LOCK_MS,
    readInitGuard,
    readLoginGuard,
    readRecoverGuard,
    readRegisterGuard,
    writeLoginGuard,
    writeRecoverGuard,
} from "../loginGuard";
import {readBearerToken, readCookie, sessionCookieHeaders, TOKEN_COOKIE} from "../httpUtils";
import type { LoginInput, RecoveryInput, RegisterInput } from "../types";
import { validateLogin } from "../validate";
import type { RouteCtx } from "./types";

export async function handlePublicRoutes(ctx: RouteCtx): Promise<Response | null> {
    const {
        request,
        env,
        path,
        method,
        api,
        ip,
        trustXFF,
        secureCookie,
        
    } = ctx;

    // 图标代理 - 公开路由，必须放在鉴权之前：
    // 浏览器用 <img src> 拉图标带不上 Authorization，被拦就是一片空白。
    // 作用是把第三方图标变成同源响应：跨域图片的 opaque response 读不出内容，
    // 前端的 IndexedDB blob 缓存用不上；走代理之后第一次抓完就存本地，
    // 二次打开图标零网络请求。
    if (path === "icon" && method === "GET") {
        return await proxyIcon(request);
    }

    // CSP 违规上报 —— 浏览器发报告不带 Authorization，必须是公开路由。
    // 只记录不存储：违规详情进 Workers 日志（observability 已开启）。
    if (path === "csp-report" && method === "POST") {
        return await handleCspReport(request);
    }

    // 客户端错误上报（不鉴权：崩在登录态外的崩溃更不该被挡）
    if (path === "report-error" && method === "POST") {
        return await reportError(request, env);
    }

    // 登录路由 - 不需要验证
    if (path === "login" && method === "POST") {
        const loginData = (await request.json()) as LoginInput;

        // 验证登录数据
        const validation = validateLogin(loginData);
        if (!validation.valid) {
            return Response.json(
                {
                    success: false,
                    message: `验证失败: ${validation.errors?.join(", ")}`,
                },
                { status: 400 }
            );
        }

        // 还在锁定期就直接回绝，并告诉还要等多久。
        // 锁是按来源 IP 分的桶：陌生人乱猜不该把站点主人自己也挡在门外。
        const guard = await readLoginGuard(api, clientBucket(request, trustXFF));
        const now = Date.now();
        if (guard.until > now) {
            const waitSec = Math.ceil((guard.until - now) / 1000);
            return Response.json(
                {
                    success: false,
                    message: `登录尝试过于频繁，请 ${waitSec} 秒后再试`,
                },
                { status: 429, headers: { "Retry-After": String(waitSec) } }
            );
        }

        const result = await api.login(loginData as LoginRequest);
        if (result.success) {
            // 登录成功就清零，别让之前的手滑一直累积
            if (guard.count > 0)
                await writeLoginGuard(api, { count: 0, until: 0 }, clientBucket(request, trustXFF));
            await api.writeAudit("login.success", loginData.username || "", ip);

            // 登记这台设备：之后才好在「账号管理 → 登录设备」里把它单独踢下线。
            // 失败不影响登录（recordSession 内部吞异常）—— 记不上只是列表里少一行。
            if (result.token) {
                await api.recordSession(result.token, request.headers.get("User-Agent") || "", ip);
            }

            // 令牌只放进 httpOnly cookie，不再回传给 JS（响应体里也不带 token）
            const ttl = loginData.remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL;
            const headers = new Headers({ "Cache-Control": "no-store" });
            const secure = secureCookie;
            if (result.token) {
                for (const cookie of sessionCookieHeaders(result.token, ttl, secure)) {
                    headers.append("Set-Cookie", cookie);
                }
            }
            return Response.json(
                {
                    success: true,
                    message: result.message,
                    // 首次部署强制改密只约束种子管理员本人；
                    // 之后注册的账号是自己设的密码，不该跟着一起被提示（见 http.ts 的说明）
                    mustChangePassword: await api.mustChangePassword(result.role),
                    // 多账号：把账号身份带回去，前端不用再单独问一次
                    username: result.username,
                    role: result.role,
                },
                { headers }
            );
        }

        await api.writeAudit("login.failed", loginData.username || "", ip);

        // 计数在 CAS 循环里算（bumpGuard）：外面算好再传进去，并发时后写的那份
        // 会把前一个请求的增量盖掉，爆破就能一直续杯。返回值才是真正写进去的次数。
        const bumped = await bumpGuard(
            api,
            LOGIN_GUARD_KEY,
            clientBucket(request, trustXFF),
            prev => {
                const count = prev.count + 1;
                const lockMs = computeLockAfterFailure(
                    count,
                    LOGIN_FREE_ATTEMPTS,
                    LOGIN_BASE_LOCK_MS,
                    LOGIN_MAX_LOCK_MS
                );
                return { count, until: lockMs > 0 ? Date.now() + lockMs : 0 };
            }
        );
        // 记不上计数也要给出正确文案：按「这次算第几次失败」兜一个
        const count = bumped ? bumped.count : guard.count + 1;
        const until = bumped ? bumped.until : 0;

        // 三种状态文案要分清楚：还能试几次 / 这是最后一次 / 已经锁了。
        // （之前按「剩余次数」判断，第 5 次还没真锁上却说「已暂时锁定」）
        const left = LOGIN_FREE_ATTEMPTS - count;
        let message = result.message;
        let status = 401;
        if (until > 0) {
            const waitSec = Math.ceil((until - now) / 1000);
            message = `${result.message}，尝试次数过多，请 ${waitSec} 秒后再试`;
            status = 429;
        } else if (left > 0) {
            message = `${result.message}（还可尝试 ${left} 次）`;
        } else {
            message = `${result.message}，已达尝试上限，再失败一次将被临时锁定`;
        }

        return Response.json(
            { ...result, message },
            {
                status,
                headers:
                    status === 429
                        ? { "Retry-After": String(Math.ceil((until - now) / 1000)) }
                        : undefined,
            }
        );
    }

    // 注册：公开路由，唯一的准入门槛是邀请码。
    // 放在鉴权之前（还没登录才要注册），但必须在邀请码校验上把好关。
    if (path === "auth/register" && method === "POST") {
        const data = (await request.json().catch(() => ({}))) as RegisterInput;
        const username = typeof data.username === "string" ? data.username.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        const inviteCode =
            typeof data.inviteCode === "string" ? data.inviteCode.trim() : "";

        // 未启用鉴权的部署不开放注册：整站本来就是公开的，没有「账号」可言
        if (!api.isAuthEnabled()) {
            return Response.json(
                { success: false, message: "当前站点未启用登录，无需注册" },
                { status: 400 }
            );
        }

        // 注册是唯一「不用任何凭据就能写库」的入口，必须限频：
        // 失败要写审计日志，成功要跑一次十万次 PBKDF2，两头都是资源。
        // 按来源 IP 分桶，跟登录那把锁互不影响。
        const rBucket = clientBucket(request, trustXFF);
        const regGuard = await readRegisterGuard(api, rBucket);
        const regNow = Date.now();
        if (regGuard.until > regNow) {
            const waitSec = Math.ceil((regGuard.until - regNow) / 1000);
            return Response.json(
                {
                    success: false,
                    message: `注册尝试过于频繁，请 ${waitSec} 秒后再试`,
                },
                { status: 429, headers: { "Retry-After": String(waitSec) } }
            );
        }

        const result = await api.registerUser(username, password, inviteCode);

        // 成功也计数：注册成功的代价（哈希 + 落库）不比失败小，
        // 一清零就变成「注册 → 计数归零 → 继续注册」的无限循环。
        // 同样走 bumpGuard：并发注册各算各的，不会互相把计数冲掉。
        await bumpGuard(api, REGISTER_GUARD_KEY, rBucket, prev => {
            const count = prev.count + 1;
            const lockMs = computeLockAfterFailure(
                count,
                REGISTER_FREE_ATTEMPTS,
                REGISTER_BASE_LOCK_MS,
                REGISTER_MAX_LOCK_MS
            );
            return { count, until: lockMs > 0 ? Date.now() + lockMs : 0 };
        });

        if (!result.success) {
            await api.writeAudit("auth.register.failed", username, ip, result.message);
            return Response.json(result, { status: 400 });
        }

        // 注册成功直接签一张令牌：让用户当场就能用，不用再回登录页输一遍
        const uid = result.user?.id ?? 0;
        const ttl = data.remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL;
        const token = await api.issueTokenForUser(uid, result.user?.username ?? username, ttl);
        const headers = new Headers({ "Cache-Control": "no-store" });
        const secure = secureCookie;
        for (const cookie of sessionCookieHeaders(token, ttl, secure)) {
            headers.append("Set-Cookie", cookie);
        }
        await api.writeAudit("auth.register", username, ip, "注册成功");
        return Response.json(
            {
                success: true,
                message: "注册成功",
                user: result.user,
            },
            { headers }
        );
    }

    // 密钥恢复：用私钥签名的 JWS 令牌重置管理员密码（无需登录即可调用）
    // 服务器只持公钥、验签，没有私钥造不出合法 token，故公网入口安全。
    // 私钥一旦泄露仍可能被高频重试，所以按来源 IP 加一道短时熔断（见 loginGuard）。
    if (path === "auth/recover" && method === "POST") {
        const data = (await request.json().catch(() => ({}))) as RecoveryInput;
        const token = typeof data.token === "string" ? data.token.trim() : "";
        if (!token) {
            return Response.json(
                { success: false, message: "请提供恢复令牌" },
                { status: 400 }
            );
        }
        const rBucket = clientBucket(request, trustXFF);
        const rGuard = await readRecoverGuard(api, rBucket);
        const rNow = Date.now();
        if (rGuard.until > rNow) {
            const waitSec = Math.ceil((rGuard.until - rNow) / 1000);
            return Response.json(
                { success: false, message: `恢复请求过于频繁，请 ${waitSec} 秒后再试` },
                { status: 429, headers: { "Retry-After": String(waitSec) } }
            );
        }
        const clientKey =
            request.headers.get("CF-Connecting-IP") ||
            (trustXFF ? (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() : "") ||
            "unknown";
        const result = await api.redeemRecoveryToken(token, clientKey);
        await api.writeAudit(
            result.success ? "auth.recover" : "auth.recover.failed",
            "",
            clientKey,
            result.message
        );
        if (result.success) {
            // 成功就清零失败计数
            if (rGuard.count > 0) await writeRecoverGuard(api, { count: 0, until: 0 }, rBucket);
        } else {
            // 失败累加，超阈值后按指数退避短暂锁定该来源
            await bumpGuard(api, RECOVER_GUARD_KEY, rBucket, prev => {
                const count = prev.count + 1;
                const lockMs = computeLockAfterFailure(
                    count,
                    RECOVER_FREE_ATTEMPTS,
                    RECOVER_BASE_LOCK_MS,
                    RECOVER_MAX_LOCK_MS
                );
                return { count, until: lockMs > 0 ? Date.now() + lockMs : 0 };
            });
        }
        return Response.json(result, { status: result.success ? 200 : 400 });
    }

    // 是否已配置恢复公钥（仅返回布尔，不下发公钥本身）
    if (path === "auth/recovery-status" && method === "GET") {
        // 带令牌时按「当前账号」回答：公钥是每个账号自己的，
        // 不认身份就只能回答「这个站点有没有人配过」——那会让新注册的账号
        // 也显示成「恢复密钥（已配置）」，可它手里根本没有对应的私钥。
        if (api.isAuthEnabled()) {
            const rawToken =
                readCookie(request, TOKEN_COOKIE) ?? readBearerToken(request);
            if (rawToken) {
                const verified = await api.verifyToken(rawToken);
                const uid = verified.valid ? verified.payload?.uid : undefined;
                api.setCurrentUser(typeof uid === "number" ? uid : null);
            }
        }
        return Response.json({ configured: await api.hasRecoveryKey() });
    }

    // 初始化数据库接口 - 不需要验证
    if (path === "init" && method === "GET") {
        // 未鉴权接口，先过一道限速：挡掉反复打接口探测的扫描。
        // 已初始化的请求（正常回源探测）不计次，避免锁正常用户。
        const initGuard = await readInitGuard(api, clientBucket(request, trustXFF));
        const initNow = Date.now();
        if (initGuard.until > initNow) {
            const waitSec = Math.ceil((initGuard.until - initNow) / 1000);
            return new Response("初始化请求过于频繁，请稍后再试", {
                status: 429,
                headers: { "Retry-After": String(waitSec) },
            });
        }

        const initResult = await api.initDB();

        // 不论是否已初始化都返回 200 + 同样字段 —— 让扫描器无法区分「未初始化部署」
        // 与「已初始化部署」，枚举失败。限速仍然生效（首次计次仍要走完整分支）
        if (!initResult.alreadyInitialized) {
            // 仅「首次真正初始化」才计次（已初始化分支不计次，避免误锁正常用户）
            await bumpGuard(api, INIT_GUARD_KEY, clientBucket(request, trustXFF), prev => {
                const count = prev.count + 1;
                const lockMs = computeLockAfterFailure(
                    count,
                    INIT_FREE_ATTEMPTS,
                    INIT_BASE_LOCK_MS,
                    INIT_MAX_LOCK_MS
                );
                return { count, until: lockMs > 0 ? Date.now() + lockMs : 0 };
            });
        }

        // 统一响应：调用方拿不到「这台是否已初始化」的信号
        return Response.json(
            { ok: true, initialized: true },
            {
                headers: { "Cache-Control": "no-store" },
            }
        );
    }

    return null;
}
