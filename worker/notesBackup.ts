// 记事本备份（2026-10-09 照 inkstone 的 BackupSettings）。
//
// 与导航页备份（worker/webdav.ts 的 runWebDavBackup / worker/cron.ts 的
// runWeeklyBackup）**完全分开**：独立目录、独立文件名前缀（navihive-notes-backup-*）、
// 独立的频率与保留策略、独立的运行记录。唯一共用的是网盘账号本身 ——
// url / username / password 直接回落到导航页已保存的 webdav.*（用户要求
// 「导航页保存后在这里自动带入」），这里只存记事本自己的差异项。
//
// 备份内容：只含记事本（notes / folders / tags / noteTags，api.exportNotesData()），
// 形状与 POST /api/notes/import 的入参一致 —— 「备份 → 数据页导入」天然闭环，
// 不需要另一套恢复代码。
//
// 纯逻辑（调度判定 / 保留清理 / 运行记录合并）都导出成纯函数，单测直接断言。
import type { NavigationAPI } from "../src/API/navigationApi";
import type { NotesBackupRun } from "../src/API/types";
import { encryptBackup } from "../src/API/crypto";
import { createZip, type ZipEntry } from "../src/utils/zip";
import { readAttachmentObject, selectAttachmentStorage } from "./attachments";
import type { Env } from "./types";
import {
    buildNotesBackupFileName,
    buildNotesBackupZipFileName,
    selectNotesBackupsToPrune,
} from "./webdav/naming";
import { gzipBytes } from "./webdav/transport";
import {
    webdavDelete,
    webdavList,
    webdavPutBytes,
    webdavTest,
} from "./webdav";
import { type WebDavBackupMode, type WebDavConfig, type WebDavResult } from "./webdav/types";

/** 记事本备份的默认目录（与导航页的 navihive-backup 区分开） */
export const DEFAULT_NOTES_BACKUP_PATH = "navihive-notes-backup";

/** 运行记录最多留几条（inkstone 的最近备份列表也只展示 12 条） */
export const NOTES_BACKUP_RUNS_CAP = 12;

export const NOTES_BACKUP_RUNS_KEY = "notesBackup.runs";
export const NOTES_BACKUP_LAST_AUTO_AT_KEY = "notesBackup.lastAutoBackupAt";

/**
 * 单次备份里附件字节的总预算（24 MB）。
 *
 * ZIP 在 Worker 内存里拼装，预算必须给「密文拷贝 + base64」留出余量：
 * 24MB 附件 + JSON + zip 结构 + 加密副本，峰值仍远低于 Workers 的内存上限。
 * 超出预算的附件**跳过并计数**（进运行记录与结果消息），绝不让备份整体失败 ——
 * 一份缺几张图的备份远好于没有备份。
 */
export const NOTES_BACKUP_ATTACHMENT_BUDGET_BYTES = 24 * 1024 * 1024;

/**
 * 从一批笔记正文里收集引用到的附件 id（去重）。
 *
 * 判据与前端引用计数同一个正则：`/api/notes/attachments/<uuid>`。
 * 只备「正文还引用着的」附件 —— 未引用的迟早被 GC 清掉，备了也恢复不出来。
 * （纯函数，单测直接打这里。）
 */
export function collectReferencedAttachmentIds(
    notes: ReadonlyArray<{ content?: string | null }>
): Set<string> {
    const ids = new Set<string>();
    for (const note of notes) {
        const content = typeof note?.content === "string" ? note.content : "";
        if (!content) continue;
        for (const match of content.matchAll(/\/api\/notes\/attachments\/([0-9a-zA-Z-]+)/g)) {
            if (match[1]) ids.add(match[1]);
        }
    }
    return ids;
}

export interface BackupAttachmentRows {
    id: string;
    filename: string | null;
    storage: string;
    object_key: string;
}

/**
 * 把「该进备份的附件」读出来打包成 zip 条目：`attachments/<id>__<文件名>`。
 *
 * ⚠️ 条目路径必须与前端导出 zip（NotesPage.exportAllZip）完全一致：
 * 恢复端按 `<旧id>__<文件名>` 把正文里的引用换成新 id —— 两边各写一套
 * 格式迟早跑偏，所以这里刻意抄同一条命名规则。
 *
 * 超出预算 / 读取失败都跳过并计数，不抛错（同上：宁缺勿失败）。
 */
export async function readBackupAttachmentEntries(
    api: NavigationAPI,
    env: Env,
    payload: { notes?: ReadonlyArray<{ content?: string | null }> },
    budgetBytes: number = NOTES_BACKUP_ATTACHMENT_BUDGET_BYTES
): Promise<{ entries: ZipEntry[]; skipped: number; bytes: number }> {
    const entries: ZipEntry[] = [];
    if (!selectAttachmentStorage(env)) return { entries, skipped: 0, bytes: 0 };
    const referenced = collectReferencedAttachmentIds(payload.notes ?? []);
    if (referenced.size === 0) return { entries, skipped: 0, bytes: 0 };

    // 只查引用到的那批：附件表可能远大于正文引用数，全量拉元数据纯属浪费
    const ids = [...referenced];
    const placeholders = ids.map(() => "?").join(",");
    const uid = api.currentUserId;
    const rowsResult = await api.db
        .prepare(
            `SELECT id, filename, storage, object_key FROM attachments
             WHERE id IN (${placeholders})${uid === null ? " AND user_id IS NULL" : " AND user_id = ?"}`
        )
        .bind(...(uid === null ? ids : [...ids, uid]))
        .all<BackupAttachmentRows>();
    const rows = rowsResult.results || [];

    let used = 0;
    let skipped = 0;
    for (const row of rows) {
        if (!isAttachmentStorageTag(row.storage)) { skipped += 1; continue; }
        if (used >= budgetBytes) { skipped += 1; continue; }
        try {
            const bytes = await readAttachmentObject(env, row.storage, row.object_key);
            if (!bytes || bytes.length === 0) { skipped += 1; continue; }
            if (used + bytes.length > budgetBytes) { skipped += 1; continue; }
            used += bytes.length;
            entries.push({
                path: `attachments/${row.id}__${row.filename || "file"}`,
                data: bytes,
            });
        } catch {
            skipped += 1;
        }
    }
    // 没查到元数据的引用（行已被删 / 串号）同样算跳过，让运行记录如实反映
    skipped += Math.max(0, referenced.size - rows.length);
    return { entries, skipped, bytes: used };
}

function isAttachmentStorageTag(v: string): v is "r2" | "kv" {
    return v === "r2" || v === "kv";
}

// ============ 纯函数（单测直接打这里） ============

/** inkstone 的 BackupSchedule 同款选项；off = 关闭自动备份 */
export type NotesBackupSchedule =
    | "off"
    | "hourly"
    | "sixHourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly";

export const NOTES_BACKUP_SCHEDULES: NotesBackupSchedule[] = [
    "off",
    "hourly",
    "sixHourly",
    "daily",
    "weekly",
    "monthly",
    "yearly",
];

/** 各频率的执行间隔。月 = 30 天、年 = 365 天（备份场景不需要日历精确） */
export function notesBackupIntervalMs(schedule: string): number | null {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    switch (schedule) {
        case "hourly":
            return HOUR;
        case "sixHourly":
            return 6 * HOUR;
        case "daily":
            return DAY;
        case "weekly":
            return 7 * DAY;
        case "monthly":
            return 30 * DAY;
        case "yearly":
            return 365 * DAY;
        default:
            return null; // off / 未知值都不跑
    }
}

/**
 * 到没到下一次自动备份的时间。lastRunAt 为空 = 从来没自动备份过，配了就跑。
 * cron 每小时触发一次调度，这里靠「距离上次成功自动备份 ≥ 间隔」判定，
 * 任何触发频率（每小时 / 每周）下行为都正确。
 */
export function shouldRunNotesBackup(
    schedule: string,
    lastRunAt: string | null | undefined,
    nowMs: number
): boolean {
    const interval = notesBackupIntervalMs(schedule);
    if (interval === null) return false;
    if (!lastRunAt) return true;
    const last = Date.parse(lastRunAt);
    if (!Number.isFinite(last)) return true;
    return nowMs - last >= interval;
}

/** 解析保留份数配置（"0" = 全部保留；缺省 / 非法值退回默认 7） */
export function parseNotesRetention(value: string | null | undefined): number {
    // Number(null) 是 0 不是 NaN —— 缺省和「0 = 全部保留」必须分开判
    if (value === null || value === undefined || value === "") return 7;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 7;
    return Math.min(Math.floor(n), 365);
}

/** 把一次运行记录并进记录列表：新的在前，超出上限的丢掉 */
export function appendNotesBackupRun(
    runs: NotesBackupRun[],
    run: NotesBackupRun,
    cap: number = NOTES_BACKUP_RUNS_CAP
): NotesBackupRun[] {
    return [run, ...runs].slice(0, cap);
}

// ============ IO 部分 ============

/** 读当前账号的全部配置（cron / 路由共用；读不到就当空，别让备份被配置读取失败带崩） */
export async function readNotesBackupStored(api: NavigationAPI): Promise<Record<string, string>> {
    try {
        return await api.getConfigs();
    } catch {
        return {};
    }
}

/**
 * 从已读出的配置拼出记事本备份要用的 WebDAV 配置。
 *
 * 凭据回落是这里的核心：url / username / password / allowPrivateNetwork 一律取
 * webdav.*（导航页保存的那套），path / backupPassword 才是 notesBackup.* 自己的
 * （backupPassword 没设就接着回落 webdav.backupPassword —— 用户只配过导航备份时，
 * 记事本备份开箱即用同样的加密口令）。
 */
export function notesWebDavConfigFrom(stored: Record<string, string>): WebDavConfig {
    return {
        url: stored["webdav.url"] || "",
        username: stored["webdav.username"] || "",
        password: stored["webdav.password"] || "",
        path: stored["notesBackup.path"] || DEFAULT_NOTES_BACKUP_PATH,
        backupPassword: stored["notesBackup.backupPassword"] || stored["webdav.backupPassword"] || "",
        allowPrivateNetwork: stored["webdav.allowPrivateNetwork"] === "1" || stored["webdav.allowPrivateNetwork"] === "true",
    };
}

export async function resolveNotesWebDavConfig(api: NavigationAPI): Promise<WebDavConfig> {
    return notesWebDavConfigFrom(await readNotesBackupStored(api));
}

/** 读运行记录（解析失败 / 键不存在都按空列表，绝不抛错） */
export async function readNotesBackupRuns(api: NavigationAPI): Promise<NotesBackupRun[]> {
    try {
        const raw = await api.getConfig(NOTES_BACKUP_RUNS_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(parsed) ? (parsed as NotesBackupRun[]) : [];
    } catch {
        return [];
    }
}

async function writeNotesBackupRuns(api: NavigationAPI, runs: NotesBackupRun[]): Promise<void> {
    try {
        await api.setConfig(NOTES_BACKUP_RUNS_KEY, JSON.stringify(runs));
    } catch (error) {
        // 记录失败不影响备份结果本身
        console.error("记录笔记备份运行记录失败:", error);
    }
}

/**
 * 执行一次记事本备份：服务端自取笔记数据 → gzip →（可选）口令加密 → 上传 →
 * （仅 auto）按保留份数清旧 → 记运行记录。
 * 任何失败也记一条 failure 运行记录（inkstone 的 RunRow 同语义），再原样返回结果。
 */
export async function runNotesWebDavBackup(
    api: NavigationAPI,
    config: WebDavConfig,
    options: {
        mode: WebDavBackupMode;
        /** 已读出的配置（cron 里已经拿过一次，免得重复查） */
        stored?: Record<string, string>;
        /** 备份口令；不传时用 config.backupPassword */
        password?: string;
        /**
         * Worker env（2026-10-11）：传了且配置了附件存储时，备份升级为
         * ZIP（notes.json + 正文引用的附件）；不传 / 没配存储时保持旧
         * gzip JSON 格式，行为与历史版本完全一致。
         */
        env?: Env;
    }
): Promise<WebDavResult<{ filename: string; size: number }>> {
    const leaseKey = `auth.notesBackup.lease.${api.currentUserId ?? 0}`;
    const leaseToken = crypto.randomUUID();
    let leaseValue = `${Date.now() + 15 * 60_000}:${leaseToken}`;
    async function renewLease(): Promise<void> {
        const next = `${Date.now() + 15 * 60_000}:${leaseToken}`;
        const result = await api.db.prepare("UPDATE configs SET value = ? WHERE key = ? AND value = ?")
            .bind(next, leaseKey, leaseValue).run();
        if (!(result.meta as { changes?: number })?.changes) throw new Error("备份租约已失效，请重试");
        leaseValue = next;
    }
    await api.migrate();
    const acquired = await api.db.prepare(
        "INSERT INTO configs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(substr(configs.value, 1, 13) AS INTEGER) < ?"
    ).bind(leaseKey, leaseValue, Date.now()).run();
    if (!(acquired.meta as { changes?: number }).changes) return { success: false, message: "已有笔记备份正在进行，请稍后再试" };
    const { mode, stored = {} } = options;
    const password = options.password ?? config.backupPassword ?? "";
    const startedMs = Date.now();
    const run: NotesBackupRun = {
        id: crypto.randomUUID(),
        startedAt: new Date(startedMs).toISOString(),
        trigger: mode === "auto" ? "auto" : "manual",
        status: "failure",
    };

    try {
        const payload = await api.exportNotesData();
        // ZIP 条件：传了 env 且配置了附件存储。没配存储的部署保持旧 gzip JSON 格式，
        // 行为与历史版本完全一致（旧格式恢复链路继续有效）。
        const zipMode = Boolean(options.env && selectAttachmentStorage(options.env));
        // 附件收集（有 env 才做）：读到对象字节为止。这一步可能发 N 次 KV/R2 读，
        // 所以读完立刻续租，别让长任务在「攒附件」的半路把租约耗光。
        let attachmentEntries: ZipEntry[] = [];
        let attachmentSkipped = 0;
        if (zipMode) {
            try {
                const collected = await readBackupAttachmentEntries(api, options.env!, payload);
                attachmentEntries = collected.entries;
                attachmentSkipped = collected.skipped;
            } catch (error) {
                // 附件读失败不拖垮备份：退回纯 JSON（运行记录里没有附件数就是信号）
                console.error("收集备份附件失败，退回纯 JSON 备份:", error);
                attachmentEntries = [];
                attachmentSkipped = 0;
            }
            await renewLease();
        }

        let body: Uint8Array;
        let filename: string;
        if (zipMode) {
            // ZIP：notes.json + attachments/<id>__<文件名>，与前端导出 zip 同一布局 ——
            // 恢复直接走前端那条已测的「解包 → 附件回传 → 引用改写」链路。
            const entries: ZipEntry[] = [
                { path: "notes.json", data: new TextEncoder().encode(JSON.stringify(payload)) },
                ...attachmentEntries,
            ];
            const zip = createZip(entries);
            body = password ? await encryptBackup(zip, password) : zip;
            filename = buildNotesBackupZipFileName(mode);
        } else {
            const gz = await gzipBytes(JSON.stringify(payload));
            body = password ? await encryptBackup(gz, password) : gz;
            filename = buildNotesBackupFileName(mode);
        }
        await renewLease();
        const result = await webdavPutBytes(config, filename, body, Boolean(password));

        await renewLease();
        if (result.success) {
            run.status = "success";
            run.filename = filename;
            run.noteCount = Array.isArray(payload.notes) ? payload.notes.length : 0;
            if (attachmentEntries.length > 0 || attachmentSkipped > 0) {
                run.attachmentCount = attachmentEntries.length;
                if (attachmentSkipped > 0) run.skippedAttachments = attachmentSkipped;
            }
            run.bytes = body.byteLength;

            // 自动备份按保留份数清理旧文件；手动备份一份都不删（与导航备份同一条铁律）
            if (mode === "auto") {
                await pruneNotesAutoBackups(
                    config,
                    filename,
                    parseNotesRetention(stored["notesBackup.retention"])
                );
                try {
                    await api.setConfig(NOTES_BACKUP_LAST_AUTO_AT_KEY, run.startedAt);
                } catch {
                    // 记录失败不影响本次结果；最多下次多备一份
                }
            }
        } else {
            run.error = result.message || "上传失败";
        }

        run.durationMs = Date.now() - startedMs;
        const runs = await readNotesBackupRuns(api);
        await writeNotesBackupRuns(api, appendNotesBackupRun(runs, run));
        return result;
    } catch (error) {
        run.error = error instanceof Error ? error.message : "备份异常";
        run.durationMs = Date.now() - startedMs;
        const runs = await readNotesBackupRuns(api);
        await writeNotesBackupRuns(api, appendNotesBackupRun(runs, run));
        return { success: false, message: run.error };
    } finally {
        try {
            await api.db.prepare("DELETE FROM configs WHERE key = ? AND value = ?").bind(leaseKey, leaseValue).run();
        } catch (error) {
            console.error("释放笔记备份租约失败，等待 TTL 回收:", error);
        }
    }
}

/** 按保留份数清理旧的自动备份；清不掉不影响备份结果（与导航备份同一容忍度） */
async function pruneNotesAutoBackups(
    config: WebDavConfig,
    keepFilename: string,
    retentionCount: number
): Promise<void> {
    try {
        if (!(retentionCount > 0)) return;
        const list = await webdavList(config);
        if (!list.success || !Array.isArray(list.data)) return;
        const targets = selectNotesBackupsToPrune(list.data, keepFilename, retentionCount);
        for (const name of targets) {
            await webdavDelete(config, name);
        }
    } catch (error) {
        console.error("清理旧笔记备份失败:", error);
    }
}

/** 测试记事本备份目录连通性（复用 webdavTest，只是配置换成 notesBackup 的目录） */
export function testNotesWebDav(config: WebDavConfig): Promise<WebDavResult> {
    return webdavTest(config);
}

/** cron / 路由里给用户看的一句话：还没配网盘时的提示（顺带把带入来源讲清楚） */
export const NOTES_BACKUP_NOT_CONFIGURED_MESSAGE =
    "尚未配置网盘：请先在导航页「数据备份」里保存 WebDAV 地址与账号，记事本备份会自动带入";
