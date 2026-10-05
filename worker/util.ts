// worker/util.ts
// 与具体业务无关的小工具：错误消息提取、安全的 JSON 读取、弱 ETag、响应安全头。

/**
 * Worker 自己产出的响应（/api/*、图标代理）统一带的安全头。
 *
 * 静态资源那套在 `public/_headers`（CSP / HSTS / COOP / CORP / Permissions-Policy …），
 * 但**它管不到 Worker 响应** —— 那边一个安全头都没有。两边必须各写一遍，
 * 否则 `/api/bootstrap` 这种返回全部站点数据的接口反而是全站头最少的响应。
 *
 * ⚠️ **刻意与静态资源不同的三处**（都带注释，别看着"不统一"就顺手抹平）：
 *   - **CSP / COOP 不加**。它们只对「会被当成文档渲染」的响应有意义，
 *     JSON 与图片响应加了不起作用；更关键的是图标代理要传自己的
 *     `default-src 'none'; sandbox`（见 icon.ts），默认塞一条 CSP 把它盖掉，
 *     那道沙箱就没了。静态资源那边的 CSP 含 `require-trusted-types-for 'script'`，
 *     对 API 响应也毫无意义。
 *   - **Permissions-Policy / X-Permitted-Cross-Domain-Policies 不加**：
 *     都是文档级指令，JSON 响应带上去纯粹是摆设。
 *   - **Referrer-Policy 用更严的 `no-referrer`**（静态资源是
 *     `strict-origin-when-cross-origin`）。该头其实只对文档/导航生效，
 *     两边值不同是**故意的**：API 响应上它近乎无效，取更保守的值没有副作用，
 *     而统一成宽松的那个反而会让人以为「它在这里是有用的」。
 *     有一处要留意：别把它改成 `strict-origin-when-cross-origin` 了事 ——
 *     真要统一，就两处都换，并且确认过外链跳转不依赖 Referer。
 *
 * 另外三条缺了都有实际作用：
 *   - HSTS：只在 HTTPS 响应里下发才有效。首页（静态）虽然已经带了，但直接打到
 *     /api 的客户端（脚本、健康检查、被 DNS 重绑定诱导的请求）拿不到，
 *     补上后「先访问过首页」不再是建立 HSTS 的前提。
 *   - CORP: same-origin：挡的是「别的源把这份响应当资源读走」。/api 已经是
 *     no-store、令牌也是 HttpOnly，但 CORP 防的是共享缓存之外的那一层 ——
 *     跨源 <img>/<script>/fetch 想读走响应体时直接被浏览器挡下。
 *   - nosniff：少它浏览器会按内容猜类型，一个 content-type 透传第三方的接口
 *     （比如图标代理）就能把任意内容变成同源文档。
 */
export function securityHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return headers;
}

export function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message || fallback : fallback;
}

export class BodyLimitError extends Error {
    constructor(public readonly status = 413) { super(status === 413 ? "payload too large" : "body read timeout"); }
}

/**
 * 在读取期间限制累计字节与总耗时，超限时取消流并**明确报错**。
 *
 * ⚠️ 超时必须靠一个显式标记来判定，不能只看 `read()` 返回什么：
 * 超时回调里要调 `reader.cancel()` 把卡住的流放掉，而 cancel 会让那个还挂着的
 * `read()` **立刻以 `{ done: true }` 结束** —— 它和 reject 是同一轮微任务里并跑的，
 * 谁先到不一定。若 read() 抢先，`Promise.race` 拿到的是「流正常结束了」，
 * 于是函数返回一段**被截断的 body**，而不是报错。
 * 那比报错糟得多：调用方拿到半截数据还会当正常的去解析（半截 JSON 是合法前缀时
 * 甚至不报错），慢流攻击就这样静默生效了。
 * 所以这里用一个 `timedOut` 标志：只要它亮了，无论 read() 回什么，一律抛 408。
 */
export async function readBoundedBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs = 15000): Promise<Uint8Array<ArrayBuffer>> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            void reader.cancel().catch(() => {});
            reject(new BodyLimitError(408));
        }, timeoutMs);
    });
    try {
        while (true) {
            const result = await Promise.race([reader.read(), deadline]);
            // 超时优先于「读到 done」：cancel 会把挂着的 read 变成 done:true
            if (timedOut) throw new BodyLimitError(408);
            if (result.done) break;
            size += result.value.byteLength;
            if (size > maxBytes) throw new BodyLimitError();
            chunks.push(result.value);
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
