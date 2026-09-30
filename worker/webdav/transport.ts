// 出网那一层：地址校验（含内网拦截）+ 请求封装 + 错误翻译 + PROPFIND 解析。
//
// 内网拦截放在这里而不是配置层：判定的是「这个地址能不能发」，
// 而真正要发的是 davFetch，放在一起不容易漏。
import { errorMessage, isBlockedHost } from "../util";
import type { Bytes } from "../../src/API/crypto";
import { DEFAULT_WEBDAV_PATH, type WebDavConfig, type WebDavFile } from "./types";

// 支持中文密码的 Base64 编码
function base64Encode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// 导出供单测用：内网豁免的判定必须能被断言，不然「默认挡、开了放」这条约束
// 只能靠人肉记着，改坏了没人拦得住。
export function buildWebDavFolderUrl(config: WebDavConfig): string {
    const base = (config.url || "").trim().replace(/\/+$/, "");
    if (!base) {
        throw new Error("请先填写 WebDAV 服务器地址");
    }
    if (!/^https?:\/\//i.test(base)) {
        throw new Error("WebDAV 服务器地址必须以 http:// 或 https:// 开头");
    }

    // SSRF 防御：WebDAV 地址由管理员配置，但一旦账号被攻破就可能指向内网，
    // 把 Basic 凭据打到内网服务。Worker 代发请求前先挡掉内网/本机地址（不限制端口，
    // 自托管 WebDAV 常用非标准端口）。
    let parsed: URL;
    try {
        parsed = new URL(base);
    } catch {
        throw new Error("WebDAV 服务器地址不合法");
    }
    // 开了 allowPrivateNetwork 才放行内网：默认一律挡，改配置也挡得住误操作
    if (!config.allowPrivateNetwork && isBlockedHost(parsed.hostname)) {
        throw new Error("WebDAV 服务器地址不允许指向内网或本机（如需备份到家庭 NAS，请打开「允许内网地址」）");
    }

    const folder = (config.path || DEFAULT_WEBDAV_PATH).trim().replace(/^\/+|\/+$/g, "");
    return folder ? `${base}/${folder}/` : `${base}/`;
}

export function buildWebDavFileUrl(folderUrl: string, filename: string): string {
    return `${folderUrl}${encodeURIComponent(filename)}`;
}

// gzip 压缩（Workers 运行时原生支持 CompressionStream）
export async function gzipBytes(input: string): Promise<Bytes> {
    const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

// gzip 解压：读取旧的压缩备份时用到
// 参数收窄成「ArrayBuffer 支撑」的视图（`Bytes`）：TS 5.9 起 `Uint8Array<ArrayBufferLike>`
// 不再满足 BlobPart，而 `subarray()` 会保留泛型参数，只能靠调用方给出确定类型。
export async function gunzipToString(bytes: Bytes): Promise<string> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
}

/** 测试连接/列目录这类探测请求的超时：卡住比报错更难受，15 秒还没回就当连不上 */
export const DAV_PROBE_TIMEOUT_MS = 15000;

/**
 * 把 HTTP 状态码翻成「能照着改」的提示（纯函数，单测覆盖）。
 * 原来只回一句「连接失败：HTTP 405」，用户根本不知道该改地址、改账号还是换协议。
 */
export function describeWebDavStatus(status: number): string {
    if (status === 401 || status === 403) {
        return "认证失败：请检查账号与密码（坚果云 / 群晖等要用「应用密码」，不是登录密码）";
    }
    if (status === 404) {
        return "备份目录不存在，也没能自动创建：请检查服务器地址是否正确（常见是少了 /dav 之类的路径）";
    }
    if (status === 405 || status === 501) {
        return "该地址不支持 WebDAV（服务器拒绝了 PROPFIND）：多半是地址少了 /dav、/remote.php/dav 之类的路径";
    }
    if (status === 409) {
        return "上级目录不存在，无法自动创建备份目录：请先在网盘里手工建好目录";
    }
    if (status === 429) {
        return "被服务器限流（HTTP 429）：稍等一会儿再试";
    }
    if (status >= 500) {
        return `WebDAV 服务端错误：HTTP ${status}`;
    }
    return `连接失败：HTTP ${status}`;
}

/** 把网络层异常翻成人话：超时、地址不通、内网拦截要能一眼分开 */
export function describeWebDavError(error: unknown): string {
    const raw = errorMessage(error, "连接失败");
    // 地址校验类错误（内网拦截 / 协议不对 / 地址不合法）原文已经说清了原因，原样透传
    if (/不允许指向内网|必须以 http|不合法/.test(raw)) return raw;
    if (error instanceof Error && error.name === "TimeoutError") {
        return `连接超时（${DAV_PROBE_TIMEOUT_MS / 1000} 秒无响应）：请确认地址能从公网访问；内网 NAS 要打开「允许内网地址」`;
    }
    if (/fetch failed|Failed to fetch|ENOTFOUND|getaddrinfo|DNS|NetworkError|ECONNREFUSED|certificate/i.test(raw)) {
        return `连不上服务器（${raw}）：请确认地址正确、端口已开放，且 Cloudflare 能访问到它`;
    }
    return raw;
}

export async function davFetch(
    url: string,
    method: string,
    config: WebDavConfig,
    body?: string | Uint8Array,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number,
    /** 最大重定向跳数（防跳板探测 / 无限循环），默认 4 */
    maxRedirects = 4
): Promise<Response> {
    const headers: Record<string, string> = { ...(extraHeaders || {}) };

    if (config.username) {
        headers["Authorization"] = `Basic ${base64Encode(`${config.username}:${config.password}`)}`;
    }

    // 手动跟随重定向（redirect:"manual"），每跳重新过 isBlockedHost：
    // redirect:"follow" 不会重验目标主机，攻击者可借 302 把 Worker 引到内网 / 云元数据
    // 服务（SSRF）。WebDAV 常用非标准端口（自托管 NAS），这里不限制端口（safeFetch 限
    // 80/443 会打断它），但内网/本机的重定向目标仍按初始地址的 allowPrivateNetwork 规矩挡。
    const init: RequestInit = {
        method,
        headers,
        // TS 5.9：BodyInit 只接受 ArrayBuffer 支撑的视图；本文件的字节都来自
        // new Uint8Array(...) / arrayBuffer()，运行时 fetch 对任何 Uint8Array 都照收，
        // 这里只做类型重解释，不拷贝数据（备份文件可能不小，避免白复制一遍）。
        body: (body ?? undefined) as BodyInit | undefined,
        redirect: "manual",
        // 只给探测请求加超时：备份文件上传体积可能很大，不能被掐断
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    };

    let currentHref = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const target = new URL(currentHref);
        if (!config.allowPrivateNetwork && isBlockedHost(target.hostname)) {
            throw new Error("WebDAV 重定向目标不允许指向内网或本机");
        }
        // 网络层错误原样上抛，由 describeWebDavError 翻成人话（这里不包 try/catch：
        // 包了也只是原样 rethrow）
        const res = await fetch(currentHref, init);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) return res; // 缺 Location：把 3xx 原样返回给调用方处理
            if (hop === maxRedirects) {
                throw new Error("WebDAV 重定向次数过多");
            }
            currentHref = new URL(loc, currentHref).href;
            continue;
        }
        return res;
    }
    throw new Error("WebDAV 重定向次数过多");
}

// 逐级创建备份目录（已存在时服务器返回 405，忽略即可）
export async function ensureWebDavFolder(config: WebDavConfig, folderUrl: string): Promise<void> {
    const base = (config.url || "").trim().replace(/\/+$/, "");
    const relative = folderUrl.slice(base.length).replace(/^\/+|\/+$/g, "");
    if (!relative) return;

    let current = base;
    for (const segment of relative.split("/").filter(Boolean)) {
        current = `${current}/${encodeURIComponent(segment)}`;
        try {
            await davFetch(`${current}/`, "MKCOL", config);
        } catch {
            // 目录已存在或无权创建，交由后续写入结果体现
        }
    }
}

// 解析 PROPFIND 返回的 XML 文件列表
export function parseWebDavList(xml: string): WebDavFile[] {
    const files: WebDavFile[] = [];
    const blocks = xml.match(/<[A-Za-z0-9]*:?response\b[\s\S]*?<\/[A-Za-z0-9]*:?response>/gi) || [];

    for (const block of blocks) {
        const isCollection = /<[A-Za-z0-9]*:?collection\s*\/?>/i.test(block);
        if (isCollection) continue;

        const hrefMatch = block.match(/<[A-Za-z0-9]*:?href\b[^>]*>([\s\S]*?)<\/[A-Za-z0-9]*:?href>/i);
        if (!hrefMatch) continue;

        let name = hrefMatch[1].trim();
        try {
            name = decodeURIComponent(name);
        } catch {
            // 保持原始值
        }
        name = name.replace(/\/+$/, "").split("/").pop() || name;

        const sizeMatch = block.match(/<[A-Za-z0-9]*:?getcontentlength\b[^>]*>([\s\S]*?)</i);
        const modifiedMatch = block.match(/<[A-Za-z0-9]*:?getlastmodified\b[^>]*>([\s\S]*?)</i);

        files.push({
            name,
            size: sizeMatch ? Number(sizeMatch[1].trim()) || 0 : 0,
            lastModified: modifiedMatch ? modifiedMatch[1].trim() : "",
        });
    }

    return files.sort((a, b) => {
        const timeA = Date.parse(a.lastModified || "") || 0;
        const timeB = Date.parse(b.lastModified || "") || 0;
        return timeB - timeA;
    });
}
