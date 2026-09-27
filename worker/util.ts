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
