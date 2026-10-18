// src/hooks/useSiteSync.ts
// 卡片侧的跨设备增量同步：轮询 `/api/sites/changes`，把**其它设备删掉的卡片**从本地移除。
//
// 为什么需要它：删除是物理删行（数据搬进 recycle_bin），只看 updated_at 的轮询
// 永远看不见「少了哪张卡」—— 笔记侧为此加了 note_tombstone + notes/changes，
// 卡片侧是同一个问题、同一个解法（site_tombstone）。
// 增与改不需要墓碑：客户端比对整份 bootstrap 就能发现，所以端点只回删除。
//
// 与 useNotes 的轮询同策略：
//   - 间隔可配（默认 60 秒），首轮留 5 秒给首屏让路；
//   - 失败一律静默：同步是锦上添花，不能因为轮询挂了就弹错误打断用户；
//   - 卸载 / 依赖变化立刻停表，不留野定时器。
//
// 游标与提示（2026-10-18 修「每次刷新都弹『其它设备删除了 N 张卡片』」）：
//   - 游标持久化到 localStorage（utils/siteSync.ts，按账号隔离）。原来只存在
//     内存 ref 里，刷新后第一次轮询 since 为空 → 后端把墓碑全量倒回来 →
//     历史删除被当成刚刚发生的，每次刷新弹一遍；
//   - 游标也为空（第一次用/清了存储）时只建基线，不提示 —— 跟笔记侧
//     notesChanges 的「首次轮询只初始化游标」同口径；
//   - 本设备自己删的站点也记在 siteSync.ts 里（删除成功时埋点），提示前过滤：
//     卡片明明是自己删的，再弹「其它设备删除了」纯属误导。

import { useEffect, useRef } from "react";
import {
    loadLocalSiteDeletes,
    loadSiteSyncCursor,
    saveSiteSyncCursor,
} from "../utils/siteSync";

export interface SiteSyncDeps {
    /** 需要有 siteChanges 方法；没有（老后端 / mock）就整个不跑 */
    api: { siteChanges?: (since?: string) => Promise<{ deleted: number[]; since: string }> };
    /** 关掉轮询（例如未登录 / 演示模式） */
    enabled: boolean;
    /** 把别的设备删掉的卡片从本地状态里摘掉 */
    removeSitesLocally: (ids: number[]) => void;
    /** 同步到变更时提示一句（可不给） */
    onNotify?: (message: string, level?: "success" | "error" | "info") => void;
    /** 轮询间隔（毫秒），默认 60 秒 */
    intervalMs?: number;
    /** 首轮延迟（毫秒），默认 5 秒 —— 测试注入小值用 */
    firstDelayMs?: number;
}

export function useSiteSync({
    api,
    enabled,
    removeSitesLocally,
    onNotify,
    intervalMs = 60_000,
    firstDelayMs = 5_000,
}: SiteSyncDeps) {
    // 游标只随轮询推进：换 api / 提示函数不应该把游标重置成「从头同步」。
    // 初始值从 localStorage 恢复 —— 刷新后接着上次的位置增量，不再全量重放墓碑。
    const sinceRef = useRef<string | null>(loadSiteSyncCursor() || null);
    const enabledRef = useRef(enabled);
    useEffect(() => {
        enabledRef.current = enabled;
    }, [enabled]);

    useEffect(() => {
        if (!enabled || typeof api.siteChanges !== "function") return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const tick = async () => {
            try {
                const firstRound = sinceRef.current === null;
                const res = await api.siteChanges?.(sinceRef.current ?? undefined);
                if (stopped || !res) return;
                sinceRef.current = res.since;
                saveSiteSyncCursor(res.since);
                if (Array.isArray(res.deleted) && res.deleted.length > 0) {
                    // 本设备自己删的不算「其它设备删的」：过滤后再应用/提示。
                    // removeSitesLocally 对本地没有的 id 是无操作，全量墓碑重放也安全。
                    const local = new Set(loadLocalSiteDeletes());
                    const external = res.deleted.filter(id => !local.has(id));
                    removeSitesLocally(res.deleted);
                    // 首轮（游标为空）只建基线不提示：全量墓碑里大多是陈年旧账
                    if (external.length > 0 && !firstRound) {
                        onNotify?.(
                            `其它设备删除了 ${external.length} 张卡片，已同步`,
                            "info"
                        );
                    }
                }
            } catch {
                // 静默：同步失败不该弹错误（下一轮自然会再试）
            } finally {
                if (!stopped && enabledRef.current) {
                    timer = setTimeout(() => void tick(), intervalMs);
                }
            }
        };

        // 首次延后一点：别跟首屏那几个请求抢带宽
        timer = setTimeout(() => void tick(), firstDelayMs);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [api, enabled, removeSitesLocally, onNotify, intervalMs, firstDelayMs]);
}
