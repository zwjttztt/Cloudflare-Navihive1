// src/components/EmptyArt.tsx
// 空状态插画：比一个灰色图标更有点温度的手绘线条图，颜色跟随当前主色。
import { Box } from "@mui/material";

type EmptyArtVariant = "search" | "group" | "empty";

interface EmptyArtProps {
    variant?: EmptyArtVariant;
    size?: number;
}

/**
 * 三种场景：
 * - search：搜不到结果（放大镜 + 虚线）
 * - group：分组里还没有卡片（空盒子 + 加号）
 * - empty：整个导航站还没有分组（三层堆叠的空架子）
 */
export default function EmptyArt({ variant = "empty", size = 96 }: EmptyArtProps) {
    const common = {
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };

    return (
        <Box
            className='nav-empty-art'
            component='svg'
            width={size}
            height={size * 0.75}
            viewBox='0 0 128 96'
            role='img'
            aria-hidden
            sx={{ display: "block", opacity: 0.9 }}
        >
            {/* 统一的底衬：一圈很淡的光晕 */}
            <ellipse
                cx='64'
                cy='82'
                rx='46'
                ry='8'
                fill='currentColor'
                opacity='0.1'
            />

            {variant === "search" && (
                <>
                    <circle cx='54' cy='40' r='20' {...common} opacity='0.85' />
                    <path d='M69 55 L84 70' {...common} opacity='0.85' />
                    <path d='M33 78 H95' {...common} opacity='0.35' strokeDasharray='5 5' />
                    <path d='M46 40 q8 -9 16 0' {...common} opacity='0.5' />
                </>
            )}

            {variant === "group" && (
                <>
                    <path d='M30 34 H98 V70 a4 4 0 0 1 -4 4 H34 a4 4 0 0 1 -4 -4 Z' {...common} />
                    <path d='M30 34 l10 -12 h48 l10 12' {...common} opacity='0.85' />
                    <path d='M64 42 v18 M55 51 h18' {...common} opacity='0.55' />
                    <path d='M38 78 H90' {...common} opacity='0.3' strokeDasharray='5 5' />
                </>
            )}

            {variant === "empty" && (
                <>
                    <rect x='30' y='26' width='68' height='14' rx='4' {...common} opacity='0.85' />
                    <rect x='26' y='46' width='76' height='14' rx='4' {...common} opacity='0.6' />
                    <rect x='34' y='66' width='60' height='12' rx='4' {...common} opacity='0.4' />
                    <path d='M46 33 h10 M46 53 h16' {...common} opacity='0.5' />
                </>
            )}
        </Box>
    );
}
