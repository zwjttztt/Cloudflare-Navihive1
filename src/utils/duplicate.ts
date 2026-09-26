// src/utils/duplicate.ts
// 重复网址检测：新增/编辑卡片时，先看看这个链接是不是已经加过了。
// 同一个站点在多个分组里各存一份，删的时候很容易漏删，所以提前拦一下。
import { Site } from "../API/http";
import { GroupWithSites } from "../types";
import { normalizeSearchText } from "./search";

/**
 * 网址归一：去掉协议头、www. 和末尾斜杠之类的差异，只留「是不是同一个地址」的信息。
 * 例：https://www.A.com/Path/ 与 a.com/path 会归一成同一个 key。
 * 查询串（?a=1）保留，因为不同参数通常就是不同页面。
 */
export const urlKey = (url?: string | null): string => {
    const raw = (url || "").trim();
    if (!raw) return "";
    return normalizeSearchText(raw).replace(/\s+/g, "");
};

export interface DuplicateHit {
    site: Site;
    groupName: string;
}

/** 在所有分组里找同链接的卡片；excludeId 用来排除「正在编辑的这张自己」 */
export function findDuplicateSite(
    groups: GroupWithSites[],
    url?: string,
    excludeId?: number | string
): DuplicateHit | null {
    const key = urlKey(url);
    if (!key) return null;

    for (const group of groups) {
        for (const site of group.sites ?? []) {
            if (excludeId != null && excludeId !== undefined && String(site.id) === String(excludeId)) {
                continue;
            }
            if (urlKey(site.url) === key) {
                return { site, groupName: group.name || "未命名分组" };
            }
        }
    }
    return null;
}

/** 一批链接里互相重复的分组（导入预览用）：key -> 站点列表 */
export function groupByUrlKey(sites: Site[]): Map<string, Site[]> {
    const map = new Map<string, Site[]>();
    for (const site of sites) {
        const key = urlKey(site.url);
        if (!key) continue;
        const list = map.get(key) ?? [];
        list.push(site);
        map.set(key, list);
    }
    return map;
}
