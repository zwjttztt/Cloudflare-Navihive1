// src/utils/fuzzy.ts
// 模糊匹配 + 命中区间（照 inkstone 的 client/lib/fuzzy.ts 搬的，评分/区间算法逐行一致）。
//
// 为什么需要它：原来记事本的搜索是 `title.includes(kw) || content.includes(kw)`，
// 两个后果 —— ① 打错一个字（「数据哭」）就什么都搜不到；② 命中的地方没有标记，
// 列表里一堆结果看不出为什么是它。inkstone 是「模糊匹配 + <mark> 高亮命中段」。
//
// 评分大致是这样的（数值照抄，别自己改 —— 排序手感是调过的）：
//   直接子串命中 1000 分起，出现位置越靠前越高，在词首再 +150，开头 +300；
//   分散命中按「连击」累加，落在词边界 +22、开头 +40、其它 +4；
//   最后按文本长度和区间数量各扣一点（偏好短标题、命中集中的）。

export interface FuzzyMatch {
    score: number;
    /** 命中区间 [start, end)，用于在标题上打 <mark> */
    ranges: [number, number][];
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
    if (!query) return { score: 0, ranges: [] };

    const haystack = text.toLowerCase();
    const needle = query.toLowerCase().trim();
    if (!needle) return { score: 0, ranges: [] };

    // 1) 直接子串命中：一次性给高分，区间就是那一整段
    const direct = haystack.indexOf(needle);
    if (direct >= 0) {
        let score = 1000 - direct * 2;
        if (direct === 0) score += 300;
        else if (isBoundary(haystack, direct)) score += 150;
        score += Math.max(0, 120 - text.length);
        return { score, ranges: [[direct, direct + needle.length]] };
    }

    // 2) 分散命中：按顺序找每个字符，连着的加连击分
    const ranges: [number, number][] = [];
    let ti = 0;
    let score = 0;
    let streak = 0;

    for (let qi = 0; qi < needle.length; qi++) {
        const ch = needle[qi];
        // 查询里的空格只当分隔符（用户可以打「数据 设计」跨词找）
        if (ch === " ") {
            streak = 0;
            continue;
        }
        const found = haystack.indexOf(ch, ti);
        if (found < 0) return null;

        if (found === ti && ranges.length) {
            streak++;
            score += 12 + streak * 6;
            const last = ranges[ranges.length - 1];
            last[1] = found + 1;
        } else {
            streak = 0;
            score += found === 0 ? 40 : isBoundary(haystack, found) ? 22 : 4;
            ranges.push([found, found + 1]);
        }
        ti = found + 1;
    }

    score -= Math.floor(text.length / 12);
    score -= ranges.length * 2;
    return { score, ranges };
}

/** 前一个字符是分隔符 / 标点就算词边界（中外标点都算） */
function isBoundary(text: string, index: number): boolean {
    if (index === 0) return true;
    const prev = text[index - 1];
    return /[\s\-_/.·、，（(【[]/.test(prev);
}

/** 把命中区间铺成「片段数组」，渲染层直接 map 出 <mark> */
export function splitByRanges(
    text: string,
    ranges: [number, number][]
): { text: string; hit: boolean }[] {
    if (!ranges.length) return [{ text, hit: false }];
    const merged = mergeRanges(ranges);
    const out: { text: string; hit: boolean }[] = [];
    let cursor = 0;

    for (const [start, end] of merged) {
        if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
        out.push({ text: text.slice(start, end), hit: true });
        cursor = end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
    return out.filter(part => part.text);
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else out.push([...range] as [number, number]);
    }
    return out;
}

/** 一批条目里挑出命中的，按分数从高到低排，最多 limit 条 */
export function fuzzyFilter<T>(
    items: T[],
    query: string,
    getText: (item: T) => string,
    limit = 50
): { item: T; match: FuzzyMatch }[] {
    if (!query.trim()) {
        return items.slice(0, limit).map(item => ({ item, match: { score: 0, ranges: [] } }));
    }
    const scored: { item: T; match: FuzzyMatch }[] = [];
    for (const item of items) {
        const match = fuzzyMatch(getText(item), query);
        if (match) scored.push({ item, match });
    }
    scored.sort((a, b) => b.match.score - a.match.score);
    return scored.slice(0, limit);
}
