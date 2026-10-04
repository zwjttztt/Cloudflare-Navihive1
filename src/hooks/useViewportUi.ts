// src/hooks/useViewportUi.ts
// 跟「视口」有关的那一簇状态：头部收缩、当前分组高亮、以及挂在顶栏 / 底栏按钮上的
// 菜单锚点（含「锚点所在按钮被卸载时要把菜单收掉」的那一整套补救）。
//
// 从 App.tsx 搬过来 —— 这几条逻辑写错的后果都不是报错，而是「窗口从窄拉宽之后
// 菜单飘到左上角」这种只有手点才能发现的问题：resize 时 anchor 已经从 DOM 分离，
// MUI 下次重定位拿到全零坐标。搬出来之后可以用 jsdom 造一个 detached 的锚点，
// 把 resize 守卫和两个 handleExit 各自「只收挂在自己那颗按钮上的那份」钉住。

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/** 判定「当前分组」的视口高度线：越过这条线的最后一个分组算当前分组 */
const ACTIVE_GROUP_LINE = 160;
/** 头部收紧的门槛：往下滚、离顶超过这么多像素、且比上一次又往下了才算 */
const HEADER_COMPACT_THRESHOLD = 90;

export interface ViewportUiParams {
    /** 数据还在加载：加载完才有分组锚点可算，要重跑一次 */
    loading: boolean;
    /** 分组数量变了（新增 / 删除 / 合并）也要重跑 */
    groupCount: number;
}

export interface ViewportUiState {
    /** 「更多」菜单的锚点 */
    menuAnchorEl: HTMLElement | null;
    setMenuAnchorEl: Dispatch<SetStateAction<HTMLElement | null>>;
    openMenu: boolean;
    /** 当前视口里的分组（左栏高亮 / 「新增」按钮的目标分组都看它） */
    activeGroupId: number | null;
    /** 向下滚动后头部收紧 */
    headerCompact: boolean;
    /** 「分组」菜单的锚点（底栏与窄桌面顶栏共用同一个菜单） */
    mobileGroupsAnchor: HTMLElement | null;
    setMobileGroupsAnchor: Dispatch<SetStateAction<HTMLElement | null>>;
    /** 锚点来自顶栏还是底栏：顶栏往下展开，底栏只能往上翻 */
    groupsAnchorFromTop: boolean;
    setGroupsAnchorFromTop: Dispatch<SetStateAction<boolean>>;
    handleMenuOpen: (event: { currentTarget: HTMLElement }) => void;
    handleMenuClose: () => void;
    /** 底栏退场（视口宽过 899.98px）时由底栏自己通知 */
    handleExitMobileViewport: () => void;
    /** 顶栏「分组」按钮退场（视口离开 900~1343.98px）时由它自己通知 */
    handleExitGroupsButtonViewport: () => void;
}

/** 菜单是不是挂在底栏那颗按钮上（两个 handleExit 靠它区分各自该收哪一份） */
const onMobileTabBar = (el: HTMLElement | null): boolean =>
    !!el && !!el.closest(".nav-mobile-tabbar");

export function useViewportUi({ loading, groupCount }: ViewportUiParams): ViewportUiState {
    const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
    const [activeGroupId, setActiveGroupId] = useState<number | null>(null);
    const [headerCompact, setHeaderCompact] = useState(false);
    const [mobileGroupsAnchor, setMobileGroupsAnchor] = useState<HTMLElement | null>(null);
    const [groupsAnchorFromTop, setGroupsAnchorFromTop] = useState(false);

    // 滚动：更新头部收缩状态 + 当前分组高亮
    useEffect(() => {
        let raf = 0;
        let lastY = window.scrollY;

        const update = () => {
            raf = 0;
            const y = window.scrollY;
            // 往下滚且已经离开顶部一段距离才收紧，避免刚滚一点就跳
            setHeaderCompact(y > HEADER_COMPACT_THRESHOLD && y > lastY + 2);
            lastY = y;

            const nodes = document.querySelectorAll<HTMLElement>("[data-group-anchor]");
            if (nodes.length === 0) return;
            let current: number | null = null;
            nodes.forEach(node => {
                const rect = node.getBoundingClientRect();
                if (rect.top <= ACTIVE_GROUP_LINE) {
                    current = Number(node.dataset.groupAnchor);
                }
            });
            if (current === null) {
                const first = nodes[0];
                if (first) current = Number(first.dataset.groupAnchor);
            }
            setActiveGroupId(current);
        };

        const onScroll = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(update);
        };

        window.addEventListener("scroll", onScroll, { passive: true });
        update();
        return () => {
            window.removeEventListener("scroll", onScroll);
            if (raf) window.cancelAnimationFrame(raf);
        };
    }, [loading, groupCount]);

    // 窗口尺寸变化会让底栏跨过 1344px 断点整个卸载（MobileTabBar 直接 return null），
    // 正开着的菜单 anchor 随之从 DOM 分离 —— MUI 下次重定位拿到全零坐标，
    // 菜单就飘到左上角（用户从窄窗口最大化时就撞到过）。resize 时凡是 anchor
    // 已经不在文档里的弹层一律收掉；底栏退场时自己也会通知一声（onExitViewport），
    // 因为 resize 事件跑在 React 卸载底栏之前，单靠这边可能晚一步。
    useEffect(() => {
        const onResize = () => {
            setMenuAnchorEl(prev => (prev && !prev.isConnected ? null : prev));
            setMobileGroupsAnchor(prev => (prev && !prev.isConnected ? null : prev));
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const handleMenuOpen = useCallback((event: { currentTarget: HTMLElement }) => {
        setMenuAnchorEl(event.currentTarget);
    }, []);

    // 包成 useCallback：它进了很多 useMemo / useCallback 的依赖，
    // 每次渲染换一个引用会让那些记忆化全部失效
    const handleMenuClose = useCallback(() => {
        setMenuAnchorEl(null);
    }, []);

    // 底栏退场（视口宽过 899.98px）：只收掉挂在底栏按钮上的弹层，顶栏自己的别误伤
    const handleExitMobileViewport = useCallback(() => {
        setMenuAnchorEl(prev => (onMobileTabBar(prev) ? null : prev));
        setMobileGroupsAnchor(prev => (onMobileTabBar(prev) ? null : prev));
    }, []);

    // 顶栏「分组」按钮退场（视口离开 900~1343.98px）：这颗按钮只在那一档渲染，
    // 菜单挂在它上面，按钮一卸载 anchor 就失效（MUI 会让菜单飘到左上角），
    // 所以这里只收挂在这颗按钮上的那份，底栏那份归 handleExitMobileViewport 管。
    const handleExitGroupsButtonViewport = useCallback(() => {
        setMobileGroupsAnchor(prev => (onMobileTabBar(prev) ? prev : null));
    }, []);

    return {
        menuAnchorEl,
        setMenuAnchorEl,
        openMenu: Boolean(menuAnchorEl),
        activeGroupId,
        headerCompact,
        mobileGroupsAnchor,
        setMobileGroupsAnchor,
        groupsAnchorFromTop,
        setGroupsAnchorFromTop,
        handleMenuOpen,
        handleMenuClose,
        handleExitMobileViewport,
        handleExitGroupsButtonViewport,
    };
}
