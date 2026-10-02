// src/context/UIPrefsContext.tsx
// UI 偏好的 Provider —— 这个文件现在**只导出组件**。
//
// 为什么拆：以前 context 对象、hook、存储键、纯函数跟 Provider 挤在同一个文件里，
// eslint 的 react-refresh/only-export-components 会逐条报警（一个文件混着组件与非组件导出，
// 热更新就只能退成整页刷新）。近千行的文件里那些警告没人会真去修，于是它们长期停在 10+ 条。
// 现在非组件的全部搬到 ./uiPrefsStore.ts，这边只剩 Provider 一个 export。
//
// 消费方要 hook / 常量请直接从 uiPrefsStore 引，不要再从这里 import ——
// 那会把 Provider 组件拖进它们的模块图（还顺带绕开了这次的拆分）。

import React, { useMemo, useState, useCallback, useEffect } from "react";
import {
    DENSITY_KEY,
    FAVORITES_KEY,
    FONT_SCALE_KEY,
    GLASS_KEY,
    ICON_PRIVACY_KEY,
    LITE_KEY,
    OFFLINE_FULL_KEY,
    PINYIN_KEY,
    PREF_SYNC_KEY,
    PrefsContext,
    RADIUS_KEY,
    RAIL_COLLAPSED_KEY,
    SEARCH_HISTORY_MAX,
    StableContext,
    VIEW_KEY,
    VisitStat,
    VisitsContext,
    emitPrefsChange,
    mergeVisitStats,
    readSearchHistory,
    readStarred,
    readString,
    readSyncedVisits,
    readTags,
    readVisits,
    scopedSearchKey,
    scopedStarredKey,
    scopedTagsKey,
    scopedVisitsKey,
    setPrefUid,
    write,
    writeSyncedVisits,
} from "./uiPrefsStore";
import {
    UIPrefsContext,
    ViewMode,
    Density,
    RadiusStyle,
    FontScale,
    dayKey,
} from "./uiPrefsStore";
import type { TagMap } from "../utils/tagOps";
import { readDeadLinks } from "../utils/linkHealth";
import type { LocalPrefsBackup } from "../API/http";



export function UIPrefsProvider({ children }: { children: React.ReactNode }) {
    const [viewMode, setViewModeState] = useState<ViewMode>(() => {
        const v = readString(VIEW_KEY, "card");
        return v === "list" || v === "wall" ? v : "card";
    });
    const [density, setDensityState] = useState<Density>(() =>
        readString(DENSITY_KEY, "comfortable") === "compact" ? "compact" : "comfortable"
    );
    const [favoritesEnabled, setFavoritesState] = useState<boolean>(
        () => readString(FAVORITES_KEY, "1") !== "0"
    );
    // 拼音搜索默认关闭：词典是按需加载的，不打开就不进包
    const [pinyinSearch, setPinyinState] = useState<boolean>(
        () => readString(PINYIN_KEY, "0") === "1"
    );
    // 毛玻璃默认开：关掉只是「换一种更省的合成方式」，本机偏好，不进数据库
    const [glassEffects, setGlassState] = useState<boolean>(
        () => readString(GLASS_KEY, "1") !== "0"
    );
    // 清爽模式默认关：多数设备跑得动完整效果，需要省电/老机器的人自己开
    const [liteMode, setLiteState] = useState<boolean>(
        () => readString(LITE_KEY, "0") === "1"
    );
    // 离线增强默认关：按需加载的意义就是「不点的功能不下载」，
    // 默认全预下来等于把那层优化白做了。要断网也能用全部功能，由用户自己打开。
    const [offlineFull, setOfflineFullState] = useState<boolean>(
        () => readString(OFFLINE_FULL_KEY, "0") === "1"
    );
    // 图标隐私模式默认关：默认行为不变（图标照常取），想要「不为图标访问外站」的人自己开
    const [iconPrivacy, setIconPrivacyState] = useState<boolean>(
        () => readString(ICON_PRIVACY_KEY, "0") === "1"
    );
    const [visits, setVisits] = useState<Record<string, VisitStat>>(readVisits);
    const [radius, setRadiusState] = useState<RadiusStyle>(() => {
        const v = readString(RADIUS_KEY, "soft");
        return v === "standard" || v === "sharp" ? v : "soft";
    });
    const [fontScale, setFontScaleState] = useState<FontScale>(() => {
        const v = readString(FONT_SCALE_KEY, "normal");
        return v === "compact" || v === "large" ? v : "normal";
    });
    // 失效链接存在 linkHealth 的 localStorage 里，这里只是为了让卡片能响应变化
    const [deadLinks, setDeadLinks] = useState<Record<string, number>>(() =>
        readDeadLinks()
    );
    const [searchHistory, setSearchHistory] = useState<string[]>(readSearchHistory);
    const [starred, setStarred] = useState<number[]>(readStarred);
    const [tags, setTags] = useState<Record<string, string[]>>(readTags);
    const [railCollapsed, setRailCollapsedState] = useState<boolean>(
        () => readString(RAIL_COLLAPSED_KEY, "0") === "1"
    );
    // 星标 / 标签是否同步到服务端。开关本身也只存本机：它决定的是「这份数据要不要外传」
    const [prefSync, setPrefSyncState] = useState<boolean>(
        () => readString(PREF_SYNC_KEY, "0") === "1"
    );

    const setPrefSync = useCallback((enabled: boolean) => {
        setPrefSyncState(enabled);
        write(PREF_SYNC_KEY, enabled ? "1" : "0");
    }, []);

    /** 合并服务端下发的星标 / 标签：取并集，绝不减掉本机已有的 */
    const mergeRemotePrefs = useCallback(
        (incomingStarred: number[], incomingTags: Record<string, string[]>) => {
            const cleanStarred = (Array.isArray(incomingStarred) ? incomingStarred : []).filter(
                id => typeof id === "number" && Number.isFinite(id)
            );
            if (cleanStarred.length > 0) {
                setStarred(prev => {
                    const next = [...new Set([...prev, ...cleanStarred])];
                    write(scopedStarredKey(), JSON.stringify(next));
                    return next;
                });
            }

            if (incomingTags && typeof incomingTags === "object") {
                setTags(prev => {
                    const next: Record<string, string[]> = { ...prev };
                    let changed = false;
                    for (const [siteId, list] of Object.entries(incomingTags)) {
                        if (!Array.isArray(list)) continue;
                        const clean = [
                            ...new Set(
                                list
                                    .filter(t => typeof t === "string" && t.trim().length > 0)
                                    .map(t => t.trim())
                            ),
                        ];
                        if (clean.length === 0) continue;
                        const merged = [...new Set([...(next[siteId] ?? []), ...clean])];
                        if (merged.length !== (next[siteId] ?? []).length) {
                            next[siteId] = merged;
                            changed = true;
                        }
                    }
                    if (!changed) return prev;
                    write(scopedTagsKey(), JSON.stringify(next));
                    return next;
                });
            }
        },
        []
    );

    /**
     * 合并服务端下发的访问统计（语义见 mergeVisitStats 的说明）。
     *
     * 合完这份就是「本机与服务端一致」的状态，所以顺手记成新的同步基线 ——
     * 下次再合并时，本机多出来的那几下才是真正的增量。
     */
    const mergeRemoteVisits = useCallback((incoming: Record<string, VisitStat>) => {
        if (!incoming || typeof incoming !== "object") return;
        setVisits(prev => {
            const next = mergeVisitStats(prev, incoming, readSyncedVisits());
            // 合并结果写回本机：下一秒断网也不至于把刚拉下来的丢掉
            write(scopedVisitsKey(), JSON.stringify(next));
            writeSyncedVisits(next);
            return next;
        });
    }, []);

    /**
     * 上传成功之后调用：把当前这份记为「已同步」。
     *
     * 是关键的一步也是容易漏的一步：不记基线，下次合并就会把已经上传过的次数
     * 再当增量加一遍，越同步越高；反过来，上传失败时绝不能记（usePrefSync 那头
     * 只在 resolve 之后才调这个）。
     */
    const markVisitsSynced = useCallback(() => {
        setVisits(prev => {
            writeSyncedVisits(prev);
            return prev;
        });
    }, []);

    /**
     * 切换账号：把「按账号分开存」的那几份本机数据整体换成新账号的。
     *
     * 不做这件事的后果很隐蔽：星标与标签记的是站点 id，不同账号的 id 会撞号，
     * 于是 B 登录后会看到 A 加过的星标亮在自己（编号相同、实际不同）的卡片上。
     * 外观类偏好不在这里动 —— 那是这台机器的习惯，换账号不该跟着变。
     */
    const setPrefsAccountUid = useCallback((uid: number | null) => {
        setPrefUid(uid);
        setVisits(readVisits());
        setSearchHistory(readSearchHistory());
        setStarred(readStarred());
        setTags(readTags());
    }, []);

    // 星标 / 标签一变就通知外部（App 用它做防抖上传）。
    // 挂在这里而不是每个 setter 里调用，是因为改动的入口太多（批量加星、标签管理、导入……），
    // 监听这两个 state 才能一个不漏。
    useEffect(() => {
        emitPrefsChange();
    }, [starred, tags]);

    const setViewMode = useCallback((mode: ViewMode) => {
        setViewModeState(mode);
        write(VIEW_KEY, mode);
    }, []);

    const setDensity = useCallback((next: Density) => {
        setDensityState(next);
        write(DENSITY_KEY, next);
    }, []);

    const setFavoritesEnabled = useCallback((enabled: boolean) => {
        setFavoritesState(enabled);
        write(FAVORITES_KEY, enabled ? "1" : "0");
    }, []);

    const setPinyinSearch = useCallback((enabled: boolean) => {
        setPinyinState(enabled);
        write(PINYIN_KEY, enabled ? "1" : "0");
    }, []);

    const setGlassEffects = useCallback((enabled: boolean) => {
        setGlassState(enabled);
        write(GLASS_KEY, enabled ? "1" : "0");
    }, []);

    const setLiteMode = useCallback((enabled: boolean) => {
        setLiteState(enabled);
        write(LITE_KEY, enabled ? "1" : "0");
    }, []);

    const setIconPrivacy = useCallback((enabled: boolean) => {
        setIconPrivacyState(enabled);
        write(ICON_PRIVACY_KEY, enabled ? "1" : "0");
    }, []);

    const setOfflineFull = useCallback((enabled: boolean) => {
        setOfflineFullState(enabled);
        write(OFFLINE_FULL_KEY, enabled ? "1" : "0");
        // 通知 Service Worker：只有用户显式打开，才把懒加载的功能块也预下来
        if (enabled && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
            navigator.serviceWorker.ready
                .then(reg => reg.active?.postMessage({ type: "precache-lazy" }))
                .catch(() => {});
        }
    }, []);

    const recordVisit = useCallback((siteId?: number) => {
        if (!siteId) return;
        setVisits(prev => {
            const key = String(siteId);
            const old = prev[key];
            const today = dayKey();
            const next = {
                ...prev,
                [key]: {
                    count: (old?.count ?? 0) + 1,
                    last: Date.now(),
                    // 顺带记一笔「今天访问了几次」，供访问热力图使用
                    days: { ...(old?.days ?? {}), [today]: (old?.days?.[today] ?? 0) + 1 },
                },
            };
            try {
                localStorage.setItem(scopedVisitsKey(), JSON.stringify(next));
            } catch {
                // 忽略写入失败
            }
            return next;
        });
    }, []);

    const pushSearchHistory = useCallback((term: string) => {
        const trimmed = term.trim();
        if (!trimmed) return;
        setSearchHistory(prev => {
            const next = [trimmed, ...prev.filter(t => t !== trimmed)].slice(0, SEARCH_HISTORY_MAX);
            write(scopedSearchKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    const clearSearchHistory = useCallback(() => {
        setSearchHistory([]);
        try {
            localStorage.removeItem(scopedSearchKey());
        } catch {
            // 忽略
        }
    }, []);

    // 星标查询每次渲染要跑很多次（每张卡片一次），先转成 Set 再判断
    const starredSet = useMemo(() => new Set(starred), [starred]);
    const isStarred = useCallback(
        (siteId?: number) => (siteId ? starredSet.has(siteId) : false),
        [starredSet]
    );

    const toggleStar = useCallback((siteId?: number) => {
        if (!siteId) return;
        setStarred(prev => {
            const has = prev.includes(siteId);
            const next = has ? prev.filter(id => id !== siteId) : [...prev, siteId];
            write(scopedStarredKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    const setStarredMany = useCallback((siteIds: number[], starred: boolean) => {
        if (siteIds.length === 0) return;
        setStarred(prev => {
            const set = new Set(prev);
            siteIds.forEach(id => (starred ? set.add(id) : set.delete(id)));
            const next = [...set];
            write(scopedStarredKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    const setSiteTags = useCallback((siteId: number, nextTags: string[]) => {
        setTags(prev => {
            const clean = Array.from(
                new Set(nextTags.map(t => t.trim()).filter(Boolean))
            );
            const next = { ...prev };
            if (clean.length > 0) {
                next[String(siteId)] = clean;
            } else {
                delete next[String(siteId)];
            }
            write(scopedTagsKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    const addTagsToMany = useCallback((siteIds: number[], addTags: string[]) => {
        const wanted = Array.from(new Set(addTags.map(t => t.trim()).filter(Boolean)));
        if (siteIds.length === 0 || wanted.length === 0) return;
        setTags(prev => {
            const next = { ...prev };
            siteIds.forEach(id => {
                const key = String(id);
                const merged = Array.from(new Set([...(next[key] ?? []), ...wanted]));
                next[key] = merged;
            });
            write(scopedTagsKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    // 标签重命名 / 合并的结果：整份 map 一次写回
    const applyTagOps = useCallback((nextTags: TagMap) => {
        setTags(nextTags);
        write(scopedTagsKey(), JSON.stringify(nextTags));
    }, []);

    // 标签管理：把一个标签从所有卡片上摘掉（某张卡摘空后连键一起删）
    const removeTagFromAll = useCallback((tag: string) => {
        const want = tag.trim();
        if (!want) return;
        setTags(prev => {
            let changed = false;
            const next: Record<string, string[]> = {};
            for (const [key, list] of Object.entries(prev)) {
                if (!list.includes(want)) {
                    next[key] = list;
                    continue;
                }
                changed = true;
                const filtered = list.filter(t => t !== want);
                if (filtered.length > 0) next[key] = filtered;
            }
            if (!changed) return prev;
            write(scopedTagsKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    // 卡片被删除：它的标签与星标已经没有宿主，一并清掉，避免标签栏出现点不出来的标签
    const forgetSites = useCallback((siteIds: number[]) => {
        if (siteIds.length === 0) return;
        const keys = new Set(siteIds.map(String));

        setTags(prev => {
            let changed = false;
            const next = { ...prev };
            for (const key of keys) {
                if (key in next) {
                    delete next[key];
                    changed = true;
                }
            }
            if (!changed) return prev;
            write(scopedTagsKey(), JSON.stringify(next));
            return next;
        });

        setStarred(prev => {
            const next = prev.filter(id => !siteIds.includes(id));
            if (next.length === prev.length) return prev;
            write(scopedStarredKey(), JSON.stringify(next));
            return next;
        });
    }, []);

    // 标签统计：每个标签被几张卡片用着，标签栏排序与标签管理都靠它
    const tagCounts = useMemo(() => {
        const counter: Record<string, number> = {};
        for (const list of Object.values(tags)) {
            for (const tag of list) counter[tag] = (counter[tag] ?? 0) + 1;
        }
        return counter;
    }, [tags]);

    // 全部标签名：按被使用的站点数排序，标签栏里越常用的越靠前
    const allTags = useMemo(
        () =>
            Object.entries(tagCounts)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([tag]) => tag),
        [tagCounts]
    );

    const setRailCollapsed = useCallback((collapsed: boolean) => {
        setRailCollapsedState(collapsed);
        write(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
    }, []);

    const setRadius = useCallback((next: RadiusStyle) => {
        setRadiusState(next);
        write(RADIUS_KEY, next);
    }, []);

    const setFontScale = useCallback((next: FontScale) => {
        setFontScaleState(next);
        write(FONT_SCALE_KEY, next);
    }, []);

    const clearVisits = useCallback(() => {
        setVisits({});
        try {
            localStorage.removeItem(scopedVisitsKey());
        } catch {
            // 忽略
        }
    }, []);

    /**
     * 从备份文件恢复星标与标签。
     * replace：覆盖恢复（备份里是什么就是什么）；
     * merge：追加导入，和本机已有的取并集。
     */
    const restoreLocalPrefs = useCallback(
        (prefs: LocalPrefsBackup | undefined, mode: "replace" | "merge") => {
            const incomingStarred = Array.isArray(prefs?.starred)
                ? prefs!.starred!.filter(id => typeof id === "number" && Number.isFinite(id))
                : [];
            const incomingTags =
                prefs?.tags && typeof prefs.tags === "object" ? prefs.tags : {};

            setStarred(prev => {
                const set = new Set<number>(mode === "replace" ? [] : prev);
                incomingStarred.forEach(id => set.add(id));
                const next = [...set];
                write(scopedStarredKey(), JSON.stringify(next));
                return next;
            });

            setTags(prev => {
                const next: Record<string, string[]> = mode === "replace" ? {} : { ...prev };
                for (const [siteId, list] of Object.entries(incomingTags)) {
                    if (!Array.isArray(list)) continue;
                    const clean = list
                        .filter(t => typeof t === "string" && t.trim().length > 0)
                        .map(t => t.trim());
                    const merged =
                        mode === "replace"
                            ? Array.from(new Set(clean))
                            : Array.from(new Set([...(next[siteId] ?? []), ...clean]));
                    if (merged.length > 0) next[siteId] = merged;
                }
                write(scopedTagsKey(), JSON.stringify(next));
                return next;
            });
        },
        []
    );

    // 多标签页之间同步偏好
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === VIEW_KEY) {
                const v = e.newValue ?? "card";
                setViewModeState(v === "list" || v === "wall" ? v : "card");
            } else if (e.key === DENSITY_KEY) {
                setDensityState(e.newValue === "compact" ? "compact" : "comfortable");
            } else if (e.key === FAVORITES_KEY) {
                setFavoritesState((e.newValue ?? "1") !== "0");
            } else if (e.key === PINYIN_KEY) {
                setPinyinState((e.newValue ?? "0") === "1");
            } else if (e.key === scopedVisitsKey()) {
                setVisits(readVisits());
            } else if (e.key === RADIUS_KEY) {
                const v = e.newValue ?? "soft";
                setRadiusState(v === "standard" || v === "sharp" ? v : "soft");
            } else if (e.key === FONT_SCALE_KEY) {
                const v = e.newValue ?? "normal";
                setFontScaleState(v === "compact" || v === "large" ? v : "normal");
            } else if (e.key === scopedSearchKey()) {
                setSearchHistory(readSearchHistory());
            } else if (e.key === scopedStarredKey()) {
                setStarred(readStarred());
            } else if (e.key === scopedTagsKey()) {
                setTags(readTags());
            } else if (e.key === RAIL_COLLAPSED_KEY) {
                setRailCollapsedState((e.newValue ?? "0") === "1");
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    // ── ① 稳定份：设置项 + 全部写操作回调 ──
    // 写操作能放进来的原因：它们全都用函数式 setState（不读当前值），引用恒定。
    // 于是「点一下卡片记一次访问」这种高频写入，不会让只订阅这一份的组件重渲染。
    const stableValue = useMemo(
        () => ({
            viewMode,
            setViewMode,
            density,
            setDensity,
            favoritesEnabled,
            setFavoritesEnabled,
            pinyinSearch,
            setPinyinSearch,
            glassEffects,
            setGlassEffects,
            liteMode,
            setLiteMode,
            offlineFull,
            setOfflineFull,
            iconPrivacy,
            setIconPrivacy,
            radius,
            setRadius,
            fontScale,
            setFontScale,
            searchHistory,
            pushSearchHistory,
            clearSearchHistory,
            railCollapsed,
            setRailCollapsed,
            recordVisit,
            clearVisits,
            toggleStar,
            setStarredMany,
            setSiteTags,
            addTagsToMany,
            removeTagFromAll,
            applyTagOps,
            forgetSites,
            setDeadLinks,
            restoreLocalPrefs,
            prefSync,
            setPrefSync,
            mergeRemotePrefs,
            mergeRemoteVisits,
            markVisitsSynced,
            setPrefsAccountUid,
        }),
        [
            viewMode,
            setViewMode,
            density,
            setDensity,
            favoritesEnabled,
            setFavoritesEnabled,
            pinyinSearch,
            setPinyinSearch,
            glassEffects,
            setGlassEffects,
            liteMode,
            setLiteMode,
            offlineFull,
            setOfflineFull,
            iconPrivacy,
            setIconPrivacy,
            radius,
            setRadius,
            fontScale,
            setFontScale,
            searchHistory,
            pushSearchHistory,
            clearSearchHistory,
            railCollapsed,
            setRailCollapsed,
            recordVisit,
            clearVisits,
            toggleStar,
            setStarredMany,
            setSiteTags,
            addTagsToMany,
            removeTagFromAll,
            applyTagOps,
            forgetSites,
            setDeadLinks,
            restoreLocalPrefs,
            prefSync,
            setPrefSync,
            mergeRemotePrefs,
            mergeRemoteVisits,
            markVisitsSynced,
            setPrefsAccountUid,
        ]
    );

    // ── ② 星标 / 标签 / 死链 ──
    const prefsValue = useMemo(
        () => ({ starred, isStarred, tags, allTags, tagCounts, deadLinks }),
        [starred, isStarred, tags, allTags, tagCounts, deadLinks]
    );

    // ── ③ 访问统计 ──
    const visitsValue = useMemo(() => ({ visits }), [visits]);

    // 合并版：给 useUIPrefs() 用，形状与拆分前完全一致
    const value = useMemo(
        () => ({ ...stableValue, ...prefsValue, ...visitsValue }),
        [stableValue, prefsValue, visitsValue]
    );

    return (
        <StableContext.Provider value={stableValue}>
            <PrefsContext.Provider value={prefsValue}>
                <VisitsContext.Provider value={visitsValue}>
                    <UIPrefsContext.Provider value={value}>{children}</UIPrefsContext.Provider>
                </VisitsContext.Provider>
            </PrefsContext.Provider>
        </StableContext.Provider>
    );
}
