// 设备输入能力：触屏设备上没有「悬停」这回事，靠 hover 浮出的按钮等于永远点不到，
// 所以卡片浮层（快捷条 / 设置 / 未加星）要在触屏上常显。
//
// 为什么不用纯 CSS 的 `@media (hover: none)`：
// 无头浏览器和没有输入设备的容器里，Chrome 会把 hover 媒体特性报成 none（CI 上踩过），
// 于是桌面端也被当成触屏 —— 浮层常显，冒烟里「鼠标不在卡片上时浮层是隐形的」直接挂。
// 这里要求两条同时成立才算触屏：
//   ① 媒体查询说没有可悬停的指针；② 真的有触摸点（navigator.maxTouchPoints > 0）
//   - 无头 / CI 容器：① 真 ② 假 → 不算触屏，浮层照旧悬停才出
//   - 手机 / 平板：①② 都真 → 常显
//   - 带触摸屏的笔记本：① 假 → 保留悬停浮出（它本来就有鼠标）
//
// 结果挂在 <html> 的 .nav-touch 上，CSS 用 `html.nav-touch .xxx`（两段，特异性 0,2,0），
// 顺带压过组件 sx 注入的单类样式，不会再出现「一半常显、一半不显」的错位。

export const TOUCH_CLASS = "nav-touch";

/** 判定本身（纯函数，便于单测把各种组合走一遍）：两条都满足才认触屏 */
export function decideTouchDevice(noHoverCoarse: boolean, maxTouchPoints: number): boolean {
    return noHoverCoarse && maxTouchPoints > 0;
}

export function isTouchDevice(): boolean {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return decideTouchDevice(
        window.matchMedia("(hover: none) and (pointer: coarse)").matches,
        window.navigator?.maxTouchPoints ?? 0
    );
}

/** 首帧前把输入模式标注到根节点，样式据此决定卡片浮层是否常显 */
export function applyInputModeClass(root: HTMLElement = document.documentElement): void {
    root.classList.toggle(TOUCH_CLASS, isTouchDevice());
}
