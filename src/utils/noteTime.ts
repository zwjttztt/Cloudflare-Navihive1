// src/utils/noteTime.ts
// 笔记时间戳的解析。单独成文件有两个目的：能直接单测；组件文件只导出组件时才吃得下
// react-refresh 快刷（把纯函数塞进组件文件会让 HMR 退化成整页刷新）。
//
// ── 为什么要存在 ────────────────────────────────────────────────
// D1 / SQLite 的 `CURRENT_TIMESTAMP` 存的是 **UTC**，格式 `2026-10-05 11:05:18`
// —— 注意：既没有 `T` 也没有时区后缀。V8 解析这种串时按 **本地时间** 解释，
// 北京时间（UTC+8）下就整整差 8 小时：用户看到「早上 7 点创建的」，
// 其实是下午 3 点创建的。带 `Z` / `±HH:mm` 的才是绝对时刻，原样解析即可。
//
// ══ 判据：一个串到底按 UTC 还是本地解释 ══
//   1. 带时区（尾 Z，或 +08:00 / -0800）→ 绝对时刻，交给 `new Date` 直接解析；
//   2. 只有日期时间、**没有**时区 → 一律按 **UTC** 补成 `T…Z` 再解析。
//      这包括两种写法：`"2026-10-05 11:05:18"`（SQLite 原生输出）
//      和 `"2026-10-05T11:05:18"`（有人把 T 带上却忘了带 Z —— 两种都按 UTC，
//      否则同一个库里两条笔记会差 8 小时，比全都错更糟）。
//   3. 解析不出（NaN / 空 / 垃圾串）→ 返回 null，上层决定怎么显示，绝不静默给 "Invalid Date"。

/** 有没有时区信息（尾 Z，或 ±HH:mm / ±HHmm） */
function hasTimezone(raw: string): boolean {
    return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw);
}

/** 把「没有时区的日期时间」补成合法的 ISO 串（按 UTC 解释） */
function toUtcIso(raw: string): string {
    // SQLite: "2026-10-05 11:05:18" → "2026-10-05T11:05:18Z"
    // 已有 T 的（"2026-10-05T11:05:18"）只补 Z
    const withT = raw.includes("T") ? raw : `${raw.replace(" ", "T")}`;
    return `${withT}Z`;
}

/**
 * 解析笔记时间戳。解析不出来返回 null（不要返回 Invalid Date 给 UI 显示）。
 * 入参允许 number 是因为回收站的 `deletedAt` 是**毫秒时间戳**（number），
 * 而笔记的 created_at/updated_at 是 SQLite 的日期串（string），两种都得吃得下；
 * 也接受现成的 Date（阶段四的相对时间要拿「相对某个基准」算，基准传 Date 最直接）。
 *
 * ⚠️ 不接受 Date 会**静默出错**：`String(new Date())` 得到 "Mon Oct 06 2026 ..."，
 * 既不是带时区的 ISO 也不是 SQLite 串，解析出来是 NaN → 返回 null → 时间显示成空白。
 */
export function parseNoteTime(
    iso?: string | number | Date | null | undefined
): Date | null {
    if (iso == null || iso === "") return null;
    if (iso instanceof Date) {
        return Number.isFinite(iso.getTime()) ? iso : null;
    }
    // ⚠️ number（毫秒时间戳）必须走数值分支。**不能**先 `String()` 再丢给 Date：
    // `new Date("1757000000000")` 解析不出来，直接返回 Invalid Date → 上层变 null。
    // 踩这个坑的正是回收站：`deletedAt` 是 number，之前一调用就显示不出删除时间。
    if (typeof iso === "number") {
        return Number.isFinite(iso) ? new Date(iso) : null;
    }
    const raw = String(iso).trim();
    if (!raw) return null;

    let parsed: Date;
    try {
        parsed = new Date(hasTimezone(raw) ? raw : toUtcIso(raw));
    } catch {
        return null;
    }
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 列表里的时间：今天只给时刻，更早只给日期（inkstone 同款）。解析失败给空串 */
export function formatWhen(iso?: string | number | Date | null | undefined): string {
    const t = parseNoteTime(iso);
    if (!t) return "";
    const now = new Date();
    const sameDay =
        t.getFullYear() === now.getFullYear() &&
        t.getMonth() === now.getMonth() &&
        t.getDate() === now.getDate();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}`;
    return `${t.getMonth() + 1}月${t.getDate()}日`;
}

/**
 * 相对时间（阶段四第 13 条）：「刚刚 / N分钟前 / N小时前 / 昨天 / M月D日 / YYYY年M月D日」。
 *
 * 为什么替换 formatWhen：列表里给一串 `14:23` 或 `10月5日`，用户还得自己在脑子里
 * 换算「这是多久以前」。相对时间一眼就知道新鲜程度，也是 inkstone 那类的做法。
 *
 * ⚠️ 刻度是刻意的：**分钟只在 1 小时内、小时只在当天内**。
 * 超过一天还写「26小时前」只会让人再算一遍，所以跨天就退回日历式（昨天 / M月D日）。
 * `now` 可注入是为了单测能钉住边界（不注入就用当前时刻）。
 */
export function formatRelative(
    iso?: string | number | Date | null | undefined,
    now: Date = new Date()
): string {
    const t = parseNoteTime(iso);
    if (!t) return "";

    const diffMs = now.getTime() - t.getTime();
    // 时钟不同步 / 服务器时间略超前 → 出现过「-1分钟前」这种怪东西，一律当「刚刚」
    if (diffMs < 60_000) return "刚刚";

    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes}分钟前`;

    const sameDay =
        t.getFullYear() === now.getFullYear() &&
        t.getMonth() === now.getMonth() &&
        t.getDate() === now.getDate();
    if (sameDay) return `${Math.floor(minutes / 60)}小时前`;

    // 昨天：拿「今天零点 - 24h」当区间，比按 24 小时整减更贴近人的直觉
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t.getTime() >= todayStart - 86_400_000) return "昨天";

    if (t.getFullYear() === now.getFullYear()) {
        return `${t.getMonth() + 1}月${t.getDate()}日`;
    }
    return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日`;
}

/** 月份分组标题：「2026-10」→「2026 年 10 月」。解析失败给「其他」 */
export function monthLabel(iso?: string | number | Date | null | undefined): string {
    const d = parseNoteTime(iso);
    if (!d) return "其他";
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}
