// src/utils/siteSync.ts
// 卡片侧跨设备同步（hooks/useSiteSync）的本地状态：轮询游标 + 本设备删除记录。
//
// 两个要解决的问题（2026-10-18 用户报「每次刷新都弹『其它设备删除了 N 张卡片』」）：
//
// 1. **游标原来只存在内存 ref 里**：刷新后第一次轮询 since 为空，后端把
//    site_tombstone 全量倒回来，前端把历史删除当成「刚刚发生的」再弹一次。
//    游标持久化到 localStorage（按账号隔离）后，刷新接着上次的位置继续增量。
//
// 2. **本设备自己删的也会被当成「其它设备删的」**：删除会写墓碑，下一轮轮询
//    （或刷新后首查）就会命中自己的删除 → 弹一条「其它设备删除了 1 张卡片」，
//    但卡片明明是自己删的（界面上还挂着撤销提示条）。所以每次本设备删除成功
//    都把 id 记进这里，轮询提示前先过滤；记录带时间戳、24 小时过期自清。
import { readActiveAccount, scopedKey } from "./accountScope";

const CURSOR_KEY_BASE = "navihive:siteSyncCursor";
const LOCAL_DELETES_KEY_BASE = "navihive:siteLocalDeletes";

/** 本设备删除记录的保质期：超过就当可能真的是「其它设备删的」（保守提示） */
const LOCAL_DELETE_TTL_MS = 24 * 60 * 60 * 1000;

/** 上次轮询的服务端游标；空串 = 还没轮询过（首次只建基线，不提示） */
export function loadSiteSyncCursor(): string {
    try {
        return (
            globalThis.localStorage?.getItem(scopedKey(CURSOR_KEY_BASE, readActiveAccount())) ?? ""
        );
    } catch {
        return "";
    }
}

export function saveSiteSyncCursor(cursor: string): void {
    try {
        globalThis.localStorage?.setItem(scopedKey(CURSOR_KEY_BASE, readActiveAccount()), cursor);
    } catch {
        /* 写不了就刷新后重新建基线，只是刷新那一轮可能多一次全量比对 */
    }
}

/**
 * 记下「这些站点是本设备删的」。删除成功后调用（单删/批删共用）。
 * 覆盖写：同一 id 重复删（理论上不该发生）以最后一次为准。
 */
export function markLocalSiteDeletes(ids: number[]): void {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
        const key = scopedKey(LOCAL_DELETES_KEY_BASE, readActiveAccount());
        const store = readStore(key);
        const now = Date.now();
        for (const id of ids) {
            if (typeof id === "number") store[id] = now;
        }
        globalThis.localStorage?.setItem(key, JSON.stringify(store));
    } catch {
        /* 记不上就退化为「自己的删除也会弹一次提示」，功能不受影响 */
    }
}

/**
 * 取出仍未过期的「本设备删除」id 集合，顺手清掉过期条目。
 * useSiteSync 每轮轮询都会调它做提示过滤。
 */
export function loadLocalSiteDeletes(): number[] {
    try {
        const key = scopedKey(LOCAL_DELETES_KEY_BASE, readActiveAccount());
        const store = readStore(key);
        const cutoff = Date.now() - LOCAL_DELETE_TTL_MS;
        const alive: number[] = [];
        let dirty = false;
        for (const [id, at] of Object.entries(store)) {
            if (typeof at !== "number" || at < cutoff) {
                delete store[id];
                dirty = true;
                continue;
            }
            alive.push(Number(id));
        }
        if (dirty) {
            try {
                globalThis.localStorage?.setItem(key, JSON.stringify(store));
            } catch {
                /* 清理失败无所谓，下次再清 */
            }
        }
        return alive;
    } catch {
        return [];
    }
}

function readStore(key: string): Record<string, number> {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as Record<string, number>;
    } catch {
        return {};
    }
}
