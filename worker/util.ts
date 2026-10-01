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

export class BodyLimitError extends Error {
    constructor(public readonly status = 413) { super(status === 413 ? "payload too large" : "body read timeout"); }
}

/** 在读取期间限制累计字节和总耗时，并在超限时取消流。 */
export async function readBoundedBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs = 15000): Promise<Uint8Array<ArrayBuffer>> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new BodyLimitError(408)); }, timeoutMs);
    });
    try {
        while (true) {
            const { done, value } = await Promise.race([reader.read(), deadline]);
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new BodyLimitError();
            chunks.push(value);
        }
        const out = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
        return out;
    } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        reader.releaseLock();
    }
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
/**
 * 把各种「IP 字面量」写法归一化成标准点分十进制，方便后面统一用正则判私网/保留段。
 *
 * 浏览器 / 运行时对以下写法都当成同一个 IP，但 `isBlockedHost` 的原始正则只认点分十进制，
 * 于是 `http://2130706433/`（=127.0.0.1）、`http://0x7f000001/`、`http://0177.0.0.1/`
 * 这类能绕过内网黑名单打到本机或内网 —— 这是 SSRF 的经典绕过手法。
 * 不是 IP 字面量的正常域名原样返回（如 example.com → example.com）。
 */
export function normalizeIpLiteral(hostname: string): string {
    const h = hostname.toLowerCase();

    // 纯十进制：2130706433 → 127.0.0.1
    if (/^\d+$/.test(h)) {
        const n = Number(h);
        if (n >= 0 && n <= 0xffffffff) {
            return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
        }
    }

    // 整体十六进制：0x7f000001 → 127.0.0.1
    if (/^0x[0-9a-f]+$/i.test(h)) {
        const n = parseInt(h.slice(2), 16);
        if (!Number.isNaN(n) && n >= 0 && n <= 0xffffffff) {
            return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
        }
    }

    // 点分形式，每段可能是十进制 / 八进制（0 前缀）/ 十六进制（0x 前缀），
    // 并允许不足 4 段（IPv4 省略写法，如 127.1 → 127.0.0.1）
    const parts = h.split(".");
    if (parts.length >= 2 && parts.length <= 4) {
        const nums = parts.map((p) => {
            const t = p.trim();
            if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
            if (/^0[0-7]+$/.test(t)) return parseInt(t, 8);
            if (/^\d+$/.test(t)) return parseInt(t, 10);
            return NaN;
        });
        if (nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
            while (nums.length < 4) nums.push(0);
            return nums.join(".");
        }
    }

    return hostname;
}

export function isBlockedHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    // 主机名本身就是 IP 字面量时，括号包裹的 IPv6 形如 `[::1]`，先剥括号
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    // 归一化 IP 字面量（十进制 / 八进制 / 十六进制 / 省略写法）后再判黑名单，
    // 否则 2130706433 / 0x7f000001 / 0177.0.0.1 这类能绕过内网拦截
    const h = normalizeIpLiteral(bare);
    return (
        h === "localhost" ||
        h === "::1" ||
        h === "0.0.0.0" ||
        h === "::" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        // IPv4 私网/保留段
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        /^169\.254\./.test(h) ||
        // 0.0.0.0/8（"本网络"），已有 IPv4 也拦
        /^0\./.test(h) ||
        // 运营商 CGNAT（部分家用宽带会撞到，存疑的 IP 段一律先拦）
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        // 组播 224.0.0.0/4、保留 240.0.0.0/4
        /^2(2[4-9]|3[0-9])\./.test(h) ||
        /^24[0-9]\./.test(h) ||
        /^25[0-5]\./.test(h) ||
        // IPv6 私网/链路本地
        /^fc[0-9a-f]{2}:/i.test(h) || // ULA fc00::/7
        /^fd[0-9a-f]{2}:/i.test(h) ||
        /^fe[89ab][0-9a-f]:/i.test(h) || // link-local fe80::/10
        // IPv4-mapped IPv6（::ffff:127.0.0.1 之类）
        /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/i.test(h)
    );
}
