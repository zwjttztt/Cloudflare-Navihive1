// worker/util.ts
// 与具体业务无关的小工具：错误消息提取、安全的 JSON 读取、弱 ETag、响应安全头。

/**
 * 所有 Worker 响应都该带上的安全头。
 *
 * 关键点：`public/_headers` 里那套 CSP / nosniff **只对静态资源生效** —— Worker 用
 * `new Response()` 返回的响应一个安全头都没有。少了 nosniff 浏览器会按内容猜类型，
 * 一个 content-type 透传第三方的接口（比如图标代理）就能把任意内容变成同源文档。
 * 这里不重复静态资源已经配好的 CSP（各接口用途不同，统一塞反而容易打断正常功能），
 * 只补这些「无论什么响应都成立」的：
 *   - X-Content-Type-Options: nosniff —— 禁止 MIME 嗅探
 *   - X-Frame-Options / CSP frame-ancestors —— 不允许被别的站点嵌进 iframe（点击劫持）
 *   - Referrer-Policy —— 不把本站 URL 泄露给外链
 */
export function securityHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    return headers;
}

export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message || fallback : fallback;
}

// 安全地读取请求体（无 body 时返回空对象）
export async function safeJson(request: Request): Promise<Record<string, unknown>> {
    try {
        const body = (await request.json()) as unknown;
        return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/**
 * 备份导入 / WebDAV 上传这类「整份数据进请求体」的接口，若不限制体积，
 * 一份超大备份就能把 Worker 的内存 / CPU 拖垮。这里只靠 Content-Length 头做前置拦截
 * （最快、不读 body）；缺该头时放行交由后续解析兜底。
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10MB

export function isBodyTooLarge(request: Request, maxBytes = MAX_REQUEST_BODY_BYTES): boolean {
    const cl = request.headers.get("content-length");
    if (cl === null) return false;
    const n = Number(cl);
    return Number.isFinite(n) && n > maxBytes;
}
// ============ 条件请求（ETag） ============

/**
 * 给响应体算一个弱 ETag（FNV-1a 哈希 + 长度，够用且不需要 crypto）。
 * 这里只用来判断「内容有没有变」，不是安全用途。
 */
export function weakEtag(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `W/"${(hash >>> 0).toString(36)}-${text.length.toString(36)}"`;
}

// ============ SSRF 内网 / 本机地址黑名单 ============
// Worker 出网仍在我们的视角里，被当跳板打内网/元数据服务（169.254.169.254）的风险真实存在。
// 抓取（meta.ts）、图标代理（icon.ts）、WebDAV 备份目标（webdav.ts）共用这一套，
// 所有「由外部输入驱动、Worker 代发请求」的 URL 都必须先过一遍。
export function isBlockedHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    // 主机名本身就是 IP 字面量时，括号包裹的 IPv6 形如 `[::1]`，先剥括号
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return (
        bare === "localhost" ||
        bare === "::1" ||
        bare === "0.0.0.0" ||
        bare === "::" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        // IPv4 私网/保留段
        /^127\./.test(bare) ||
        /^10\./.test(bare) ||
        /^192\.168\./.test(bare) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(bare) ||
        /^169\.254\./.test(bare) ||
        // 0.0.0.0/8（"本网络"），已有 IPv4 也拦
        /^0\./.test(bare) ||
        // 运营商 CGNAT（部分家用宽带会撞到，存疑的 IP 段一律先拦）
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bare) ||
        // 组播 224.0.0.0/4、保留 240.0.0.0/4
        /^2(2[4-9]|3[0-9])\./.test(bare) ||
        /^24[0-9]\./.test(bare) ||
        /^25[0-5]\./.test(bare) ||
        // IPv6 私网/链路本地
        /^fc[0-9a-f]{2}:/i.test(bare) || // ULA fc00::/7
        /^fd[0-9a-f]{2}:/i.test(bare) ||
        /^fe[89ab][0-9a-f]:/i.test(bare) || // link-local fe80::/10
        // IPv4-mapped IPv6（::ffff:127.0.0.1 之类）
        /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(bare)
    );
}
