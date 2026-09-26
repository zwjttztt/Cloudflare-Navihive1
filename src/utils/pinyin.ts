// src/utils/pinyin.ts
// 拼音搜索：开启后可以用「bd」搜到「百度」、「txy」搜到「腾讯云」。
// 词典（pinyin-match，约 28KB）是按需加载的：开关关闭时完全不会请求这个 chunk。

type PinyinMatchFn = (input: string, keys: string) => [number, number] | false;

let matcher: PinyinMatchFn | null = null;
let loading: Promise<PinyinMatchFn | null> | null = null;

/** 是否已就位（加载完成或已失败都算结束） */
export const isPinyinReady = (): boolean => matcher !== null;

/**
 * 加载拼音词典。重复调用只会真的加载一次。
 * 失败时返回 null，调用方按「不支持拼音」继续，不影响正常搜索。
 */
export function loadPinyinMatcher(): Promise<PinyinMatchFn | null> {
    if (matcher) return Promise.resolve(matcher);
    if (loading) return loading;

    loading = import("pinyin-match")
        .then(mod => {
            const fn = (mod as unknown as { default?: PinyinMatchFn }).default;
            if (typeof fn === "function") {
                matcher = fn;
                return fn;
            }
            return null;
        })
        .catch(() => null);

    return loading;
}

/**
 * 拼音（含首字母缩写）是否命中。
 * 注意：pinyin-match 匹配的是「连续片段」，所以只在常规匹配失败时才兜底用一次。
 */
export function matchesByPinyin(text: string, query: string): boolean {
    if (!matcher || !text || !query) return false;
    try {
        return matcher(text, query) !== false;
    } catch {
        return false;
    }
}
