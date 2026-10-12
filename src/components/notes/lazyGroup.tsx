// src/components/notes/lazyGroup.tsx
// 笔记列表的**组级懒挂载**：视口外的分组先不建 React 元素 / DOM，只留一个占位高度。
//
// 为什么是「组级懒挂载」而不是 computeWindow 那种定高窗口虚拟化：
// 笔记列表是**时间桶分组**结构（置顶 / 今天 / 上周 / 更早……），组标题夹在行中间，
// 而行高随标签徽章与摘要行数浮动（contentVisibility 的 containIntrinsicSize 用的
// 56/96 本来就是估计值）—— 定高窗口的 padTop/totalHeight 在这两个前提下都会算错，
// 表现为滚动条跳动、组标题被跳过。组级懒挂载不假设行高精确（占位只是近似，
// rootMargin 有 600px 提前量，滚到附近就换成真行校正），也完全不改变组内 DOM 结构。
//
// 与 GroupCard 对站点的懒挂载是同一个模式（IntersectionObserver + enqueueMountTask
// 分帧挂载，快速滚动时同帧进圈的组逐个挂，不挤爆一帧）。
//
// 挂载判定的两个入口：
// 1. `enabled=false` → **渲染期直接短路**成真渲染（不经过 effect / setState），
//    所以「切文件夹后总条数低于阈值」这类变化在同一轮渲染就生效；
// 2. 进视口（rootMargin 600px）→ observer 回调里分帧 setMounted。
// 一旦挂上就不收回（mounted 只涨不跌）—— 来回滚动不反复重建，与 GroupCard 一致。

import { Box } from "@mui/material";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { enqueueMountTask } from "../../utils/mountQueue";

export function LazyGroup({
    enabled,
    placeholderHeight,
    children,
}: {
    /** false = 不懒挂载（条数低于阈值 / 环境没有 IntersectionObserver），照常全量渲染 */
    enabled: boolean;
    /** 未挂载时的占位高度（px）：行数 × 估计行高。近似即可，进视口就换真行 */
    placeholderHeight: number;
    children: ReactNode;
}) {
    const [mounted, setMounted] = useState(false);
    const panelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        // enabled=false：渲染期已经短路成真渲染了（或者本来就该全量），observer 没必要跑。
        // ⚠️ 这里刻意不 setMounted(false)：挂上就不收回，来回滚动不反复重建。
        if (!enabled) return;
        const el = panelRef.current;
        if (!el || typeof IntersectionObserver === "undefined") {
            setMounted(true);
            return;
        }
        const io = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) {
                    io.disconnect(); // 一旦挂上就不卸载，避免来回滚动反复重建
                    enqueueMountTask(() => setMounted(true));
                }
            },
            { rootMargin: "600px 0px" }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [enabled]);

    // ⚠️ enabled=false 必须在**渲染期**短路：如果走 effect setState，
    // 要多等一轮渲染 DOM 才出现，依赖「渲染后立刻量 DOM」的逻辑会踩空。
    if (!enabled || mounted) return <>{children}</>;
    return (
        <Box
            ref={panelRef}
            data-lazy-group='1'
            aria-hidden={true}
            sx={{ height: Math.max(24, placeholderHeight) }}
        />
    );
}
