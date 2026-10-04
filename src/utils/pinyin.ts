// src/utils/pinyin.ts
// 拼音搜索：开启后可以用「bd」搜到「百度」、「txy」搜到「腾讯云」。
// 词典（pinyin-match，约 28KB）是按需加载的：开关关闭时完全不会请求这个 chunk。

type PinyinMatchFn = (input: string, keys: string) => [number, number] | false;

let matcher: PinyinMatchFn | null = null;
let loading: Promise<PinyinMatchFn | null> | null = null;

/** 是否已就位（加载完成或已失败都算结束） */
export const isPinyinReady = (): boolean => matcher !== null;

/**
 * 从动态 import 的结果里把 match 函数挖出来。
 *
 * ⚠️ pinyin-match 的**默认导出是对象不是函数**：ESM 入口（es/main.js，也就是打包器
 * 优先选的 `module` 字段）最后是 `export { l as default }`，而 `l` 是 `{ match }`；
 * CJS 入口同理是 `module.exports = { match }`。所以只认
 * `typeof mod.default === "function"` 是取不到东西的 —— 以前正是这么写的，
 * 结果 matcher 永远是 null：拼音开关开了、搜不到、还不报错（match 为 null 时
 * matchesByPinyin 直接返回 false）。这个 bug 是靠 tests/pinyin.test.ts 逼出来的。
 */
function pickMatcher(mod: unknown): PinyinMatchFn | null {
    const ns = mod as { default?: unknown; match?: unknown } | null;
    const nested = ns?.default as { match?: unknown } | undefined;
    for (const candidate of [ns?.default, nested?.match, ns?.match]) {
        if (typeof candidate === "function") return candidate as PinyinMatchFn;
    }
    return null;
}

/**
 * 加载拼音词典。重复调用只会真的加载一次。
 * 失败时返回 null，调用方按「不支持拼音」继续，不影响正常搜索。
 */
export function loadPinyinMatcher(): Promise<PinyinMatchFn | null> {
    if (matcher) return Promise.resolve(matcher);
    if (loading) return loading;

    loading = import("pinyin-match")
        .then(mod => {
            const fn = pickMatcher(mod);
            if (fn) {
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
