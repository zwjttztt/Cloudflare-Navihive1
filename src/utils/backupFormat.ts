// src/utils/backupFormat.ts
// 备份列表里的两个「给人看」的格式化。
//
// 从 BackupDialog.tsx 搬出来：备份页与恢复页都要显示文件大小和备份时间，
// 而这两页拆成独立组件之后，谁也不该再依赖弹窗本体里的私有函数。
// 顺带它们也能被单测直接覆盖（以前要挂起整个弹窗才测得着）。

import { fmtDateTime } from "./format";

/** 人类可读的文件大小 */
export function formatSize(bytes: number): string {
    if (!bytes) return "未知大小";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 远端备份时间格式化（紧凑 `YYYY-MM-DD HH:MM`）。
 * 复用 format.ts 的共享解析器：解析失败原样返回（与旧行为一致），
 * 同时修掉了 `new Date("2024-01-01 12:00:00")` 在 Safari/iOS 上 Invalid Date 的坑。
 */
export function formatTime(value: string): string {
    return fmtDateTime(value, { style: "compact" });
}

/**
 * 自动备份多久没成功就算「不对劲」：8 天。
 *
 * 为什么是 8 而不是 7：定时任务是「距上次成功 ≥ 6.5 天才跑」，每小时检查一次。
 * 正常情况下最长间隔约 6.5 天 + 1 小时；给到 8 天才报警，是为了不把「刚好晚了一小时」
 * 这种噪声也报成故障 —— 天天喊的警告等于没有警告。
 */
export const AUTO_BACKUP_STALE_DAYS = 8;

/**
 * 距某个时间点过了多少**天**（向下取整）。解析不出来返回 null。
 *
 * 只给「N 天前」这种粗粒度文案用，所以按整天取整、负数夹到 0
 * （时间戳在未来时显示「今天」，不显示「-3 天前」）。
 */
export function daysSince(value: string, nowMs: number): number | null {
    if (!value) return null;
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return null;
    const diff = nowMs - at;
    if (diff <= 0) return 0;
    return Math.floor(diff / 86_400_000);
}
