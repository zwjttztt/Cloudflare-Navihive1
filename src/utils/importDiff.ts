// src/utils/importDiff.ts
// 导入备份前的差异计算：先告诉用户「这份备份会带来什么」，再让他挑要导入哪些。
// 比对口径：
// - 分组按 id 比；站点先按 id 比，id 对不上再退回「同链接 + 同分组」
// - 「将删除」只在覆盖恢复（overwrite）时才有意义：现有数据里没出现在这份备份中的条目
import { ExportData, Site } from "../API/http";
import { GroupWithSites } from "../types";
import { urlKey } from "./duplicate";

export type DiffStatus = "added" | "updated" | "unchanged" | "removed";

export interface DiffEntry {
    kind: "group" | "site";
    /** 勾选用的稳定 key，同时用于回查对应哪一条数据 */
    key: string;
    status: DiffStatus;
    name: string;
    /** 副标题：站点显示链接，分组显示排序号 */
    detail: string;
    /** 站点所属分组的 key（分组被取消勾选时，它的站点一起不导入） */
    groupKey?: string;
}

export interface ImportDiff {
    /** 与 incoming.groups 一一对应 */
    groupEntries: DiffEntry[];
    /** 与 incoming.sites 一一对应 */
    siteEntries: DiffEntry[];
    /** 覆盖恢复时会被清掉的现有条目（只是提示，不参与勾选） */
    removedGroups: string[];
    removedSites: string[];
    counts: Record<DiffStatus, number>;
}

export const STATUS_LABEL: Record<DiffStatus, string> = {
    added: "新增",
    updated: "更新",
    unchanged: "无变化",
    removed: "将删除",
};

/** 站点内容指纹：这些字段里有一个不同，就算「更新」 */
const siteFingerprint = (site: Site) =>
    [
        site.name ?? "",
        site.url ?? "",
        site.icon ?? "",
        site.description ?? "",
        site.notes ?? "",
        site.username ?? "",
        site.password ?? "",
        String(site.group_id ?? ""),
        String(site.order_num ?? ""),
    ].join("");

export function computeImportDiff(
    current: GroupWithSites[],
    incoming: ExportData,
    overwrite: boolean
): ImportDiff {
    const currentGroups = current;
    const currentSites = current.flatMap(group => group.sites ?? []);

    const groupById = new Map(currentGroups.map(g => [String(g.id), g]));
    const siteById = new Map(currentSites.map(s => [String(s.id), s]));
    // 同链接 + 同分组也算同一张卡片（合并导入时 id 通常是全新分配的）
    const siteByUrl = new Map(
        currentSites.map(s => [`${s.group_id ?? ""}|${urlKey(s.url)}`, s])
    );

    const counts: Record<DiffStatus, number> = {
        added: 0,
        updated: 0,
        unchanged: 0,
        removed: 0,
    };
    const bump = (status: DiffStatus) => {
        counts[status] += 1;
    };

    // ---- 分组 ----
    const groupEntries: DiffEntry[] = (incoming.groups ?? []).map((group, index) => {
        const key = `group:${group.id ?? `new-${index}`}`;
        const prev = group.id != null ? groupById.get(String(group.id)) : undefined;
        const status: DiffStatus = !prev
            ? "added"
            : prev.name === group.name && (prev.order_num ?? 0) === (group.order_num ?? 0)
              ? "unchanged"
              : "updated";
        bump(status);
        return {
            kind: "group",
            key,
            status,
            name: group.name || "未命名分组",
            detail: `排序 ${group.order_num ?? 0}`,
        };
    });

    // ---- 站点 ----
    const siteEntries: DiffEntry[] = (incoming.sites ?? []).map((site, index) => {
        const key = `site:${site.id ?? `new-${index}`}`;
        const byId = site.id != null ? siteById.get(String(site.id)) : undefined;
        const byUrl = siteByUrl.get(`${site.group_id ?? ""}|${urlKey(site.url)}`);
        const prev = byId ?? byUrl;
        const status: DiffStatus = !prev
            ? "added"
            : siteFingerprint(prev) === siteFingerprint(site)
              ? "unchanged"
              : "updated";
        bump(status);

        const ownerGroup = (incoming.groups ?? []).find(g => g.id === site.group_id);
        return {
            kind: "site",
            key,
            status,
            name: site.name || site.url || "未命名站点",
            detail: ownerGroup?.name || "未分组",
            groupKey: ownerGroup ? `group:${ownerGroup.id ?? `new-${(incoming.groups ?? []).indexOf(ownerGroup)}`}` : undefined,
        };
    });

    // ---- 覆盖恢复会被清掉的现有数据 ----
    const removedGroups: string[] = [];
    const removedSites: string[] = [];
    if (overwrite) {
        const incomingGroupIds = new Set(
            (incoming.groups ?? []).map(g => (g.id != null ? String(g.id) : ""))
        );
        const incomingSiteKeys = new Set(
            (incoming.sites ?? []).map(s => `${s.group_id ?? ""}|${urlKey(s.url)}`)
        );

        for (const group of currentGroups) {
            if (!incomingGroupIds.has(String(group.id))) removedGroups.push(group.name || "未命名分组");
        }
        for (const site of currentSites) {
            if (!incomingSiteKeys.has(`${site.group_id ?? ""}|${urlKey(site.url)}`)) {
                removedSites.push(site.name || site.url || "未命名站点");
            }
        }
        counts.removed = removedGroups.length + removedSites.length;
    }

    return { groupEntries, siteEntries, removedGroups, removedSites, counts };
}

/** 默认勾选：新增和更新（无变化的也默认带上，用户想精简再自己取消） */
export function defaultSelection(diff: ImportDiff): Set<string> {
    const selected = new Set<string>();
    for (const entry of [...diff.groupEntries, ...diff.siteEntries]) {
        if (entry.status !== "unchanged") selected.add(entry.key);
    }
    // 一个都不勾选时反而容易让人以为出错了，全选一遍更直观
    if (selected.size === 0) {
        for (const entry of [...diff.groupEntries, ...diff.siteEntries]) selected.add(entry.key);
    }
    return selected;
}

/** 按勾选结果裁剪备份数据，得到真正要导入的那份 */
export function applyImportSelection(
    data: ExportData,
    diff: ImportDiff,
    selected: Set<string>
): ExportData {
    const groupKeys = new Set(
        diff.groupEntries.filter(entry => selected.has(entry.key)).map(entry => entry.key)
    );

    const groups = (data.groups ?? []).filter(
        (_group, index) => groupKeys.has(diff.groupEntries[index]?.key ?? "")
    );
    const sites = (data.sites ?? []).filter((_site, index) => {
        const entry = diff.siteEntries[index];
        if (!entry || !selected.has(entry.key)) return false;
        // 所属分组没被勾选，这张卡片也不导入（不然会落到不存在的分组里）
        if (entry.groupKey && !groupKeys.has(entry.groupKey)) return false;
        return true;
    });

    return { ...data, groups, sites };
}
