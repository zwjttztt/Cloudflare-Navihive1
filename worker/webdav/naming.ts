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
