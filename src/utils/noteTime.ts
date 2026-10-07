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

/**
 * 完整时刻：「2026年9月25日 13:52」（inkstone 状态栏同款）。
 *
 * 与 formatWhen 的分工：那个用于**列表**（今天只给时:分，更早给 M月D日），
 * 这个用于**状态栏**，要一眼看到「哪年哪月哪日几点」，所以不做「今天」的特殊化 ——
 * 状态栏那行字有地方放，藏掉反而让人以为笔记没有创建时间。
 * 解析失败给空串。
 */
export function formatWhenFull(iso?: string | number | Date | null | undefined): string {
    const t = parseNoteTime(iso);
    if (!t) return "";
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日 ${hh}:${mm}`;
}

/**
 * 笔记列表的分组标题（照 inkstone 的 `groupLabel`）。
 *
 * ⚠️ 为什么不是「按月分」：inkstone 的分组是**相对**的 ——
 * 今天 / 昨天 / 本周 / 本月 / 「10月」/ 「2026年10月」，越近的越粗，
 * 越远的越细。之前我们一律按 `YYYY-MM` 分组，于是列表顶部永远是
 * 「2026 年 10 月」这种又长又没信息量的标题，而「今天改的那几条」被埋在里面。
 * 同一批笔记、同一个列表，inkstone 那套一眼就能看出「哪几条是刚动的」。
 *
 * 解析失败给「其他」—— 宁可分组名退化，也不要在列表顶上打一个「NaN」。
 */
export function groupLabel(
    iso: string | number | Date | null | undefined,
    now: number = Date.now()
): string {
    const d = parseNoteTime(iso);
    if (!d) return "其他";
    const today = new Date(now);
    const startOfToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
    ).getTime();
    const ts = d.getTime();
    if (ts >= startOfToday) return "今天";
    if (ts >= startOfToday - 24 * 3600_000) return "昨天";
    // 本周：从周一开始算（跟 inkstone 的 isSameDay/previousDay 一样按自然日）
    const weekday = (today.getDay() + 6) % 7;
    const startOfWeek = startOfToday - weekday * 24 * 3600_000;
    if (ts >= startOfWeek) return "本周";
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) {
        return "本月";
    }
    if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1} 月`;
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}
