// src/utils/statsInsights.ts
// 看板派生指标（2026-10-22，B9 看板增强）。
//
// 为什么单独成文件、且全是纯函数：
//   1. 统计面板原来只有「原始计数」—— 30 根柱子、几个 Top 条，看得出「有多少」，
//      看不出「是变好还是变差」。趋势/占比这类指标**都能从现有数据算出来**，
//      不需要动服务端接口（加接口要等部署，纯前端当天就能用）。
//   2. 这些计算是「边界最容易错」的那类：不足 14 天数据时环比怎么算、
//      全零时百分比会不会除出 NaN、占比加起来是不是 100%。
//      放在纯函数里可以单测钉住 —— 写在组件里就只能靠肉眼看。
//
// ⚠️ 输入只有 OpsStats 里已有的字段（auditDaily / auditTopActions / shareTop），
//    新增指标请先确认服务端有没有那个数据，不要在这里编。

export interface DailyPoint {
    day: string;
    count: number;
}

export interface WeekOverWeek {
    /** 最近 7 天合计 */
    last7: number;
    /** 之前 7 天合计（数据不足 14 天时可能为 0） */
    prev7: number;
    /**
     * 环比变化百分比。⚠️ 三种特殊情况：
     *   - 前 7 天为 0、最近 7 天 > 0：无法算百分比，返回 null（界面显示「新增」而不是「+∞%」）
     *   - 两边都是 0：返回 0（「持平」，不是「没有数据」）
     *   - 其余：四舍五入到整数百分比，负数是下降
     */
    deltaPct: number | null;
    /** 数据是否够 14 天：不够时界面要说明「对比样本不足」 */
    enough: boolean;
}

export function weekOverWeek(daily: DailyPoint[]): WeekOverWeek {
    // ⚠️ 必须按 day 排序后再切：服务端回来的顺序依赖 SQL 的 GROUP BY，
    //    直接 slice(-7) 拿到的是「SQL 认为的最后 7 行」，不一定是日历上最近的 7 天。
    const sorted = [...daily].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const sum = (rows: DailyPoint[]) => rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
    const last7 = sum(sorted.slice(-7));
    const prev7 = sum(sorted.slice(-14, -7));
    const enough = sorted.length >= 14;
    let deltaPct: number | null;
    if (prev7 === 0) {
        // 前一周没有基数：涨了就说不清涨了多少倍，没涨就是持平
        deltaPct = last7 === 0 ? 0 : null;
    } else {
        deltaPct = Math.round(((last7 - prev7) / prev7) * 100);
    }
    return { last7, prev7, deltaPct, enough };
}

export interface ShareSlice<T extends string> {
    key: T;
    count: number;
    /** 占总量的百分比（0–100，保留一位小数）。总量为 0 时是 0，不会是 NaN */
    pct: number;
}

/** 占比：把一组计数换算成百分比。总量为 0 时全部给 0，绝不返回 NaN。 */
export function shareOf<T extends string>(rows: { key: T; count: number }[]): ShareSlice<T>[] {
    const total = rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
    if (total <= 0) return rows.map(r => ({ key: r.key, count: r.count, pct: 0 }));
    return rows.map(r => ({
        key: r.key,
        count: r.count,
        pct: Math.round(((Number(r.count) || 0) / total) * 1000) / 10,
    }));
}

export interface DailySummary {
    /** 有记录的天数 */
    activeDays: number;
    /** 窗口内零记录的天数 */
    quietDays: number;
    /** 最活跃的一天（全零时为 null） */
    peak: DailyPoint | null;
    /** 活跃日的日均（只算有记录的天，不把空白天摊进去 —— 那会低估实际使用强度） */
    avgOnActiveDays: number;
}

export function dailySummary(daily: DailyPoint[]): DailySummary {
    const active = daily.filter(d => (Number(d.count) || 0) > 0);
    const total = active.reduce((n, d) => n + d.count, 0);
    let peak: DailyPoint | null = null;
    for (const d of active) {
        if (!peak || d.count > peak.count) peak = d;
    }
    return {
        activeDays: active.length,
        quietDays: daily.length - active.length,
        peak,
        avgOnActiveDays: active.length > 0 ? Math.round((total / active.length) * 10) / 10 : 0,
    };
}

/** 环比文案。⚠️ 三种情况要分开说，「+0%」和「持平」不是一回事，更别输出 Infinity%。 */
export function deltaText(w: WeekOverWeek): string {
    if (w.deltaPct === null) return "最近 7 天开始有记录";
    if (w.deltaPct === 0) return "与上一周持平";
    return w.deltaPct > 0 ? `较上一周 +${w.deltaPct}%` : `较上一周 ${w.deltaPct}%`;
}
