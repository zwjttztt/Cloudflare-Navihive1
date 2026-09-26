// src/context/UIPrefsContext.tsx
// 只跟「本机使用习惯」有关的偏好：视图版式、显示密度、常用置前开关、站点访问统计。
// 这些不进数据库，只存 localStorage，换设备不跟随。
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { readDeadLinks } from "../utils/linkHealth";
import type { LocalPrefsBackup } from "../API/http";

export type ViewMode = "card" | "list" | "wall";
export type Density = "comfortable" | "compact";
/** 圆角风格：圆润 / 标准 / 锐利 */
export type RadiusStyle = "soft" | "standard" | "sharp";
/** 字号档位：紧凑 / 标准 / 宽松 */
export type FontScale = "compact" | "normal" | "large";

export interface VisitStat {
    count: number;
    last: number; // 最近访问时间戳（ms）
    /** 按天累计的访问次数，键为本地日期 YYYY-MM-DD。老数据没有这个字段，读取时兜底成空对象 */
    days?: Record<string, number>;
}

/** 本地日期键：YYYY-MM-DD（用本机时区，避免跨天算错） */
export const dayKey = (ts: number = Date.now()): string => {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
};

/** 圆角风格对应的像素值，写进 CSS 变量 --card-radius */
export const RADIUS_PX: Record<RadiusStyle, string> = {
    soft: "22px",
    standard: "14px",
    sharp: "6px",
};

/** 字号档位对应的缩放系数，写进 CSS 变量 --font-scale */
export const FONT_SCALE_VALUE: Record<FontScale, string> = {
    compact: "0.94",
    normal: "1",
    large: "1.07",
};

interface UIPrefsValue {
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    density: Density;
    setDensity: (density: Density) => void;
    favoritesEnabled: boolean;
    setFavoritesEnabled: (enabled: boolean) => void;
    visits: Record<string, VisitStat>;
    recordVisit: (siteId?: number) => void;
    clearVisits: () => void;
    radius: RadiusStyle;
    setRadius: (radius: RadiusStyle) => void;
    fontScale: FontScale;
    setFontScale: (scale: FontScale) => void;
    /** 判定为失效的站点链接 -> 失效时间戳 */
    deadLinks: Record<string, number>;
    setDeadLinks: (next: Record<string, number>) => void;
    /** 最近搜索过的关键词（本机，最新在前） */
    searchHistory: string[];
    pushSearchHistory: (term: string) => void;
    clearSearchHistory: () => void;
    /** 加了星标的站点 id（本机偏好，星标卡片会在分组里置顶） */
    starred: number[];
    isStarred: (siteId?: number) => boolean;
    toggleStar: (siteId?: number) => void;
    /** 批量加星 / 取消加星 */
    setStarredMany: (siteIds: number[], starred: boolean) => void;
    /** 站点标签：站点 id -> 标签名数组（本机偏好，不进数据库） */
    tags: Record<string, string[]>;
    setSiteTags: (siteId: number, tags: string[]) => void;
    /** 给一批站点追加标签（已存在的不会重复） */
    addTagsToMany: (siteIds: number[], tags: string[]) => void;
    /** 全部用过的标签名（按使用次数排序，供筛选栏展示） */
    allTags: string[];
    /** 左侧分组栏是否收起 */
    railCollapsed: boolean;
    setRailCollapsed: (collapsed: boolean) => void;
    /**
     * 从备份文件恢复星标与标签（它们只存 localStorage，备份里由前端附带）。
     * replace = 覆盖恢复，merge = 追加导入取并集。
     */
    restoreLocalPrefs: (prefs: LocalPrefsBackup | undefined, mode: "replace" | "merge") => void;
}

const VIEW_KEY = "navihive:viewMode";
const DENSITY_KEY = "navihive:density";
const FAVORITES_KEY = "navihive:favoritesEnabled";
const VISITS_KEY = "navihive:visits";
const RADIUS_KEY = "navihive:radius";
const FONT_SCALE_KEY = "navihive:fontScale";
const SEARCH_HISTORY_KEY = "navihive:searchHistory";
const STARRED_KEY = "navihive:starred";
const TAGS_KEY = "navihive:tags";
const RAIL_COLLAPSED_KEY = "navihive:railCollapsed";
/** 搜索历史最多留几条，够用又不至于把面板撑长 */
const SEARCH_HISTORY_MAX = 8;

const readString = (key: string, fallback: string): string => {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
};

const readVisits = (): Record<string, VisitStat> => {
    try {
        const raw = localStorage.getItem(VISITS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return {};
        // 过滤脏数据，保证后续排序不会崩
        const clean: Record<string, VisitStat> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            const stat = v as Partial<VisitStat>;
            if (typeof stat?.count === "number" && typeof stat?.last === "number") {
                // days 是后加的字段：老数据没有，只保留合法的数字值
                const days: Record<string, number> = {};
                if (stat.days && typeof stat.days === "object") {
                    for (const [dk, dv] of Object.entries(stat.days)) {
                        if (typeof dv === "number" && dv > 0) days[dk] = dv;
                    }
                }
                clean[k] = { count: stat.count, last: stat.last, days };
            }
        }
        return clean;
    } catch {
        return {};
    }
};

const readSearchHistory = (): string[] => {
    try {
        const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(t => typeof t === "string").slice(0, SEARCH_HISTORY_MAX) : [];
    } catch {
        return [];
    }
};

/** 星标名单：过滤掉非数字脏数据，保证 Set/查询不会崩 */
const readStarred = (): number[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STARRED_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === "number") : [];
    } catch {
        return [];
    }
};

/** 标签表：{ [siteId]: string[] }，脏数据一律丢掉 */
const readTags = (): Record<string, string[]> => {
    try {
        const parsed = JSON.parse(localStorage.getItem(TAGS_KEY) || "{}");
        if (!parsed || typeof parsed !== "object") return {};
        const clean: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            const list = value.filter(t => typeof t === "string" && t.trim().length > 0);
            if (list.length > 0) clean[key] = list;
        }
        return clean;
    } catch {
        return {};
    }
};

const write = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 隐私模式下写入失败，忽略即可
    }
};

const defaultValue: UIPrefsValue = {
    viewMode: "card",
    setViewMode: () => {},
    density: "comfortable",
    setDensity: () => {},
    favoritesEnabled: true,
    setFavoritesEnabled: () => {},
    visits: {},
    recordVisit: () => {},
    clearVisits: () => {},
    radius: "soft",
    setRadius: () => {},
    fontScale: "normal",
    setFontScale: () => {},
    deadLinks: {},
    setDeadLinks: () => {},
    searchHistory: [],
    pushSearchHistory: () => {},
    clearSearchHistory: () => {},
    starred: [],
    isStarred: () => false,
    toggleStar: () => {},
    setStarredMany: () => {},
    tags: {},
    setSiteTags: () => {},
    addTagsToMany: () => {},
    allTags: [],
    railCollapsed: false,
    setRailCollapsed: () => {},
    restoreLocalPrefs: () => {},
};

export const UIPrefsContext = createContext<UIPrefsValue>(defaultValue);

export const useUIPrefs = (): UIPrefsValue => useContext(UIPrefsContext);

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
                localStorage.setItem(VISITS_KEY, JSON.stringify(next));
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
            write(SEARCH_HISTORY_KEY, JSON.stringify(next));
            return next;
        });
    }, []);

    const clearSearchHistory = useCallback(() => {
        setSearchHistory([]);
        try {
            localStorage.removeItem(SEARCH_HISTORY_KEY);
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
            write(STARRED_KEY, JSON.stringify(next));
            return next;
        });
    }, []);

    const setStarredMany = useCallback((siteIds: number[], starred: boolean) => {
        if (siteIds.length === 0) return;
        setStarred(prev => {
            const set = new Set(prev);
            siteIds.forEach(id => (starred ? set.add(id) : set.delete(id)));
            const next = [...set];
            write(STARRED_KEY, JSON.stringify(next));
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
            write(TAGS_KEY, JSON.stringify(next));
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
            write(TAGS_KEY, JSON.stringify(next));
            return next;
        });
    }, []);

    // 全部标签名：按被使用的站点数排序，标签栏里越常用的越靠前
    const allTags = useMemo(() => {
        const counter = new Map<string, number>();
        for (const list of Object.values(tags)) {
            for (const tag of list) counter.set(tag, (counter.get(tag) ?? 0) + 1);
        }
        return [...counter.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([tag]) => tag);
    }, [tags]);

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
            localStorage.removeItem(VISITS_KEY);
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
                write(STARRED_KEY, JSON.stringify(next));
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
                write(TAGS_KEY, JSON.stringify(next));
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
            } else if (e.key === VISITS_KEY) {
                setVisits(readVisits());
            } else if (e.key === RADIUS_KEY) {
                const v = e.newValue ?? "soft";
                setRadiusState(v === "standard" || v === "sharp" ? v : "soft");
            } else if (e.key === FONT_SCALE_KEY) {
                const v = e.newValue ?? "normal";
                setFontScaleState(v === "compact" || v === "large" ? v : "normal");
            } else if (e.key === SEARCH_HISTORY_KEY) {
                setSearchHistory(readSearchHistory());
            } else if (e.key === STARRED_KEY) {
                setStarred(readStarred());
            } else if (e.key === TAGS_KEY) {
                setTags(readTags());
            } else if (e.key === RAIL_COLLAPSED_KEY) {
                setRailCollapsedState((e.newValue ?? "0") === "1");
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    const value = useMemo(
        () => ({
            viewMode,
            setViewMode,
            density,
            setDensity,
            favoritesEnabled,
            setFavoritesEnabled,
            visits,
            recordVisit,
            clearVisits,
            radius,
            setRadius,
            fontScale,
            setFontScale,
            deadLinks,
            setDeadLinks,
            searchHistory,
            pushSearchHistory,
            clearSearchHistory,
            starred,
            isStarred,
            toggleStar,
            setStarredMany,
            tags,
            setSiteTags,
            addTagsToMany,
            allTags,
            railCollapsed,
            setRailCollapsed,
            restoreLocalPrefs,
        }),
        [
            viewMode,
            setViewMode,
            density,
            setDensity,
            favoritesEnabled,
            setFavoritesEnabled,
            visits,
            recordVisit,
            clearVisits,
            radius,
            setRadius,
            fontScale,
            setFontScale,
            deadLinks,
            searchHistory,
            pushSearchHistory,
            clearSearchHistory,
            starred,
            isStarred,
            toggleStar,
            setStarredMany,
            tags,
            setSiteTags,
            addTagsToMany,
            allTags,
            railCollapsed,
            setRailCollapsed,
            restoreLocalPrefs,
        ]
    );

    return <UIPrefsContext.Provider value={value}>{children}</UIPrefsContext.Provider>;
}
