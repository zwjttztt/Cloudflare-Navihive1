// src/components/EmptyArt.tsx
// 空状态插画：比一个灰色图标更有点温度的手绘线条图，颜色跟随当前主色。
//
// 2026-10-07 对齐 inkstone 的 `EmptyIllustration`：
//   - 线宽从 2 收到 **1.25**（inkstone 就是这么细 —— 粗线在 78px 的框里显得笨重）；
//   - 加了 **ink-draw 描边自绘动画**：stroke-dashoffset 从 220 走到 0，900ms，
//     线条像被一笔画出来。空状态是用户「什么都没找到」的那一瞬间，
//     给它一点动效，页面就不像是坏了。
//   - 补齐 inkstone 的 8 种场景（原来只有 3 种）。
import { Box } from "@mui/material";
import type { ReactNode } from "react";

type EmptyArtVariant =
    | "search"
    | "group"
    | "empty"
    | "notes"
    | "trash"
    | "starred"
    | "archive"
    | "folder"
    | "tag"
    | "select";

interface EmptyArtProps {
    variant?: EmptyArtVariant;
    size?: number;
}

/** inkstone 的 `EmptyArt` 变体 → 我们的别名（旧调用点不用改） */
const VARIANT_ALIAS: Record<string, EmptyArtVariant> = {
    empty: "notes",
    group: "folder",
};

/**
 * 场景：
 * - notes：一条笔记（默认，之前叫 `empty`）
 * - search：搜不到结果
 * - folder：文件夹是空的（之前叫 `group`）
 * - trash / starred / archive / tag / select：回收站 / 收藏 / 归档 / 标签 / 还没选笔记
 */
export default function EmptyArt({ variant = "notes", size = 78 }: EmptyArtProps) {
    const v = VARIANT_ALIAS[variant] ?? variant;
    const common = {
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.25,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };
    // 每条子路径各自从「整条没画」走到「画完」。220 是 inkstone 用的长度，
    // 比我们任何一条路径的实际周长都长，所以起点一定是全隐。
    const draw = {
        strokeDasharray: 220,
        strokeDashoffset: 220,
        animation: "ink-draw 900ms var(--ease-out, ease-out) forwards",
    };

    return (
        <Box
            className='nav-empty-art'
            component='svg'
            viewBox='0 0 64 64'
            role='img'
            aria-hidden
            sx={{
                width: size,
                height: size,
                display: "block",
                color: "text.disabled",
                "& > *": draw,
            }}
        >
            {v === "search" && (
                <>
                    <circle cx='28' cy='28' r='14' {...common} />
                    <path d='M38.5 38.5 50 50' {...common} />
                    <path d='M22 28h12M24 23h8' {...common} opacity='0.5' />
                </>
            )}
            {v === "trash" && (
                <>
                    <path d='M17 20h30l-2.5 27a4 4 0 0 1-4 3.6H23.5a4 4 0 0 1-4-3.6z' {...common} />
                    <path d='M13 20h38M26 20v-4a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v4' {...common} />
                    <path d='M27 29v13M37 29v13' {...common} opacity='0.5' />
                </>
            )}
            {v === "starred" && (
                <path
                    d='M32 13.5l5.6 11.7 12.4 1.8-9 9 2.1 12.7L32 42.7l-11.1 6 2.1-12.7-9-9 12.4-1.8z'
                    {...common}
                />
            )}
            {v === "archive" && (
                <>
                    <rect x='12' y='16' width='40' height='10' rx='2.5' {...common} />
                    <path d='M16 26v22a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V26' {...common} />
                    <path d='M26 34h12' {...common} opacity='0.6' />
                </>
            )}
            {v === "folder" && (
                <>
                    <path d='M11 22a3 3 0 0 1 3-3h11l4.5 5H50a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3z' {...common} />
                    <path d='M11 30h42' {...common} opacity='0.5' />
                </>
            )}
            {v === "tag" && (
                <>
                    <path d='M31 12H16a4 4 0 0 0-4 4v15l21 21 19-19z' {...common} />
                    <circle cx='23' cy='23' r='3.5' {...common} />
                </>
            )}
            {v === "select" && (
                <>
                    <rect x='12' y='13' width='26' height='38' rx='3' {...common} />
                    <path d='M44 21h8v30a3 3 0 0 1-3 3H26' {...common} opacity='0.55' />
                    <path d='M19 24h12M19 31h12M19 38h7' {...common} opacity='0.7' />
                </>
            )}
            {v === "notes" && (
                <>
                    <path d='M18 11h20l10 10v32a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3z' {...common} />
                    <path d='M38 11v10h10' {...common} />
                    <path d='M23 32h18M23 40h13' {...common} opacity='0.65' />
                </>
            )}
        </Box>
    );
}

/**
 * 空状态整块（照 inkstone 的 `Empty`：插画 + 标题 + 说明 + 可选动作）。
 *
 * ⚠️ 为什么单独抽出来：之前每个空位置各写各的，样式（居中方式、间距、
 * 标题字号）互不一致，同一个页面里三种空状态长得像三个产品。
 */
export function EmptyState({
    art,
    title,
    description,
    action,
    compact,
}: {
    art: EmptyArtVariant;
    title: string;
    description?: string;
    action?: ReactNode;
    /** 抽屉 / 弹窗里那种矮容器用（py 收一半） */
    compact?: boolean;
}) {
    return (
        <Box
            data-empty-state={art}
            sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                px: 4,
                textAlign: "center",
                ...(compact ? { py: 5 } : { height: "100%", minHeight: 240, py: 8 }),
            }}
        >
            <EmptyArt variant={art} />
            <Box sx={{ mt: 2, fontSize: 13.5, fontWeight: 500, color: "text.secondary" }}>
                {title}
            </Box>
            {description && (
                <Box sx={{ mt: 0.75, maxWidth: 290, fontSize: 12, lineHeight: 1.7, color: "text.disabled" }}>
                    {description}
                </Box>
            )}
            {action && <Box sx={{ mt: 2 }}>{action}</Box>}
        </Box>
    );
}
