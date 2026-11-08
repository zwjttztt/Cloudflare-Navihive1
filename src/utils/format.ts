// src/utils/format.ts
// 全站共用的「给人看」的格式化：字节大小、日期时间、相对时间。
//
// 之前这些散落在 6+ 处各自实现（见各组件的私有 formatTime / fmtBytes / fullTime /
// humanBytes），既重复又藏着同一个 Safari/iOS 兼容性坑：`new Date("2024-01-01 12:00:00")`
// 是非标准写法，在 Safari / iOS 上得到 Invalid Date。这里统一收口，并让解析器同时接受
// ISO（`2024-01-01T12:00:00`）和 D1 / 备份文件里常见的 `YYYY-MM-DD HH:MM:SS`。
//
// ⚠️ 全站「显示」固定为北京时间（Asia/Shanghai）：SQLite / D1 的 `CURRENT_TIMESTAMP`
// 是无时区的 UTC 文本，解析时补 `Z` 按 UTC 还原成绝对时刻；所有给人看的输出再统一
// 按北京时间（UTC+8，无夏令时）换算。这样无论用户 / 浏览器在哪个时区，看到的都是
// 同一个北京时间。相对时间（fmtRelative）按绝对毫秒差计算，本身与时区无关。
//
// ⚠️ 不要在这里偷偷改输出格式：每个调用方对「长什么样」都有既定预期（locale 风格 vs
// 紧凑 `YYYY-MM-DD HH:MM`），靠 options 切换，而不是各写一份。时区改动只换「取值方式」，
// 不改任何输出文案 / 位数。

/** 全站显示时区：北京时间（UTC+8，无夏令时）。 */
export const BEIJING_TIME_ZONE = "Asia/Shanghai";
/** 北京是 UTC+8 定偏移（1991 年后无夏令时）：绝对时刻 + 8h 的 UTC 分量即北京墙上时钟。 */
const BEIJING_OFFSET_MS = 8 * 3600_000;

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
 *   · 带时区的 ISO / GMT 串（尾 `Z` 或 `±HH:mm`）—— 绝对时刻，原样交给 `new Date`
 *   · SQLite / D1 的 `CURRENT_TIMESTAMP`：`YYYY-MM-DD HH:MM:SS`（或带 T、带小数秒），
 *     **没有时区后缀** —— 这是 UTC 文本，补 `Z` 按 UTC 解析，避免 V8 按浏览器本地
 *     时区解释导致差 8 小时；展示时再统一换算成北京时间（见 fmtDateTime）。
 *
 * 非标准的「空格分隔」写法先换成 `T`，否则 Safari / iOS 会得到 Invalid Date。
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
    // 完整「日期 + 时间」且末尾没有 Z / ±HH:mm → SQLite CURRENT_TIMESTAMP 的 UTC 文本：
    // 补 Z 按 UTC 还原绝对时刻；顺带把非标准的空格分隔换成 T（Safari/iOS 兼容）。
    // 带时区 / 纯日期 / 其它格式原样交给 new Date。
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(s);
    const d = new Date(m ? `${m[1]}T${m[2]}Z` : s);
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

/** 把绝对时刻换算成固定的北京时间（Asia/Shanghai）墙上时钟分量。 */
export interface BeijingParts {
    year: number;
    /** 1-12 */
    month: number;
    /** 1-31 */
    day: number;
    /** 0-23 */
    hour: number;
    /** 0-59 */
    minute: number;
    /** 0=周日 … 6=周六（北京日历日的星期） */
    weekday: number;
}

/** 取某个绝对时刻在北京时间下的年 / 月 / 日 / 时 / 分 / 星期。
 *  UTC+8 定偏移，+8h 后的 UTC 分量就是北京墙上时钟，不必依赖 Intl 时区库。 */
export function beijingParts(date: Date): BeijingParts {
    const b = new Date(date.getTime() + BEIJING_OFFSET_MS);
    return {
        year: b.getUTCFullYear(),
        month: b.getUTCMonth() + 1,
        day: b.getUTCDate(),
        hour: b.getUTCHours(),
        minute: b.getUTCMinutes(),
        weekday: b.getUTCDay(),
    };
}

/**
 * 北京日期 `YYYY-MM-DD`（用于下载 / 导出文件名）。
 * 北京是 UTC+8 定偏移（无夏令时），把绝对时刻 +8h 后取 `toISOString()` 的 UTC 日期
 * 即北京日期；不依赖 locale / Intl 时区库，避免 `en-CA` 之类的平台差异。
 */
export function beijingDateStamp(input: Date | number = Date.now()): string {
    const ms = typeof input === "number" ? input : input.getTime();
    return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日期时间 → 给人看的字符串（固定北京时间）。 */
export function fmtDateTime(
    input: Date | string | number,
    opts: FmtDateTimeOptions = {}
): string {
    const { style = "locale", locale = "zh-CN", hour12 = false, fallback } = opts;
    const date = toDate(input);
    if (!date) return fallback ?? String(input ?? "");
    if (style === "compact") {
        const p = (n: number) => String(n).padStart(2, "0");
        const { year, month, day, hour, minute } = beijingParts(date);
        return `${year}-${p(month)}-${p(day)} ${p(hour)}:${p(minute)}`;
    }
    return date.toLocaleString(locale, { hour12, timeZone: BEIJING_TIME_ZONE });
}

/**
 * 审计时间。toDate 已把无时区的 SQLite UTC 文本补 Z 按 UTC 解析，
 * fmtDateTime 的 locale 分支又固定按北京时间输出 —— 直接委托，避免两份逻辑漂移。
 */
export function fmtAuditDateTime(input: Date | string | number, fallback?: string): string {
    return fmtDateTime(input, { hour12: false, fallback });
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
