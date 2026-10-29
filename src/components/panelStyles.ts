// src/components/panelStyles.ts
// 「出错面板」的共用样式：**一份常量，四处引用**。
//
// 谁在用：
//   - `RenderBoundary.tsx`  —— 某一块界面渲染时抛了异常（整块被换成这块面板）
//   - `SiteListErrorState.tsx` —— 站点列表这一次没取到（数据没丢，只是没有）
//   - 同族的 `ChunkBoundary.tsx` / `ErrorBoundary`（根上那个）也是同一套纯 DOM + 内联样式
//     的技术路线，只是它们的面板结构比较特殊（一个带按钮一个不带），没有共用这里的常量。
//
// 为什么必须抽出来（2026-10-29 评审结论）：这两块面板原本各写一套 style 字面量 ——
// 字号、行高、圆角、按钮配色全都重复了两遍。它不会立刻出错，但**改版时只会改到一套**：
// 调了错误面板的字号，渲染兜底那块还是老样子，用户在不同故障下看到两种观感；
// 而这类不一致没人会写 bug 单，只会一直烂在那里。
//
// 为什么颜色一律走 `var(--…)` 而不是字面量：
//   1. `tests/hardcodedColorGuard.test.ts` 是棘轮守卫，新文件里出现任何 `#rgb` / `rgba()`
//      都会直接红；
//   2. 更重要的：亮暗两套主题只换 token，面板跟着变。写死颜色在暗色下就是一块亮斑
//      （这个仓库真的踩过一次：角标写死 #fff，暗色的 --accent 是浅蓝，对比度 1.9:1）。
//
// ⚠️ 改这里的任何一条，等于同时改「渲染崩了」与「加载失败了」两种界面的观感。
import type { CSSProperties } from "react";

/**
 * 面板外壳的公共部分：内边距、圆角、字体、文字色。
 *
 * 边框与背景**故意不放在这里**：两种故障的语义不同，观感也该不同 ——
 *   · 渲染崩了（RenderBoundary）：中性色描边卡片，跟在页面上「有一块空位」的语气；
 *   · 这次没取到（SiteListErrorState）：警示色虚线框 + 居中，它在原位顶替整个列表，
 *     需要一眼看出「这是占位，不是内容」。
 * 所以外壳的差异留给各自组件覆盖，其余 90% 从这里来。
 */
export const PANEL_BOX: CSSProperties = {
    margin: 12,
    padding: "12px 14px",
    borderRadius: 10,
    color: "var(--text-primary)",
    fontSize: 14,
    lineHeight: 1.7,
};

/** 面板标题（一句话说清发生了什么） */
export const PANEL_TITLE: CSSProperties = {
    fontWeight: 600,
    marginBottom: 4,
};

/** 面板正文（发生了什么 + 用户接下来能做什么） */
export const PANEL_BODY: CSSProperties = {
    color: "var(--text-secondary)",
};

/** 面板里那行更小的补充说明（「数据没丢」这类定心话） */
export const PANEL_NOTE: CSSProperties = {
    color: "var(--text-muted)",
    fontSize: 12,
};

/**
 * 面板里的主按钮（重试 / 刷新页面）。
 *
 * 用 `--accent` + `--on-accent` 而不是固定色：暗色主题下 `--accent` 是浅蓝，
 * 必须配深字，所以「按什么色」和「字什么色」是两个 token，不能写成 color: "#fff"。
 */
export const PANEL_BUTTON: CSSProperties = {
    marginTop: 10,
    padding: "6px 14px",
    fontSize: 14,
    borderRadius: 8,
    border: "1px solid var(--neutral-border)",
    background: "var(--accent)",
    color: "var(--on-accent)",
    cursor: "pointer",
};
