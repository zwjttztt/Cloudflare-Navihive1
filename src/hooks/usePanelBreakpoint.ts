// src/hooks/usePanelBreakpoint.ts
// 记事本三栏的断点（照 inkstone 的 `useBreakpoint`，src/client/lib/hooks.ts:20）。
//
// 为什么必须有这个（2026-10-07 用户报「右边内容超出不可见」的根因）：
// 三栏是**写死的像素宽**（导航 128 + 列表 208），而之前完全没有断点，
// 只有一处 `md:`（MUI 默认 900px）在切「列表/编辑」两屏。问题出在：
// 浏览器缩放 125% 时，1080px 的窗口在 CSS 里只剩 864px —— 跨过 900px 那条线，
// 于是编辑区被挤成 **0 宽**（真机量到 edW=0），工具栏、正文、状态栏全部消失。
// 用户看到的正是「右边内容超出不可见」。
//
// inkstone 的规则（照抄，别自己另定一套）：
//   ≥1180  desktop  三栏全展开
//   ≥768   tablet   收掉导航列（列表 + 编辑区两栏）
//   <768   mobile   列表 / 编辑 两屏切换
//
// ⚠️ 断点值必须写成**数字**再喂给 matchMedia，不能写死 CSS 字符串：
// MUI 的 `md` 是 900，跟这里的两条线（1180/768）都不是一回事，三套并存必然打架。
// 而且要用 useSyncExternalStore 订阅，不能只在挂载时读一次 ——
// 用户拖窗口 / 改缩放时窗口宽度会变，不订阅的话布局永远停在打开那一刻的宽度。
import { useSyncExternalStore } from "react";

/** 与 inkstone 一致的两条线 */
export const BP_DESKTOP = 1180;
export const BP_TABLET = 768;

export type PanelBreakpoint = "mobile" | "tablet" | "desktop";

function current(): PanelBreakpoint {
    if (typeof window === "undefined") return "desktop";
    const w = window.innerWidth;
    if (w >= BP_DESKTOP) return "desktop";
    if (w >= BP_TABLET) return "tablet";
    return "mobile";
}

function subscribe(cb: () => void): () => void {
    window.addEventListener("resize", cb);
    // 移动端地址栏收放会改 innerHeight，但也会改 innerWidth；
    // orientationchange 一起监听，旋转屏幕时立刻重算而不是等下一次 resize。
    window.addEventListener("orientationchange", cb);
    return () => {
        window.removeEventListener("resize", cb);
        window.removeEventListener("orientationchange", cb);
    };
}

/** 当前断点。SSR/首帧返回 desktop（宁可宽一点，也不要先闪一下两屏布局）。 */
export function usePanelBreakpoint(): PanelBreakpoint {
    return useSyncExternalStore(subscribe, current, () => "desktop");
}
