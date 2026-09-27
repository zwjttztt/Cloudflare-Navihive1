// worker/util.ts
// 与具体业务无关的小工具：错误消息提取、安全的 JSON 读取、弱 ETag。

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
    return (
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^0\./.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    );
}
