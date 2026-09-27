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
