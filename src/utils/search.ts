import { Site } from "../API/http";
import { matchesByPinyin } from "./pinyin";

/**
 * 搜索用的文本归一化：
 * - 统一小写
 * - 去掉协议头与开头的 www.
 * - 把所有非字母/数字的字符（. / - _ 空格 : 等）统一成一个空格，并压缩空白
 *
 * 这样「www.yunso.net」「https://www.yunso.net/」「yunso.net」「yunso net」
 * 归一化后都是「yunso net」，互相都能搜到。
 */
export const normalizeSearchText = (text: string): string =>
    (text || "")
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

/** 一张卡片可被搜到的文本：网站名称 / 网站链接 / 网站描述 */
export const siteSearchText = (site: Site): string =>
    `${site.name || ""} ${site.url || ""} ${site.description || ""}`;

/**
 * 卡片是否命中关键词。
 * 支持多词：所有词都出现才算命中（例如「云设 示例」）。
 */
export const matchesSiteQuery = (
    site: Site,
    rawQuery: string,
    usePinyin = false
): boolean => {
    const query = normalizeSearchText(rawQuery);
    if (!query) return true;

    const haystack = normalizeSearchText(siteSearchText(site));
    if (haystack.includes(query)) return true;

    const terms = query.split(" ").filter(Boolean);
    if (terms.length > 1 && terms.every(term => haystack.includes(term))) return true;

    // 拼音兜底：只对站点名做（链接/描述里塞拼音没有意义，还容易误命中）
    return usePinyin && matchesByPinyin(site.name || "", rawQuery.trim());
};

/** 分组名是否命中关键词（同样做归一化，允许 "常用 工具" 这种输入） */
export const matchesGroupQuery = (
    groupName: string,
    rawQuery: string,
    usePinyin = false
): boolean => {
    const query = normalizeSearchText(rawQuery);
    if (!query) return true;
    const haystack = normalizeSearchText(groupName);
    if (haystack.includes(query)) return true;
    const terms = query.split(" ").filter(Boolean);
    if (terms.length > 1 && terms.every(term => haystack.includes(term))) return true;
    return usePinyin && matchesByPinyin(groupName || "", rawQuery.trim());
};
