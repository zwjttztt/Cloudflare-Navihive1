// src/utils/tagSuggest.ts
// 「网站设置」里标签输入框右侧的快捷候选：
// 一部分来自已经用过的标签（现有），一部分是常用词（推荐），点一下直接加到卡片的标签里。

/** 推荐标签：还没用过任何标签时的起步候选，按常见用途排 */
export const RECOMMENDED_TAGS = [
    "常用",
    "工具",
    "效率",
    "开发",
    "AI",
    "设计",
    "学习",
    "资讯",
    "娱乐",
    "购物",
    "影音",
    "网盘",
];

/**
 * 现有标签候选：全站用过的标签里，去掉这张卡片已经加过的。
 * allTags 已按使用次数排序（UIPrefs 里算过），这里保持原顺序取前 limit 个。
 */
export function pickExistingTags(
    allTags: string[],
    currentTags: string[],
    limit = 8
): string[] {
    const used = new Set(currentTags);
    return allTags.filter(tag => !used.has(tag)).slice(0, limit);
}

/**
 * 推荐标签候选：常用词里排除掉「这张卡片已经有了」和「已经在现有标签里露出过」的，
 * 避免同一排里出现两个一样的词。
 */
export function pickRecommendedTags(
    allTags: string[],
    currentTags: string[],
    limit = 6
): string[] {
    const used = new Set([...currentTags, ...allTags]);
    return RECOMMENDED_TAGS.filter(tag => !used.has(tag)).slice(0, limit);
}
