// 分组数组的纯变换：把「卡片写入 / 移除」这类只依赖 prev state 的计算从 App.tsx 里摘出来。
//
// 抽出来的理由：这些逻辑原本内联在 setGroups(prev => ...) 的回调里，是 App.tsx 里少数
// 「完全自洽、不碰任何其它状态」的部分——但写在组件里就没法单测。放到这里之后
// tests/siteMutations.test.ts 可以直接跑，组件侧只剩一行 setGroups(prev => f(prev, ...))。
//
// 引用稳定性是硬要求：没有实际变化时必须原样返回入参，否则被 memo 的 GroupCard / SiteCard
// 会因为无关改动整片重渲染（这是 App.tsx 里注释反复强调的性能前提）。
import type { Site } from "../API/http";
import type { GroupWithSites } from "../types";

/** 在分组数组里按 id 找一张卡片（跨分组遍历），找不到返回 null */
export function findSite(groups: GroupWithSites[], siteId: number): Site | null {
    for (const group of groups) {
        const hit = group.sites.find(site => site.id === siteId);
        if (hit) return hit;
    }
    return null;
}

/**
 * 把一张卡片写回分组数组：目标分组里已有就合并，没有就追加。
 *
 * 跨分组移动时额外做两件事：
 *   1. 排到目标分组末尾（沿用旧分组的 order_num 会和目标分组里的卡片撞号导致乱序）
 *   2. 从来源分组里移除
 *
 * 返回新的数组；没有命中任何分组时原样返回入参。
 */
export function upsertSite(groups: GroupWithSites[], site: Site): GroupWithSites[] {
    const targetIdx = groups.findIndex(group => group.id === site.group_id);
    const fromIdx = groups.findIndex(group => group.sites.some(item => item.id === site.id));
    // 跨分组移动：目标分组与来源分组不同
    const moved = fromIdx !== -1 && fromIdx !== targetIdx;

    let nextSite = site;
    if (moved && targetIdx !== -1) {
        const maxOrder = groups[targetIdx].sites.reduce(
            (max, item) => Math.max(max, item.order_num ?? 0),
            -1
        );
        nextSite = { ...site, order_num: maxOrder + 1 };
    }

    let changed = false;
    const next = groups.map((group, idx) => {
        if (idx === targetIdx) {
            const exists = group.sites.some(item => item.id === nextSite.id);
            const sites = exists
                ? group.sites.map(item =>
                      item.id === nextSite.id ? { ...item, ...nextSite } : item
                  )
                : [...group.sites, nextSite];
            changed = true;
            return {
                ...group,
                sites: [...sites].sort((a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)),
            };
        }

        // 站点被移动到了其他分组：从原分组移除
        if (moved && idx === fromIdx) {
            changed = true;
            return { ...group, sites: group.sites.filter(item => item.id !== site.id) };
        }

        return group;
    });

    return changed ? next : groups;
}

/** 从分组数组里移除一张卡片；没找到就原样返回入参 */
export function removeSite(groups: GroupWithSites[], siteId: number): GroupWithSites[] {
    let changed = false;
    const next = groups.map(group => {
        if (!group.sites.some(item => item.id === siteId)) return group;
        changed = true;
        return { ...group, sites: group.sites.filter(item => item.id !== siteId) };
    });
    return changed ? next : groups;
}

/** 批量移除（多选删除用）：只重建真正命中的分组，一次遍历搞定 */
export function removeSites(groups: GroupWithSites[], siteIds: number[]): GroupWithSites[] {
    if (siteIds.length === 0) return groups;
    const doomed = new Set(siteIds);
    let changed = false;
    const next = groups.map(group => {
        if (!group.sites.some(item => item.id !== undefined && doomed.has(item.id))) return group;
        changed = true;
        return {
            ...group,
            sites: group.sites.filter(item => item.id === undefined || !doomed.has(item.id)),
        };
    });
    return changed ? next : groups;
}
