// src/hooks/useBookmarkImport.ts
// 「书签导入」的写库这一段：建分组 → 并发建卡片 → 刷新 → 提示。
//
// 解析（utils/bookmarks.ts）、差异（utils/importDiff.ts）、预览（ImportPreviewDialog）
// 三处都有用例，唯独这层胶水没有 —— 而它恰好是「点确认之后到底往库里写了什么」的
// 地方。搬出来不是为了省行数（也就四十行），是为了让这层能被单独测到。
//
// 几个不能改的细节都写在注释里了：同名的文件夹要复用已有分组而不是新建、
// 并发要有上限（一次性几百个请求会把 Worker 打爆）、导入完要静默刷新。
import { useCallback } from "react";
import type { Group, Site } from "../API/http";
import { mapWithConcurrency } from "../API/methods/transfer";
import { resolveIconApiUrl } from "../utils/iconApi";
import type { ParsedBookmarkGroup } from "../utils/bookmarks";
import type { GroupWithSites } from "../types";
import type { NotifySeverity } from "./useNotify";

/** 并发上限：一次拖进来几百个书签也不该同一时刻全发出去 */
export const BOOKMARK_IMPORT_CONCURRENCY = 6;

/** 本域用到的后端方法，单测里可以塞假实现 */
export type BookmarkImportApi = {
    createGroup(input: Group): Promise<Group | undefined>;
    createSite(input: Site): Promise<Site | undefined>;
};

type UseBookmarkImportParams = {
    api: BookmarkImportApi;
    groups: GroupWithSites[];
    /** 图标 API 模板（来自网站设置） */
    iconApi: string;
    /** 导入完重新拉一次数据（来自 useSites，返回值不关心） */
    refresh: (opts?: { silent?: boolean }) => Promise<unknown>;
    onNotify: (message: string, level?: NotifySeverity) => void;
};

export function useBookmarkImport({
    api,
    groups,
    iconApi,
    refresh,
    onNotify,
}: UseBookmarkImportParams) {
    const importBookmarks = useCallback(
        async (parsed: ParsedBookmarkGroup[]) => {
            let created = 0;
            let groupSeq = 0;
            const iconTemplate = (iconApi || "").trim();

            for (const folder of parsed) {
                if (folder.items.length === 0) continue;
                // 同名文件夹复用已有分组：浏览器导出的书签里「书签栏」很常见，
                // 每次导入都新建一个的话，库里会躺一排同名的分组
                let target = groups.find(g => g.name === folder.folder);
                if (!target) {
                    const saved = await api.createGroup({
                        name: folder.folder,
                        order_num: groups.length + groupSeq,
                    } as Group);
                    groupSeq += 1;
                    target = { ...saved, sites: [] } as GroupWithSites;
                }
                const baseOrder = target.sites?.length ?? 0;
                const groupId = target.id;
                const done = await mapWithConcurrency(
                    folder.items,
                    BOOKMARK_IMPORT_CONCURRENCY,
                    async (item, idx) => {
                        await api.createSite({
                            // 书签标题可能很长，截断到和手动新建一致的长度
                            name: item.title.slice(0, 60),
                            url: item.url,
                            icon: resolveIconApiUrl(iconTemplate, item.url),
                            description: "",
                            group_id: groupId,
                            order_num: baseOrder + idx,
                        } as Site);
                        return 1;
                    }
                );
                created += done.length;
            }

            // 静默刷新：导入过程本身没有加载态，再弹一个会显得卡
            await refresh({ silent: true });
            onNotify(`已导入 ${created} 个网站`, "success");
            return created;
        },
        [api, groups, iconApi, refresh, onNotify]
    );

    return { importBookmarks };
}
