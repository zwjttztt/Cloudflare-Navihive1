// src/context/uiPrefsStore.ts
// UI 偏好的「非组件」部分：类型、存储键、读写工具、纯函数、四个 Context 与对应 hook。
//
// 从 UIPrefsContext.tsx 拆出来，目的是让那边只剩 Provider 组件 ——
// 一个文件混着组件与非组件导出时，react-refresh 会把整个文件的热更新降级成整页刷新，
// eslint 也会逐条报警。这里是纯数据与 context 定义，不含任何组件。
// src/context/UIPrefsContext.tsx
// 只跟「本机使用习惯」有关的偏好：视图版式、显示密度、常用置前开关、站点访问统计。
// 这些不进数据库，只存 localStorage，换设备不跟随。
import { createContext, useContext } from "react";
import { scopedKey } from "../utils/accountScope";
import type { TagMap } from "../utils/tagOps";
import type { LocalPrefsBackup } from "../API/http";

/**
 * 星标 / 标签变化时通知外部（App 用它做防抖上传到服务端）。
 * 不注册就是纯本机行为，跟开同步之前完全一致。
 */
export let prefsChangeListener: (() => void) | null = null;
export function onLocalPrefsChange(listener: (() => void) | null) {
    prefsChangeListener = listener;
}
export const emitPrefsChange = () => {
    try {
        prefsChangeListener?.();
    } catch {
        // 上传失败不该影响本机使用
    }
};

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

/** 只有有限数字才算数：undefined / NaN / 字符串都得当成 0，否则合并结果会变 NaN */
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 当前账号，决定「哪几份本机数据要按账号分开存」。
 *
 * 星标 / 标签 / 访问统计 / 搜索历史都记着**站点 id**，而 id 是全局自增、不同账号之间
 * 完全可能撞号：换个人登录之后，上一个人的星标会亮在别人同名号的卡片上，
 * 搜索历史里也会冒出从没搜过的词。所以这四份跟着账号走。
 * 外观类偏好（版式 / 密度 / 圆角 / 字号）是「这台机器的习惯」，刻意不分开。
 */
let prefUid: number | null = null;
/**
 * 切换当前账号：本地偏好按账号分桶存（:u&lt;uid&gt; / :anon）， scarcopedKey 每次取的是这里的当前值。
 * 必须走函数而不是导出变量本身 —— ES module 的 import 是只读绑定，
 * 在别的文件里给它赋值会直接编译不过。
 */
export function setPrefUid(uid: number | null): void {
    prefUid = uid;
}
export const scopedVisitsKey = () => scopedKey(VISITS_KEY, prefUid);
export const scopedVisitsSyncedKey = () => scopedKey(VISITS_SYNCED_KEY, prefUid);
export const scopedSearchKey = () => scopedKey(SEARCH_HISTORY_KEY, prefUid);
export const scopedStarredKey = () => scopedKey(STARRED_KEY, prefUid);
export const scopedTagsKey = () => scopedKey(TAGS_KEY, prefUid);

/**
 * 合并两份访问统计（本机 + 服务端下发的那份），第三个参数是「上次同步时本机那份」。
 *
 * 旧做法是逐项取 max，理由写在当时的注释里：怕相加会把两台设备各点一次算成两次。
 * 但 max 是**低估**而不是保守：手机点了 8 次、电脑点了 5 次，合完只剩 8，
 * 另外 5 次凭空消失，而且每次同步都可能在两边来回抹。
 *
 * 现在的做法是把「本机自上次同步以来的增量」加到服务端那份上：
 *   合并值 = 服务端值 + (本机现值 - 本机上次同步时的值)
 * 服务端那份本来就含着其它设备（以及本机已同步过的部分），补上本机还没上传的那一截
 * 才是真实总数；增量按 max(0, …) 取，本机被清过缓存也不会把服务端的值往下拽。
 * 没有基线可比对时（老数据 / 第一次同步）退回取 max，宁可低估也不瞎加。
 */
export function mergeVisitStats(
    local: Record<string, VisitStat>,
    incoming: Record<string, VisitStat>,
    synced?: Record<string, VisitStat> | null
): Record<string, VisitStat> {
    const out: Record<string, VisitStat> = { ...local };
    if (!incoming || typeof incoming !== "object") return out;

    for (const [url, inc] of Object.entries(incoming)) {
        if (!inc || typeof inc !== "object" || typeof url !== "string") continue;
        const incCount = typeof inc.count === "number" && Number.isFinite(inc.count) ? inc.count : 0;
        const incLast = typeof inc.last === "number" && Number.isFinite(inc.last) ? inc.last : 0;

        const cur = out[url];
        if (!cur) {
            out[url] = { count: incCount, last: incLast, days: { ...(inc.days ?? {}) } };
            continue;
        }

        const curCount = num(cur.count);
        const base = synced?.[url];
        // 本机自上次同步以来的增量；没有基线就当「无法计算」，退化为取最大值
        const delta =
            base && typeof base.count === "number"
                ? Math.max(0, curCount - num(base.count))
                : null;

        const days: Record<string, number> = { ...(cur.days ?? {}) };
        for (const [day, n] of Object.entries(inc.days ?? {})) {
            if (typeof n !== "number" || !Number.isFinite(n)) continue;
            const localDay = num(days[day]);
            const baseDay = base?.days?.[day];
            const dayDelta =
                delta !== null && typeof baseDay === "number"
                    ? Math.max(0, localDay - baseDay)
                    : null;
            days[day] =
                dayDelta === null
                    ? Math.max(localDay, n)
                    : Math.max(n, num(base?.days?.[day])) + dayDelta;
        }

        out[url] = {
            // 基线也要参与取大：服务端那份被别台设备覆盖成更小的值时，
            // 不能让本机已经同步出去的次数跟着倒退回去。
            count:
                delta === null
                    ? Math.max(curCount, incCount)
                    : Math.max(incCount, num(base?.count)) + delta,
            // 最近访问时间没有「累加」这回事，永远取更晚的那次
            last: Math.max(num(cur.last), incLast),
            days,
        };
    }
    return out;
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

/**
 * 三份 Context 的分工：**按「多久变一次」拆，而不是按功能拆。**
 *
 * 全站最频繁的状态变化是「点一次卡片记一次访问」—— 它以前会让**每一个**
 * useUIPrefs 的消费者一起重渲染，包括只想知道「分组栏收没收起」的左侧栏、
 * 以及几百张根本不显示访问次数的卡片。React 的 Context 没有选择器：
 * 只要 value 变了，订阅者全部重来一遍。
 *
 * 所以拆成三份，各自只在自己那份变了的时候通知订阅者：
 *   ① stable —— 设置项 + 所有写操作回调（回调都用函数式 setState，引用恒定）
 *   ② prefs  —— 星标 / 标签 / 死链：只有用户动手才变
 *   ③ visits —— 访问统计：每点一次卡片就变，订阅它的只有真正显示热度的那几处
 *
 * 需要用全量的地方（App）仍可用 useUIPrefs() 拿合并版，行为与拆分前一致。
 */
export interface UIPrefsStableValue {
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    density: Density;
    setDensity: (density: Density) => void;
    favoritesEnabled: boolean;
    setFavoritesEnabled: (enabled: boolean) => void;
    /** 拼音搜索：默认关，打开后可以用「bd」搜到「百度」（词典按需加载） */
    pinyinSearch: boolean;
    setPinyinSearch: (enabled: boolean) => void;
    /** 毛玻璃特效：关掉后全站不再用 backdrop-filter，改用接近不透明的底色（本机偏好） */
    glassEffects: boolean;
    setGlassEffects: (enabled: boolean) => void;
    /**
     * 清爽模式（低性能设备友好）：一并关掉毛玻璃、柔光背景、装饰动画与悬浮阴影，
     * 只留纯色底 + 静态卡片。比「关毛玻璃」更彻底 —— 后者只是换一种合成方式，
     * 背景光晕那层 blur(48px) 与几百张卡片的入场动画依然在跑。
     */
    liteMode: boolean;
    setLiteMode: (enabled: boolean) => void;
    /**
     * 离线增强：打开后 Service Worker 会把懒加载的功能块也预下载下来，
     * 断网时也能点开全部弹窗。默认关 —— 按需加载就是为了「不点的功能不下载」。
     */
    offlineFull: boolean;
    setOfflineFull: (enabled: boolean) => void;
    /**
     * 图标隐私模式：打开后**一个第三方图标请求都不发**。
     *
     * 取图标这件事本身会泄露访问了哪些站：卡片一进视野，浏览器（或本站的
     * /api/icon 代理）就要去那个域名抓一次 favicon，第三方图标服务还会顺带
     * 记下这个域名。开启后卡片一律用首字母块，代价是图标没那么好看。
     */
    iconPrivacy: boolean;
    setIconPrivacy: (enabled: boolean) => void;
    radius: RadiusStyle;
    setRadius: (radius: RadiusStyle) => void;
    fontScale: FontScale;
    setFontScale: (scale: FontScale) => void;
    /** 最近搜索过的关键词（本机，最新在前） */
    searchHistory: string[];
    pushSearchHistory: (term: string) => void;
    clearSearchHistory: () => void;
    /** 左侧分组栏是否收起 */
    railCollapsed: boolean;
    setRailCollapsed: (collapsed: boolean) => void;
    // 下面这些是「写操作」：它们不持有任何会变的值（全部走函数式 setState），
    // 所以引用恒定 —— 只调用不读取的组件（卡片记一次访问）不必订阅对应状态。
    recordVisit: (siteId?: number) => void;
    clearVisits: () => void;
    toggleStar: (siteId?: number) => void;
    /** 批量加星 / 取消加星 */
    setStarredMany: (siteIds: number[], starred: boolean) => void;
    setSiteTags: (siteId: number, tags: string[]) => void;
    /** 给一批站点追加标签（已存在的不会重复） */
    addTagsToMany: (siteIds: number[], tags: string[]) => void;
    /** 删除某个标签：所有卡片都不再带它（标签管理用） */
    removeTagFromAll: (tag: string) => void;
    /**
     * 一次性写入标签重命名 / 合并的结果（纯计算在 utils/tagOps）。
     * 走这里而不是多次 setSiteTags：一次 setState 只重渲染一遍，
     * 也避免中途失败留下「一半改了名、一半没改」的状态。
     */
    applyTagOps: (nextTags: TagMap) => void;
    /** 卡片被删除时，把它们的本机标签 / 星标一起清掉，避免留下点不出来的孤儿标签 */
    forgetSites: (siteIds: number[]) => void;
    setDeadLinks: (next: Record<string, number>) => void;
    /**
     * 从备份文件恢复星标与标签（它们只存 localStorage，备份里由前端附带）。
     * replace = 覆盖恢复，merge = 追加导入取并集。
     */
    restoreLocalPrefs: (prefs: LocalPrefsBackup | undefined, mode: "replace" | "merge") => void;
    /**
     * 星标 / 标签是否同步到服务端（默认关）。
     * 关着的时候它们只在本机 localStorage 里，清缓存就没了；开了之后换设备也能看到。
     */
    prefSync: boolean;
    setPrefSync: (enabled: boolean) => void;
    /** 合并服务端下发的星标 / 标签（取并集，不会减掉本机已有的） */
    mergeRemotePrefs: (starred: number[], tags: Record<string, string[]>) => void;
    /**
     * 合并服务端下发的访问统计：把本机「自上次同步以来的增量」加到服务端那份上。
     * 换设备后热度不会从头再来，也不会因为两台机器各记一次就把次数抹掉一半
     * （见 mergeVisitStats 的说明）。
     */
    mergeRemoteVisits: (incoming: Record<string, VisitStat>) => void;
    /** 访问统计上传成功后调用：把当前这份记为「已同步」，作为下次合并的基线 */
    markVisitsSynced: () => void;
    /** 切换账号：把按账号分开存的那几份本机数据换成新账号的 */
    setPrefsAccountUid: (uid: number | null) => void;
}

/** ② 星标 / 标签 / 死链：只在用户动手时变（见上面三份拆分说明） */
export interface UIPrefsPrefsValue {
    /** 加了星标的站点 id（本机偏好，星标卡片会在分组里置顶） */
    starred: number[];
    isStarred: (siteId?: number) => boolean;
    /** 站点标签：站点 id -> 标签名数组（本机偏好，不进数据库） */
    tags: Record<string, string[]>;
    /** 全部用过的标签名（按使用次数排序，供筛选栏展示） */
    allTags: string[];
    /** 每个标签被多少张卡片使用（标签管理展示用） */
    tagCounts: Record<string, number>;
    /** 判定为失效的站点链接 -> 失效时间戳 */
    deadLinks: Record<string, number>;
}

/** ③ 访问统计：点一次卡片就变一次，是全站最频繁的状态变化 */
export interface UIPrefsVisitsValue {
    visits: Record<string, VisitStat>;
}

/** 合并版：给确实需要全量（或懒得细分）的组件用，形状与拆分前完全一致 */
export interface UIPrefsValue
    extends UIPrefsStableValue,
        UIPrefsPrefsValue,
        UIPrefsVisitsValue {}

export const VIEW_KEY = "navihive:viewMode";
export const DENSITY_KEY = "navihive:density";
export const FAVORITES_KEY = "navihive:favoritesEnabled";
export const VISITS_KEY = "navihive:visits";
/**
 * 上次成功同步给服务端的那份访问统计的**快照**。
 *
 * 增量合并需要它：拿本机现值减去快照，才是「还没上传出去的那几下」。
 * 只在确认上传成功之后才写，写早了（上传失败却记成已同步）会把增量悄悄丢掉。
 */
export const VISITS_SYNCED_KEY = "navihive:visitsSynced";
export const RADIUS_KEY = "navihive:radius";
export const FONT_SCALE_KEY = "navihive:fontScale";
export const SEARCH_HISTORY_KEY = "navihive:searchHistory";
export const STARRED_KEY = "navihive:starred";
export const TAGS_KEY = "navihive:tags";
export const RAIL_COLLAPSED_KEY = "navihive:railCollapsed";
export const PINYIN_KEY = "navihive:pinyinSearch";
export const GLASS_KEY = "navihive:glassEffects";
/** 清爽模式：低性能设备一键关掉全部装饰性特效 */
export const LITE_KEY = "navihive:liteMode";
export const PREF_SYNC_KEY = "navihive:prefSync";
/** 离线增强：用户显式开启后才把懒加载的功能块也预下载下来 */
export const OFFLINE_FULL_KEY = "navihive:offlineFull";
/** 图标隐私模式：开启后不再为取图标而请求任何第三方 */
export const ICON_PRIVACY_KEY = "navihive:iconPrivacy";
/** 搜索历史最多留几条，够用又不至于把面板撑长 */
export const SEARCH_HISTORY_MAX = 8;

export const readString = (key: string, fallback: string): string => {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
};

export const readVisits = (): Record<string, VisitStat> => {
    try {
        const raw = localStorage.getItem(scopedVisitsKey());
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

/** 读出「上次已同步」的快照；读不到（老数据）返回 null，合并时会退化成取最大值 */
export const readSyncedVisits = (): Record<string, VisitStat> | null => {
    try {
        const raw = localStorage.getItem(scopedVisitsSyncedKey());
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed as Record<string, VisitStat>;
    } catch {
        return null;
    }
};

export const writeSyncedVisits = (snapshot: Record<string, VisitStat>): void => {
    try {
        localStorage.setItem(scopedVisitsSyncedKey(), JSON.stringify(snapshot));
    } catch {
        /* 隐私模式：基记不住，下次合并退化成取最大值，不会算错成负数 */
    }
};

export const readSearchHistory = (): string[] => {
    try {
        const raw = localStorage.getItem(scopedSearchKey());
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(t => typeof t === "string").slice(0, SEARCH_HISTORY_MAX) : [];
    } catch {
        return [];
    }
};

/** 星标名单：过滤掉非数字脏数据，保证 Set/查询不会崩 */
export const readStarred = (): number[] => {
    try {
        const parsed = JSON.parse(localStorage.getItem(scopedStarredKey()) || "[]");
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === "number") : [];
    } catch {
        return [];
    }
};

/** 标签表：{ [siteId]: string[] }，脏数据一律丢掉 */
export const readTags = (): Record<string, string[]> => {
    try {
        const parsed = JSON.parse(localStorage.getItem(scopedTagsKey()) || "{}");
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

export const write = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // 隐私模式下写入失败，忽略即可
    }
};

export const defaultValue: UIPrefsValue = {
    viewMode: "card",
    setViewMode: () => {},
    density: "comfortable",
    setDensity: () => {},
    favoritesEnabled: true,
    pinyinSearch: false,
    setPinyinSearch: () => {},
    glassEffects: true,
    setGlassEffects: () => {},
    liteMode: false,
    setLiteMode: () => {},
    offlineFull: false,
    setOfflineFull: () => {},
    iconPrivacy: false,
    setIconPrivacy: () => {},
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
    removeTagFromAll: () => {},
    applyTagOps: () => {},
    forgetSites: () => {},
    allTags: [],
    tagCounts: {},
    railCollapsed: false,
    setRailCollapsed: () => {},
    restoreLocalPrefs: () => {},
    prefSync: false,
    setPrefSync: () => {},
    mergeRemotePrefs: () => {},
    mergeRemoteVisits: () => {},
    markVisitsSynced: () => {},
    setPrefsAccountUid: () => {},
};

export const UIPrefsContext = createContext<UIPrefsValue>(defaultValue);

// 三份细分 Context（分工见 UIPrefsStableValue 上的注释）。
// 它们的默认值取自 defaultValue 的对应字段，Provider 缺失时也不至于崩。
export const StableContext = createContext<UIPrefsStableValue>(defaultValue);
export const PrefsContext = createContext<UIPrefsPrefsValue>(defaultValue);
export const VisitsContext = createContext<UIPrefsVisitsValue>(defaultValue);

/** 全量（合并版）：形状与拆分前一致，给 App 这类确实需要全套的地方 */
export const useUIPrefs = (): UIPrefsValue => useContext(UIPrefsContext);
/** ① 设置项 + 全部写操作回调：点一次卡片不会让它变 */
export const useUIPrefsStable = (): UIPrefsStableValue => useContext(StableContext);
/** ② 星标 / 标签 / 死链：只有用户动手才变 */
export const useUIPrefsPrefs = (): UIPrefsPrefsValue => useContext(PrefsContext);
/** ③ 访问统计：每点一次卡片就变，只有真正显示热度的组件该订阅它 */
export const useUIPrefsVisits = (): UIPrefsVisitsValue => useContext(VisitsContext);
