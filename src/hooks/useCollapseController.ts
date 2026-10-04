// src/hooks/useCollapseController.ts
// 分组折叠的整套状态：本机存储 + 跨标签页同步 + 「全部折叠」开关。
//
// 原来内联在 App 里（realGroups / collapsedIds / 那两个事件监听 / toggleCollapseAll）。
// 纯读写与「是否全折叠」的判断本来就在 utils/collapse.ts，这里只做 React 那层胶水。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    COLLAPSED_EVENT,
    isAllCollapsed,
    readCollapsedGroupIds,
    setAllCollapsed,
} from "../utils/collapse";
import { resetCollapsedState } from "../utils/sessionBoundary";

export function useCollapseController(
    groups: { id?: number | string }[] | null | undefined
) {
    // 只有真的存进库的分组才有折叠状态（刚新建还没保存的临时分组 id 是 undefined）。
    // 用类型谓词而不是普通 filter：过滤完 id 就是 number，「全部折叠」那句 map 才
    // 不会推导出 undefined 混在里面。
    const realGroups = useMemo(
        () =>
            (groups || []).filter(
                (g): g is { id: number } => typeof g.id === "number" && g.id > 0
            ),
        [groups]
    );

    // 收起状态存在 localStorage（和 GroupCard 共用），这里再跟一份 state：
    // 左侧分组栏的开关要能立刻换成「展开全部」，所以必须随事件同步，不能只现算
    const [collapsedIds, setCollapsedIds] = useState<string[]>(() =>
        readCollapsedGroupIds()
    );

    useEffect(() => {
        const sync = () => setCollapsedIds(readCollapsedGroupIds());
        // 本页写入走自定义事件，其他标签页写入走 storage
        window.addEventListener(COLLAPSED_EVENT, sync);
        window.addEventListener("storage", sync);
        return () => {
            window.removeEventListener(COLLAPSED_EVENT, sync);
            window.removeEventListener("storage", sync);
        };
    }, []);

    const allGroupsCollapsed = isAllCollapsed(realGroups, collapsedIds);

    const toggleCollapseAll = useCallback(() => {
        const next = !allGroupsCollapsed; // true = 折叠全部
        setAllCollapsed(
            realGroups.map(g => g.id),
            next
        );
        // 折叠 / 展开是即时可见的操作，不再弹提示打扰
    }, [allGroupsCollapsed, realGroups]);

    /**
     * 换账号 / 退出登录时清空。折叠是「当前状态」而不是累计量，不该跨账号带过去。
     * 由 App 那边用 ref 转交出去 —— 折叠表的声明位置比退出 / 换账号的逻辑晚，
     * 直接引用会引用不到（这也是它为什么是个 ref）。
     */
    const resetCollapsed = useMemo(
        () => resetCollapsedState(setCollapsedIds),
        [setCollapsedIds]
    );

    return {
        collapsedIds,
        setCollapsedIds,
        allGroupsCollapsed,
        toggleCollapseAll,
        resetCollapsed,
    };
}
