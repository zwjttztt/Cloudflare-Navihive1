// worker/webdav.ts

import type { ExportData, NavigationAPI } from "../src/API/http";
import { decryptBytes, encryptBytes } from "../src/API/crypto";
import { errorMessage, isBlockedHost, safeJson } from "./util";

// ============ WebDAV 备份相关工具函数 ============
// 说明：WebDAV 服务大多不返回 CORS 头，浏览器直连会被拦截，
// 因此所有 WebDAV 请求都由 Worker 代为发起。

const DEFAULT_WEBDAV_PATH = "navihive-backup";

export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
    /**
     * 允许指向内网 / 本机地址（家里 NAS 的 192.168.x.x、xxx.local 之类）。
     * 默认关闭：WebDAV 地址由管理员配置，但账号一旦被攻破就可能被改成内网地址，
     * 让 Worker 把 Basic 凭据打到内网服务上。确实要备份到内网 NAS 时才打开。
     */
    allowPrivateNetwork?: boolean;
}

/** 布尔配置在 configs 表里按项目惯例存 "1"/"0" */
function parseBoolFlag(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const v = value.trim();
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false" || v === "") return false;
    }
    return fallback;
}

export interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

export interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
}

// 优先使用请求中传入的配置，缺失时回落到数据库中保存的配置
export async function resolveWebDavConfig(
    api: NavigationAPI,
    request: Request,
    body?: Record<string, unknown>
): Promise<WebDavConfig> {
    const payload = body ?? (await safeJson(request));

    // 一次读回全部配置（原来要查四次，每次都是一次 D1 往返）
    let stored: Record<string, string> = {};
    try {
        stored = await api.getConfigs();
    } catch {
        stored = {};
    }

    const pick = (value: unknown, fallback: string): string =>
        typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

    return {
        url: pick(payload.url, stored["webdav.url"] || ""),
        username: pick(payload.username, stored["webdav.username"] || ""),
        password: pick(payload.password, stored["webdav.password"] || ""),
        path: pick(payload.path, stored["webdav.path"] || "") || DEFAULT_WEBDAV_PATH,
        // 请求体带就用请求体的（前端开关刚拨的那一下），否则用库里存的
        allowPrivateNetwork: parseBoolFlag(
            payload.allowPrivateNetwork,
            parseBoolFlag(stored["webdav.allowPrivateNetwork"], false)
        ),
    };
}

// 读取全部配置（供备份流程复用，避免重复查询）
export async function readAllConfigs(api: NavigationAPI): Promise<Record<string, string>> {
    try {
        return await api.getConfigs();
    } catch {
        return {};
    }
}

export function configFromStored(stored: Record<string, string>): WebDavConfig {
    return {
        url: stored["webdav.url"] || "",
        username: stored["webdav.username"] || "",
        password: stored["webdav.password"] || "",
        path: stored["webdav.path"] || DEFAULT_WEBDAV_PATH,
        allowPrivateNetwork: parseBoolFlag(stored["webdav.allowPrivateNetwork"], false),
    };
}

/**
 * 备份来源：手动点「备份到 WebDAV」是 manual，每周定时任务是 auto。
 * 两者保留策略不同（见 runWebDavBackup），所以文件名也要能区分得出来源。
 */
export type WebDavBackupMode = "auto" | "manual";

const AUTO_BACKUP_PREFIX = "navihive-backup-auto-";
const MANUAL_BACKUP_PREFIX = "navihive-backup-";

/** 导出供单测用：自动备份的清理范围必须能被断言，否则「手动备份不会被删」没人拦得住 */
export function isAutoBackupFileName(filename: string): boolean {
    return typeof filename === "string" && filename.startsWith(AUTO_BACKUP_PREFIX);
}

/**
 * 挑出要清理的自动备份：只动自动备份，手动备份一律保留。
 * - recorded：上次自动备份的文件名（库里有记录时优先用它，省一次列目录）；
 * - files：列目录结果，用来兜底清理历史上遗留的自动备份（升级前的文件名带不带
 *   auto 前缀都可能在，没记录的也要清）；
 * - keepFilename：本次刚上传的那份，绝不能删。
 */
export function selectAutoBackupsToPrune(
    files: readonly { name: string }[],
    keepFilename: string,
    recorded?: string
): string[] {
    const targets = new Set<string>();
    if (recorded && recorded !== keepFilename) {
        targets.add(recorded);
    }
    for (const file of files) {
        const name = file?.name;
        if (name && name !== keepFilename && isAutoBackupFileName(name)) {
            targets.add(name);
        }
    }
    return [...targets];
}

/** 执行一次完整备份：导出 → 压缩上传 →（仅自动备份）清理上一次自动备份 → 记录文件名。 */
export async function runWebDavBackup(
    api: NavigationAPI,
    config: WebDavConfig,
    options: {
        mode: WebDavBackupMode;
        stored?: Record<string, string>;
        data?: ExportData;
        secret?: string;
    }
): Promise<WebDavResult<{ filename: string; size: number }>> {
    const { mode, stored = {}, data, secret } = options;

    // 没有 AUTH_SECRET 时备份文件是不加密的 gzip —— 站点密码会明文落到网盘。
    // 宁可让这次备份失败并把原因说清楚，也不悄悄上传一份明文存档。
    // （导出本身不算泄密：备份文件里的敏感配置已经被 stripSecretConfigs 剔除，
    //  真正会上网盘的是站点账号密码，正是要保的东西）
    if (!secret) {
        return {
            success: false,
            message:
                "未配置 AUTH_SECRET，已拒绝上传：没有它备份文件无法加密，站点密码会明文存到网盘。请先执行 wrangler secret put AUTH_SECRET 再备份",
        };
    }

    const payload = data ?? (await api.exportData());
    const filename = buildBackupFileName(mode);

    const result = await webdavUpload(config, filename, payload, secret);
    if (!result.success) return result;

    // 自动备份只保留最新一份：删掉上一次的自动备份（删不掉也不算备份失败）。
    // 手动备份一个都不删 —— 用户自己点的备份是「存档」，被定时任务清掉是数据丢失。
    if (mode === "auto") {
        await pruneAutoBackups(config, filename, stored["webdav.lastAutoBackup"]);
    }

    try {
        await api.setConfig("webdav.lastBackup", filename);
        await api.setConfig("webdav.lastBackupAt", new Date().toISOString());
        if (mode === "auto") {
            await api.setConfig("webdav.lastAutoBackup", filename);
        }
    } catch (error) {
        console.error("记录备份状态失败:", error);
    }

    return result;
}

// 清理上一次的自动备份：有记录就只删那一份，没记录（老库升级）才列目录兜底
async function pruneAutoBackups(
    config: WebDavConfig,
    keepFilename: string,
    recordedFilename?: string
): Promise<void> {
    try {
        let targets: string[] = [];
        if (recordedFilename && recordedFilename !== keepFilename) {
            targets = [recordedFilename];
        } else {
            const list = await webdavList(config);
            targets = selectAutoBackupsToPrune(list.data || [], keepFilename, recordedFilename);
        }
        for (const name of targets) {
            await webdavDelete(config, name);
        }
    } catch (error) {
        // 清理失败不影响本次备份结果
        console.error("清理旧备份失败:", error);
    }
}

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

function buildWebDavFileUrl(folderUrl: string, filename: string): string {
    return `${folderUrl}${encodeURIComponent(filename)}`;
}

// 自动备份带 auto 前缀：清理时靠文件名就能区分来源，不会误删手动备份
function buildBackupFileName(mode: WebDavBackupMode): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
        // 带毫秒：同一秒内连续备份也不会重名，避免新备份把旧的覆盖掉
        `-${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
    // 备份内容用 gzip 压缩后再上传，体积通常只有原来的十分之一
    const prefix = mode === "auto" ? AUTO_BACKUP_PREFIX : MANUAL_BACKUP_PREFIX;
    return `${prefix}${stamp}.json.gz`;
}

// gzip 压缩（Workers 运行时原生支持 CompressionStream）
async function gzipBytes(input: string): Promise<Uint8Array> {
    const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

// gzip 解压：读取旧的压缩备份时用到
async function gunzipToString(bytes: ArrayBuffer): Promise<string> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
}

/** 测试连接/列目录这类探测请求的超时：卡住比报错更难受，15 秒还没回就当连不上 */
const DAV_PROBE_TIMEOUT_MS = 15000;

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

async function davFetch(
    url: string,
    method: string,
    config: WebDavConfig,
    body?: string | Uint8Array,
    extraHeaders?: Record<string, string>,
    timeoutMs?: number
): Promise<Response> {
    const headers: Record<string, string> = { ...(extraHeaders || {}) };

    if (config.username) {
        headers["Authorization"] = `Basic ${base64Encode(`${config.username}:${config.password}`)}`;
    }

    return fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        // 只给探测请求加超时：备份文件上传体积可能很大，不能被掐断
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
}

// 逐级创建备份目录（已存在时服务器返回 405，忽略即可）
async function ensureWebDavFolder(config: WebDavConfig, folderUrl: string): Promise<void> {
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
function parseWebDavList(xml: string): WebDavFile[] {
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


export async function webdavTest(config: WebDavConfig): Promise<WebDavResult> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        let response = await davFetch(
            folderUrl,
            "PROPFIND",
            config,
            undefined,
            { Depth: "0" },
            DAV_PROBE_TIMEOUT_MS
        );

        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(
                folderUrl,
                "PROPFIND",
                config,
                undefined,
                { Depth: "0" },
                DAV_PROBE_TIMEOUT_MS
            );
        }

        if (response.ok) {
            return { success: true, message: "连接成功，备份目录可用" };
        }
        return { success: false, message: describeWebDavStatus(response.status) };
    } catch (error) {
        return { success: false, message: describeWebDavError(error) };
    }
}

// 上传备份文件
export async function webdavUpload(
    config: WebDavConfig,
    filename: string,
    data: ExportData,
    secret?: string
): Promise<WebDavResult<{ filename: string; size: number }>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);

        // 不缩进 + gzip：比原来的「带缩进明文 JSON」小一个数量级，上传快得多。
        // 有 AUTH_SECRET 时再套一层 AES-GCM（IV 随机），备份文件落 WebDAV/网盘也是密文，
        // 丢了盘也解不出站点密码。secret 缺失（未配置）时退化为明文 gzip，不阻断备份。
        const gz = await gzipBytes(JSON.stringify(data));
        const body = secret ? await encryptBytes(gz, secret) : gz;
        const putHeaders = { "Content-Type": secret ? "application/octet-stream" : "application/gzip" };

        let response = await davFetch(
            buildWebDavFileUrl(folderUrl, filename),
            "PUT",
            config,
            body,
            putHeaders
        );

        // 目录不存在时才补建，避免每次备份都先发一次 PROPFIND 预检
        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(
                buildWebDavFileUrl(folderUrl, filename),
                "PUT",
                config,
                body,
                putHeaders
            );
        }

        if (response.ok) {
            return {
                success: true,
                message: `已备份到 WebDAV：${filename}`,
                data: { filename, size: body.byteLength },
            };
        }
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
        }

        const detail = await response.text().catch(() => "");
        return { success: false, message: `备份失败：HTTP ${response.status} ${detail.slice(0, 120)}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "备份失败") };
    }
}

// 列出远端备份文件
export async function webdavList(config: WebDavConfig): Promise<WebDavResult<WebDavFile[]>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        let response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "1" });

        if (response.status === 404) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "1" });
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
            }
            return { success: false, message: `获取备份列表失败：HTTP ${response.status}` };
        }

        const xml = await response.text();
        // 兼容压缩备份（.json.gz）与早期明文备份（.json）
        const files = parseWebDavList(xml).filter(file =>
            /\.json(\.gz)?$/i.test(file.name)
        );

        // 手动备份会累积多份，而 WebDAV 的返回顺序没有保证 —— 按修改时间倒序，
        // 保证「最近的远端备份」和列表顶部就是最新那份（时间缺失时退回文件名倒序，
        // 文件名里带时间戳，顺序同样正确）
        files.sort((a, b) => {
            const ta = Date.parse(a.lastModified) || 0;
            const tb = Date.parse(b.lastModified) || 0;
            if (ta !== tb) return tb - ta;
            return b.name < a.name ? -1 : b.name > a.name ? 1 : 0;
        });

        return { success: true, data: files };
    } catch (error) {
        return { success: false, message: errorMessage(error, "获取备份列表失败") };
    }
}

// 下载指定的远端备份
export async function webdavDownload(
    config: WebDavConfig,
    filename: string,
    secret?: string
): Promise<WebDavResult<ExportData>> {
    try {
        if (!filename) {
            return { success: false, message: "未指定备份文件" };
        }

        const folderUrl = buildWebDavFolderUrl(config);
        const response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "GET", config);

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
            }
            return { success: false, message: `下载备份失败：HTTP ${response.status}` };
        }

        // 历史明文备份以 gzip 魔数（1f 8b）开头，直接解压；
        // 加密备份以随机 IV 开头，绝不会是 1f 8b —— 先解密再解压。
        // 解密失败（密钥不符 / 已轮换 / 仍是旧明文）一律回退按明文 gzip 解，保证旧备份可恢复。
        const rawBytes = new Uint8Array(await response.arrayBuffer());
        const isLegacy = rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b;

        let jsonText: string;
        if (isLegacy) {
            jsonText = await gunzipToString(rawBytes);
        } else if (secret) {
            try {
                jsonText = await gunzipToString(await decryptBytes(rawBytes, secret));
            } catch {
                jsonText = await gunzipToString(rawBytes).catch(() => "");
            }
        } else {
            jsonText = await gunzipToString(rawBytes).catch(() => "");
        }

        const text = jsonText.replace(/^\uFEFF/, "");
        let data: ExportData;
        try {
            data = JSON.parse(text) as ExportData;
        } catch {
            return { success: false, message: "备份文件已损坏或密钥不匹配，无法解析" };
        }

        return { success: true, data, message: filename };
    } catch (error) {
        return { success: false, message: errorMessage(error, "下载备份失败") };
    }
}

// 删除指定的远端备份
export async function webdavDelete(config: WebDavConfig, filename: string): Promise<WebDavResult> {
    try {
        if (!filename) {
            return { success: false, message: "未指定备份文件" };
        }

        const folderUrl = buildWebDavFolderUrl(config);
        const response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "DELETE", config);

        if (response.ok || response.status === 404) {
            return { success: true, message: `已删除 ${filename}` };
        }
        return { success: false, message: `删除失败：HTTP ${response.status}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "删除失败") };
    }
}
