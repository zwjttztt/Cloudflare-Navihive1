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
import {
    buildNotesBackupFileName,
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
    }
): Promise<WebDavResult<{ filename: string; size: number }>> {
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
        const gz = await gzipBytes(JSON.stringify(payload));
        const body = password ? await encryptBackup(gz, password) : gz;
        const filename = buildNotesBackupFileName(mode);
        const result = await webdavPutBytes(config, filename, body, Boolean(password));

        if (result.success) {
            run.status = "success";
            run.filename = filename;
            run.noteCount = Array.isArray(payload.notes) ? payload.notes.length : 0;
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
