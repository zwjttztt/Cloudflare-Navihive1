// src/components/BrandMark.tsx
// 品牌图标（2026-10-28 重做：指南针蜂巢 · 方案 2）。
//
// 为什么从 `<img src="/favicon.svg">` 改成内联 SVG：
//   用户要求图标「跟随界面的强调色」。静态 favicon 是固定色，跟着主题漂不了；
//   内联 SVG 直接用 var(--accent) / var(--on-accent)，亮暗主题 + 强调色都能跟上。
//   ⚠️ 形状与 public/favicon.svg 保持一致（一个是静态资产、一个是内联组件），
//      改一处记得改另一处。
//
// 配色：底板 = var(--accent)；图形 = var(--on-accent)（「强调色底上的字」专用 token，
//   亮色是白、暗色是深，对比度由主题保证）。中间小点是底板色，把指针切成两半。
// 形状：圆角方形底板（squircle）= 蜂巢格；六边形 = hive 的 DNA；指针 = 导航。
import React from "react";

export const BrandMark: React.FC<{ size?: number }> = ({ size = 64 }) => (
    <svg
        width={size}
        height={size}
        viewBox='0 0 96 96'
        role='img'
        aria-label='Navihive'
        style={{ display: "block", flexShrink: 0 }}
    >
        <rect x='0' y='0' width='96' height='96' rx='28' style={{ fill: "var(--accent)" }} />
        <polygon
            points='48,10 81,29 81,67 48,86 15,67 15,29'
            style={{ fill: "none", stroke: "var(--on-accent)" }}
            strokeWidth='6'
            strokeLinejoin='round'
        />
        <polygon points='48,25 56,48 40,48' style={{ fill: "var(--on-accent)" }} />
        <polygon points='48,71 56,48 40,48' style={{ fill: "var(--on-accent)", opacity: 0.42 }} />
        <circle cx='48' cy='48' r='2.6' style={{ fill: "var(--accent)" }} />
    </svg>
);
