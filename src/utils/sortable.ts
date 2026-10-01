// src/utils/sortable.ts
// 拖拽排序的纯计算部分：从 App.tsx 里搬出来的那 200 多行里，真正有逻辑的是这三件事
// ——「分组怎么重排」「站点怎么跨组移动」「保存时提交给后端的顺序长什么样」。
//
// 为什么要单独拆成纯函数：拖拽过程中 dragOver 会**每秒触发几十次**，
// 每次都要判断「位置没变就不动」，一旦算错就会让全部分组拿到新引用、
// 整页卡片重渲染（拖起来一卡一卡的）。这种「返回值必须是原引用」的约定，
// 只有纯函数才好测。用例在 tests/sortable.test.ts。
//
// 这里刻意不 import @dnd-kit 的 arrayMove：那个包会连带把 React 拉进来，
// 纯 node 单测里没必要，而且 arrayMove 本身就是三次 splice。
import type { GroupWithSites } from "../types";
import type { Site } from "../API/http";

/** 把 oldIndex 处的元素搬到 newIndex 处，返回新数组（等价于 @dnd-kit 的 arrayMove） */
function arrayMove<T>(list: readonly T[], oldIndex: number, newIndex: number): T[] {
    const next = [...list];
    const [item] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, item);
    return next;
}

/** dnd-kit 的拖拽 id 约定：站点是 `site-<id>`，分组是 `group-<id>` */
const SITE_PREFIX = "site-";
const GROUP_PREFIX = "group-";

function parseId(id: string, prefix: string): number | undefined {
    if (!id.startsWith(prefix)) return undefined;
    const n = Number(id.slice(prefix.length));
    return Number.isFinite(n) ? n : undefined;
}

/**
 * 分组整体重排（分组排序模式下的 onDragEnd）。
 * 拖拽到分组自身的卡片上、或 id 对不上时返回**原数组引用**，让 React 跳过重渲染。
 */
export function moveGroupByDrag(
    groups: GroupWithSites[],
    activeId: string,
    overId: string
): GroupWithSites[] {
    if (!overId || activeId === overId) return groups;
    const oldIndex = groups.findIndex(g => g.id.toString() === activeId);
    const newIndex = groups.findIndex(g => g.id.toString() === overId);
    if (oldIndex === -1 || newIndex === -1) return groups;
    return arrayMove(groups, oldIndex, newIndex);
}

/**
 * 分组按「上移 / 下移一位」重排 —— 拖拽的键盘 / 按钮替代。
 *
 * 拖拽不是人人可用：触屏长按容易误触、读屏用户拿不到指针事件、键盘拖拽要靠
 * 空格 + 方向键这套不显眼的组合。给每个分组一对上下按钮，顺序调整就有了
 * 一条「看得见、点得到」的路。到头的方向返回原数组引用，React 直接跳过重渲染。
 */
export function moveGroupByStep(
    groups: GroupWithSites[],
    groupId: string,
    delta: number
): GroupWithSites[] {
    if (delta !== -1 && delta !== 1) return groups;
    const index = groups.findIndex(g => g.id.toString() === groupId);
    if (index === -1) return groups;
    const target = index + delta;
    if (target < 0 || target >= groups.length) return groups;
    return arrayMove(groups, index, target);
}

/** 站点列表内按「前移 / 后移一位」重排（分组内排序模式用） */
export function moveSiteByStep(sites: Site[], index: number, delta: number): Site[] {
    if (delta !== -1 && delta !== 1) return sites;
    if (index < 0 || index >= sites.length) return sites;
    const target = index + delta;
    if (target < 0 || target >= sites.length) return sites;
    return arrayMove(sites, index, target);
}

/**
 * 站点跨分组拖拽：同一分组内重排，跨分组则把卡片移动到目标分组。
 *
 * 只重建受影响的分组对象（同组 1 个、跨组 2 个），其它分组保持原引用。
 * 任何「没得动」的情况都返回**原数组引用** —— dragOver 高频触发时靠这个兜住性能。
 */
export function moveSiteAcrossGroups(
    groups: GroupWithSites[],
    activeId: string,
    overId: string
): GroupWithSites[] {
    if (!overId || activeId === overId) return groups;
    const activeSiteId = parseId(activeId, SITE_PREFIX);
    if (activeSiteId === undefined) return groups;

    // 悬停在另一张卡片上 → 插到它前面；悬停在分组容器上 → 追加到末尾
    const overSiteId = parseId(overId, SITE_PREFIX);
    const overGroupId = overSiteId === undefined ? parseId(overId, GROUP_PREFIX) : undefined;

    const activeContainerIdx = groups.findIndex(g => g.sites.some(s => s.id === activeSiteId));
    if (activeContainerIdx === -1) return groups;

    let overContainerIdx: number;
    let overIndex: number;
    if (overSiteId !== undefined) {
        overContainerIdx = groups.findIndex(g => g.sites.some(s => s.id === overSiteId));
        if (overContainerIdx === -1) return groups;
        overIndex = groups[overContainerIdx].sites.findIndex(s => s.id === overSiteId);
        if (overIndex === -1) return groups;
    } else if (overGroupId !== undefined) {
        overContainerIdx = groups.findIndex(g => g.id === overGroupId);
        if (overContainerIdx === -1) return groups;
        overIndex = groups[overContainerIdx].sites.length;
    } else {
        return groups;
    }

    const moved = groups[activeContainerIdx].sites.find(s => s.id === activeSiteId);
    if (!moved) return groups;

    // 同一分组内重排：只克隆这一个分组
    if (activeContainerIdx === overContainerIdx) {
        const siteList = groups[activeContainerIdx].sites;
        const oldIndex = siteList.findIndex(s => s.id === activeSiteId);
        // 索引要夹到列表内：overIndex 可能是「末尾」语义（= length）
        const newIndex = Math.min(overIndex, siteList.length - 1);
        if (oldIndex === -1 || oldIndex === newIndex) return groups;
        const next = [...groups];
        next[activeContainerIdx] = {
            ...groups[activeContainerIdx],
            sites: arrayMove(siteList, oldIndex, newIndex),
        };
        return next;
    }

    // 跨分组移动：改来源分组和目标分组两个对象，group_id 同步改写
    const next = [...groups];
    const movedSite: Site = { ...moved, group_id: groups[overContainerIdx].id };
    next[activeContainerIdx] = {
        ...groups[activeContainerIdx],
        sites: groups[activeContainerIdx].sites.filter(s => s.id !== activeSiteId),
    };
    const target = groups[overContainerIdx].sites;
    const insertIdx = Math.min(overIndex, target.length);
    next[overContainerIdx] = {
        ...groups[overContainerIdx],
        sites: [...target.slice(0, insertIdx), movedSite, ...target.slice(insertIdx)],
    };
    return next;
}

/** 提交给 api.updateSiteOrder 的一条记录：跨组移动时才带 group_id */
export type SiteOrderItem = {
    id: number;
    order_num: number;
    group_id?: number;
};

/**
 * 构造「一次批量请求」的顺序数据：所有分组的卡片顺序 + 跨组移动合成**一个**数组。
 *
 * `originalGroup` 是进入排序模式那一刻记录的「站点 id → 原分组 id」快照，
 * 用它判断某张卡片是否被拖到了别的分组：只有真跨组了才带 group_id，
 * 没带的话后端就只改 order_num（少一次归属变更、也少一次越权校验）。
 * 快照里没有记录的卡片（比如排序期间刚新建、还没落库的）同样不带 group_id。
 */
export function buildSiteOrderPayload(
    groups: GroupWithSites[],
    originalGroup: ReadonlyMap<number, number>
): SiteOrderItem[] {
    const orders: SiteOrderItem[] = [];
    groups.forEach(g => {
        g.sites.forEach((site, idx) => {
            const id = site.id as number;
            const fromGroup = originalGroup.get(id);
            const moved = fromGroup !== undefined && fromGroup !== g.id;
            orders.push(moved ? { id, order_num: idx, group_id: g.id } : { id, order_num: idx });
        });
    });
    return orders;
}
