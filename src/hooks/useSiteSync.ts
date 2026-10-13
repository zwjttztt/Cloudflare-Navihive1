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

import { useEffect, useRef } from "react";

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
}

export function useSiteSync({
    api,
    enabled,
    removeSitesLocally,
    onNotify,
    intervalMs = 60_000,
}: SiteSyncDeps) {
    // 游标只随轮询推进：换 api / 提示函数不应该把游标重置成「从头同步」
    const sinceRef = useRef<string | null>(null);
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
                const res = await api.siteChanges?.(sinceRef.current ?? undefined);
                if (stopped || !res) return;
                sinceRef.current = res.since;
                if (Array.isArray(res.deleted) && res.deleted.length > 0) {
                    removeSitesLocally(res.deleted);
                    onNotify?.(
                        `其它设备删除了 ${res.deleted.length} 张卡片，已同步`,
                        "info"
                    );
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
        timer = setTimeout(() => void tick(), 5_000);
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [api, enabled, removeSitesLocally, onNotify, intervalMs]);
}
