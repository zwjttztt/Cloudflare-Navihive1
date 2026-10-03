// src/hooks/useUndoRedo.ts
// 撤销 / 重做的**执行层**：useHistoryStack 只管栈，这里负责「按下之后发生什么」，
// 以及刷新之后把上次留下的可重放记录捞回来（utils/undoPersist）。
//
// 跨刷新恢复那条路径上有个必须小心的地方：**快照里的账号 / 密码是空的**
// （落盘前就被 stripSecrets 抹掉了）。写回时必须把它俩排除在外，否则撤销一次
// 「改标题」会把库里的站点密码清成空 —— 等于借撤销之手做了一次静默的凭据删除，
// 而用户完全不知情。这条有单测钉着。
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { Site } from "../API/http";
import type { GroupWithSites } from "../types";
import type { PersistedUndo } from "../utils/undoPersist";
import { loadPersistedUndo } from "../utils/undoPersist";
import type { NotifySeverity } from "./useNotify";

export interface UndoRedoNotify {
    (message: string, level?: NotifySeverity): void;
}

export interface UndoRedoDeps {
    api: { updateSite(id: number, site: Partial<Site>): Promise<unknown> };
    /** groups 的最新值（ref）：恢复时要判断「那张卡片还在不在」 */
    groupsRef: MutableRefObject<GroupWithSites[]>;
    upsertSiteLocally: (site: Site) => void;
    notify: UndoRedoNotify;
    undoHistory: () => Promise<string | null>;
    redoHistory: () => Promise<string | null>;
    /** 把落盘的记录变回命令压回栈里（useHistoryStack 提供） */
    hydrateHistory: (
        list: PersistedUndo[],
        build: (item: PersistedUndo) => {
            label: string;
            undo: () => Promise<void>;
            redo: () => Promise<void>;
            persist: PersistedUndo;
        } | null
    ) => void;
    /** groups 是否已经到位：早于这时候校验会全判成「卡片不在了」 */
    groupsReady: boolean;
}

export function useUndoRedo(deps: UndoRedoDeps) {
    // 就地解构：下面的实现是从 App.tsx 整段搬过来的，变量名保持原样才能不改一行逻辑
    const {
        api,
        groupsRef,
        upsertSiteLocally,
        notify,
        undoHistory,
        redoHistory,
        hydrateHistory,
        groupsReady,
    } = deps;

    /**
     * 刷新之后把上次留下的「可重放」撤销记录捞回来（见 utils/undoPersist）。
     *
     * 只恢复此刻还存在的卡片：中间已经被删掉 / 恢复过的，再写回去只会造出一张
     * 谁都不认识的脏卡片。删卡片不走这条路 —— 它有回收站兜底，那才是跨刷新的正解。
     */
    const restorePersistedUndo = useCallback(() => {
        const list = loadPersistedUndo();
        if (list.length === 0) return;
        hydrateHistory(list, item => {
            const stillThere = groupsRef.current.some(group =>
                group.sites.some(site => site.id === item.siteId)
            );
            if (!stillThere) return null;

            const apply = async (site: Site) => {
                // 快照里的账号 / 密码是空的（落盘前就抹掉了，见 undoPersist.stripSecrets）。
                // 这里必须把它俩排除在写回之外 —— 否则撤销一次「改标题」会把库里的
                // 站点密码清成空，等于借撤销之手做了一次静默的凭据删除。
                const { username: _skipUser, password: _skipPass, ...rest } = site;
                await api.updateSite(item.siteId, { ...rest, id: item.siteId });
                // 本地同样保留现存的凭据字段，界面上不会突然变成「未设置密码」
                const current = groupsRef.current
                    .flatMap(group => group.sites)
                    .find(s => s.id === item.siteId);
                upsertSiteLocally({
                    ...rest,
                    id: item.siteId,
                    username: current?.username ?? "",
                    password: current?.password ?? "",
                });
            };
            return {
                label: item.label,
                undo: () => apply(item.before),
                redo: () => apply(item.after),
                persist: item,
            };
        });
    }, [api, groupsRef, hydrateHistory, upsertSiteLocally]);

    // 数据第一次到位后恢复一次：早于这时候 groupsRef 还是空的，校验会全判成「卡片不在了」
    const restoredUndoRef = useRef(false);
    useEffect(() => {
        if (restoredUndoRef.current) return;
        if (!groupsReady) return;
        restoredUndoRef.current = true;
        restorePersistedUndo();
    }, [groupsReady, restorePersistedUndo]);
    const runUndo = useCallback(async () => {
        if (!undoHistory) return;
        try {
            const label = await undoHistory();
            notify(label ? `已撤销：${label}` : "没有可撤销的操作", label ? "success" : "info");
        } catch {
            notify("撤销失败", "error");
        }
    }, [undoHistory, notify]);
    const runRedo = useCallback(async () => {
        try {
            const label = await redoHistory();
            notify(label ? `已重做：${label}` : "没有可重做的操作", label ? "success" : "info");
        } catch {
            notify("重做失败", "error");
        }
    }, [redoHistory, notify]);
    return { runUndo, runRedo };
}
