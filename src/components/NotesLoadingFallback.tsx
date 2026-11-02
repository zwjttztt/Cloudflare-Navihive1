// 记事本懒块加载中的占位骨架（NotesOverlay 是整页级懒块，357KB + 编辑器 564KB，
// 弱网会真等几秒）。纯 DOM + 内联样式（与 ChunkBoundary 同路线：出错/加载界面
// 不该往首屏塞组件）。挂在 ChunkBoundary 的 loadingFallback 上，且本组件本身是**懒块**
// （App 用 `lazy(() => import(...))` 引），所以它的代码与样式都不进首屏预算。
//
// 样式策略：keyframes 用组件内 `<style>` 注入（随懒块走），骨架块用内联样式 +
// currentColor 低透明度脉冲（currentColor 跟随主题：亮色=深色淡纹、暗色=浅色淡纹，
// 明暗都不掉色、不撞对比度审计——纯装饰、无文字）。
import type React from "react";

export default function NotesLoadingFallback() {
    const lineWidths = ["100%", "92%", "96%", "70%", "88%", "60%"];
    const blockStyle: React.CSSProperties = {
        height: 14,
        borderRadius: 7,
        marginBottom: 12,
        background: "currentColor",
        opacity: 0.14,
        animation: "notesSkeletonPulse 1.2s ease-in-out infinite",
    };
    return (
        <>
            <style>{`@keyframes notesSkeletonPulse{0%,100%{opacity:.16}50%{opacity:.05}}`}</style>
            <div
                role="status"
                aria-live="polite"
                aria-label="记事本加载中"
                style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 2000,
                    background: "var(--surface-raised, #fff)",
                    color: "var(--text-secondary, #55595f)",
                    overflow: "hidden",
                }}
            >
                <div
                    style={{
                        height: 52,
                        borderBottom: "1px solid var(--border-default, #d0d3d8)",
                    }}
                />
                <div
                    style={{
                        maxWidth: 760,
                        width: "100%",
                        margin: "0 auto",
                        padding: "20px 16px",
                        boxSizing: "border-box",
                    }}
                >
                    <div
                        style={{ ...blockStyle, height: 26, borderRadius: 8, marginBottom: 20 }}
                    />
                    {lineWidths.map((w, i) => (
                        <div key={i} style={{ ...blockStyle, width: w }} />
                    ))}
                </div>
            </div>
        </>
    );
}
