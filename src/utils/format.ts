// src/utils/format.ts
// 全站共用的「给人看」的格式化：字节大小、日期时间、相对时间。
//
// 之前这些散落在 6+ 处各自实现（见各组件的私有 formatTime / fmtBytes / fullTime /
// humanBytes），既重复又藏着同一个 Safari/iOS 兼容性坑：`new Date("2024-01-01 12:00:00")`
// 是非标准写法，在 Safari / iOS 上得到 Invalid Date。这里统一收口，并让解析器同时接受
// ISO（`2024-01-01T12:00:00`）和 D1 / 备份文件里常见的 `YYYY-MM-DD HH:MM:SS`。
//
// ⚠️ 不要在这里偷偷改输出格式：每个调用方对「长什么样」都有既定预期（locale 风格 vs
// 紧凑 `YYYY-MM-DD HH:MM`），靠 options 切换，而不是各写一份。

/** 人类可读的文件 / 字节大小。 */
export function fmtBytes(n: number): string {
    const bytes = Number.isFinite(n) ? n : 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 把任意输入解析成 Date；解析不出来返回 null。
 *
 * 同时接受：
 *   · Date 实例
 *   · 数字（毫秒时间戳；秒级时间戳请在调用方 ×1000）
 *   · ISO 字符串 `2024-01-01T12:00:00` / `2024-01-01T12:00`
 *   · 非标准但 D1 / 备份里常见的 `2024-01-01 12:00:00` / `2024-01-01 12:00`
 *     （空格换成 T 即可，保持「本地时区」语义，与旧代码一致；否则 Safari/iOS 会 Invalid Date）
 */
function toDate(input: Date | string | number): Date | null {
    if (input instanceof Date) {
        return Number.isNaN(input.getTime()) ? null : input;
    }
    if (typeof input === "number") {
        const d = new Date(input);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(input).trim();
    if (s === "") return null;
    // 仅当是「日期 时间」这种非标准空格写法时才把空格换成 T；
    // 已经是 ISO（含 T）或纯日期（无时间）的不动。
    const normalized = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.test(s)
        ? s.replace(" ", "T")
        : s;
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
}

export type DateTimeStyle = "locale" | "compact";

export interface FmtDateTimeOptions {
    /**
     * 输出风格：
     *   · "locale"（默认）—— `toLocaleString("zh-CN", { hour12: false })`，形如 `2024/1/1 12:00:00`。
     *   · "compact" —— 自定义 `YYYY-MM-DD HH:MM`（无秒，无星期），形如 `2024-01-01 12:00`。
     */
    style?: DateTimeStyle;
    /** locale 风格用的 locale，默认 "zh-CN"。 */
    locale?: string;
    /** locale 风格是否用 12 小时制，默认 false。 */
    hour12?: boolean;
    /**
     * 输入缺失 / 空 / 解析失败时的回退文本。
     * 默认返回「原始输入转成的字符串」——这样 AuditDialog / backupFormat 的旧行为
     * （解析不出来就原样显示）得以保留；需要显示空串的调用方（settingsShared）传 ""。
     */
    fallback?: string;
}

/** 日期时间 → 给人看的字符串。 */
export function fmtDateTime(
    input: Date | string | number,
    opts: FmtDateTimeOptions = {}
): string {
    const { style = "locale", locale = "zh-CN", hour12 = false, fallback } = opts;
    const date = toDate(input);
    if (!date) return fallback ?? String(input ?? "");
    if (style === "compact") {
        const p = (n: number) => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(
            date.getHours()
        )}:${p(date.getMinutes())}`;
    }
    return date.toLocaleString(locale, { hour12 });
}

export interface FmtRelativeOptions {
    /** 参照「现在」，默认 new Date()。注入是为了测试 / 自动保存计时器可以手动推进。 */
    now?: Date;
    /** 输入缺失 / 解析失败时的回退文本，默认返回原始输入转成的字符串。 */
    fallback?: string;
}

/**
 * 相对时间（「刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前」）。
 * 未来时间给「N 分钟后 / 小时后 / 天后」。
 *
 * 与 notes 专用的 noteTime.formatRelative 分工：那个要按「昨天 / M月D日 / YYYY年M月D日」
 * 回退、且注入了 now 给自动保存计时器用；这里是一个不依赖笔记上下文的通用版本。
 */
export function fmtRelative(
    input: Date | string | number,
    opts: FmtRelativeOptions = {}
): string {
    const now = opts.now ?? new Date();
    const date = toDate(input);
    if (!date) return opts.fallback ?? String(input ?? "");
    const diffMs = now.getTime() - date.getTime();
    const abs = Math.abs(diffMs);
    const sec = Math.floor(abs / 1000);
    if (diffMs < 0) {
        if (sec < 60) return "即将";
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min} 分钟后`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr} 小时后`;
        const day = Math.floor(hr / 24);
        return `${day} 天后`;
    }
    if (sec < 60) return "刚刚";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 30) return `${day} 天前`;
    const month = Math.floor(day / 30);
    if (day < 365) return `${month} 个月前`;
    const year = Math.floor(day / 365);
    return `${year} 年前`;
}
