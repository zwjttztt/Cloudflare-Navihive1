// 批量操作里那些「算错了界面就会说谎」的判定。
//
// 从 useBulkActions 抽出来的纯计算。批量移动是唯一一处**同时改服务端与本地快照**
// 的地方，写歪了的表现非常隐蔽：界面上卡片已经搬走了，刷新一看还在原处 ——
// 用户以为操作成功，其实是本地快照骗了他。

import type { GroupWithSites } from "../types";
import type { Site } from "../API/http";

/** 一条排序更新请求 */
export interface SiteOrderItem {
    id: number;
    order_num: number;
    group_id: number;
}

/** 目标分组里现有的最大排序号（空分组是 -1） */
export function maxOrderNum(sites: Site[]): number {
    return sites.reduce((max, site) => Math.max(max, site.order_num ?? 0), -1);
}

/**
 * 算「搬进目标分组后，每张卡片该排第几」。
 *
 * 追加到目标分组末尾（现有最大排序号 +1 起），顺序沿用勾选顺序。
 * 空分组的 maxOrder 是 -1，所以第一张落到 0 —— 不能写成 0 起，
 * 否则把卡片搬进空分组时会和目标分组里已有的第 0 张撞号。
 */
export function planBulkMoveOrders(
    selectedIds: number[],
    targetSites: Site[],
    groupId: number
): SiteOrderItem[] {
    const base = maxOrderNum(targetSites) + 1;
    return selectedIds.map((id, idx) => ({
        id,
        order_num: base + idx,
        group_id: groupId,
    }));
}

/**
 * 按服务端「真正写进去了哪些」重排号。
 *
 * D1 没有跨语句事务，一批里失败几条是真实存在的。只给成功的那几条编号，
 * 且**不留空洞**（1、2、4 要压成 1、2、3）—— 否则排序号会随时间越拉越稀。
 */
export function renumberMoved(
    orders: SiteOrderItem[],
    updated: number[]
): Map<number, number> {
    const movedIds = new Set(updated);
    const map = new Map<number, number>();
    const base = orders.length > 0 ? orders[0].order_num : 0;
    let cursor = base;
    for (const item of orders) {
        if (!movedIds.has(item.id)) continue;
        map.set(item.id, cursor++);
    }
    return map;
}

/**
 * 把「真正移动成功的那批卡片」在本地快照里搬家。
 *
 * 只有进 `movedOrder` 的卡片会动 —— 照全量更新会变成「库里没动、界面先动了」，
 * 用户刷新一下才发现少了一半，还不如当场说清楚。
 */
export function applyBulkMoveToGroups(
    groups: GroupWithSites[],
    movedOrder: Map<number, number>,
    groupId: number
): GroupWithSites[] {
    // 一个都没写进去：界面一个都不该动。早退还顺带省掉一次全量重渲染
    if (movedOrder.size === 0) return groups;

    const moving = groups
        .flatMap(group => group.sites)
        .filter((site): site is Site & { id: number } => site.id !== undefined && movedOrder.has(site.id))
        .map(site => ({
            ...site,
            group_id: groupId,
            order_num: movedOrder.get(site.id) ?? site.order_num,
        }));

    return groups.map(group => {
        const kept = group.sites.filter(site => !movedOrder.has(site.id as number));
        if (group.id === groupId) {
            return {
                ...group,
                sites: [...kept, ...moving].sort(
                    (a, b) => (a.order_num ?? 0) - (b.order_num ?? 0)
                ),
            };
        }
        return kept.length === group.sites.length ? group : { ...group, sites: kept };
    });
}

/**
 * 「删掉这个标签」会影响哪些卡片。
 *
 * 标签表的键是 JSON 的对象键，一定是字符串；判重也要按字符串比 ——
 * 直接拿数字 id 去比会一个都匹配不上，表现为「删了标签但卡片上还在」。
 */
export function pickSitesWithTag(tags: Record<string, string[]>, tag: string): number[] {
    const affected: number[] = [];
    for (const [siteId, list] of Object.entries(tags)) {
        if (!list.includes(tag)) continue;
        const id = Number(siteId);
        if (Number.isFinite(id)) affected.push(id);
    }
    return affected;
}
