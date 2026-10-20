// src/i18n/localeStore.ts
// 语言 context 与取值 hook —— **不含组件**。
//
// 与 context/appConfigStore.ts 同一个道理：Provider 组件放在 LocaleProvider.tsx，
// 这边只有 context 与 hook。混在一个文件里的话，热更新会因为「文件里既导出组件
// 又导出函数」而降级成整页刷新 —— 改一句文案就要整页重载，很影响手感。
import { createContext, useContext } from "react";
import { DEFAULT_LOCALE, translate, type Locale } from "./locale";
import { messages } from "./messages";

export interface I18nValue {
    locale: Locale;
    setLocale: (next: Locale) => void;
    /** 取一条文案；缺翻译时回落 zh，再回落调用方给的兜底 */
    t: (key: string, fallback?: string) => string;
}

/** 没有 Provider 时（单测里直接渲染组件）也能用：回落 zh + 原样返回兜底 */
export const I18N_DEFAULT: I18nValue = {
    locale: DEFAULT_LOCALE,
    setLocale: () => undefined,
    t: (_key, fallback) => fallback ?? "",
};

export const I18nContext = createContext<I18nValue>(I18N_DEFAULT);

/** 读语言上下文 */
export const useI18n = (): I18nValue => useContext(I18nContext);

/** 按当前语言取一条文案（不订阅 context 的地方用它，省一层重渲染） */
export function translateFor(locale: Locale, key: string, fallback?: string): string {
    return translate(messages, locale, key, fallback);
}
