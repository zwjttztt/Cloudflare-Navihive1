// 出网那一层：地址校验（含内网拦截）+ 请求封装 + 错误翻译 + PROPFIND 解析。
//
// 内网拦截放在这里而不是配置层：判定的是「这个地址能不能发」，
// 而真正要发的是 davFetch，放在一起不容易漏。
import { errorMessage, isBlockedHost, readBoundedBytes } from "../util";
import { isEgressAllowed } from "../safeFetch";
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
//
// 两道上限，缺一不可：
//   - 输出硬上限 10MB：撑爆内存的最后一道闸
//   - 压缩比上限 200:1：光有硬上限挡不住「解压炸弹」—— 几十 KB 的 gzip 能吐出 10MB，
//     真正的恶意样本能到 1000:1。按输入算一道比例闸，输入越小允许的输出越少。
// 64KB 是下限：合法的小备份（几十字节）压缩比也可能超过 200，别把它误杀。
const GUNZIP_MAX_BYTES = 10 * 1024 * 1024;
const GUNZIP_MAX_RATIO = 200;
const GUNZIP_MIN_BYTES = 64 * 1024;

/** 按输入大小算出这次解压允许输出多少字节（导出以便单测直接打这个判定） */
export function gunzipOutputLimit(inputBytes: number): number {
    return Math.min(GUNZIP_MAX_BYTES, Math.max(GUNZIP_MIN_BYTES, inputBytes * GUNZIP_MAX_RATIO));
}

export async function gunzipToString(bytes: Bytes): Promise<string> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const limit = gunzipOutputLimit(bytes.byteLength);
    return new TextDecoder().decode(await readBoundedBytes(stream, limit));
}

/** 测试连接/列目录这类探测请求的超时：卡住比报错更难受，15 秒还没回就当连不上 */
export const DAV_PROBE_TIMEOUT_MS = 15000;

/**
 * 上传（PUT）超时：按备份体积算，不再固定 60 秒。
 *
 * 为什么改：备份是「全部笔记 + 附件」打成一个 gzip，几 MB 到几十 MB 都正常；
 * 坚果云 / 群晖这类网盘对单连接还有限速，固定 60 秒**必然**在上传中途被
 * AbortSignal 掐断。线上表现就是每周自动备份一次都没成功过，错误只有一句
 * "The operation was aborted due timeout"（用户既看不懂也不知道该改什么）。
 *
 * 口径：60 秒基线 + 每 MB 加 30 秒（按比例，不是向上取整 —— 否则 1 字节也加 30 秒），
 * 封顶 10 分钟（cron 单次执行的余量远大于此，真到 10 分钟还传不完，
 * 该做的是分卷而不是继续等）。
 */
export const DAV_UPLOAD_TIMEOUT_BASE_MS = 60_000;
export const DAV_UPLOAD_TIMEOUT_PER_MB_MS = 30_000;
export const DAV_UPLOAD_TIMEOUT_MAX_MS = 600_000;

/** 按上传体积算这次 PUT 允许的最长耗时（纯函数，单测钉死边界） */
export function uploadTimeoutMs(bytes: number): number {
    const mb = Math.max(0, bytes) / (1024 * 1024);
    return Math.min(
        DAV_UPLOAD_TIMEOUT_MAX_MS,
        Math.round(DAV_UPLOAD_TIMEOUT_BASE_MS + mb * DAV_UPLOAD_TIMEOUT_PER_MB_MS)
    );
}

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

/**
 * 把网络层异常翻成人话：超时、地址不通、内网拦截要能一眼分开。
 *
 * timeoutMs 是**这次请求实际用的超时**（探测 15s / 上传按体积算），不是写死的 15s ——
 * 否则上传被掐断时会提示「连接超时（15 秒）」，用户对着一个几分钟的任务去查
 * 「网络通不通」，方向整个错。
 */
export function describeWebDavError(error: unknown, timeoutMs: number = DAV_PROBE_TIMEOUT_MS): string {
    const raw = errorMessage(error, "连接失败");
    // 地址校验类错误（内网拦截 / 协议不对 / 地址不合法）原文已经说清了原因，原样透传
    if (/不允许指向内网|必须以 http|不合法|不允许跨源|不允许 HTTPS 降级|无内嵌凭据/.test(raw)) return raw;
    if (error instanceof Error && error.name === "TimeoutError") {
        const sec = Math.round(timeoutMs / 1000);
        if (sec <= 20) {
            return `连接超时（${sec} 秒无响应）：请确认地址能从公网访问；内网 NAS 要打开「允许内网地址」`;
        }
        return (
            `上传超时（${sec} 秒内没有传完）：备份文件太大或网盘限速。` +
            `可以分几次手动备份、减少附件数量，或换更快的 WebDAV 服务；` +
            `同一批次会自动重试，重试仍失败才记这条。`
        );
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
        // 上传也必须有总耗时上限，避免无限占用资源。
        signal: AbortSignal.timeout(timeoutMs || 60000),
    };

    const original = new URL(url);
    let currentHref = url;
    // 每跳的请求头单独拷贝：跨源那一跳要剥掉 Authorization（凭据只属于用户配置的
    // 那台服务器），同源跳保持原样。
    const hopHeaders = { ...headers };
    let previousOrigin = original.origin;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const target = new URL(currentHref);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
            throw new Error("WebDAV 目标只允许无内嵌凭据的 http/https 地址");
        }
        if (original.protocol === "https:" && target.protocol !== "https:") {
            throw new Error("WebDAV 不允许 HTTPS 降级重定向");
        }
        const crossOrigin = target.origin !== previousOrigin;
        if (crossOrigin) {
            // 带请求体的方法（PUT / MKCOL / DELETE…）跨源重定向：保持拒绝。
            // 301/302/303 的标准语义就是换 GET 重发、丢掉 body —— 上传被静默
            // 重定向等于丢备份；DELETE 被重定向则可能在别的服务器上删东西。
            if (!["GET", "HEAD", "OPTIONS", "PROPFIND"].includes(method)) {
                throw new Error("WebDAV 不允许跨源重定向，请保存最终服务器地址");
            }
            // 只读方法（GET / PROPFIND / HEAD / OPTIONS）跨源：**跟随**。
            // openlist/Alist 挂了云存储时，GET 备份文件就是 302 到签名直链
            // （2026-10-15 用户实测：列表、上传都正常，唯独恢复被旧逻辑挡死）。
            // 但剥掉 Authorization —— Basic 凭据只属于配置的那台服务器，
            // 签名直链不需要它，也不该把它送到另一个域上（安全不变式，见
            // tests/webdav.test.ts 的重定向一组）。
            delete hopHeaders.Authorization;
        }
        if (!config.allowPrivateNetwork && isBlockedHost(target.hostname)) {
            throw new Error("WebDAV 重定向目标不允许指向内网或本机");
        }
        // 第二道：把 hostname 解析出来的 IP 逐条复核（DNS rebinding —— hostname 是
        // 公网域名、实际连出去却是内网 IP 的情况）。这条路径以前完全没有，等于自托管
        // 注册的那道校验只覆盖了图标与 AI；现在 WebDAV 也过同一道。
        //   - 开了 allowPrivateNetwork 是管理员显式放行内网，不再复核（否则 NAS 全废）；
        //   - IPv6 的 URL.hostname 带方括号，先剥掉再交给解析器，免得 lookup 失败被当成放行。
        if (!config.allowPrivateNetwork) {
            const hostForResolve = target.hostname.replace(/^\[|\]$/g, "");
            if (!(await isEgressAllowed(hostForResolve))) {
                throw new Error("WebDAV 目标解析到不允许的地址（内网或本机）");
            }
        }
        // 网络层错误原样上抛，由 describeWebDavError 翻成人话（这里不包 try/catch：
        // 包了也只是原样 rethrow）
        const res = await fetch(currentHref, { ...init, headers: hopHeaders });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) return res; // 缺 Location：把 3xx 原样返回给调用方处理
            if (hop === maxRedirects) {
                throw new Error("WebDAV 重定向次数过多");
            }
            previousOrigin = target.origin;
            currentHref = new URL(loc, currentHref).href;
            continue;
        }
        if (crossOrigin && !hopHeaders.Authorization && (res.status === 401 || res.status === 403)) {
            // 跨源那一跳已经剥了凭据还 401：重定向目标自己也认登录 ——
            // 指路：把最终地址直接填进配置（回到同源，凭据就能正常带上）。
            throw new Error(
                "重定向目标要求登录（跨源跟随按安全规则不带凭据）：请把重定向后的最终地址直接填进 WebDAV 配置"
            );
        }
        return res;
    }
    throw new Error("WebDAV 重定向次数过多");
}

/**
 * 带重试的 PUT（上传备份用）。
 *
 * 为什么需要：备份是每周一次、无人盯守的任务，网络抖动 / 网盘限流（429）/
 * 服务端 5xx 都是**暂时性**的，原样失败就等于这一周没有备份 —— 而备份的意义
 * 恰恰在于「出事的时候有得恢复」。重试两次（2s、8s 退避）能把绝大多数
 * 抖动吃下去。
 *
 * 刻意**不**重试的：
 *   - 地址校验类错误（内网 / 跨源 / 降级）：重试一万次也不会变
 *   - 401/403/404/409：是配置问题，交给调用方翻成人话
 *   PUT 同一 URL 是幂等的，重试不会产生重复文件。
 */
export async function putWithRetry(
    url: string,
    config: WebDavConfig,
    body: Uint8Array,
    extraHeaders: Record<string, string>,
    timeoutMs: number,
    attempts = 3,
    /** 每次重试前等多久（毫秒）。默认 2s、8s；测试传 [0, 0] 免得真等 10 秒 */
    backoffMs: readonly number[] = [2000, 8000]
): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, backoffMs[attempt - 1] ?? 0));
        try {
            const res = await davFetch(url, "PUT", config, body, extraHeaders, timeoutMs);
            // 429 限流与 5xx 服务端错误：值得再试一次
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error(`HTTP ${res.status}`);
                continue;
            }
            return res;
        } catch (error) {
            const raw = errorMessage(error, "");
            // 配置/校验类错误重试无意义，直接上抛
            if (/不允许指向内网|不允许跨源|不允许 HTTPS 降级|不合法|无内嵌凭据|重定向次数过多|必须以 http/.test(raw)) {
                throw error;
            }
            lastError = error;
        }
    }
    throw lastError;
}

// 逐级创建备份目录（已存在时服务器返回 405，忽略即可）
export async function ensureWebDavFolder(config: WebDavConfig, folderUrl: string): Promise<void> {    const base = (config.url || "").trim().replace(/\/+$/, "");
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
