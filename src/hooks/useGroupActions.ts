// src/hooks/useGroupActions.ts
// 分组的「改 / 删」：删分组是代价最大的一次操作——它会连组内所有卡片一起删。
//
// 所以这里的撤销必须把「分组 + 卡片」整组重建回来，而且卡片的本机标签 / 星标
// 也要按快照重新挂上（重建出来的卡片是**新 id**）。顺序也不能乱：卡片要按原来的
// order_num 重建，分组本身要按 order_num 插回原来的位置。
//
// 与 useSiteActions 一样：优先从回收站精确还原，拿不到才按快照重建。
// 从 App.tsx 整段搬过来的，行为不变；引用点名字与抽走前保持一致。
import { useCallback, useState, type MutableRefObject } from "react";
import type { Group, Site } from "../API/http";
import type { GroupWithSites } from "../types";
import type { TagMap } from "../utils/tagOps";
import type { HistoryCommand } from "../utils/historyStack";
import type { NotifyAction } from "../context/NotifyContext";
import type { NotifySeverity } from "./useNotify";
import { reportError } from "../utils/errorReporter";
import { snapshotSitePrefs } from "../utils/siteMutations";

export interface GroupActionNotify {
    (
        message: string,
        level?: NotifySeverity,
        ms?: number,
        action?: NotifyAction
    ): void;
}

/** 本域用到的接口（照 SortApi / CreatorApi 的写法只声明用到的部分） */
export type GroupActionsApi = {
    updateGroup(id: number, group: Group): Promise<Group | null>;
    createGroup(group: Group): Promise<Group>;
    createSite(site: Site): Promise<Site>;
    deleteGroup(id: number): Promise<{ success: boolean; recycleId?: number }>;
    /**
     * 从回收站还原一条。**两种返回形状都得认**：服务端实现给 boolean，
     * 浏览器端 NavigationClient 给 { success: boolean }（详见 doGroupDelete 里的说明）。
     */
    restoreRecycleItem(id: number): Promise<boolean | { success: boolean }>;
    // 两端的声明不一致（NavigationAPI 写 boolean，NavigationClient 返回
    // { success: boolean }），本域只 await 不看结果，用 unknown 两边都对得上
    purgeRecycleItem(id: number): Promise<unknown>;
};

export interface GroupActionsDeps {
    api: GroupActionsApi;
    groupsRef: MutableRefObject<GroupWithSites[]>;
    setGroups: (updater: (prev: GroupWithSites[]) => GroupWithSites[]) => void;
    handleError: (message: string) => void;
    notify: GroupActionNotify;
    tags: TagMap;
    starred: number[];
    forgetSites: (siteIds: number[]) => void;
    setSiteTags: (siteId: number, tags: string[]) => void;
    setStarredMany: (siteIds: number[], starred: boolean) => void;
    pushHistory: (command: HistoryCommand) => void;
    runUndo: () => Promise<void>;
    fetchData: (options?: { silent?: boolean }) => Promise<boolean>;
}

export function useGroupActions(deps: GroupActionsDeps) {
    // 就地解构：下面的实现是从 App.tsx 整段搬过来的，变量名保持原样才能不改一行逻辑
    const {
        api,
        groupsRef,
        setGroups,
        handleError,
        notify,
        tags,
        starred,
        forgetSites,
        setSiteTags,
        setStarredMany,
        pushHistory,
        runUndo,
        fetchData,
    } = deps;

    // 更新分组（引用稳定，配合 GroupCard 的 memo 减少重渲染）
    const handleGroupUpdate = useCallback(
        async (updatedGroup: Group) => {
            try {
                if (updatedGroup.id) {
                    const saved = await api.updateGroup(updatedGroup.id, updatedGroup);
                    const nextGroup = saved && saved.id !== undefined ? saved : updatedGroup;
                    setGroups(prev => {
                        const idx = prev.findIndex(group => group.id === updatedGroup.id);
                        if (idx === -1) return prev;
                        const next = [...prev];
                        next[idx] = { ...prev[idx], ...nextGroup };
                        return next;
                    });
                }
            } catch (error) {
                reportError(error, { source: "group-update" });
                handleError("更新分组失败: " + (error as Error).message);
            }
        },
        [api, handleError, setGroups]
    );

    // 删除分组：连同组内卡片一起删，所以撤销要把「分组 + 卡片」整组重建回来
    // 分组删除：先弹二次确认（含导出提示），确认后才真删。
    // 删除是软删除（先进回收站），撤销时优先从回收站精确还原。
    const [pendingGroupDelete, setPendingGroupDelete] = useState<number | null>(null);

    // 真正执行分组删除（确认后调用）
    const doGroupDelete = useCallback(
        async (groupId: number) => {
            const snapshot = groupsRef.current.find(group => group.id === groupId);
            // 分组里的卡片会跟着一起删，它们的本机标签/星标也先留一份快照
            // （与批量删卡片共用 utils/siteMutations.ts 的 snapshotSitePrefs）
            const sitePrefs = snapshotSitePrefs(snapshot?.sites ?? [], tags, starred);
            try {
                const del = await api.deleteGroup(groupId);
                const recycleId = del.recycleId;
                setGroups(prev => {
                    const next = prev.filter(group => group.id !== groupId);
                    return next.length === prev.length ? prev : next;
                });
                // 组内卡片的标签/星标随卡片一起清掉，避免孤儿标签残留在标签栏
                if (snapshot) forgetSites(snapshot.sites.map(site => site.id as number));
                if (!snapshot) return;

                const restoredGroupId: { id?: number } = {};
                const restoredSiteIds: number[] = [];
                const restore = async () => {
                    if (recycleId !== undefined) {
                        const res = await api.restoreRecycleItem(recycleId);
                        // ⚠️ 这个值两端的形状不一样：服务端实现返回 boolean，
                        // 而浏览器端的 NavigationClient 返回 { success: boolean }。
                        // 以前写的是 `if (ok)`，而**对象永远是 truthy** ——
                        // 于是「回收站里那条已经被清掉、还原失败」时也会被当成成功，
                        // 下面「按快照重建」的分支永远走不到，撤销删分组后分组就回不来。
                        // 两种形状都认，取真正的成功标志。
                        const ok = typeof res === "boolean" ? res : res?.success === true;
                        if (ok) {
                            await fetchData({ silent: true });
                            restoredGroupId.id = snapshot.id;
                            return;
                        }
                    }
                    const created = await api.createGroup({
                        name: snapshot.name,
                        order_num: snapshot.order_num ?? 0,
                    } as Group);
                    const newId = created?.id;
                    if (newId === undefined) throw new Error("重建分组失败");
                    restoredGroupId.id = newId;

                    // 卡片按原顺序重建，分组位置也按 order_num 插回原处
                    const restored: Site[] = [];
                    const ordered = [...snapshot.sites].sort(
                        (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                    );
                    restoredSiteIds.length = 0;
                    for (const site of ordered) {
                        const createdSite = await api.createSite({
                            ...site,
                            id: undefined,
                            group_id: newId,
                        } as Site);
                        if (createdSite && createdSite.id !== undefined) {
                            restored.push(createdSite);
                            restoredSiteIds.push(createdSite.id);
                            const prefs = sitePrefs.get(site.id as number);
                            if (prefs) {
                                if (prefs.tags.length > 0) setSiteTags(createdSite.id, prefs.tags);
                                if (prefs.starred) setStarredMany([createdSite.id], true);
                            }
                        }
                    }

                    setGroups(prev =>
                        [...prev, { ...created, id: newId, sites: restored }].sort(
                            (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                        )
                    );
                };
                const removeAgain = async () => {
                    if (recycleId !== undefined) {
                        await api.purgeRecycleItem(recycleId);
                        return;
                    }
                    const groupIdToRemove = restoredGroupId.id;
                    restoredGroupId.id = undefined;
                    if (groupIdToRemove === undefined) return;
                    await api.deleteGroup(groupIdToRemove);
                    setGroups(prev => prev.filter(g => g.id !== groupIdToRemove));
                    if (restoredSiteIds.length) {
                        forgetSites([...restoredSiteIds]);
                        restoredSiteIds.length = 0;
                    }
                };

                const label = `删除分组「${snapshot.name}」`;
                pushHistory({ label, undo: restore, redo: removeAgain });
                notify(
                    `已删除分组「${snapshot.name}」${snapshot.sites.length ? `及 ${snapshot.sites.length} 张卡片（可在回收站恢复）` : ""}`,
                    "info",
                    8000,
                    {
                        label: "撤销",
                        onClick: () => void runUndo(),
                    }
                );
            } catch (error) {
                reportError(error, { source: "group-delete" });
                handleError("删除分组失败: " + (error as Error).message);
            }
        },
        [api, groupsRef, tags, starred, setGroups, forgetSites, pushHistory, notify, fetchData, setSiteTags, setStarredMany, runUndo, handleError]
    );

    // 入口：先确认再删（分组删除会连带清空其下所有卡片，误删代价大）
    const handleGroupDelete = useCallback((groupId: number) => {
        setPendingGroupDelete(groupId);
    }, []);
    return {
        handleGroupUpdate,
        pendingGroupDelete,
        setPendingGroupDelete,
        doGroupDelete,
        handleGroupDelete,
    };
}
