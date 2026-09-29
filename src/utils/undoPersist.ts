// src/utils/undoPersist.ts
// 撤销栈的跨刷新保留：把「能靠数据重放」的那几步写进 localStorage。
//
// 撤销栈平时是命令模式（每条记着一个 undo 闭包），闭包没法存进 localStorage ——
// 所以这里只挑**重放不需要闭包**的操作：改卡片就是把 before 写回去，纯数据就能倒回去。
// 删除不走这条路：它已经有回收站兜底（那才是跨刷新的正解），没必要再存一份。
//
// 存是有代价的：卡片里可能有站点密码。所以它跟着两条限制：只留最近几步、超过一天作废，
// 并且刷新后恢复时会先确认卡片还在（不在了就丢弃，避免把一张早删掉的卡片写回来）。
import type { Site } from "../API/http";

/** 一条可以跨刷新重放的撤销记录 */
export type PersistedUndo = {
    kind: "site-edit";
    /** 提示条 / 读屏用的一句话说明 */
    label: string;
    /** 记录时间（毫秒）；超过一天就作废 */
    at: number;
    siteId: number;
    /** 改之前的那一版 */
    before: Site;
    /** 改之后的那一版 */
    after: Site;
};

const STORAGE_KEY = "navihive:persistedUndo";
/** 只留最近几步：多了 localStorage 里就常年躺着一堆卡片内容 */
const MAX_ITEMS = 10;
/** 超过一天就不认了：隔了这么久再撤销，多半已经不是当时那回事 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isSiteLike(value: unknown): value is Site {
    if (!value || typeof value !== "object") return false;
    const site = value as Partial<Site>;
    return typeof site.id === "number" && typeof site.name === "string";
}

/** 反序列化后的形状校验：坏数据一律丢弃（宁可少一步撤销，也别把脏东西写回库里） */
export function isPersistedUndo(value: unknown): value is PersistedUndo {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<PersistedUndo>;
    if (item.kind !== "site-edit") return false;
    if (typeof item.siteId !== "number" || typeof item.at !== "number") return false;
    if (typeof item.label !== "string") return false;
    return isSiteLike(item.before) && isSiteLike(item.after);
}

/** 读出还能用的记录（坏的、过期的自动丢掉） */
export function loadPersistedUndo(now = Date.now()): PersistedUndo[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            item => isPersistedUndo(item) && now - item.at < MAX_AGE_MS
        ) as PersistedUndo[];
    } catch {
        return [];
    }
}

/** 写入（超过上限丢最旧的）。localStorage 不可用时静默放弃 —— 撤销少一步不是大事 */
export function savePersistedUndo(list: PersistedUndo[]): void {
    try {
        const trimmed = list.slice(-MAX_ITEMS);
        if (trimmed.length === 0) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
        /* 隐私模式 / 配额满：忽略 */
    }
}

export function clearPersistedUndo(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* 同上 */
    }
}
