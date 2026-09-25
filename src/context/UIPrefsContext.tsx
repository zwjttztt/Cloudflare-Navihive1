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

export type ViewMode = "card" | "list" | "wall";
export type Density = "comfortable" | "compact";

export interface VisitStat {
    count: number;
    last: number; // 最近访问时间戳（ms）
}

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
}

const VIEW_KEY = "navihive:viewMode";
const DENSITY_KEY = "navihive:density";
const FAVORITES_KEY = "navihive:favoritesEnabled";
const VISITS_KEY = "navihive:visits";

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
                clean[k] = { count: stat.count, last: stat.last };
            }
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
            const next = {
                ...prev,
                [key]: { count: (old?.count ?? 0) + 1, last: Date.now() },
            };
            try {
                localStorage.setItem(VISITS_KEY, JSON.stringify(next));
            } catch {
                // 忽略写入失败
            }
            return next;
        });
    }, []);

    const clearVisits = useCallback(() => {
        setVisits({});
        try {
            localStorage.removeItem(VISITS_KEY);
        } catch {
            // 忽略
        }
    }, []);

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
        ]
    );

    return <UIPrefsContext.Provider value={value}>{children}</UIPrefsContext.Provider>;
}
