// src/components/SiteListErrorState.tsx
// 站点列表**加载失败**时的面板：说清「没加载上」+ 给一个重试。
//
// 为什么要专门有这一块（2026-10-29）：以前 bootstrap 失败后 groups 是空的，
// 页面上照常渲染 SiteListEmptyState —— 用户看到「还没有任何分组」，
// 会以为自己几百个网站全没了。数据其实一条没丢，只是没取到。
// 局部失败（只是这一次请求没成功）不该被夸大成整站异常，所以这里不用全局 toast，
// 就在列表原来的位置给一块带「重试」的面板。
//
// ⚠️ 面板样式与 `RenderBoundary.tsx`（渲染崩了那块）**同源**，都在
//    `panelStyles.ts` 里。改字号 / 按钮 / 文字色请改那个文件，别在这里再写一份字面量 ——
//    重复两份的结果是「改版只改到一套」，两种故障下用户看到两种观感。
//    这里只覆盖两件**语义上确实不同**的事：警示色虚线边框（它在原位顶替整个列表，
//    要一眼看出是占位）与居中布局。文案也各自保留：渲染崩溃 ≠ 加载失败。
//
// 为什么不用 MUI 组件（Box/Typography/Button 都现成）：
//   1. 这一类界面全站技术路线统一 —— RenderBoundary / ChunkBoundary / 根上的
//      ErrorBoundary 都是纯 DOM + 内联样式 + CSS 变量，出错时的界面不该为它往首屏
//      多塞组件（这条经验上次实测过：一个 MUI Button 就是 KB 级涨幅）；
//   2. 首屏预算（tests/bundleBudget.test.ts）本来就贴着 5% 线，这个组件必须静态
//      import 进首屏（出现的场合恰恰是请求失败，不能再去下载 chunk）。
//
// 纯渲染、没有逻辑：message 由 useSites 的 error 状态给，onRetry 由 App 接到 fetchData。
import type { CSSProperties } from "react";
import { PANEL_BODY, PANEL_BOX, PANEL_BUTTON, PANEL_NOTE, PANEL_TITLE } from "./panelStyles";

interface SiteListErrorStateProps {
    /** 失败原因（通常是 api 抛出的 err.message） */
    message: string;
    /** 重新取一次数据（App 里是 fetchData） */
    onRetry: () => void;
}

/**
 * 覆盖在外壳常量上的三件事：警示色虚线（语义）、居中（它是列表的占位）、
 * 大一点的纵向留白（原来空状态就是这么高的，换成错误面板时布局不该跳）。
 */
const BOX_OVERRIDE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
    textAlign: "center",
    padding: "40px 16px",
    borderRadius: 14,
    border: "1.5px dashed var(--danger)",
    background: "transparent",
};

export default function SiteListErrorState({ message, onRetry }: SiteListErrorStateProps) {
    return (
        <div role='alert' className='nav-site-list-error' style={{ ...PANEL_BOX, ...BOX_OVERRIDE }}>
            {/* 一条手绘风格的感叹号：线宽 1.25 与 EmptyArt 一致，不引 @mui/icons-material
                —— 这个面板常驻首屏包，为一个只在出错时出现的图标塞一整个 icon 不划算。 */}
            <svg
                viewBox='0 0 48 48'
                width={96}
                height={96}
                aria-hidden='true'
                style={{ color: "var(--danger)" }}
            >
                <circle
                    cx='24'
                    cy='24'
                    r='19'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.25'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                />
                <path
                    d='M24 13.5v14'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='1.25'
                    strokeLinecap='round'
                />
                <path
                    d='M24 33.2v.4'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2'
                    strokeLinecap='round'
                />
            </svg>
            <div style={PANEL_TITLE}>加载失败</div>
            <div style={{ ...PANEL_BODY, maxWidth: 520, wordBreak: "break-word" }}>{message}</div>
            {/* 一句定心的话：这里最怕的不是打不开，是用户以为数据没了 */}
            <div style={PANEL_NOTE}>你的网站数据没有丢，只是这一次没取到。点重试重新加载即可。</div>
            <button
                type='button'
                onClick={onRetry}
                className='nav-site-list-error-retry'
                style={{ ...PANEL_BUTTON, marginTop: 0 }}
            >
                重试
            </button>
        </div>
    );
}
