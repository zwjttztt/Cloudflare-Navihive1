// src/hooks/usePrefSync.ts
// 本机偏好「上传」到服务端的那一半（合并 / 应用留在 App 的 applyRemoteExtras 里）。
//
// 从 App.tsx 抽出来：四份数据、四段几乎同构的防抖 effect，散在文件里两头
// （失效检测与星标标签在中间，访问统计与折叠态在分组折叠那块之后），
// 加一个同步项就要在两处各补一段，很容易漏。收进来之后只在一个地方加。
//
// 共同规则：
//   - 上传失败一律静默 —— 同步是锦上添花，不能让网络问题干扰正常使用；
//   - 内容没变就不写库（`payload === 上次`） —— 打开开关时刚从服务端合并回来，
//     那一轮不该立刻再写一次；
//   - 防抖而不是直接发：拖星标、连着点十几张卡片都只合并成一次请求。
import { useEffect, useRef, type MutableRefObject } from "react";

import type { NavigationClient } from "../API/client";
import type { VisitStat } from "../context/UIPrefsContext";
import { onLocalPrefsChange } from "../context/UIPrefsContext";
import { exportLinkHealth, onLinkHealthChange } from "../utils/linkHealth";
import {
    LINK_HEALTH_CONFIG,
    PREF_COLLAPSED_CONFIG,
    PREF_STARRED_CONFIG,
    PREF_TAGS_CONFIG,
    PREF_VISITS_CONFIG,
    SYNC_DEBOUNCE_MS,
} from "../appDefaults";

export interface PrefSyncOptions {
    /**
     * 只要 `setConfig` 就行：真实客户端与本地演示客户端都有这个方法，
     * 写成结构化类型两边都能传（App 里 api 本身就是这两者的联合类型）。
     */
    api: Pick<NavigationClient, "setConfig">;
    /**
     * 「上次推上去的内容」缓存。由 App 创建并同时交给 useBackupController：
     * 打开同步开关时那边会立刻推一次并记下内容，这里才不会转头又原样推一遍。
     */
    lastHealthPushRef: MutableRefObject<string>;
    lastPrefPushRef: MutableRefObject<string>;
    /** 「失效检测结果」同步开关 */
    linkHealthSync: boolean;
    /** 「星标、标签与访问记录」同步开关 */
    prefSync: boolean;
    starred: number[];
    tags: Record<string, string[]>;
    /** 访问统计（哪条链接点过几次） */
    visits: Record<string, VisitStat>;
    /**
     * 上传成功后调用：把当前统计记为「已同步」。
     * 记了基线，下次合并才知道哪些是新点的；不记就会把已上传的次数重复累加。
     */
    onVisitsSynced: () => void;
    /** 当前折叠的分组 id */
    collapsedIds: string[];
}

/**
 * 把四份「只存本机、清缓存就没了」的数据按开关上传服务端。
 *
 * 两个开关各自管一摊：`pref.sync` 管星标 / 标签 / 访问统计 / 分组折叠，
 * `link.healthSync` 单独管失效检测（后者数据量大、重测成本不同，用户可能只想开一个）。
 *
 * 注意调用位置：这个 hook 要用到 collapsedIds，所以只能在 App 里 collapsedIds
 * 声明之后调用 —— 前面的 hook 顺序跟着一起后移，只要每渲染顺序一致就没问题。
 */
export function usePrefSync({
    api,
    lastHealthPushRef,
    lastPrefPushRef,
    linkHealthSync,
    prefSync,
    starred,
    tags,
    visits,
    onVisitsSynced,
    collapsedIds,
}: PrefSyncOptions): void {
    // ---- 失效检测结果 ----
    // 走 linkHealth 的变更回调而不是监听 state：检测结果只在「跑完一轮巡检」时变，
    // 用回调能正好在那一刻触发，不用依赖一个每次渲染都新建的对象。
    useEffect(() => {
        if (!linkHealthSync) {
            onLinkHealthChange(null);
            return;
        }
        let timer: number | undefined;
        onLinkHealthChange(() => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const payload = JSON.stringify(exportLinkHealth());
                if (payload === lastHealthPushRef.current) return;
                lastHealthPushRef.current = payload;
                void api.setConfig(LINK_HEALTH_CONFIG, payload).catch(() => {});
            }, SYNC_DEBOUNCE_MS);
        });
        return () => {
            onLinkHealthChange(null);
            if (timer) window.clearTimeout(timer);
        };
    }, [api, linkHealthSync, lastHealthPushRef]);

    // ---- 星标 / 标签 ----
    // 同样走回调（UIPrefsContext 在星标 / 标签变化时统一 emit）：
    // 改动的入口太多（批量加星、标签管理、导入……），监听 state 才一个不漏。
    useEffect(() => {
        if (!prefSync) {
            onLocalPrefsChange(null);
            return;
        }
        let timer: number | undefined;
        const push = () => {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const payload = JSON.stringify({ starred, tags });
                if (payload === lastPrefPushRef.current) return;
                lastPrefPushRef.current = payload;
                void Promise.all([
                    api.setConfig(PREF_STARRED_CONFIG, JSON.stringify(starred)),
                    api.setConfig(PREF_TAGS_CONFIG, JSON.stringify(tags)),
                ]).catch(() => {});
            }, SYNC_DEBOUNCE_MS);
        };
        onLocalPrefsChange(push);
        return () => {
            onLocalPrefsChange(null);
            if (timer) window.clearTimeout(timer);
        };
    }, [api, prefSync, starred, tags, lastPrefPushRef]);

    // ---- 访问统计 ----
    // 不走 onLocalPrefsChange（那条只盯星标 / 标签），自己防抖：
    // 连着点十几张卡片只会合并成一次写库。
    const lastVisitsPushRef = useRef("");
    useEffect(() => {
        if (!prefSync) return;
        const timer = window.setTimeout(() => {
            const payload = JSON.stringify(visits);
            // 刚从服务端合并回来的那份内容一样，不必再写一次
            if (payload === lastVisitsPushRef.current) return;
            lastVisitsPushRef.current = payload;
            // 只有真的写进服务端了才记基线：写失败时本机这份还没同步出去，
            // 记成已同步的话，这几次访问就永远补不回去了。
            void api
                .setConfig(PREF_VISITS_CONFIG, payload)
                .then(() => onVisitsSynced())
                .catch(() => {});
        }, SYNC_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [api, prefSync, visits, onVisitsSynced]);

    // ---- 分组折叠 ----
    // 与访问统计不同，它是「当前状态」而不是累计量：以最后一次操作为准，
    // 服务端那份拉下来时由 applyRemoteExtras 直接覆盖本机。
    const lastCollapsedPushRef = useRef("");
    useEffect(() => {
        if (!prefSync) return;
        const timer = window.setTimeout(() => {
            const payload = JSON.stringify(collapsedIds);
            if (payload === lastCollapsedPushRef.current) return;
            lastCollapsedPushRef.current = payload;
            void api.setConfig(PREF_COLLAPSED_CONFIG, payload).catch(() => {});
        }, SYNC_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [api, prefSync, collapsedIds]);
}
