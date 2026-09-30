// 请求侧的通用小工具：cookie 读写、安全头、客户端 IP、同源判定。
//
// 从 worker/index.ts 拆出来：这些函数跟路由分发没有任何关系，
// 却占了原来那个 1548 行文件的开头 130 行，还被 auth 中间件 / 公开路由 /
// 受保护路由三处同时 import。单独放一份之后谁要用谁拿，不再互相拖着。

import { securityHeaders } from "./util";

// ============ 会话 cookie ============
// 令牌放 httpOnly cookie，JS 读不到 —— XSS 偷不走令牌（这是 localStorage 存令牌的最大问题）。
// 另设一个**非** httpOnly 的 navihive_session 只用来给前端判断「是否已登录」，
// 它不含任何凭据，泄露也无意义。
export const TOKEN_COOKIE = "navihive_token";
export const SESSION_COOKIE = "navihive_session";

/**
 * Worker 返回的纯文本响应统一带上安全头。
 * `_headers` 里那套 CSP / nosniff 只作用于静态资源，Worker 响应得自己加，详见 util.ts。
 */
export const TEXT_HEADERS = () => securityHeaders({ "Content-Type": "text/plain; charset=utf-8" });

/** 取客户端 IP（审计日志用） */
export function clientIp(request: Request): string {
    return (
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") ||
        "unknown"
    );
}

/** 从 Cookie 头部里取出指定 cookie */
export function readCookie(request: Request, name: string): string | null {
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

/**
 * 从 Authorization 头里取出 Bearer 令牌（历史客户端与脚本用）。
 * 只认 Bearer，其它类型一律当没有，避免把奇怪的凭据喂给验签。
 */
export function readBearerToken(request: Request): string | null {
    const header = request.headers.get("Authorization");
    if (!header) return null;
    const [type, raw] = header.split(" ");
    if (type !== "Bearer" || !raw) return null;
    return raw;
}

/**
 * 判断「浏览器这一侧是不是真的在 https 上」——决定 cookie 要不要带 Secure。
 *
 * 不能直接信 url.protocol：站点只要架在反代后面（Nginx / Caddy / 自建网关，
 * 或 Cloudflare 之外又套了一层），Worker 看到的往往是回源用的 https，
 * 而浏览器那头其实是 http。这时下发带 Secure 的 cookie，浏览器会按规范
 * 直接丢弃（非安全通道不允许写入 Secure cookie），表现为：
 * 登录接口返回 200、前端也写了登录标记，但令牌根本没存上，
 * 下一个请求 401 → 界面立刻弹回登录页。
 *
 * 取值优先级：
 * 1. CF-Visitor —— Cloudflare 在边缘注入的客户端真实 scheme，客户端伪造不了；
 * 2. X-Forwarded-Proto —— 只有在明确声明信任反代（NAVIHIVE_TRUST_XFF=1）时才认，
 *    否则攻击者随手加个头就能骗我们把 Secure 去掉；
 * 3. 都没有就退回 url.protocol。
 */
export function requestIsSecure(request: Request, url: URL, trustProxy: boolean): boolean {
    const visitor = request.headers.get("CF-Visitor");
    if (visitor) {
        try {
            const parsed = JSON.parse(visitor) as { scheme?: unknown };
            if (parsed.scheme === "https" || parsed.scheme === "http") {
                return parsed.scheme === "https";
            }
        } catch {
            // 头格式异常就继续往下问
        }
    }
    if (trustProxy) {
        const proto = (request.headers.get("X-Forwarded-Proto") || "")
            .split(",")[0]
            .trim()
            .toLowerCase();
        if (proto === "https" || proto === "http") return proto === "https";
    }
    return url.protocol === "https:";
}

/** 登录成功时下发的两条 cookie（令牌 httpOnly + 前端可读的登录标记） */
export function sessionCookieHeaders(token: string, ttlSeconds: number, secure: boolean): string[] {
    const attrs = `Path=/; SameSite=Strict; Max-Age=${ttlSeconds}${secure ? "; Secure" : ""}`;
    return [
        `${TOKEN_COOKIE}=${token}; HttpOnly; ${attrs}`,
        `${SESSION_COOKIE}=1; ${attrs}`,
    ];
}

/** 退出登录：两条 cookie 都设成已过期 */
export function expiredCookieHeaders(secure: boolean): string[] {
    const attrs = `Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
    return [`${TOKEN_COOKIE}=; HttpOnly; ${attrs}`, `${SESSION_COOKIE}=; ${attrs}`];
}

/**
 * 同源校验（CSRF 防护）。
 * 令牌一改成 cookie，跨站请求就会自动带上它，所以写操作必须确认「确实是本站发起的」。
 * 有 Origin 就看 Origin；没有就看 Sec-Fetch-Site；两者都没有（老客户端/curl）时放行，
 * 交给 SameSite=Strict 兜底。
 */
export function isSameOrigin(request: Request): boolean {
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

/**
 * 所有响应统一补安全头。
 *
 * `_headers` 里那套 CSP / nosniff 只作用于静态资源，Worker 自己 new 出来的响应
 * 一个安全头都没有 —— 逐个 return 处去补必漏（这个入口有一百多个出口），
 * 所以在 fetch 出口统一加一层。已经设过的不覆盖（图标代理那条 CSP sandbox 更严格）。
 */
export function withSecurityHeaders(response: Response): Response {
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (!response.headers.has("X-Frame-Options")) response.headers.set("X-Frame-Options", "DENY");
    if (!response.headers.has("Referrer-Policy")) response.headers.set("Referrer-Policy", "no-referrer");
    return response;
}
