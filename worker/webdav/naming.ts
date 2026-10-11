// 备份文件名与保留策略。
//
// 全是纯函数，没有网络也没有数据库 —— 因为「手动备份不会被定时任务清掉」
// 这条规则必须能被单测直接断言，掺进 IO 就测不动了。
import type { WebDavBackupMode } from "./types";

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

// 自动备份带 auto 前缀：清理时靠文件名就能区分来源，不会误删手动备份
export function buildBackupFileName(mode: WebDavBackupMode): string {
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

// ============ 记事本备份（2026-10-09 照 inkstone 的 BackupSettings） ============
//
// 与导航页备份「分开」的物理体现就在文件名前缀：navihive-notes-backup-*
// 与导航备份 navihive-backup-* 同住一个网盘也可能互不干扰，列目录 / 清理各认各的前缀。

const NOTES_AUTO_BACKUP_PREFIX = "navihive-notes-backup-auto-";
const NOTES_MANUAL_BACKUP_PREFIX = "navihive-notes-backup-";

/** 只有自动备份会被保留策略清理（手动备份是存档，谁都不能动 —— 与导航备份同一条铁律） */
export function isNotesAutoBackupFileName(filename: string): boolean {
    return typeof filename === "string" && filename.startsWith(NOTES_AUTO_BACKUP_PREFIX);
}

export function buildNotesBackupFileName(mode: WebDavBackupMode): string {
    return buildBackupFileName(mode).replace(
        mode === "auto" ? AUTO_BACKUP_PREFIX : MANUAL_BACKUP_PREFIX,
        mode === "auto" ? NOTES_AUTO_BACKUP_PREFIX : NOTES_MANUAL_BACKUP_PREFIX
    );
}

/**
 * ZIP 备份的文件名（2026-10-11 起的新格式：notes.json + 正文引用的附件）。
 * 前缀与旧 gzip JSON 备份一致（列目录 / 清理 / 恢复都只认 navihive-notes-backup-*），
 * 只是扩展名换成 .zip —— 恢复端按文件头（PK）而不是扩展名分流，两种格式都能恢复。
 */
export function buildNotesBackupZipFileName(mode: WebDavBackupMode): string {
    return buildNotesBackupFileName(mode).replace(/\.json\.gz$/i, ".zip");
}

/**
 * 按保留份数挑出要清理的旧自动备份（inkstone 的 retentionCount 同语义）：
 * - retentionCount <= 0 = 全部保留，一个不删；
 * - 候选只有 notes 自动备份（手动备份 / 导航备份永远不在清理范围）；
 * - 「保留 N 份」按**含本次刚上传那份**算：keepFilename 占掉一个名额，
 *   剩下的名额给最新的 N-1 份旧备份（inkstone 同语义）；
 * - 按修改时间倒序（时间缺失退回文件名倒序，文件名自带时间戳）。
 */
export function selectNotesBackupsToPrune(
    files: readonly { name: string; lastModified?: string }[],
    keepFilename: string,
    retentionCount: number
): string[] {
    if (!(retentionCount > 0)) return [];
    const candidates = files
        .map(f => ({ name: f?.name ?? "", lastModified: f?.lastModified ?? "" }))
        .filter(f => f.name && f.name !== keepFilename && isNotesAutoBackupFileName(f.name));
    candidates.sort((a, b) => {
        const ta = Date.parse(a.lastModified) || 0;
        const tb = Date.parse(b.lastModified) || 0;
        if (ta !== tb) return tb - ta;
        return b.name < a.name ? -1 : b.name > a.name ? 1 : 0;
    });
    return candidates.slice(Math.max(retentionCount - 1, 0)).map(f => f.name);
}
