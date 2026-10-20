// src/i18n/LocaleProvider.tsx
// 语言 Provider：只持有「当前语言」这一个状态，外加一个 t()。
//
// 为什么单独一层而不是塞进 UIPrefsContext：语言是全局的、几乎不变的值，
// 混进那个「每项偏好都带同步逻辑」的大对象里，会让每次改字号都把整棵树的
// 语言消费者一起重渲染。独立 context 之后，切语言才会引起重渲染。
//
// ⚠️ 这个文件**只导出组件**：context / hook / 默认值都在 ./localeStore.ts，
// 要取语言请从那边引（连带拉进 Provider 组件会绕开这次拆分，也会让热更新降级）。
import { useCallback, useMemo, useState } from "react";
import { readStoredLocale, writeStoredLocale, type Locale } from "./locale";
import { I18nContext, type I18nValue } from "./localeStore";
import { messages } from "./messages";
import { translate } from "./locale";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(() =>
        typeof localStorage === "undefined" ? "zh" : readStoredLocale(localStorage)
    );

    const setLocale = useCallback((next: Locale) => {
        setLocaleState(next);
        writeStoredLocale(next, typeof localStorage === "undefined" ? null : localStorage);
    }, []);

    const value = useMemo<I18nValue>(
        () => ({
            locale,
            setLocale,
            t: (key, fallback) => translate(messages, locale, key, fallback),
        }),
        [locale, setLocale]
    );

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export default LocaleProvider;
