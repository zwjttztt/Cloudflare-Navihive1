// src/utils/groupColor.ts
// 分组自动配色：按分组 id 稳定地映射到一组色相上，让分组之间一眼能分开。
// 用哈希而不是「按序号取色」是因为分组会被删除、重排，序号一变颜色就跟着跳。
const HUES = [4, 24, 42, 96, 142, 172, 199, 232, 262, 320];

function hueOf(id: number): number {
    // 分组 id 可能为负（本地虚拟分组），取绝对值保证落在数组范围内
    const n = Math.abs(Math.trunc(id)) || 0;
    return HUES[n % HUES.length];
}

/**
 * 分组强调色。明暗两套亮度，暗色下调亮一点，免得深色背景上看不清。
 */
export function groupAccent(id: number, mode: "light" | "dark"): string {
    const h = hueOf(id);
    return mode === "dark" ? `hsl(${h} 68% 68%)` : `hsl(${h} 62% 46%)`;
}
