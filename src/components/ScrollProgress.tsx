// src/components/ScrollProgress.tsx
// 顶部阅读进度条：贴在视口最上方，滚动时按比例增长，到顶 / 无滚动时淡出。
// 纯装饰、pointer-events: none，不会拦截任何点击。
import { useEffect, useState } from "react";

export default function ScrollProgress() {
    const [progress, setProgress] = useState(0);
    const [idle, setIdle] = useState(true);

    useEffect(() => {
        let raf = 0;

        const compute = () => {
            raf = 0;
            const doc = document.documentElement;
            const max = doc.scrollHeight - window.innerHeight;
            if (max <= 8) {
                setProgress(0);
                setIdle(true);
                return;
            }
            const ratio = Math.min(1, Math.max(0, window.scrollY / max));
            setProgress(ratio);
            // 顶部一点点以内视作「没开始读」，把进度条藏起来更干净
            setIdle(ratio <= 0.01);
        };

        const onScroll = () => {
            if (raf) return;
            raf = window.requestAnimationFrame(compute);
        };

        compute();
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        return () => {
            window.removeEventListener("scroll", onScroll);
            window.removeEventListener("resize", onScroll);
            if (raf) window.cancelAnimationFrame(raf);
        };
    }, []);

    return (
        <div
            className='nav-scroll-progress'
            data-idle={idle ? "true" : "false"}
            aria-hidden
        >
            <span style={{ width: `${(progress * 100).toFixed(2)}%` }} />
        </div>
    );
}
