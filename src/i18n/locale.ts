// src/i18n/locale.ts
// 国际化的**骨架**（2026-10-20）。
//
// 这一层只做三件纯函数的事：认语言、存语言、按 key 取文案。
// 刻意**不**引入 i18next 之类的运行时：本项目全站文案是中文，需要的是「把散落的文案
// 收进一张表、并且留一条以后能整体换语言的路」，而不是一整套插值/复数/懒加载机制 ——
// 后者带来的体积和复杂度，换不来现在就要用的东西。
//
// 设计取舍：
//   1. `t(key)` 的返回值在 zh 下**等于**原来的硬编码文案，所以接入不会改变界面；
//   2. 取不到就回落：先回落 zh，再回落调用方给的兜底文案，最后回落 key 本身 ——
//      缺一条翻译最多是「这一处还是中文」，不会显示成 undefined 或空白；
//   3. 语言只存在本机（localStorage），不进 configs 表：界面语言是「这台设备/这个
//      浏览器」的事，同步到服务端只会带来「换设备界面变语言」的困惑。

export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALES: Locale[] = ["zh", "en"];

/** 存语言的键（与其它 UI 偏好同一个前缀，方便一起清） */
export const LOCALE_STORAGE_KEY = "navihive.locale";

/** 一条文案的两种写法 */
export type Message = Record<Locale, string>;

/**
 * 把任意输入认成一种语言。
 * 认不出来一律回落默认（zh）—— 存储里可能残留老值或手改的脏数据，
 * 那种时候「当没配过」比抛错或显示空白都好。
 */
export function normalizeLocale(raw: unknown): Locale {
    if (raw === "en" || raw === "zh") return raw;
    if (typeof raw === "string") {
        const lower = raw.trim().toLowerCase();
        if (lower === "en" || lower.startsWith("en-")) return "en";
        if (lower === "zh" || lower.startsWith("zh-")) return "zh";
    }
    return DEFAULT_LOCALE;
}

/** 从 localStorage 读语言。storage 不可用（隐私模式 / SSR 桩）时按没配过处理。 */
export function readStoredLocale(
    storage?: Pick<Storage, "getItem"> | null
): Locale {
    try {
        return normalizeLocale(storage?.getItem(LOCALE_STORAGE_KEY));
    } catch {
        return DEFAULT_LOCALE;
    }
}

/** 写语言。写失败（配额 / 被禁用）不影响本次会话的选择。 */
export function writeStoredLocale(
    locale: Locale,
    storage?: Pick<Storage, "setItem"> | null
): void {
    try {
        storage?.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
        /* 存不下就算了：语言本来就是本机偏好，重开一次回到默认即可 */
    }
}

/**
 * 取一条文案。
 *
 * 回落顺序：当前语言 → zh → fallback → key。
 * 最后回落到 key 是有意的：出现未翻译的 key 时，界面上显示的是 key（长得像
 * `settings.language.title`），一眼能看出「这条还没翻译」，比空白或 undefined 好查。
 */
export function translate(
    dict: Record<string, Message>,
    locale: Locale,
    key: string,
    fallback?: string
): string {
    const entry = dict[key];
    if (entry) {
        const hit = entry[locale] ?? entry[DEFAULT_LOCALE];
        if (hit) return hit;
    }
    return fallback ?? key;
}
