// 记事本懒块加载中的占位骨架（NotesOverlay 是整页级懒块，357KB + 编辑器 564KB，
// 弱网会真等几秒）。纯 DOM + 内联样式（与 ChunkBoundary 同路线：出错/加载界面
// 不该往首屏塞组件）。挂在 ChunkBoundary 的 loadingFallback 上，且本组件本身是**懒块**
// （App 用 `lazy(() => import(...))` 引），所以它的代码与样式都不进首屏预算。
//
// 样式策略：keyframes 用组件内 `<style>` 注入（随懒块走），骨架块用内联样式 +
// currentColor 低透明度脉冲（currentColor 跟随主题：亮色=深色淡纹、暗色=浅色淡纹，
// 明暗都不掉色、不撞对比度审计——纯装饰、无文字）。
//
// ⚠️ 骨架超时出口为什么放在这里、而不是 ChunkBoundary：ChunkBoundary 是首屏包，
// 给它加状态机实测把 index chunk 从 259.47 顶到 262.02 KB，5% 余量直接跌到 4.6%
// （check:budget 红）。本文件已经是懒块，计时器与「刷新」文案放这里首屏零增量。
// Suspense resolve 后 fallback 卸载、useEffect 的 cleanup 自动取消计时器，
// 不需要（也不可能）去感知 React.lazy 的 promise 何时 settle。
import { useEffect, useState, type CSSProperties } from "react";

/** 线上抖动时大块 20 秒 0 字节；12 秒给出口，又不误伤正常慢速（实测大块 7.5s） */
const LOADING_TIMEOUT_MS = 12_000;

/**
 * 清 Cache Storage 再刷新，与 ChunkBoundary 的错误出口 / public/boot-guard.js 同语义。
 * 这里自己写而不 import ChunkBoundary：那是首屏模块，从懒块引它会往首屏依赖图加边。
 * 3 秒兜底保证缓存清理卡住时用户也不会被留在骨架上。
 */
async function clearCachesAndReload(): Promise<void> {
    let done = false;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const reloadOnce = (): void => {
        if (done) return;
        done = true;
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
        try {
            location.reload();
        } catch {
            /* 极少数环境禁止 reload：保持原样 */
        }
    };
    deadline.timer = setTimeout(reloadOnce, 3000);
    try {
        if (typeof caches !== "undefined" && typeof caches.keys === "function") {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => caches.delete(key).catch(() => false)));
        }
    } catch {
        // 打不开 Cache Storage：照样刷新
    }
    reloadOnce();
}

interface Props {
    /** 仅测试注入短超时用；生产不传，走 12 秒 */
    timeoutMs?: number;
}

export default function NotesLoadingFallback({ timeoutMs = LOADING_TIMEOUT_MS }: Props) {
    const [timedOut, setTimedOut] = useState(false);
    useEffect(() => {
        const timer = setTimeout(() => setTimedOut(true), timeoutMs);
        return () => clearTimeout(timer);
    }, [timeoutMs]);

    const lineWidths = ["100%", "92%", "96%", "70%", "88%", "60%"];
    const blockStyle: CSSProperties = {
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
                aria-label={timedOut ? "记事本加载时间过长" : "记事本加载中"}
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
                    {timedOut ? (
                        <div
                            role="alert"
                            style={{
                                padding: "12px 14px",
                                borderRadius: 10,
                                border: "1px solid var(--border-default, #d0d3d8)",
                                color: "var(--text-primary, #1f2329)",
                                fontSize: 14,
                                lineHeight: 1.7,
                            }}
                        >
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>加载时间过长</div>
                            <div style={{ color: "var(--text-secondary, #55595f)" }}>
                                记事本的代码一直没加载完，多半是站点刚更新或缓存出了问题。点下面的按钮会清掉缓存、刷新页面后重新加载。
                            </div>
                            <button
                                onClick={() => void clearCachesAndReload()}
                                style={{
                                    marginTop: 10,
                                    padding: "6px 14px",
                                    fontSize: 14,
                                    borderRadius: 8,
                                    border: "1px solid var(--border-default, #d0d3d8)",
                                    background: "var(--accent, #1976d2)",
                                    color: "var(--on-accent, #fff)",
                                    cursor: "pointer",
                                }}
                            >
                                刷新页面
                            </button>
                        </div>
                    ) : (
                        <>
                            <div
                                style={{ ...blockStyle, height: 26, borderRadius: 8, marginBottom: 20 }}
                            />
                            {lineWidths.map((w, i) => (
                                <div key={i} style={{ ...blockStyle, width: w }} />
                            ))}
                        </>
                    )}
                </div>
            </div>
        </>
    );
}
