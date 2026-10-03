// src/hooks/useSiteActions.ts
// 卡片的「改 / 删 / 批量删」以及改链接前的重复网址守卫。
//
// 这几条路径的共同点是**都要留快照、都要能撤销**：改链接要先记下原来的卡片，
// 删卡片要把它的本机标签 / 星标一起留一份（卡片没了，这两样就没有宿主了）。
// 撤销时优先「从回收站精确还原」拿回原 id，拿不到回收站条目才退回「按快照重建」
// （新 id，所以要把标签 / 星标重新挂上去）——两条路径都得在，缺一条就会出现
// 「卡片回来了但标签没了」。
//
// 从 App.tsx 整段搬过来的，行为不变；引用点名字与抽走前保持一致。
import { useCallback, type MutableRefObject } from "react";
import type { Site } from "../API/http";
import type {
    SiteBatchDeleteResult,
    RecycleBatchRestoreResult,
} from "../API/types";
import type { GroupWithSites } from "../types";
import type { TagMap } from "../utils/tagOps";
import type { HistoryCommand } from "../utils/historyStack";
import type { NotifyAction } from "../context/NotifyContext";
import type { NotifySeverity } from "./useNotify";
import type { DupPrompt } from "./useAppDialogs";
import { normalizeFailureText, normalizeUrl } from "../utils/url";
import { findDuplicateSite } from "../utils/duplicate";
import { reportError } from "../utils/errorReporter";
import {
    snapshotSitePrefs,
    pickDeletedIds,
    describeRestoredPrefs,
} from "../utils/siteMutations";

/** 提示条的四个参数：message / severity / 时长 / 动作 */
export interface SiteActionNotify {
    (
        message: string,
        level?: NotifySeverity,
        ms?: number,
        action?: NotifyAction
    ): void;
}

/**
 * 本域真正用到的那几个接口（照 SortApi / CreatorApi 的写法只声明用到的部分）。
 * 好处有两个：单测里塞假实现只要实现这七個方法；App 传进来的是
 * `NavigationClient | MockNavigationClient` 的联合类型，用 NavigationAPI 反而对不上。
 */
export type SiteActionsApi = {
    updateSite(id: number, site: Partial<Site>): Promise<Site | null>;
    createSite(site: Site): Promise<Site>;
    deleteSite(id: number): Promise<{ success: boolean; recycleId?: number }>;
    deleteSites(ids: number[]): Promise<SiteBatchDeleteResult>;
    restoreRecycleItems(ids: number[]): Promise<RecycleBatchRestoreResult>;
    // 返回类型写 unknown 是因为**两端的声明本身就不一致**：NavigationAPI 上写的是
    // Promise<boolean>，而 NavigationClient 实际返回 Promise<{ success: boolean }>。
    // 本域只 await 不看结果，用 unknown 两边都对得上（顺带记一笔：这个不一致值得单独修）。
    purgeRecycleItem(id: number): Promise<unknown>;
    purgeRecycleItems(ids: number[]): Promise<{ purged: number[] }>;
};

export interface SiteActionsDeps {
    api: SiteActionsApi;
    groupsRef: MutableRefObject<GroupWithSites[]>;
    /** 重复网址确认弹窗：撞车时把「继续」的动作存进去，用户点了才执行 */
    setDupPrompt: (prompt: DupPrompt | null) => void;
    upsertSiteLocally: (site: Site) => void;
    upsertSitesLocally: (sites: Site[]) => void;
    removeSiteLocally: (siteId: number) => void;
    removeSitesLocally: (siteIds: number[]) => void;
    handleError: (message: string) => void;
    notify: SiteActionNotify;
    tags: TagMap;
    starred: number[];
    /** 卡片删掉后连它的本机标签 / 星标一起清掉，避免标签栏留着点不出来的标签 */
    forgetSites: (siteIds: number[]) => void;
    setSiteTags: (siteId: number, tags: string[]) => void;
    setStarredMany: (siteIds: number[], starred: boolean) => void;
    pushHistory: (command: HistoryCommand) => void;
    runUndo: () => Promise<void>;
    fetchData: (options?: { silent?: boolean }) => Promise<boolean>;
}

export function useSiteActions(deps: SiteActionsDeps) {
    // 就地解构：下面的实现是从 App.tsx 整段搬过来的，变量名保持原样才能不改一行逻辑
    const {
        api,
        groupsRef,
        setDupPrompt,
        upsertSiteLocally,
        upsertSitesLocally,
        removeSiteLocally,
        removeSitesLocally,
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

    /**
     * 重复网址守卫：新增 / 改链接时先看这张链接是不是已经有了。
     * 没撞车就直接执行 run；撞了先弹确认，用户点「仍然添加」才继续。
     * 返回 true 表示已经直接执行。
     */
    const guardDuplicate = useCallback(
        (url: string | undefined, excludeId: number | undefined, run: () => void | Promise<void>) => {
            const hit = findDuplicateSite(groupsRef.current, url, excludeId);
            if (!hit) {
                void run();
                return true;
            }
            setDupPrompt({ url: url || "", hit, run });
            return false;
        },
        [setDupPrompt, groupsRef]
    );

    // 更新站点：保存成功后直接用（本地这份 + 服务端回显）更新本地状态，界面即时生效，不再刷新页面
    const handleSiteUpdate = useCallback(
        async (siteInput: Site) => {
            // 网址规范化：不写协议时补 https://，javascript: 之类的伪协议直接挡掉
            // （编辑站点这条路径同样不走 type=url 校验，见 utils/url.ts 的说明）
            const urlCheck = normalizeUrl(siteInput.url || "");
            if (!urlCheck.ok) {
                handleError(normalizeFailureText(urlCheck.reason));
                return;
            }
            const updatedSite: Site = { ...siteInput, url: urlCheck.url };
            if (!updatedSite.id) return;

            const doUpdate = async () => {
                // 改之前先留一份快照，请求失败时用它把卡片改回去
                const snapshot =
                    groupsRef.current
                        .flatMap(group => group.sites)
                        .find(site => site.id === updatedSite.id) || null;

                // 乐观更新：不等网络往返就先改本地、弹提示，
                // 实测一次保存端到端 336ms 里有 311ms 是网络等待，没必要让界面陪着等
                upsertSiteLocally(updatedSite);
                notify("卡片已更新", "success");

                const siteId = updatedSite.id as number;

                try {
                    const saved = await api.updateSite(siteId, updatedSite);
                    // id 以本地这份为准，避免个别后端实现回显的 id 不准确
                    if (saved) {
                        upsertSiteLocally({ ...updatedSite, ...saved, id: updatedSite.id });
                    }

                    // 改卡片也能撤销：Ctrl+Z 或提示条上的「撤销」把它改回原样。
                    // 顺带记一份持久化描述 —— 这是少数「靠数据就能倒回去」的操作，
                    // 刷新之后照样能撤（删除不走这条，回收站已经兜住了）。
                    if (snapshot && snapshot.id !== undefined) {
                        const label = `修改「${snapshot.name || updatedSite.name || "该网站"}」`;
                        const writeBack = async (site: Site) => {
                            await api.updateSite(siteId, { ...site, id: siteId });
                            upsertSiteLocally({ ...site, id: siteId });
                        };
                        pushHistory({
                            label,
                            undo: () => writeBack(snapshot),
                            redo: () => writeBack(updatedSite),
                            persist: {
                                kind: "site-edit",
                                label,
                                at: Date.now(),
                                siteId,
                                before: snapshot,
                                after: updatedSite,
                            },
                        });
                    }
                } catch (error) {
                    reportError(error, { source: "site-update" });
                    if (snapshot) upsertSiteLocally(snapshot);
                    handleError("更新站点失败: " + (error as Error).message);
                }
            };

            // 改完链接后跟别张卡片撞了，也先确认一次再写库
            guardDuplicate(updatedSite.url, updatedSite.id, doUpdate);
        },
        [api, groupsRef, upsertSiteLocally, handleError, notify, guardDuplicate, pushHistory]
    );

    // 删除站点：删完给一条带「撤销」的提示，8 秒内点一下就能把卡片原样建回来。
    // 删除是软删除（先进回收站），撤销优先「从回收站精确还原」原 id；
    // 拿不到回收站 id（如本地 mock 模式）时退回「按快照重建」。
    const handleSiteDelete = useCallback(
        async (siteId: number) => {
            const snapshot = groupsRef.current
                .flatMap(group => group.sites)
                .find(site => site.id === siteId);
            // 本机标签/星标先留一份快照：删除时要清掉它们，撤销时再挂到新卡片上
            const snapshotTags = tags[String(siteId)] ?? [];
            const wasStarred = starred.includes(siteId);
            try {
                const del = await api.deleteSite(siteId);
                const recycleId = del.recycleId;
                removeSiteLocally(siteId);
                // 卡片没了，它的标签/星标也就没有宿主，一并清掉，避免标签栏残留点不出来的标签
                forgetSites([siteId]);
                if (!snapshot) return;

                // 恢复：优先从回收站精确还原（保留原 id，标签/星标按 id 自动归位）；
                // 没有回收站 id 时退回「按快照重建」老路径。
                const restored: { id?: number } = {};
                // 兜底：拿不到回收站条目时按快照重建一张（新 id，所以要重挂标签/星标）
                const restoreBySnapshot = async () => {
                    const created = await api.createSite({
                        ...snapshot,
                        id: undefined,
                    } as Site);
                    if (!created || created.id === undefined) throw new Error("重建站点失败");
                    upsertSiteLocally(created);
                    // 撤销是「原样恢复」，把标签与星标也挂回新 id 上
                    if (snapshotTags.length > 0) setSiteTags(created.id, snapshotTags);
                    if (wasStarred) setStarredMany([created.id], true);
                    restored.id = created.id;
                };
                const restore = async () => {
                    if (recycleId !== undefined) {
                        // 还原接口会把卡片本身带回来，直接插回界面即可 ——
                        // 不再整表重拉（那要把分组/站点/配置全拉一遍再重建界面，
                        // 站点一多就是肉眼可见的卡顿，撤销慢主要慢在这里）
                        const result = await api.restoreRecycleItems([recycleId]);
                        if (result.restored.length > 0) {
                            upsertSitesLocally(result.restored);
                            // 删除时清掉的标签/星标要按原 id 挂回去：还原保留原 id，
                            // 所以直接写回即可。以前靠全量重拉顺带捞回来，现在不重拉了，
                            // 不显式写回的话撤销后卡片回来了、标签却没了
                            if (snapshot.id !== undefined) {
                                if (snapshotTags.length > 0) setSiteTags(snapshot.id, snapshotTags);
                                if (wasStarred) setStarredMany([snapshot.id], true);
                            }
                            restored.id = snapshot.id;
                            return;
                        }
                        // 拿不回来（回收站里已被清掉）则退回「按快照重建」
                        await restoreBySnapshot();
                        return;
                    }
                    await restoreBySnapshot();
                };
                const removeAgain = async () => {
                    if (recycleId !== undefined) {
                        // 撤销后「再删一次」= 把回收站里那一条彻底删除（不可恢复）
                        await api.purgeRecycleItem(recycleId);
                        return;
                    }
                    if (restored.id === undefined) return;
                    const id = restored.id;
                    restored.id = undefined;
                    await api.deleteSite(id);
                    removeSiteLocally(id);
                    forgetSites([id]);
                };

                const label = `删除「${snapshot.name || "该网站"}」`;
                // 压进操作栈后，即使提示条已经消失，Ctrl+Z 还能把卡片找回来
                pushHistory({ label, undo: restore, redo: removeAgain });
                notify(`已删除「${snapshot.name || "该网站"}」（可在回收站恢复）`, "info", 8000, {
                    label: "撤销",
                    onClick: () => void runUndo(),
                });
            } catch (error) {
                reportError(error, { source: "site-delete" });
                handleError("删除站点失败: " + (error as Error).message);
            }
        },
        [
            api,
            groupsRef,
            removeSiteLocally,
            upsertSiteLocally,
            upsertSitesLocally,
            handleError,
            notify,
            tags,
            starred,
            forgetSites,
            setSiteTags,
            setStarredMany,
            pushHistory,
            runUndo,
        ]
    );

    // 批量删除站点（多选模式）：确认弹窗在底部操作条上（OverlayHost），确认后直接进这里。
    // 删除是软删除（先进回收站），撤销时优先从回收站精确还原。

    // 真正执行批量删除（确认后调用）
    const doSitesDelete = useCallback(
        async (siteIds: number[]) => {
            if (siteIds.length === 0) return;
            const snapshots = groupsRef.current
                .flatMap(group => group.sites)
                .filter(site => site.id !== undefined && siteIds.includes(site.id));

            if (snapshots.length === 0) return;

            // 本机标签/星标快照（按站点 id），删除时清掉、撤销时挂回新 id。
            // 计算本身在 utils/siteMutations.ts 的 snapshotSitePrefs（有单测）
            const prefsMap = snapshotSitePrefs(snapshots, tags, starred);

            const ids = snapshots.map(site => site.id as number);
            try {
                // 一次请求搬完：删 20 张卡过去是 20 次 HTTP 往返，点下去要等好几秒
                const result = await api.deleteSites(ids);
                const recycleIds = result.items
                    .map(item => item.recycleId)
                    .filter((x): x is number => x !== undefined);
                // 只有真进了回收站的才从界面上摘掉，没删成的留在原地（提示里会说清楚）
                // 判据见 utils/siteMutations.ts 的 pickDeletedIds（有单测）
                const deletedIds = pickDeletedIds(result.items);
                if (deletedIds.length === 0) {
                    handleError("一个都没删成功，请刷新后重试");
                    return;
                }
                removeSitesLocally(deletedIds);
                forgetSites(deletedIds);

                const restoredIds: number[] = [];
                // 兜底：拿不到回收站条目时按快照逐个重建（新 id，要重挂标签/星标）
                const restoreBySnapshot = async () => {
                    const ordered = [...snapshots].sort(
                        (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                    );
                    restoredIds.length = 0;
                    for (const site of ordered) {
                        const created = await api.createSite({
                            ...site,
                            id: undefined,
                        } as Site);
                        if (created && created.id !== undefined) {
                            upsertSiteLocally(created);
                            restoredIds.push(created.id);
                            const prefs = prefsMap.get(site.id as number);
                            if (prefs) {
                                if (prefs.tags.length > 0) setSiteTags(created.id, prefs.tags);
                                if (prefs.starred) setStarredMany([created.id], true);
                            }
                        }
                    }
                };
                const restore = async () => {
                    if (recycleIds.length > 0) {
                        // 一次请求还原，并把卡片本身带回来直接插回界面，
                        // 不再 bootstrap 全量重拉（撤销慢主要就慢在那一步）
                        const restored = await api.restoreRecycleItems(recycleIds);
                        if (restored.restored.length > 0) {
                            upsertSitesLocally(restored.restored);
                            // 还原保留原始 id，删除时清掉的标签/星标按原 id 挂回去即可
                            // （以前靠全量重拉顺带从服务端捞回来，现在不重拉了）
                            for (const item of describeRestoredPrefs(restored.restored, prefsMap)) {
                                if (item.tags.length > 0) setSiteTags(item.siteId, item.tags);
                                if (item.starred) setStarredMany([item.siteId], true);
                            }
                        }
                        // 有没还原成的，拉一次远端把界面和库对齐
                        if (restored.failed.length > 0) {
                            await fetchData({ silent: true });
                        }
                        return;
                    }
                    await restoreBySnapshot();
                };
                const removeAgain = async () => {
                    if (recycleIds.length > 0) {
                        await api.purgeRecycleItems(recycleIds);
                        return;
                    }
                    const pending = [...restoredIds];
                    restoredIds.length = 0;
                    if (pending.length === 0) return;
                    await Promise.all(pending.map(id => api.deleteSite(id)));
                    removeSitesLocally(pending);
                    forgetSites(pending);
                };

                const label = `删除 ${deletedIds.length} 个网站`;
                pushHistory({ label, undo: restore, redo: removeAgain });
                if (result.failed.length > 0) {
                    notify(
                        `已删除 ${deletedIds.length} 个网站，${result.failed.length} 个没删成`,
                        "error"
                    );
                } else {
                    notify(`已删除 ${deletedIds.length} 个网站（可在回收站恢复）`, "info", 8000, {
                        label: "撤销",
                        onClick: () => void runUndo(),
                    });
                }
            } catch (error) {
                reportError(error, { source: "site-bulk-delete" });
                handleError("批量删除站点失败: " + (error as Error).message);
            }
        },
        [
            api,
            groupsRef,
            removeSitesLocally,
            upsertSiteLocally,
            upsertSitesLocally,
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
        ]
    );
    return { guardDuplicate, handleSiteUpdate, handleSiteDelete, doSitesDelete };
}
