// src/components/ConfirmDialogGate.tsx
// 二次确认弹窗的按需入口。
//
// 为什么多这一层：站内每个破坏性操作（删卡片 / 删分组 / 批量删 / 清空访问记录 /
// 清空回收站）都要先过 ConfirmDialog 这道门，于是它一直**静态待在首屏包里** ——
// 而它只在「用户点了删除之后」才出现。首屏预算的余量就在 5% 边上，这道门挪出去能省 3 KB 左右。
//
// 两个刻意的取舍：
// 1. **打开过一次之后就常驻**（everOpen），不是关了就卸载。二次确认常常连着点好几次
//    （删一张、再删一张），每次都重新加载一遍反而更慢、也更晃。
// 2. **只在 open 变 true 的那一刻挂载**，而且是在同一次渲染里决定（不是放到 effect 里）——
//    放到 effect 里会先渲染一帧 null、下一帧才挂弹窗，MUI 的入场动画就丢了。
//    MUI 的 Dialog 关着的时候本来也不渲染内容，少挂载一层不影响开关。
//
// ⚠️ 离线可用性由构建侧保证：ConfirmDialog 的块被加进了 Service Worker 的**预缓存核心清单**
// （见 vite.config.ts 的 ALWAYS_PRECACHE）。删除操作在离线队列里是允许的，
// 不能因为「这个块还没下载到本机」就把用户的删除拦下来。
import { useState, lazy } from "react";
import ChunkBoundary from "./ChunkBoundary";
import type { ConfirmDialogProps } from "./ConfirmDialog";

const ConfirmDialog = lazy(() => import("./ConfirmDialog"));

export default function ConfirmDialogGate(props: ConfirmDialogProps) {
    const [everOpen, setEverOpen] = useState(props.open);
    // React 官方的「props 变化时直接改 state」写法：同一次渲染里生效，不留空帧
    if (props.open && !everOpen) setEverOpen(true);

    if (!everOpen) return null;
    return (
        <ChunkBoundary>
            <ConfirmDialog {...props} />
        </ChunkBoundary>
    );
}
