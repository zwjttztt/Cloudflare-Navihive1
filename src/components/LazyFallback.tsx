// src/components/LazyFallback.tsx
// 懒加载弹窗加载中的**轻量反馈**（2026-10-17 首开延迟排查的修复件）。
//
// 问题：弹窗是「条件挂载 + lazy」，首次点击要现场下载块；在慢链路上这有数秒，
// 而 Suspense fallback 一直是 null —— 用户点了却什么都看不到，感知就是
// 「按键坏了」（实测原话「首次点击后反馈延迟很久，关闭后再次打开才恢复正常」）。
//
// 设计取舍：
// 1. **延迟 200ms 才显示**：本地缓存 / 预取命中的快路径完全不闪一下；
// 2. **不用 MUI**：它是首屏包里的静态 import，为一个加载指示往首屏塞组件
//    不划算（同 ChunkBoundary 错误层的取舍）—— 纯 DOM + 内联样式；
// 3. **不挡点击**（pointer-events: none）：预取 / 命中时弹窗马上就来，
//    挡了反而打断连击；慢路径下它只是「点了、在加载」的确认。
import { useEffect, useState } from "react";

const SHOW_DELAY_MS = 200;

export default function LazyFallback() {
    const [show, setShow] = useState(false);
    useEffect(() => {
        const t = window.setTimeout(() => setShow(true), SHOW_DELAY_MS);
        return () => window.clearTimeout(t);
    }, []);
    if (!show) return null;
    return (
        <div
            role='status'
            aria-label='加载中'
            data-lazy-fallback='1'
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 1400,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
            }}
        >
            <div
                style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    border: "3px solid rgba(25, 118, 210, 0.2)",
                    borderTopColor: "var(--accent, #1976d2)",
                    animation: "nh-lazy-spin 0.9s linear infinite",
                }}
            />
            <style>{"@keyframes nh-lazy-spin{to{transform:rotate(360deg)}}"}</style>
        </div>
    );
}
