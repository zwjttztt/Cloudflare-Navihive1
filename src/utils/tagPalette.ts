// src/utils/tagPalette.ts
// 标签的**自动**配色（2026-10-25 笔记美化）。
//
// 为什么需要：标签一直支持「手动设色」（tagColorByName），但绝大多数标签
// 用户从没设过 —— 列表里一片灰底灰字，三四个标签挤在一起时全靠读文字
// 才能分辨。这里按标签名取一档固定色相（6 档，见 index.css 的 --tag-N-fg），
// 让**没设过色**的标签也有一点辨识度。
//
// 三条硬约束：
// 1. **哈希必须稳定**：同一个名字在任何设备、任何会话都取到同一档 ——
//    允许用 FNV-1a 这类确定性哈希，绝不能用 Math.random 或时间种子。
// 2. **手设颜色永远优先**：调用方先查 tagColorByName，命中就不用这里的值。
// 3. 只返回**档位索引**，具体色值在 CSS 变量里（亮/暗两套互不干扰）——
//    在 JS 里判断主题会让主题切换时多一次重渲，而且色值没法跟着主题变量走。

/** 档位数量，必须与 index.css 里的 --tag-1-fg … --tag-6-fg 对齐 */
export const TAG_COLOR_COUNT = 6;

/**
 * 标签名 → 档位索引（0 起）。
 *
 * FNV-1a 32 位：够短、够散，且**与平台无关**（不依赖 Intl/locale）。
 * 空名字返回 null —— 调用方据此退回中性灰（不猜颜色）。
 */
export function tagColorIndex(name: string): number | null {
    const key = name.trim();
    if (!key) return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        // >>> 0 把结果钳回无符号 32 位，避免大数在乘 16777619 时丢精度
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % TAG_COLOR_COUNT;
}

/** 档位 → CSS 变量表达式（1 起，与 --tag-1-fg … --tag-6-fg 对齐） */
export function tagColorVar(index: number): string {
    const n = ((index % TAG_COLOR_COUNT) + TAG_COLOR_COUNT) % TAG_COLOR_COUNT;
    return `var(--tag-${n + 1}-fg)`;
}
