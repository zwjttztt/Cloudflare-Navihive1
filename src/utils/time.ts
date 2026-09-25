// src/utils/time.ts
// 「最近访问」分区与卡片时间标签用到的日期工具。
export type DayBucket = "today" | "yesterday" | "earlier";

const startOfDay = (ts: number) => {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** 把时间戳归到「今天 / 昨天 / 更早」三档 */
export const dayBucketOf = (ts: number): DayBucket => {
    if (!ts) return "earlier";
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    if (day >= today) return "today";
    if (day >= today - 86400000) return "yesterday";
    return "earlier";
};

const two = (n: number) => String(n).padStart(2, "0");

/** 卡片上的相对时间标签：今天 14:05 / 昨天 09:30 / 9月3日 */
export const recentLabelOf = (ts: number): string => {
    if (!ts) return "";
    const d = new Date(ts);
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    const bucket = dayBucketOf(ts);
    if (bucket === "today") return `今天 ${hm}`;
    if (bucket === "yesterday") return `昨天 ${hm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
};
