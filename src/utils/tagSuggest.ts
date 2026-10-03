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
 * 批量打标签弹窗的两排候选。
 *
 * 与「网站设置」里那两排的区别：**不按已选过滤**。
 * 单张卡片点一下标签就落到卡片上、从候选里消失是合理的；批量场景里勾上的标签
 * 必须留在原处显示成选中态，否则点一下就消失，对不上「我到底勾了哪些」。
 *
 * hidden 告诉 UI「常用排没显示完的还有几个」，> 0 时要给「显示全部」入口 ——
 * 库里标签多了不能让用户够不着后面的。
 */
export function pickBulkTagSuggestions(
    allTags: string[],
    {
        commonLimit = 12,
        recommendLimit = 6,
    }: { commonLimit?: number; recommendLimit?: number } = {}
): { common: string[]; recommended: string[]; hidden: number } {
    const common = allTags.slice(0, commonLimit);
    const used = new Set(allTags);
    return {
        common,
        recommended: RECOMMENDED_TAGS.filter(tag => !used.has(tag)).slice(0, recommendLimit),
        hidden: Math.max(0, allTags.length - common.length),
    };
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
