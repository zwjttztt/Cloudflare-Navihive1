// 请求侧的通用小工具：cookie 读写、安全头、客户端 IP、同源判定。
//
// 从 worker/index.ts 拆出来：这些函数跟路由分发没有任何关系，
// 却占了原来那个 1548 行文件的开头 130 行，还被 auth 中间件 / 公开路由 /
// 受保护路由三处同时 import。单独放一份之后谁要用谁拿，不再互相拖着。

import { securityHeaders } from "./util";
// 会话 cookie 的名字与前端（src/API/transport.ts）共用一份，定义在 shared/ 下：
// 两边引用同一个常量，就不会再出现「改了前端忘了服务端」的静默掉线。
import { SESSION_COOKIE } from "../shared/sessionCookie";

export { SESSION_COOKIE };

// ============ 会话 cookie ============
// 令牌放 httpOnly cookie，JS 读不到 —— XSS 偷不走令牌（这是 localStorage 存令牌的最大问题）。
// 另设一个**非** httpOnly 的 navihive_session 只用来给前端判断「是否已登录」，
// 它不含任何凭据，泄露也无意义。
export const TOKEN_COOKIE = "navihive_token";

/**
 * 由**自托管 Node 入口**注入的客户端真实地址（server/entry.ts 的 proxyToWorker）。
 *
 * 为什么需要一条专用头：worker 侧取 IP 只认 `CF-Connecting-IP`（Cloudflare 边缘注入，
 * 伪造不了）与 `X-Forwarded-For`（要 `NAVIHIVE_TRUST_XFF=1` 才认）。自托管时前面没有
 * Cloudflare，`CF-Connecting-IP` 是客户端想写什么就写什么；不信任 XFF 时又不能拿 XFF
 * 顶上（它同样来自客户端）—— 限速分桶会被无限绕过。
 * 所以入口把 socket 对端地址写进这条头，**一律覆盖**、客户端带过来的不算数。
 * Workers 部署下没人写这条头，且 `CF-Connecting-IP` 优先级更高 → 行为零变化。
 */
export const REAL_IP_HEADER = "x-navihive-client-ip";

/**
 * Worker 返回的纯文本响应统一带上安全头。
 * `_headers` 里那套 CSP / nosniff 只作用于静态资源，Worker 响应得自己加，详见 util.ts。
 */
export const TEXT_HEADERS = () => securityHeaders({ "Content-Type": "text/plain; charset=utf-8" });

/**
 * 取客户端 IP（审计日志 / 登录设备显示用）。
 *
 * 优先级：CF-Connecting-IP（Cloudflare 边缘注入）→ X-Forwarded-For（代理链首段）
 * → 自托管入口注入的真实地址 → unknown。
 * 前两条都可能被客户端伪造（自托管部署下没有 Cloudflare 在前面），
 * 那条「入口注入」的是最后一档：由 server/entry.ts 从 socket 对端地址写进来，
 * 客户端带的一律被它盖掉；Workers 部署下这条头不存在。
 */
export function clientIp(request: Request): string {
    const cf = request.headers.get("CF-Connecting-IP");
    if (cf) return cf;
    const xff = request.headers.get("X-Forwarded-For");
    if (xff) {
        // XFF 是链式头：「客户端, 代理1, 代理2」—— 第一个才是真实客户端。
        // 整条存下来，登录设备列表里的 IP 会显示成「1.2.3.4, 5.6.7.8」一串。
        const first = xff.split(",")[0].trim();
        if (first) return first;
    }
    // 自托管：入口用 socket 对端地址补的那一档（没人伪造得了）
    const real = request.headers.get(REAL_IP_HEADER);
    if (real) return real.trim().slice(0, 64);
    return "unknown";
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
 * ⚠️ CF-Visitor 与 CF-Connecting-IP 一样，**只有在 Cloudflare 边缘后面才可信**。
 * 自托管部署下客户端随手就能带上它（把自己声明成 http 就能骗我们去掉 Secure）——
 * 那道口子不在本函数里堵，而在入口：server/entry.ts 转发给 worker 之前会把
 * CF-Visitor / CF-Connecting-IP 一律删掉。这里保持无条件读是为了不动 Workers 的行为：
 * 那边这个头由平台注入，且 url.protocol 恒为 https（丢了它反而会误判）。
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
 *
 * ⚠️ 判据顺序是 2026-10-14 按一次线上事故调过的（Sec-Fetch-Site 优先）：
 * 反代方案必须把回源 Host 改写成源站域名（否则 DNS 指向自己会死循环），
 * 于是 Worker 眼里 request.url 的主机名永远和浏览器看到的不一样，
 * 拿 Origin 比 host 会把**所有**本站写操作打成 403 —— 而用户描述的现象
 * 恰恰是「页面能看、一保存就 403、且报错没有人话」。详见 CHANGELOG 2026-10-14。
 *
 * 取值优先级：
 * 1. Sec-Fetch-Site —— 浏览器按「发起页面 vs 目标」自己算的，禁伪造头，JS 改不了。
 *    关键是它**不受回源 Host 改写影响**：不管中间经过几层反代，它回答的都是
 *    「浏览器眼里这次请求是不是同源发的」，正是这道校验想问的问题。
 *    只放行 same-origin / none；same-site、cross-site 一律拦。
 * 2. Origin —— 只有没有 Sec-Fetch-Site 时才用（老浏览器 / curl）。
 *    比 host（含端口）不比协议：host 相同只差 scheme 不构成 CSRF，而反代下
 *    两者的协议经常不一致，把 scheme 加进比较同样会误伤所有本站写操作。
 * 3. 两个头都没有：放行，交给 SameSite=Strict cookie 兜底。
 */
export function isSameOrigin(request: Request): boolean {
    const site = request.headers.get("Sec-Fetch-Site");
    if (site) return site === "same-origin" || site === "none";

    const origin = request.headers.get("Origin");
    if (origin) {
        try {
            return new URL(origin).host === new URL(request.url).host;
        } catch {
            return false;
        }
    }
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
    // ⚠️ Workers 运行时里 env.ASSETS.fetch()（以及 Cache API 命中）返回的 Response
    // headers 是 immutable 的，直接 set 会抛 "Can't modify immutable headers."
    // （TypeError → 平台级 1101；2026-10-18 myhp 全站 500 的根因——本地单测 mock 的
    // ASSETS 返回可变 Response，没暴露这个真机语义）。用 body+init 重建一份
    // 可变副本再加头：对普通 Response 无害，对 immutable 是救命。
    const out = new Response(response.body, response);
    out.headers.set("X-Content-Type-Options", "nosniff");
    if (!out.headers.has("X-Frame-Options")) out.headers.set("X-Frame-Options", "DENY");
    if (!out.headers.has("Referrer-Policy")) out.headers.set("Referrer-Policy", "no-referrer");
    return out;
}
