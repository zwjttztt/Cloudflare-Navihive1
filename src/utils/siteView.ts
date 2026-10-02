// src/utils/siteView.ts
// 分组视图的纯派生逻辑：从原始分组 + 访问统计算出「最近访问」虚拟分组，
// 以及真正要渲染的分组列表（把「最近访问」按当前筛选/搜索前置）。
// 抽成纯函数：既能被 App 直接调用，也能单测覆盖，不再和 4000+ 行的 App 绑死。
import type { GroupWithSites } from "../types";
import type { Site } from "../API/http";
import { matchesSiteQuery } from "./search";
import { recentVisitCount, RECENT_GROUP_SIZE } from "./time";

export type VisitStat = {
    count?: number;
    last?: number;
    days?: Record<string, number>;
};

/** 「最近访问」虚拟分组：7 天内点开过、且点开次数最多的前 N 个网站 */
export function buildFavoritesGroup(
    groups: GroupWithSites[],
    visits: Record<string, VisitStat | undefined>
): GroupWithSites {
    const scored = groups
        .flatMap(g => g.sites)
        .map(site => {
            const stat = visits[String(site.id)];
            return { site, stat, count: recentVisitCount(stat) };
        })
        .filter(item => item.count > 0)
        .sort((a, b) => b.count - a.count || (b.stat?.last ?? 0) - (a.stat?.last ?? 0))
        .slice(0, RECENT_GROUP_SIZE)
        .map(item => item.site);

    return { id: -1, name: "最近访问", order_num: -1, sites: scored } as GroupWithSites;
}

/**
 * 搜索结果的渲染上限：每组各截一点不够，必须有全局额度。
 *
 * 以前只对每组套 `slice(0, perGroup)`，五个分组各命中 24 条就是 120 张卡片 ——
 * 全局上限写了却没生效，卡住的还是输入时的那一次大过滤。
 * 这里按「分组顺序依次领取额度」来截：先到先得，总额度用完就停，
 * 并保留分组结构（空组不进结果，分组名不会因为截断而消失）。
 *
 * `expanded` 为真时不截断，由调用方（useSiteSearch）决定何时展开。
 */
export function truncateSearchGroups(
    groups: GroupWithSites[],
    total: number,
    perGroup: number,
    expanded = false
): GroupWithSites[] {
    if (expanded || total <= 0) return groups;

    let matched = 0;
    for (const group of groups) {
        matched += group.sites?.length ?? 0;
    }
    // 总额度够用、且没有哪个组要单独受限、也没有空组时，原样返回同一个数组引用：
    // 下游的 useMemo / memo 组件靠引用相等跳过重算，重建数组会让整屏卡片白重渲一遍
    const needsEdit = groups.some(g => {
        const n = g.sites?.length ?? 0;
        return n === 0 || n > perGroup;
    });
    if (matched <= total && !needsEdit) return groups;

    let remaining = total;
    const out: GroupWithSites[] = [];
    for (const group of groups) {
        if (remaining <= 0) break;
        const sites = group.sites ?? [];
        if (sites.length === 0) continue;
        const take = Math.min(sites.length, perGroup, remaining);
        out.push(take === sites.length ? group : { ...group, sites: sites.slice(0, take) });
        remaining -= take;
    }
    return out;
}

/**
 * 真正渲染的分组列表：开启「最近访问」且确有内容时，把它按当前筛选 / 搜索前置。
 * 没有任何命中时退回原始分组，保证界面不为空。
 */
export function deriveDisplayedGroups(
    renderGroups: GroupWithSites[],
    favoritesEnabled: boolean,
    favoritesGroup: GroupWithSites,
    query: string,
    matchFilters: (site: Site) => boolean,
    usePinyin: boolean
): GroupWithSites[] {
    if (!favoritesEnabled || favoritesGroup.sites.length === 0) return renderGroups;

    const favSites = favoritesGroup.sites.filter(
        site => matchFilters(site) && (!query || matchesSiteQuery(site, query, usePinyin))
    );

    if (favSites.length === 0) return renderGroups;
    return [{ ...favoritesGroup, sites: favSites }, ...renderGroups];
}
