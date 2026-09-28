/**
 * Worker 入口：API 路由分发。
 * 各领域实现拆在同级模块：validate（请求体校验）/ loginGuard（登录限速）/
 * webdav（备份）/ icon（图标代理）/ meta（站点信息抓取）/ csp（违规上报）/
 * cron（定时任务）/ util / types。
 */
import {
    NavigationAPI,
    DEFAULT_TOKEN_TTL,
    REMEMBER_TOKEN_TTL,
    type ExportData,
    type Group,
    type LoginRequest,
    type Site,
} from "../src/API/http";
import { handleCspReport } from "./csp";
import { reportError } from "./errorReport";
import { runScheduledTasks } from "./cron";
import { proxyIcon } from "./icon";
import {
    readLoginGuard,
    writeLoginGuard,
    LOGIN_FREE_ATTEMPTS,
    LOGIN_BASE_LOCK_MS,
    LOGIN_MAX_LOCK_MS,
    readInitGuard,
    writeInitGuard,
    INIT_FREE_ATTEMPTS,
    INIT_BASE_LOCK_MS,
    INIT_MAX_LOCK_MS,
} from "./loginGuard";
import { fetchSiteMeta } from "./meta";
import type {
    AuthCredentialsInput,
    ConfigInput,
    Env,
    ExportedHandler,
    GroupInput,
    LoginInput,
    RecoveryInput,
    RecoveryKeyInput,
    SiteInput,
} from "./types";
import { validateConfig, validateGroup, validateLogin, validateSite } from "./validate";
import { safeJson, weakEtag } from "./util";
import {
    readAllConfigs,
    resolveWebDavConfig,
    runWebDavBackup,
    webdavDelete,
    webdavDownload,
    webdavList,
    webdavTest,
} from "./webdav";

// ============ 会话 cookie ============
// 令牌放 httpOnly cookie，JS 读不到 —— XSS 偷不走令牌（这是 localStorage 存令牌的最大问题）。
// 另设一个**非** httpOnly 的 navihive_session 只用来给前端判断「是否已登录」，
// 它不含任何凭据，泄露也无意义。
const TOKEN_COOKIE = "navihive_token";
const SESSION_COOKIE = "navihive_session";

/** 取客户端 IP（审计日志用） */
function clientIp(request: Request): string {
    return (
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") ||
        "unknown"
    );
}

/** 从 Cookie 头部里取出指定 cookie */
function readCookie(request: Request, name: string): string | null {
    const header = request.headers.get("Cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

/** 登录成功时下发的两条 cookie（令牌 httpOnly + 前端可读的登录标记） */
function sessionCookieHeaders(token: string, ttlSeconds: number, secure: boolean): string[] {
    const attrs = `Path=/; SameSite=Strict; Max-Age=${ttlSeconds}${secure ? "; Secure" : ""}`;
    return [
        `${TOKEN_COOKIE}=${token}; HttpOnly; ${attrs}`,
        `${SESSION_COOKIE}=1; ${attrs}`,
    ];
}

/** 退出登录：两条 cookie 都设成已过期 */
function expiredCookieHeaders(secure: boolean): string[] {
    const attrs = `Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
    return [`${TOKEN_COOKIE}=; HttpOnly; ${attrs}`, `${SESSION_COOKIE}=; ${attrs}`];
}

/**
 * 同源校验（CSRF 防护）。
 * 令牌一改成 cookie，跨站请求就会自动带上它，所以写操作必须确认「确实是本站发起的」。
 * 有 Origin 就看 Origin；没有就看 Sec-Fetch-Site；两者都没有（老客户端/curl）时放行，
 * 交给 SameSite=Strict 兜底。
 */
function isSameOrigin(request: Request): boolean {
    const origin = request.headers.get("Origin");
    if (origin) {
        try {
            return new URL(origin).host === new URL(request.url).host;
        } catch {
            return false;
        }
    }
    const site = request.headers.get("Sec-Fetch-Site");
    if (site) return site === "same-origin" || site === "none";
    return true;
}

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);

        // API路由处理
        if (url.pathname.startsWith("/api/")) {
            const path = url.pathname.replace("/api/", "");
            const method = request.method;

            try {
                const api = new NavigationAPI(env);

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

                    // 还在锁定期就直接回绝，并告诉还要等多久
                    const guard = await readLoginGuard(api);
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
                    const ip = clientIp(request);

                    if (result.success) {
                        // 登录成功就清零，别让之前的手滑一直累积
                        if (guard.count > 0) await writeLoginGuard(api, { count: 0, until: 0 });
                        await api.writeAudit("login.success", loginData.username || "", ip);

                        // 令牌只放进 httpOnly cookie，不再回传给 JS（响应体里也不带 token）
                        const ttl = loginData.remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL;
                        const headers = new Headers({ "Cache-Control": "no-store" });
                        const secure = url.protocol === "https:";
                        if (result.token) {
                            for (const cookie of sessionCookieHeaders(result.token, ttl, secure)) {
                                headers.append("Set-Cookie", cookie);
                            }
                        }
                        return Response.json(
                            {
                                success: true,
                                message: result.message,
                                mustChangePassword: await api.mustChangePassword(),
                            },
                            { headers }
                        );
                    }

                    await api.writeAudit("login.failed", loginData.username || "", ip);

                    const count = guard.count + 1;
                    const over = count - LOGIN_FREE_ATTEMPTS;
                    const until =
                        over > 0
                            ? now +
                              Math.min(
                                  LOGIN_BASE_LOCK_MS * Math.pow(2, over - 1),
                                  LOGIN_MAX_LOCK_MS
                              )
                            : 0;
                    await writeLoginGuard(api, { count, until });

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

                // 密钥恢复：用私钥签名的 JWS 令牌重置管理员密码（无需登录即可调用）
                // 服务器只持公钥、验签，没有私钥造不出合法 token，故公网入口安全。
                if (path === "auth/recover" && method === "POST") {
                    const data = (await request.json().catch(() => ({}))) as RecoveryInput;
                    const token = typeof data.token === "string" ? data.token.trim() : "";
                    if (!token) {
                        return Response.json(
                            { success: false, message: "请提供恢复令牌" },
                            { status: 400 }
                        );
                    }
                    const clientKey =
                        request.headers.get("CF-Connecting-IP") ||
                        request.headers.get("X-Forwarded-For") ||
                        "unknown";
                    const result = await api.redeemRecoveryToken(token, clientKey);
                    await api.writeAudit(
                        result.success ? "auth.recover" : "auth.recover.failed",
                        "",
                        clientKey,
                        result.message
                    );
                    return Response.json(result, { status: result.success ? 200 : 400 });
                }

                // 是否已配置恢复公钥（仅返回布尔，不下发公钥本身）
                if (path === "auth/recovery-status" && method === "GET") {
                    return Response.json({ configured: await api.hasRecoveryKey() });
                }

                // 初始化数据库接口 - 不需要验证
                if (path === "init" && method === "GET") {
                    // 未鉴权接口，先过一道限速：挡掉反复打接口探测的扫描。
                    // 已初始化的请求（正常回源探测）不计次，避免锁正常用户。
                    const initGuard = await readInitGuard(api);
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
                        const initCount = initGuard.count + 1;
                        const initOver = initCount - INIT_FREE_ATTEMPTS;
                        const initUntil =
                            initOver > 0
                                ? initNow +
                                  Math.min(INIT_BASE_LOCK_MS * Math.pow(2, initOver - 1), INIT_MAX_LOCK_MS)
                                : 0;
                        await writeInitGuard(api, { count: initCount, until: initUntil });
                    }

                    // 统一响应：调用方拿不到「这台是否已初始化」的信号
                    return Response.json(
                        { ok: true, initialized: true },
                        {
                            headers: { "Cache-Control": "no-store" },
                        }
                    );
                }

                // 验证中间件 - 除登录接口和初始化接口外，所有请求都需要验证
                // currentJti 记下当前这张令牌的编号，退出登录时按它拉黑
                let currentJti = "";
                let currentTokenExp = 0;
                if (api.isAuthEnabled()) {
                    // 令牌优先取 httpOnly cookie（浏览器主路径，JS 拿不到）；
                    // 取不到再退回 Authorization 头，兼容历史客户端与自动化脚本。
                    const cookieToken = readCookie(request, TOKEN_COOKIE);
                    let token: string | null = cookieToken;

                    if (!token) {
                        const authHeader = request.headers.get("Authorization");
                        if (authHeader) {
                            const [authType, raw] = authHeader.split(" ");
                            if (authType !== "Bearer" || !raw) {
                                return new Response("无效的认证信息", { status: 401 });
                            }
                            token = raw;
                        }
                    }

                    if (!token) {
                        return new Response("请先登录", {
                            status: 401,
                            headers: {
                                "WWW-Authenticate": "Bearer",
                            },
                        });
                    }

                    const verifyResult = await api.verifyToken(token);
                    if (!verifyResult.valid) {
                        return new Response("认证已过期或无效，请重新登录", { status: 401 });
                    }
                    currentJti =
                        typeof verifyResult.payload?.jti === "string" ? verifyResult.payload.jti : "";
                    currentTokenExp =
                        typeof verifyResult.payload?.exp === "number" ? verifyResult.payload.exp : 0;

                    // CSRF：令牌改成 cookie 后跨站请求会自动带上它，
                    // 所以写操作必须确认是本站发起的（判据见 isSameOrigin 注释）。
                    if (cookieToken && method !== "GET" && method !== "HEAD" && !isSameOrigin(request)) {
                        return new Response("跨站请求已被拒绝", { status: 403 });
                    }
                }

                // 确保数据库结构是最新的（迁移结果缓存在模块作用域，同一 isolate 内只执行一次）
                await api.migrate();

                // 首次部署强制改密：种子凭据来自部署变量，等同半公开。
                // 改密 / 重置 / 退出 三个口子必须留着，其余写操作一律拦下。
                if (
                    api.isAuthEnabled() &&
                    method !== "GET" &&
                    method !== "HEAD" &&
                    path !== "auth/credentials" &&
                    path !== "auth/recover" &&
                    path !== "auth/recovery-status" &&
                    path !== "logout" &&
                    (await api.mustChangePassword())
                ) {
                    return Response.json(
                        { success: false, message: "请先修改管理员密码后再进行其它操作" },
                        { status: 403 }
                    );
                }

                // 退出登录：把这张令牌拉黑（服务端真正失效）+ 清掉浏览器 cookie
                if (path === "logout" && method === "POST") {
                    if (currentJti) {
                        await api.blacklistToken(currentJti, currentTokenExp);
                    }
                    await api.writeAudit("logout", "", clientIp(request));
                    const headers = new Headers({ "Cache-Control": "no-store" });
                    for (const cookie of expiredCookieHeaders(url.protocol === "https:")) {
                        headers.append("Set-Cookie", cookie);
                    }
                    return Response.json({ success: true }, { headers });
                }

                // 抓目标站点的标题 / 描述（新增卡片时一键补全）—— 要鉴权，因为会对外发请求，
                // 不能让陌生人拿我们的 Worker 当代理使
                if (path === "meta" && method === "GET") {
                    return await fetchSiteMeta(request);
                }

                // 路由匹配
                if (path === "bootstrap" && method === "GET") {
                    // 一次请求返回分组 + 站点 + 配置，供前端首屏与刷新使用。
                    // 带上弱 ETag：浏览器下次会在 If-None-Match 里回传，
                    // 数据没变就只回一个 304 空包，省掉整份 JSON 的下载与解析
                    // （站点多的时候这一份能到几百 KB）。
                    const data = await api.getBootstrap();
                    const body = JSON.stringify(data);
                    const etag = weakEtag(body);
                    // no-cache（每次都要问一趟服务器）而不是 no-store（不许存），
                    // 否则浏览器手头没有副本，ETag 也就无从比较
                    const headers = {
                        "Content-Type": "application/json; charset=utf-8",
                        ETag: etag,
                        "Cache-Control": "no-cache",
                    };
                    if (request.headers.get("if-none-match") === etag) {
                        return new Response(null, { status: 304, headers });
                    }
                    return new Response(body, { headers });
                } else if (path === "groups" && method === "GET") {
                    const groups = await api.getGroups();
                    return Response.json(groups);
                } else if (path.startsWith("groups/") && method === "GET") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }
                    const group = await api.getGroup(id);
                    return Response.json(group);
                } else if (path === "groups" && method === "POST") {
                    const data = (await request.json()) as GroupInput;

                    // 验证分组数据
                    const validation = validateGroup(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.createGroup(validation.sanitizedData as Group);
                    return Response.json(result);
                } else if (path.startsWith("groups/") && method === "PUT") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const data = (await request.json()) as Partial<Group>;
                    // 对修改的字段进行验证
                    if (
                        data.name !== undefined &&
                        (typeof data.name !== "string" || data.name.trim() === "")
                    ) {
                        return Response.json(
                            {
                                success: false,
                                message: "分组名称不能为空且必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    if (data.order_num !== undefined && typeof data.order_num !== "number") {
                        return Response.json(
                            {
                                success: false,
                                message: "排序号必须是数字",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.updateGroup(id, data);
                    return Response.json(result);
                } else if (path.startsWith("groups/") && method === "DELETE") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const result = await api.deleteGroup(id);
                    return Response.json({ success: result });
                }
                // 站点相关API
                else if (path === "sites" && method === "GET") {
                    const groupId = url.searchParams.get("groupId");
                    const sites = await api.getSites(groupId ? parseInt(groupId) : undefined);
                    return Response.json(sites);
                } else if (path.startsWith("sites/") && method === "GET") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const site = await api.getSite(id);
                    return Response.json(site);
                } else if (path === "sites" && method === "POST") {
                    const data = (await request.json()) as SiteInput;

                    // 验证站点数据
                    const validation = validateSite(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.createSite(validation.sanitizedData as Site);
                    return Response.json(result);
                } else if (path.startsWith("sites/") && method === "PUT") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const data = (await request.json()) as Partial<Site>;

                    // 验证更新的站点数据
                    if (data.url !== undefined) {
                        try {
                            new URL(data.url);
                        } catch {
                            return Response.json(
                                {
                                    success: false,
                                    message: "无效的URL格式",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    if (data.icon !== undefined && data.icon !== "") {
                        try {
                            new URL(data.icon);
                        } catch {
                            return Response.json(
                                {
                                    success: false,
                                    message: "无效的图标URL格式",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    if (data.username !== undefined && typeof data.username !== "string") {
                        return Response.json(
                            {
                                success: false,
                                message: "账号必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    if (data.password !== undefined && typeof data.password !== "string") {
                        return Response.json(
                            {
                                success: false,
                                message: "密码必须是字符串",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.updateSite(id, data);
                    return Response.json(result);
                } else if (path.startsWith("sites/") && method === "DELETE") {
                    const id = parseInt(path.split("/")[1]);
                    if (isNaN(id)) {
                        return Response.json({ error: "无效的ID" }, { status: 400 });
                    }

                    const result = await api.deleteSite(id);
                    await api.writeAudit("site.delete", "", clientIp(request), `站点 ${id}`);
                    return Response.json({ success: result });
                }
                // 批量更新排序
                else if (path === "group-orders" && method === "PUT") {
                    const data = (await request.json()) as Array<{ id: number; order_num: number }>;

                    // 验证排序数据
                    if (!Array.isArray(data)) {
                        return Response.json(
                            {
                                success: false,
                                message: "排序数据必须是数组",
                            },
                            { status: 400 }
                        );
                    }

                    for (const item of data) {
                        if (
                            !item.id ||
                            typeof item.id !== "number" ||
                            item.order_num === undefined ||
                            typeof item.order_num !== "number"
                        ) {
                            return Response.json(
                                {
                                    success: false,
                                    message: "排序数据格式无效，每个项目必须包含id和order_num",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    const result = await api.updateGroupOrder(data);
                    return Response.json({ success: result });
                } else if (path === "site-orders" && method === "PUT") {
                    // 支持一次提交「顺序 + 所属分组」，拖拽跨组移动不必再逐个请求
                    const data = (await request.json()) as Array<{
                        id: number;
                        order_num: number;
                        group_id?: number;
                    }>;

                    // 验证排序数据
                    if (!Array.isArray(data)) {
                        return Response.json(
                            {
                                success: false,
                                message: "排序数据必须是数组",
                            },
                            { status: 400 }
                        );
                    }

                    for (const item of data) {
                        if (
                            !item.id ||
                            typeof item.id !== "number" ||
                            item.order_num === undefined ||
                            typeof item.order_num !== "number"
                        ) {
                            return Response.json(
                                {
                                    success: false,
                                    message: "排序数据格式无效，每个项目必须包含id和order_num",
                                },
                                { status: 400 }
                            );
                        }

                        if (item.group_id !== undefined && typeof item.group_id !== "number") {
                            return Response.json(
                                {
                                    success: false,
                                    message: "分组ID必须是数字",
                                },
                                { status: 400 }
                            );
                        }
                    }

                    const result = await api.updateSiteOrder(data);
                    return Response.json({ success: result });
                }
                // 配置相关API
                else if (path === "configs" && method === "GET") {
                    const configs = await api.getConfigs();
                    return Response.json(configs);
                }
                // 批量写入配置：保存网站设置时一次请求搞定，省掉 N 个网络往返
                else if (path === "configs/batch" && method === "POST") {
                    const data = (await request.json()) as { configs?: Record<string, string> };
                    const entries = Object.entries(data.configs || {});

                    if (entries.length === 0) {
                        return Response.json({ success: true, saved: 0 });
                    }

                    // 管理员凭据同样不允许在这里改（要走校验当前密码的专用接口）
                    const blocked = entries.find(([key]) => key.startsWith("auth."));
                    if (blocked) {
                        return Response.json(
                            {
                                success: false,
                                message: "管理员凭据请通过「网站设置 - 管理员账号与密码」修改",
                            },
                            { status: 403 }
                        );
                    }

                    const bad = entries.find(
                        ([, value]) => typeof value !== "string" || value === undefined
                    );
                    if (bad) {
                        return Response.json(
                            { success: false, message: `配置项 ${bad[0]} 的值不合法` },
                            { status: 400 }
                        );
                    }

                    const result = await api.setConfigs(Object.fromEntries(entries));
                    return Response.json({ success: result, saved: entries.length });
                }                 else if (path.startsWith("configs/") && method === "GET") {
                    const key = path.substring("configs/".length);
                    // 管理员凭据不允许读取
                    if (key.startsWith("auth.")) {
                        return Response.json(
                            { error: "管理员凭据不可读取" },
                            { status: 403 }
                        );
                    }
                    const value = await api.getConfig(key);
                    return Response.json({ key, value });
                } else if (path.startsWith("configs/") && method === "PUT") {
                    const key = path.substring("configs/".length);
                    // 管理员凭据只能通过 /api/auth/credentials 修改（需要校验当前密码）
                    if (key.startsWith("auth.")) {
                        return Response.json(
                            {
                                success: false,
                                message: "管理员凭据请通过「网站设置 - 管理员账号与密码」修改",
                            },
                            { status: 403 }
                        );
                    }
                    const data = (await request.json()) as ConfigInput;

                    // 验证配置数据
                    const validation = validateConfig(data);
                    if (!validation.valid) {
                        return Response.json(
                            {
                                success: false,
                                message: `验证失败: ${validation.errors?.join(", ")}`,
                            },
                            { status: 400 }
                        );
                    }

                    // 确保value存在
                    if (data.value === undefined) {
                        return Response.json(
                            {
                                success: false,
                                message: "配置值不能为空",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.setConfig(key, data.value);
                    return Response.json({ success: result });
                } else if (path.startsWith("configs/") && method === "DELETE") {
                    const key = path.substring("configs/".length);
                    // 不允许删除管理员凭据，避免悄悄退化回默认密码
                    if (key.startsWith("auth.")) {
                        return Response.json({ success: false }, { status: 403 });
                    }
                    const result = await api.deleteConfig(key);
                    return Response.json({ success: result });
                }

                // 修改管理员账号密码（保存在数据库中，重新部署不会被覆盖）
                else if (path === "auth/credentials" && method === "PUT") {
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

                    const current = await api.getAuthCredentials();
                    if (!(await api.verifyCurrentPassword(currentPassword))) {
                        return Response.json(
                            { success: false, message: "当前密码不正确" },
                            { status: 403 }
                        );
                    }

                    // 留空的字段表示保持不变
                    const result = await api.updateAuthCredentials(
                        username || current.username,
                        password || current.password
                    );
                    await api.writeAudit(
                        "auth.credentials",
                        username || current.username,
                        clientIp(request),
                        result ? "管理员凭据已更新" : "更新失败"
                    );
                    return Response.json({
                        success: result,
                        message: result ? "管理员凭据已更新，请牢记新账号密码" : "保存管理员凭据失败",
                    });
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
                        clientIp(request)
                    );
                    return Response.json(result, { status: result.success ? 200 : 400 });
                }

                // 数据导出路由
                else if (path === "export" && method === "GET") {
                    const data = await api.exportData();
                    // 引号包住文件名：RFC 6266 推荐，且文件名带空格/中文时不被截断
                    return Response.json(data, {
                        headers: {
                            "Content-Disposition": 'attachment; filename="navihive-data.json"',
                            "Content-Type": "application/json",
                            "Cache-Control": "no-store",
                        },
                    });
                }

                // 数据导入路由
                else if (path === "import" && method === "POST") {
                    const data = (await request.json()) as ExportData;

                    // 验证导入数据（站点允许嵌套在分组中，兼容旧版备份格式）
                    if (
                        !data.groups ||
                        !Array.isArray(data.groups) ||
                        (data.configs !== undefined && typeof data.configs !== "object")
                    ) {
                        return Response.json(
                            {
                                success: false,
                                message: "导入数据格式无效",
                            },
                            { status: 400 }
                        );
                    }

                    const result = await api.importData(data as ExportData);
                    return Response.json({ success: result });
                }

                // ============ WebDAV 备份相关路由（由 Worker 代理，避免浏览器跨域限制） ============
                else if (path === "webdav/test" && method === "POST") {
                    const config = await resolveWebDavConfig(api, request);
                    const result = await webdavTest(config);
                    return Response.json(result);
                } else if (path === "webdav/upload" && method === "POST") {
                    const body = (await safeJson(request)) as {
                        filename?: string;
                        data?: ExportData;
                    };
                    const config = await resolveWebDavConfig(api, request, body);
                    // 手动备份：不删任何已有备份（自动备份才滚动清理自己那一份）
                    const stored = await readAllConfigs(api);
                    // 备份口令来自配置（请求体优先，其次库里存的），与 AUTH_SECRET 无关
                    const result = await runWebDavBackup(api, config, {
                        mode: "manual",
                        stored,
                        data: body.data,
                        password: config.backupPassword,
                    });
                    return Response.json(result);
                } else if (path === "webdav/list" && method === "POST") {
                    const config = await resolveWebDavConfig(api, request);
                    const result = await webdavList(config);
                    return Response.json(result);
                } else if (path === "webdav/download" && method === "POST") {
                    const body = (await safeJson(request)) as { filename?: string };
                    const config = await resolveWebDavConfig(api, request, body);
                    const result = await webdavDownload(config, body.filename || "", config.backupPassword);
                    return Response.json(result);
                } else if (path === "webdav/delete" && method === "POST") {
                    const body = (await safeJson(request)) as { filename?: string };
                    const config = await resolveWebDavConfig(api, request, body);
                    const result = await webdavDelete(config, body.filename || "");
                    return Response.json(result);
                }

                // 默认返回404
                return new Response("API路径不存在", { status: 404 });
            } catch (error) {
                // 安全处理错误，不暴露内部细节
                console.error(`API错误: ${error instanceof Error ? error.message : "未知错误"}`);
                return new Response(`处理请求时发生错误`, { status: 500 });
            }
        }

        // 非API路由默认返回404
        return new Response("Not Found", { status: 404 });
    },
    /**
     * 每周定时任务（由 wrangler.jsonc 的 triggers.crons 触发）。
     * 实现在 ./cron.ts：WebDAV 自动备份 + 死链巡检。
     */
    async scheduled(_controller: unknown, env: Env): Promise<void> {
        await runScheduledTasks(env);
    },
} satisfies ExportedHandler;
