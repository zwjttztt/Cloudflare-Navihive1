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
