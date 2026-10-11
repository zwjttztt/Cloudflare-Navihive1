// src/utils/notesSync.ts
// 跨设备变更轮询（2026-10-11，阶段 5）的客户端侧纯逻辑。
//
// 设计口径（与 useNotes 里的轮询 effect 配套）：
//   - **不是自动合并，也不是实时同步**：轮询发现「其他设备改过数据」后走既有的
//     reload() 整表重拉（列表与标签立刻收敛），编辑器里的未保存草稿绝不被覆盖 ——
//     真正的并发保存冲突仍由 rev 守卫（409 + 冲突弹框）兜底。
//   - 光标与偏好都按**账号**分桶（同一台设备登录两个账号互不串扰），
//     与 NoteGraphDialog 的 scopedKey 同一套机制。
//   - 多标签页只允许一个「主标签」发轮询请求：靠 BroadcastChannel 上的
//     sync-heartbeat 消息判活，主标签消失后其余标签自然接管（短暂双发无害，
//     轮询是幂等读）。

import { readActiveAccount, scopedKey } from "./accountScope";

export interface NotesSyncPrefs {
    /** 关掉就完全不发轮询请求（默认开：一次轮询只有几条轻量读，D1 成本可忽略） */
    enabled: boolean;
    /** 轮询间隔（秒）。服务端每次轮询是 1 次游标读 + 3 个小表全读 */
    intervalSec: number;
}

export const DEFAULT_NOTES_SYNC_PREFS: NotesSyncPrefs = {
    enabled: true,
    intervalSec: 120,
};

const PREFS_KEY_BASE = "notes.sync.prefs";
const CURSOR_KEY_BASE = "notes.sync.cursor";

function prefsKey(): string {
    return scopedKey(PREFS_KEY_BASE, readActiveAccount());
}

/** 逐字段清洗，脏数据一律回落默认值（与 notesSettings.sanitize 同一纪律） */
export function sanitizeNotesSyncPrefs(raw: unknown): NotesSyncPrefs {
    const d = DEFAULT_NOTES_SYNC_PREFS;
    if (!raw || typeof raw !== "object") return { ...d };
    const o = raw as Record<string, unknown>;
    const interval =
        typeof o.intervalSec === "number" && Number.isFinite(o.intervalSec)
            ? Math.min(Math.max(Math.round(o.intervalSec), 30), 600)
            : d.intervalSec;
    return {
        enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
        intervalSec: interval,
    };
}

export function loadNotesSyncPrefs(): NotesSyncPrefs {
    try {
        const raw = globalThis.localStorage?.getItem(prefsKey());
        if (!raw) return { ...DEFAULT_NOTES_SYNC_PREFS };
        return sanitizeNotesSyncPrefs(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_NOTES_SYNC_PREFS };
    }
}

export function saveNotesSyncPrefs(prefs: NotesSyncPrefs): void {
    try {
        globalThis.localStorage?.setItem(prefsKey(), JSON.stringify(sanitizeNotesSyncPrefs(prefs)));
    } catch {
        /* 隐私模式下写不了，忽略 */
    }
}

/** 上次轮询的服务端游标（SQLite CURRENT_TIMESTAMP 格式）。空串 = 还没轮询过 */
export function loadNotesSyncCursor(): string {
    try {
        return globalThis.localStorage?.getItem(scopedKey(CURSOR_KEY_BASE, readActiveAccount())) ?? "";
    } catch {
        return "";
    }
}

export function saveNotesSyncCursor(cursor: string): void {
    try {
        globalThis.localStorage?.setItem(scopedKey(CURSOR_KEY_BASE, readActiveAccount()), cursor);
    } catch {
        /* 写不了就下次重新初始化游标，只是第一次轮询多一次全量比对 */
    }
}

/** 清掉当前账号的同步状态（退出登录 / 切账号时不必调，键本身按账号隔离） */
export function clearNotesSyncState(): void {
    try {
        globalThis.localStorage?.removeItem(prefsKey());
        globalThis.localStorage?.removeItem(scopedKey(CURSOR_KEY_BASE, readActiveAccount()));
    } catch {
        /* 忽略 */
    }
}
