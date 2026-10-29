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
