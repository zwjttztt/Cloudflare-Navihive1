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

// ================= 检索索引 =================
//
// 归一化是三趟正则（小写、去协议、非字母数字统一成空格），这件事对**每个站点**
// 做一遍就是 O(站点数 × 三趟正则)。原来每次按键都要重做一遍 —— 打一个五字词
// 就是 5 × 站点数 次全量归一化，几千张卡片时输入开始发涩就是这么来的。
//
// 索引的思路很简单：站点侧的文本只在**数据变了**的时候算一次，查询侧只在
// **关键词变了**的时候算一次，剩下的就是 `includes` 而已。
// 不建倒排表：卡片量级（几百到几千）用不上，线性扫一遍更快也更省心。

/** 查询侧：一次归一化，全站点复用 */
export interface PreparedQuery {
    /** 归一化后的整串 */
    text: string;
    /** 拆开的词（多词要求全部命中） */
    terms: string[];
    /** 原始输入：拼音匹配要用（它对大小写与空格不敏感） */
    raw: string;
}

/** 空查询：一切都命中，和 matchesSiteQuery 传空串的行为一致 */
export const EMPTY_QUERY: PreparedQuery = { text: "", terms: [], raw: "" };

export function prepareQuery(rawQuery: string): PreparedQuery {
    const text = normalizeSearchText(rawQuery);
    if (!text) return EMPTY_QUERY;
    return { text, terms: text.split(" ").filter(Boolean), raw: rawQuery };
}

/** 站点侧的归一化文本（建索引时算一次） */
export const siteHaystack = (site: Site): string =>
    normalizeSearchText(siteSearchText(site));

/** 站点是否命中一个已经准备好的查询 */
export function matchesPrepared(
    haystack: string,
    name: string,
    q: PreparedQuery,
    usePinyin = false
): boolean {
    if (!q.text) return true;
    if (haystack.includes(q.text)) return true;
    if (q.terms.length > 1 && q.terms.every(term => haystack.includes(term))) return true;
    // 拼音兜底只针对站点名（链接/描述里塞拼音没有意义，还容易误命中）
    return usePinyin && matchesByPinyin(name, q.raw.trim());
}

/**
 * 站点索引：站点 id -> 归一化后的可搜文本。
 *
 * 用 id 当键而不是数组下标：过滤时要按分组重组，拿 id 直接查最省事，
 * 站点顺序变了也不会错位。
 */
export type SiteSearchIndex = Map<number, { haystack: string; name: string }>;

/** 分组索引：分组 id -> 归一化后的分组名 */
export type GroupSearchIndex = Map<number, string>;

export interface SearchIndex {
    sites: SiteSearchIndex;
    groups: GroupSearchIndex;
}

export function buildSearchIndex(
    groups: readonly { id?: number; name?: string; sites: Site[] }[]
): SearchIndex {
    const sites: SiteSearchIndex = new Map();
    const groupNames: GroupSearchIndex = new Map();

    for (const group of groups) {
        if (group.id !== undefined) groupNames.set(group.id, normalizeSearchText(group.name || ""));
        for (const site of group.sites) {
            if (site.id === undefined) continue;
            sites.set(site.id, { haystack: siteHaystack(site), name: site.name || "" });
        }
    }

    return { sites, groups: groupNames };
}
