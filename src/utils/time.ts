// src/utils/time.ts
// 「最近访问」分组的统计窗口用到的日期工具。

const startOfDay = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** 「最近访问」分组只看最近这么多天的点击 */
export const RECENT_WINDOW_DAYS = 7;
/** 「最近访问」分组最多保留的网站数量 */
export const RECENT_GROUP_SIZE = 10;

/**
 * 最近 N 天（含今天）的访问次数。
 * 老记录没有按天明细时，用总次数兜底，避免升级后统计直接归零。
 */
export const recentVisitCount = (
    stat: { count?: number; last?: number; days?: Record<string, number> } | undefined,
    windowDays = RECENT_WINDOW_DAYS
): number => {
    if (!stat) return 0;

    const from = startOfDay(Date.now()) - (windowDays - 1) * 86400000;
    const days = stat.days ?? {};
    const keys = Object.keys(days);

    if (keys.length === 0) {
        return (stat.last ?? 0) >= from ? (stat.count ?? 0) : 0;
    }

    let total = 0;
    for (const key of keys) {
        const [y, m, d] = key.split("-").map(Number);
        if (!y || !m || !d) continue;
        if (new Date(y, m - 1, d).getTime() >= from) total += days[key];
    }
    return total;
};
