// src/hooks/useBulkActions.ts
// 多选模式下的那一排批量动作：加星、打标签、删标签、移动、删除。
//
// 从 App.tsx 搬过来的纯搬迁，行为一个字没改 —— App 已经四千多行，这组动作彼此
// 只通过「勾选了哪些卡片」发生关系，跟首屏渲染、设置弹窗那些没有耦合，单独放一处
// 更好读。搬动时守两条：参数只从外面传进来、回调名字一个都别改。
import { useCallback } from "react";
import type { MutableRefObject, Dispatch, SetStateAction } from "react";
import type { SiteOrderUpdateResult } from "../API/http";
import type { GroupWithSites } from "../types";
import { reportError } from "../utils/errorReporter";
import {
    applyBulkMoveToGroups,
    pickSitesWithTag,
    planBulkMoveOrders,
    renumberMoved,
} from "../utils/bulkOps";

/** 只用到一个方法的窄接口：不必把整个 client 类型拖进来 */
interface SiteOrderApi {
    updateSiteOrder(
        orders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<SiteOrderUpdateResult>;
}

type NotifyFn = (
    text: string,
    level?: "success" | "error" | "info",
    ms?: number,
    act?: { label: string; onClick: () => void }
) => void;

export interface BulkActionsParams {
    /** 当前勾选的卡片 id */
    selectedIds: number[];
    clearSelection: () => void;
    /** 分组的即时快照：批量移动要按它算目标分组里现有的排序号 */
    groupsRef: MutableRefObject<GroupWithSites[]>;
    tags: Record<string, string[]>;
    api: SiteOrderApi;
    setGroups: Dispatch<SetStateAction<GroupWithSites[]>>;
    setActiveTags: Dispatch<SetStateAction<string[]>>;
    setStarredMany: (ids: number[], starred: boolean) => void;
    addTagsToMany: (ids: number[], tags: string[]) => void;
    removeTagFromAll: (tag: string) => void;
    setBulkDeleteOpen: (open: boolean) => void;
    doSitesDelete: (ids: number[]) => Promise<void>;
    notify: NotifyFn;
    handleError: (message: string) => void;
}

export function useBulkActions(params: BulkActionsParams) {
    const {
        selectedIds,
        clearSelection,
        groupsRef,
        tags,
        api,
        setGroups,
        setActiveTags,
        setStarredMany,
        addTagsToMany,
        removeTagFromAll,
        setBulkDeleteOpen,
        doSitesDelete,
        notify,
        handleError,
    } = params;

    // 加星 / 取消加星：只改本机偏好，不碰数据库，改完立刻可见。
    // 批量操作后保留勾选，方便接着做下一个动作，收尾交给底部「完成」按钮。
    const bulkStar = useCallback(
        (next: boolean) => {
            if (selectedIds.length === 0) return;
            setStarredMany(selectedIds, next);
            notify(
                next
                    ? `已给 ${selectedIds.length} 个网站加星标`
                    : `已取消 ${selectedIds.length} 个网站的星标`,
                "success"
            );
        },
        [selectedIds, setStarredMany, notify]
    );

    // 批量打标签：追加式，不会覆盖已有标签，同样保留勾选
    const bulkTag = useCallback(
        (next: string[]) => {
            if (selectedIds.length === 0) return;
            addTagsToMany(selectedIds, next);
            notify(`已给 ${selectedIds.length} 个网站加上标签：${next.join("、")}`, "success");
        },
        [selectedIds, addTagsToMany, notify]
    );

    // 标签管理：删除一个标签 = 从所有卡片上摘掉它，并给一次撤销机会
    const deleteTagWithUndo = useCallback(
        (tag: string) => {
            const affected = pickSitesWithTag(tags, tag);
            if (affected.length === 0) return;

            removeTagFromAll(tag);
            // 这个标签正在被筛选时，顺手把筛选条件也去掉，免得筛出一片空白
            setActiveTags(prev => prev.filter(t => t !== tag));

            notify(`已删除标签「${tag}」（${affected.length} 个网站）`, "info", 8000, {
                label: "撤销",
                onClick: () => {
                    addTagsToMany(affected, [tag]);
                    notify(`已恢复标签「${tag}」`, "success");
                },
            });
        },
        [tags, removeTagFromAll, addTagsToMany, setActiveTags, notify]
    );

    // 批量移动到分组：一次批量请求改 group_id + order_num，本地同步搬运卡片
    const bulkMove = useCallback(
        async (groupId: number) => {
            if (selectedIds.length === 0) return;
            const target = groupsRef.current.find(group => group.id === groupId);
            if (!target) return;

            const orders = planBulkMoveOrders(selectedIds, target.sites, groupId);

            try {
                const result = await api.updateSiteOrder(orders);
                if (result.updated.length === 0) {
                    throw new Error(
                        result.failed.length > 0
                            ? `一个都没移动成功（${result.failed.length} 个未生效）`
                            : "服务端移动失败"
                    );
                }

                // 只有真正写进去的那些才在界面上搬家。D1 没有跨语句事务，
                // 一批里失败几条是真实存在的 —— 照全量更新会变成「库里没动、界面先动了」，
                // 用户刷新一下才发现少了一半，还不如当场说清楚。
                // 只有真正写进去的那些才在界面上搬家（见 utils/bulkOps 的说明）
                const movedOrder = renumberMoved(orders, result.updated);
                setGroups(prev => applyBulkMoveToGroups(prev, movedOrder, groupId));

                // 移动后也保留勾选：卡片已经搬到新分组，选中态跟着走
                if (result.failed.length > 0) {
                    notify(
                        `已移动 ${result.updated.length} 个到「${target.name}」，${result.failed.length} 个没成功（刷新后重试）`,
                        "error"
                    );
                } else {
                    notify(`已移动 ${orders.length} 个网站到「${target.name}」`, "success");
                }
            } catch (error) {
                reportError(error, { source: "site-bulk-move" });
                handleError("批量移动站点失败: " + (error as Error).message);
            }
        },
        [selectedIds, groupsRef, api, setGroups, notify, handleError]
    );

    // 批量删除：底部操作条上那个确认框就是唯一一道确认，确认后直接执行。
    // 早年这里走的是 handleSitesDelete —— 它只负责再弹一个 ConfirmDialog，
    // 于是「点删除 → 确认 → 又弹一个删除确认」，第二道框不点的话删除根本不发生
    // （界面上看不出还卡着一道确认，像是按钮失灵）。现在直接进 doSitesDelete。
    const bulkDelete = useCallback(async () => {
        const ids = [...selectedIds];
        setBulkDeleteOpen(false);
        clearSelection();
        await doSitesDelete(ids);
    }, [selectedIds, doSitesDelete, clearSelection, setBulkDeleteOpen]);

    return { bulkStar, bulkTag, deleteTagWithUndo, bulkMove, bulkDelete };
}
