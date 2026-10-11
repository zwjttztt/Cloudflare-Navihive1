// 五个对外操作（测试 / 上传 / 列表 / 下载 / 删除）+ 一次完整备份的编排。
//
// 下面这几个函数就是 worker/routes/backup.ts 与 worker/cron.ts 用到的全部入口；
// 原来的 worker/webdav.ts 拆开后，这里顺手把子模块的导出原样转出去，
// 所以 `from "../worker/webdav"` 这种老写法一行都不用改。
import { decryptBackup, encryptBackup, isEncryptedBackup, type Bytes } from "../../src/API/crypto";
import type { ExportData } from "../../src/API/http";
import type { NavigationAPI } from "../../src/API/navigationApi";
import { withBackupIntegrity } from "../../src/utils/backupIntegrity";
import { BodyLimitError, errorMessage, readBoundedBytes } from "../util";
import { buildBackupFileName, selectAutoBackupsToPrune } from "./naming";
import {
    davFetch,
    DAV_PROBE_TIMEOUT_MS,
    buildWebDavFileUrl,
    buildWebDavFolderUrl,
    describeWebDavError,
    describeWebDavStatus,
    ensureWebDavFolder,
    gunzipToString,
    gzipBytes,
    parseWebDavList,
} from "./transport";
import type {
    WebDavBackupMode,
    WebDavConfig,
    WebDavFile,
    WebDavResult,
} from "./types";

/**
 * 从网盘拉回来的备份文件最大读多少（32 MB）。
 *
 * 网盘上那份东西不由我们控制：文件名是自己生成的，内容却可能被别的东西覆盖过。
 * 不设上限地 arrayBuffer() 一个几 G 的文件，Worker 内存直接被吃干 ——
 * 这里是「下载链路上唯一一道体积闸」，解压那边另有一道（见 gunzipToString）。
 */
const MAX_BACKUP_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** 执行一次完整备份：导出 → 压缩上传 →（仅自动备份）清理上一次自动备份 → 记录文件名。 */
export async function runWebDavBackup(
    api: NavigationAPI,
    config: WebDavConfig,
    options: {
        mode: WebDavBackupMode;
        stored?: Record<string, string>;
        data?: ExportData;
        /** 备份口令；不传时回落到 config.backupPassword。留空 = 不加密上传 */
        password?: string;
    }
): Promise<WebDavResult<{ filename: string; size: number }>> {
    const { mode, stored = {}, data } = options;
    // 备份口令与 AUTH_SECRET 无关：没设口令只是「不加密」，照样能备份，不再拦着不让传
    const password = options.password ?? config.backupPassword ?? "";

    // 摘要按「最终要写进文件的这份」算：传进来的 data 可能已经被前端补过 localPrefs，
    // 服务端自取的 exportData 也可能与第一手不同 —— 统一在这里收口重算一次
    const payload = await withBackupIntegrity(data ?? (await api.exportData()));
    const filename = buildBackupFileName(mode);

    const result = await webdavUpload(config, filename, payload, password);
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

/**
 * 把**已经压缩 / 加密好的最终字节** PUT 上去（404/409 时补建目录重试一次）。
 * 从 webdavUpload 拆出来：记事本备份（worker/notesBackup.ts）的载荷形状不同
 * （notes 专用 JSON 而不是 ExportData），但 PUT / 重试 / 结果映射完全一样，没必要抄一份。
 */
export async function webdavPutBytes(
    config: WebDavConfig,
    filename: string,
    body: Uint8Array,
    encrypted: boolean
): Promise<WebDavResult<{ filename: string; size: number }>> {
    try {
        const folderUrl = buildWebDavFolderUrl(config);
        const putHeaders = { "Content-Type": encrypted ? "application/octet-stream" : "application/gzip" };

        let response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "PUT", config, body, putHeaders);

        // 目录不存在时才补建，避免每次备份都先发一次 PROPFIND 预检
        if (response.status === 404 || response.status === 409) {
            await ensureWebDavFolder(config, folderUrl);
            response = await davFetch(buildWebDavFileUrl(folderUrl, filename), "PUT", config, body, putHeaders);
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

// 上传备份文件
export async function webdavUpload(
    config: WebDavConfig,
    filename: string,
    data: ExportData,
    password: string = config.backupPassword ?? ""
): Promise<WebDavResult<{ filename: string; size: number }>> {
    try {
        // 不缩进 + gzip：比原来的「带缩进明文 JSON」小一个数量级，上传快得多。
        // 设了备份口令再套一层口令加密（NAVIHIVE-ENC1，PBKDF2 随机盐），备份文件
        // 落到网盘上也是密文。没设口令就退化为明文 gzip —— 能备份，只是不加密。
        const gz = await gzipBytes(JSON.stringify(data));
        const body = password ? await encryptBackup(gz, password) : gz;
        return await webdavPutBytes(config, filename, body, Boolean(password));
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
        // 兼容压缩备份（.json.gz）、早期明文备份（.json）与 ZIP 笔记备份（.zip，2026-10-11）
        const files = parseWebDavList(xml).filter(file =>
            /\.json(\.gz)?$/i.test(file.name) || /\.zip$/i.test(file.name)
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

/**
 * 下载一份远端备份并解开口令加密（如有），返回**原始字节**（不 gunzip、不解析）。
 *
 * 与 webdavDownload 的分工：这里是「取回 + 解密」这一段；
 * JSON 备份的 gunzip + 解析仍在 webdavDownload，ZIP 笔记备份（2026-10-11 起）
 * 则由 notes download 路由直接拿字节转 base64 交给前端解包。
 *
 * maxBytes 可调：ZIP 备份带附件，体积上限比纯 JSON 的 32MB 宽（见调用方）。
 */
export async function webdavDownloadBytes(
    config: WebDavConfig,
    filename: string,
    password: string = config.backupPassword ?? "",
    maxBytes: number = MAX_BACKUP_DOWNLOAD_BYTES
): Promise<WebDavResult<{ bytes: Bytes; encrypted: boolean }>> {
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

        // 有界读取：网盘上的东西不受我们控制，对方真返回一个几个 G 的文件，
        // 直接 arrayBuffer() 会把 Worker 的内存吃干。
        const rawBytes: Bytes = new Uint8Array(
            await readBoundedBytes(response.body, maxBytes, 60_000)
        );

        // 按文件头判断是否口令加密（NAVIHIVE-ENC1/2）。没加密就原样返回。
        if (isEncryptedBackup(rawBytes)) {
            if (!password) {
                return {
                    success: false,
                    code: "encrypted",
                    // 备份可能是别的账号传上去的（网盘地址/口令每个账号各存一份），
                    // 所以这里不能只让用户去「备份」页改配置 —— 前端会就地在恢复区弹口令框
                    message: "这份备份是口令加密的，请输入备份密码后再恢复",
                };
            }
            try {
                return {
                    success: true,
                    data: { bytes: await decryptBackup(rawBytes, password), encrypted: true },
                    message: filename,
                };
            } catch (error) {
                return {
                    success: false,
                    code: "badPassword",
                    message: errorMessage(error, "备份密码不正确，或备份文件已损坏"),
                };
            }
        }
        return { success: true, data: { bytes: rawBytes, encrypted: false }, message: filename };
    } catch (error) {
        if (error instanceof BodyLimitError) {
            return {
                success: false,
                message:
                    error.status === 413
                        ? `备份文件过大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB），已放弃下载`
                        : "下载备份超时，请稍后重试",
            };
        }
        return { success: false, message: errorMessage(error, "下载备份失败") };
    }
}

// 下载指定的远端备份
export async function webdavDownload(
    config: WebDavConfig,
    filename: string,
    password: string = config.backupPassword ?? ""
): Promise<WebDavResult<ExportData>> {
    // 取回 + 解密这一段共用 webdavDownloadBytes；这里只负责「解开 JSON」。
    const raw = await webdavDownloadBytes(config, filename, password);
    if (!raw.success || !raw.data) {
        // 类型收窄：失败分支没有 data
        return { success: false, code: raw.code, message: raw.message };
    }
    const rawBytes = raw.data.bytes;

    // 按文件头判断格式，兼容历史备份：
    // - 1f 8b 开头：gzip 备份（加密备份解开之后也是 gzip），直接解压；
    // - PK 开头：ZIP 笔记备份（2026-10-11 起的新格式）—— 这条路不解析，
    //   交给前端走带附件回传的导入，这里报一句明确的错而不是含糊的「损坏」；
    // - 其余：再按明文 JSON 试一次（更早期的未压缩备份）。
    let jsonText: string;
    if (rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b) {
        jsonText = await gunzipToString(rawBytes).catch(() => "");
    } else if (rawBytes.length >= 2 && rawBytes[0] === 0x50 && rawBytes[1] === 0x4b) {
        return {
            success: false,
            message: "这是新版 ZIP 备份，请刷新页面后再恢复（旧版界面不认识这种格式）",
        };
    } else {
        jsonText = new TextDecoder().decode(rawBytes);
    }

    const text = jsonText.replace(/^\uFEFF/, "");
    let data: ExportData;
    try {
        data = JSON.parse(text) as ExportData;
    } catch {
        // 走到这里的只有一种常见情况：旧版本用 AUTH_SECRET 加密的备份。那份密钥
        // 已经和备份解耦，服务端不再用它解密，只能请用户重新备份一份。
        return {
            success: false,
            message: password
                ? "备份文件已损坏或口令不匹配，无法解析"
                : "这份备份是用旧版服务端密钥（AUTH_SECRET）加密的，现已与备份解耦：请用备份密码重新备份一次",
        };
    }

    return { success: true, data, message: filename };
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

// 子模块的导出原样转出去：老代码 import from "../worker/webdav" 不用改
export * from "./config";
export * from "./naming";
export * from "./transport";
export * from "./types";
