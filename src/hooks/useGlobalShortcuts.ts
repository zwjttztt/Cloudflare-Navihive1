// src/hooks/useGlobalShortcuts.ts
// 全局键盘编排：「/」聚焦搜索框、Ctrl / Cmd+Z 撤销、Ctrl+Shift+Z（或 Ctrl+Y）重做、
// 搜索框内 ↑↓ 选结果 / Enter 打开 / Esc 清空、「?」打开快捷键说明表、1~9 打开第 N 条、
// 方向键在卡片之间移动焦点；顺带管着「点搜索面板以外的地方就收起面板」。
//
// 从 App.tsx 搬过来 —— 那 100 多行里藏着 6 条守卫（正在输入时不拦、有弹窗 / 菜单开着时不拦、
// 搜索态下 1~9 优先开搜索结果……），改坏一条不会报错，只会变成「在设置弹窗里按个 1
// 就把某个网站打开了」这种事后很难复现的问题。搬出来之后可以用 jsdom 直接派键盘事件，
// 把这些守卫一条条钉住（在 App 里做这件事要起整棵 React 树，做不到）。

import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Site } from "../API/http";
import type { SearchResult } from "../components/HeaderSearchBox";
import type { FocusDirection } from "../utils/cardFocus";

export interface GlobalShortcutsEnv {
    /** 顶栏搜索框（「/」聚焦、框内 ↑↓ / Enter / Esc 都靠它） */
    searchInputRef: RefObject<HTMLInputElement | null>;
    /** 搜索结果面板 */
    searchPanelRef: RefObject<HTMLDivElement | null>;
    /** 搜索框所在的容器：点在它里面不算「点到外面」 */
    searchAnchor: HTMLDivElement | null;
    searchQuery: string;
    setSearchQuery: Dispatch<SetStateAction<string>>;
    setSearchFocused: Dispatch<SetStateAction<boolean>>;
    /** 搜索结果（有序）：↑↓ 与 1~9 都在这份列表上跳 */
    flatResults: SearchResult[];
    activeResult: number;
    setActiveResult: Dispatch<SetStateAction<number>>;
    /** 打开一张卡片（会记搜索历史） */
    openResult: (site: Site) => void;
    /** 当前分组的卡片：没搜索时 1~9 打开的是这份 */
    currentGroupSites: Site[];
    runUndo: () => void;
    runRedo: () => void;
    /** 「?」打开快捷键说明表（这里是普通 setter，不是 setState 的 Dispatch） */
    setOpenShortcuts: (value: boolean) => void;
    /** Ctrl / Cmd + K 打开命令面板（输入框里也照开，那是全局命令） */
    setCommandOpen: (value: boolean) => void;
    /** 方向键在卡片网格里移动焦点 */
    focusCardByDirection: (dir: FocusDirection) => void;
}

/** 正在输入的时候，除了 Escape 之外一律不抢键 */
function isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== "string") return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable === true;
}

/** 有弹窗 / 菜单 / 浮层开着：这些「直接动手」的快捷键一律不响应 */
function hasOverlayOpen(): boolean {
    return !!document.querySelector(".MuiModal-root, .MuiMenu-root, .MuiPopover-root");
}

/**
 * 装上全局监听。没有返回值 —— 键盘是纯副作用，JSX 那边不需要任何东西。
 * （mousedown 那条也放在这里：它和快捷键共用同一组 anchor / panel ref，
 * 拆开反而要把三个 ref 传两份。）
 */
export function useGlobalShortcuts(env: GlobalShortcutsEnv): void {
    const {
        searchInputRef,
        searchPanelRef,
        searchAnchor,
        searchQuery,
        setSearchQuery,
        setSearchFocused,
        flatResults,
        activeResult,
        setActiveResult,
        openResult,
        currentGroupSites,
        runUndo,
        runRedo,
        setOpenShortcuts,
        setCommandOpen,
        focusCardByDirection,
    } = env;

    // openResult / focusCardByDirection 每次渲染都是新函数，进 deps 会让键盘监听
    // 每渲染拆装一次；用 ref 拿最新的一份（和 App 里 fetchDataRef 同一个套路）。
    const openResultRef = useRef(openResult);
    const focusCardRef = useRef(focusCardByDirection);
    useEffect(() => {
        openResultRef.current = openResult;
        focusCardRef.current = focusCardByDirection;
    });

    // Ctrl / Cmd + K 打开命令面板（输入框里也照开：它是全局命令，不是编辑快捷键）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setCommandOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [setCommandOpen]);

    // 点击搜索框与结果面板以外的地方才收起面板。
    // （不用 onBlur：点结果项时 mousedown 会先让输入框失焦，面板还没等到 click 就卸载了）
    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target) return;
            if (searchAnchor && searchAnchor.contains(target)) return;
            if (searchPanelRef.current && searchPanelRef.current.contains(target)) return;
            setSearchFocused(false);
        };

        document.addEventListener("mousedown", onMouseDown);
        return () => document.removeEventListener("mousedown", onMouseDown);
    }, [searchAnchor, searchPanelRef, setSearchFocused]);

    // 「/」快速聚焦搜索框、方向键导航、搜索框内的上下键与回车
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const isTyping = isTypingTarget(target);

            if (e.key === "/" && !isTyping) {
                e.preventDefault();
                searchInputRef.current?.focus();
                return;
            }

            // Ctrl / Cmd + Z 撤销、Ctrl+Shift+Z（或 Ctrl+Y）重做。
            // 正在输入时不能拦：输入框里的 Ctrl+Z 是「撤销我刚打的字」，那是浏览器自己的事。
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isTyping) {
                e.preventDefault();
                if (e.shiftKey) void runRedo();
                else void runUndo();
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y" && !isTyping) {
                e.preventDefault();
                void runRedo();
                return;
            }

            // 搜索框内：↑↓ 选结果，Enter 打开，Esc 清空
            if (target === searchInputRef.current) {
                if (e.key === "ArrowDown" && flatResults.length > 0) {
                    e.preventDefault();
                    setActiveResult(prev => (prev + 1) % flatResults.length);
                    return;
                }
                if (e.key === "ArrowUp" && flatResults.length > 0) {
                    e.preventDefault();
                    setActiveResult(prev =>
                        prev <= 0 ? flatResults.length - 1 : prev - 1
                    );
                    return;
                }
                if (e.key === "Enter" && flatResults.length > 0) {
                    e.preventDefault();
                    const picked = flatResults[activeResult] || flatResults[0];
                    if (picked) openResultRef.current(picked.site);
                    return;
                }
                if (e.key === "Escape") {
                    setSearchQuery("");
                    setSearchFocused(false);
                    searchInputRef.current?.blur();
                    return;
                }
                return;
            }

            // 其它位置：方向键在卡片之间移动焦点
            if (isTyping) return;

            // 有弹窗 / 菜单开着的时候，下面这些「直接动手」的快捷键一律不响应，
            // 免得在设置弹窗里按个 1 就把某个网站打开了
            const overlayOpen = hasOverlayOpen();

            // ? 打开快捷键说明表（Shift + /）
            if (e.key === "?" && !overlayOpen && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                setOpenShortcuts(true);
                return;
            }

            // 1~9：搜索状态下打开第 N 条结果，否则打开当前分组第 N 张卡片。
            // 这是最省事的一条路 —— 不用先把鼠标挪过去，敲个数字就跳走了
            if (!overlayOpen && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
                const index = Number(e.key) - 1;
                if (searchQuery.trim() && flatResults.length > 0) {
                    const picked = flatResults[index];
                    if (picked) {
                        e.preventDefault();
                        openResultRef.current(picked.site);
                    }
                    return;
                }
                const picked = currentGroupSites[index];
                if (picked) {
                    e.preventDefault();
                    openResultRef.current(picked);
                }
                return;
            }

            if (e.key === "ArrowRight") {
                focusCardRef.current("right");
                e.preventDefault();
            } else if (e.key === "ArrowLeft") {
                focusCardRef.current("left");
                e.preventDefault();
            } else if (e.key === "ArrowDown") {
                focusCardRef.current("down");
                e.preventDefault();
            } else if (e.key === "ArrowUp") {
                focusCardRef.current("up");
                e.preventDefault();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        flatResults,
        activeResult,
        runUndo,
        runRedo,
        searchQuery,
        currentGroupSites,
        setOpenShortcuts,
        searchInputRef,
        setActiveResult,
        setSearchFocused,
        setSearchQuery,
    ]);
}
