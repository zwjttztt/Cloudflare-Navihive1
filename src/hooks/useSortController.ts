// src/hooks/useSortController.ts
// 「分组 / 站点排序 + 拖拽」这一个域：从 App.tsx 里整块搬过来的。
// 拆出来的理由和其它域一样 —— App 已经 4000+ 行，而这一块自己有完整闭环：
// 进入排序模式 → 拖拽改本地顺序 → 保存时把顺序（+跨组移动）合成一次请求。
//
// 分工：真正的排列计算在 src/utils/sortable.ts（纯函数，有单测），
// 这里只负责状态、事件回调和「发请求 + 报错 + 本地补齐」这类副作用。
import { useCallback, useRef, useState } from "react";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { SortMode } from "../constants";
import {
    buildSiteOrderPayload,
    moveGroupByDrag,
    moveGroupByStep,
    moveSiteAcrossGroups as moveSiteInGroups,
    type SiteOrderItem,
} from "../utils/sortable";
import { reportError } from "../utils/errorReporter";
import type { GroupWithSites } from "../types";
import type { Site } from "../API/http";

/** 只声明本域用到的两个接口，方便单测里塞一个假 api */
export type SortApi = {
    updateGroupOrder(orders: { id: number; order_num: number }[]): Promise<unknown>;
    updateSiteOrder(
        orders: SiteOrderItem[]
    ): Promise<{ success: boolean; failed: number[]; updated?: number[] }>;
};

type UseSortControllerParams = {
    api: SortApi;
    /** groups 的最新值（ref）：拖拽回调要读它，但不能因为它变化而重建回调 */
    groupsRef: { current: GroupWithSites[] };
    setGroups: (updater: (prev: GroupWithSites[]) => GroupWithSites[]) => void;
    /** 统一的错误提示（App 里是 notify + reportError） */
    onError: (message: string) => void;
    /** 进入排序模式前要先关掉「更多选项」菜单，否则菜单会失去锚点跑到左上角 */
    onMenuClose: () => void;
};

export function useSortController({
    api,
    groupsRef,
    setGroups,
    onError,
    onMenuClose,
}: UseSortControllerParams) {
    const [sortMode, setSortMode] = useState<SortMode>(SortMode.None);
    const [currentSortingGroupId, setCurrentSortingGroupId] = useState<number | null>(null);
    // 进入站点排序时记录每个站点所属的原始分组，用于保存时识别跨组移动
    const siteOriginalGroupRef = useRef<Map<number, number>>(new Map());

    // 保存分组排序
    const handleSaveGroupOrder = async () => {
        try {
            const groupOrders = groupsRef.current.map((group, index) => ({
                id: group.id as number,
                order_num: index,
            }));

            const result = await api.updateGroupOrder(groupOrders);

            if (!result) {
                throw new Error("分组排序更新失败");
            }

            // 本地顺序就是拖拽后的结果，补一下 order_num 即可，不再多发一次全量刷新请求
            setGroups(prev => prev.map((group, index) => ({ ...group, order_num: index })));

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("更新分组排序失败:", error);
            reportError(error, { source: "group-reorder" });
            onError("更新分组排序失败: " + (error as Error).message);
        }
    };

    // 保存站点排序（单组保存）
    const handleSaveSiteOrder = useCallback(
        async (groupId: number, sites: Site[]) => {
            try {
                const siteOrders = sites.map((site, index) => ({
                    id: site.id as number,
                    order_num: index,
                }));

                const result = await api.updateSiteOrder(siteOrders);

                if (!result.success) {
                    throw new Error(
                        result.failed.length > 0
                            ? `站点排序更新失败（${result.failed.length} 个未生效，刷新后重试）`
                            : "站点排序更新失败"
                    );
                }

                // 本地即服务端结果，补齐 order_num；只重建这一个分组，其它分组保持原引用
                const orderMap = new Map(siteOrders.map(item => [item.id, item.order_num]));
                setGroups(prev => {
                    const idx = prev.findIndex(g => g.id === groupId);
                    if (idx === -1) return prev;
                    const next = [...prev];
                    next[idx] = {
                        ...prev[idx],
                        sites: prev[idx].sites
                            .map(site => {
                                const order = orderMap.get(site.id as number);
                                return order === undefined ? site : { ...site, order_num: order };
                            })
                            .sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)),
                    };
                    return next;
                });

                setSortMode(SortMode.None);
                setCurrentSortingGroupId(null);
            } catch (error) {
                console.error("更新站点排序失败:", error);
                reportError(error, { source: "site-reorder" });
                onError("更新站点排序失败: " + (error as Error).message);
            }
        },
        [api, onError, setGroups]
    );

    // 启动分组排序
    const startGroupSort = useCallback(() => {
        onMenuClose();
        setSortMode(SortMode.GroupSort);
        setCurrentSortingGroupId(null);
    }, [onMenuClose]);

    // 启动站点排序
    const startSiteSort = useCallback((groupId: number) => {
        setSortMode(SortMode.SiteSort);
        setCurrentSortingGroupId(groupId);
        // 记录每个站点当前的原始分组，用于保存时识别跨组移动
        const map = new Map<number, number>();
        groupsRef.current.forEach(g => {
            g.sites.forEach(s => {
                if (s.id !== undefined) map.set(s.id, g.id as number);
            });
        });
        siteOriginalGroupRef.current = map;
    }, [groupsRef]);

    // 取消排序
    const cancelSort = useCallback(() => {
        setSortMode(SortMode.None);
        setCurrentSortingGroupId(null);
    }, []);

    // 处理分组拖拽结束事件
    const handleDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            setGroups(prev => moveGroupByDrag(prev, String(active.id), String(over.id)));
        },
        [setGroups]
    );

    // 拖拽替代：分组「上移 / 下移一位」。给读屏、键盘、触屏误触用户一条不靠拖拽的路
    const nudgeGroup = useCallback(
        (groupId: string, delta: number) => {
            setGroups(prev => moveGroupByStep(prev, groupId, delta));
        },
        [setGroups]
    );

    // 站点跨分组拖拽：排列计算在 utils/sortable（有单测），这里只负责写回状态
    const moveSite = useCallback(
        (activeId: string, overId: string) => {
            setGroups(prev => moveSiteInGroups(prev, activeId, overId));
        },
        [setGroups]
    );

    const handleSiteSortDragOver = useCallback(
        (event: DragOverEvent) => {
            const { active, over } = event;
            if (!over) return;
            moveSite(String(active.id), String(over.id));
        },
        [moveSite]
    );

    const handleSiteSortDragEnd = useCallback(
        (event: DragEndEvent) => {
            const { active, over } = event;
            if (!over) return;
            moveSite(String(active.id), String(over.id));
        },
        [moveSite]
    );

    // 拖拽视觉反馈：被拖起的卡片用浮层跟着指针走，原位留半透明占位
    const [draggingSite, setDraggingSite] = useState<Site | null>(null);
    const handleSiteDragStart = useCallback((event: DragStartEvent) => {
        const id = String(event.active.id);
        if (!id.startsWith("site-")) return;
        const siteId = Number(id.slice(5));
        const found = groupsRef.current.flatMap(g => g.sites).find(s => s.id === siteId);
        setDraggingSite(found ?? null);
    }, [groupsRef]);
    const handleSiteDragCancel = useCallback(() => setDraggingSite(null), []);

    // 保存站点排序（支持跨分组移动）
    // 顺序调整 + 跨组移动合并成「一次」批量请求：
    // 原来是「1 次排序 + 每移动一张卡片一次串行更新请求」，卡片多时保存会明显变慢。
    const handleSaveSiteSort = useCallback(async () => {
        try {
            const orders = buildSiteOrderPayload(groupsRef.current, siteOriginalGroupRef.current);

            if (orders.length > 0) {
                const result = await api.updateSiteOrder(orders);
                if (!result.success) {
                    throw new Error(
                        result.failed.length > 0
                            ? `更新排序失败（${result.failed.length} 个未生效，刷新后重试）`
                            : "更新排序失败"
                    );
                }
            }

            // 本地补齐 order_num / group_id，与服务端保持一致，无需再拉一次全量数据
            const orderMap = new Map(orders.map(item => [item.id, item]));
            setGroups(prev =>
                prev.map(g => ({
                    ...g,
                    sites: g.sites.map(site => {
                        const item = orderMap.get(site.id as number);
                        if (!item) return site;
                        return { ...site, order_num: item.order_num, group_id: g.id as number };
                    }),
                }))
            );

            setSortMode(SortMode.None);
            setCurrentSortingGroupId(null);
        } catch (error) {
            console.error("保存站点排序失败:", error);
            reportError(error, { source: "site-order-save" });
            onError("保存站点排序失败: " + (error as Error).message);
        }
    }, [api, groupsRef, onError, setGroups]);

    return {
        sortMode,
        currentSortingGroupId,
        draggingSite,
        startGroupSort,
        startSiteSort,
        cancelSort,
        handleDragEnd,
        nudgeGroup,
        handleSiteSortDragOver,
        handleSiteSortDragEnd,
        handleSiteDragStart,
        handleSiteDragCancel,
        handleSaveGroupOrder,
        handleSaveSiteOrder,
        handleSaveSiteSort,
    };
}
