// worker/webdav.ts

import type { ExportData, NavigationAPI } from "../src/API/http";
import { errorMessage, safeJson } from "./util";

// ============ WebDAV 备份相关工具函数 ============
// 说明：WebDAV 服务大多不返回 CORS 头，浏览器直连会被拦截，
// 因此所有 WebDAV 请求都由 Worker 代为发起。

const DEFAULT_WEBDAV_PATH = "navihive-backup";

export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
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
    };
}

/**
 * 执行一次完整备份：导出 → 压缩上传 → 删掉上一次的备份 → 记录本次文件名。
 * 手动备份和每周定时备份都走这里，行为保持一致。
 */
export async function runWebDavBackup(
    api: NavigationAPI,
    config: WebDavConfig,
    previousFilename: string,
    data?: ExportData
): Promise<WebDavResult<{ filename: string; size: number }>> {
    const payload = data ?? (await api.exportData());
    const filename = buildBackupFileName();

    const result = await webdavUpload(config, filename, payload);
    if (!result.success) return result;

    // 只保留最新一份：删掉上一次的备份（删不掉也不算备份失败）
    await prunePreviousBackup(config, filename, previousFilename);

    try {
        await api.setConfig("webdav.lastBackup", filename);
        await api.setConfig("webdav.lastBackupAt", new Date().toISOString());
    } catch (error) {
        console.error("记录备份状态失败:", error);
    }

    return result;
}

// 删除上一次的备份文件；没有记录时列目录兜底，清掉除本次以外的所有备份
async function prunePreviousBackup(
    config: WebDavConfig,
    keepFilename: string,
    previousFilename?: string
): Promise<void> {
    try {
        if (previousFilename && previousFilename !== keepFilename) {
            await webdavDelete(config, previousFilename);
            return;
        }

        const list = await webdavList(config);
        for (const file of list.data || []) {
            if (file.name !== keepFilename) {
                await webdavDelete(config, file.name);
            }
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

function buildWebDavFolderUrl(config: WebDavConfig): string {
    const base = (config.url || "").trim().replace(/\/+$/, "");
    if (!base) {
        throw new Error("请先填写 WebDAV 服务器地址");
    }
    if (!/^https?:\/\//i.test(base)) {
        throw new Error("WebDAV 服务器地址必须以 http:// 或 https:// 开头");
    }

    const folder = (config.path || DEFAULT_WEBDAV_PATH).trim().replace(/^\/+|\/+$/g, "");
    return folder ? `${base}/${folder}/` : `${base}/`;
}

function buildWebDavFileUrl(folderUrl: string, filename: string): string {
    return `${folderUrl}${encodeURIComponent(filename)}`;
}

function buildBackupFileName(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}` +
        // 带毫秒：同一秒内连续备份也不会重名，避免新备份把旧的覆盖掉
        `-${String(now.getUTCMilliseconds()).padStart(3, "0")}`;
    // 备份内容用 gzip 压缩后再上传，体积通常只有原来的十分之一
    return `navihive-backup-${stamp}.json.gz`;
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

async function davFetch(
    url: string,
    method: string,
    config: WebDavConfig,
    body?: string | Uint8Array,
    extraHeaders?: Record<string, string>
): Promise<Response> {
    const headers: Record<string, string> = { ...(extraHeaders || {}) };

    if (config.username) {
        headers["Authorization"] = `Basic ${base64Encode(`${config.username}:${config.password}`)}`;
    }

    return fetch(url, {
        method,
        headers,
        body: body ?? undefined,
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

// 测试 WebDAV 连接
export async function webdavTest(config: WebDavConfig): Promise<WebDavResult> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        let response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "0" });

        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(folderUrl, "PROPFIND", config, undefined, { Depth: "0" });
        }

        if (response.ok) {
            return { success: true, message: "连接成功，备份目录可用" };
        }
        if (response.status === 401 || response.status === 403) {
            return { success: false, message: "认证失败，请检查 WebDAV 账号或应用密码" };
        }
        return { success: false, message: `连接失败：HTTP ${response.status}` };
    } catch (error) {
        return { success: false, message: errorMessage(error, "连接失败") };
    }
}

// 上传备份文件
export async function webdavUpload(
    config: WebDavConfig,
    filename: string,
    data: ExportData
): Promise<WebDavResult<{ filename: string; size: number }>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);

        // 不缩进 + gzip：比原来的「带缩进明文 JSON」小一个数量级，上传快得多
        const body = await gzipBytes(JSON.stringify(data));
        const putHeaders = { "Content-Type": "application/gzip" };

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

        return { success: true, data: files };
    } catch (error) {
        return { success: false, message: errorMessage(error, "获取备份列表失败") };
    }
}

// 下载指定的远端备份
export async function webdavDownload(config: WebDavConfig, filename: string): Promise<WebDavResult<ExportData>> {
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

        // 压缩备份（.gz）先解压，明文备份（.json）直接读，两种格式都能恢复
        const raw = filename.toLowerCase().endsWith(".gz")
            ? await gunzipToString(await response.arrayBuffer())
            : await response.text();
        const text = raw.replace(/^\uFEFF/, "");
        const data = JSON.parse(text) as ExportData;

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
