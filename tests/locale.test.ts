// tests/locale.test.ts
// i18n 骨架的用例（2026-10-20）。
//
// 钉的是这套设计的**三个承诺**，任何一个被改坏都会直接伤到界面：
//   ① zh 列取出来的必须**等于**界面上原来的硬编码文案 —— 否则接入 i18n 就等于改字；
//   ② 缺翻译时回落 zh，再回落兜底，最后回落 key —— 绝不能显示 undefined / 空白；
//   ③ 语言只认得两种，认不出来一律按默认，存储里的脏数据不能把界面弄崩。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LOCALE,
    LOCALE_STORAGE_KEY,
    LOCALES,
    normalizeLocale,
    readStoredLocale,
    translate,
    writeStoredLocale,
} from "../src/i18n/locale";
import { messages } from "../src/i18n/messages";

test("语言只认 zh / en，认不出来一律回落默认", () => {
    assert.equal(normalizeLocale("zh"), "zh");
    assert.equal(normalizeLocale("en"), "en");
    // 带地区的写法要认（浏览器语言最常见就是这种）
    assert.equal(normalizeLocale("zh-CN"), "zh");
    assert.equal(normalizeLocale("en-US"), "en");
    // 脏数据：不认识的一律当没配过，不能抛错也不能显示空白
    assert.equal(normalizeLocale("jp"), DEFAULT_LOCALE);
    assert.equal(normalizeLocale(null), DEFAULT_LOCALE);
    assert.equal(normalizeLocale(42), DEFAULT_LOCALE);
    assert.equal(normalizeLocale(""), DEFAULT_LOCALE);
});

test("存储读写：读不到 / 存不下都不影响本次会话", () => {
    const store = new Map<string, string>();
    const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
    };
    assert.equal(readStoredLocale(storage), DEFAULT_LOCALE, "没配过时是默认");
    writeStoredLocale("en", storage);
    assert.equal(store.get(LOCALE_STORAGE_KEY), "en");
    assert.equal(readStoredLocale(storage), "en");

    // storage 整个不可用（隐私模式 / 没这个全局）：读成默认，写不崩
    assert.equal(readStoredLocale(null), DEFAULT_LOCALE);
    assert.doesNotThrow(() => writeStoredLocale("zh", null));
    // 抛异常的 storage 也要兜住（配额满 / 被禁用）
    const hostile = {
        getItem: () => {
            throw new Error("blocked");
        },
        setItem: () => {
            throw new Error("blocked");
        },
    };
    assert.equal(readStoredLocale(hostile), DEFAULT_LOCALE);
    assert.doesNotThrow(() => writeStoredLocale("en", hostile));
});

test("取文案：zh 列必须与界面原文逐字一致（接入不允许顺手改字）", () => {
    assert.equal(translate(messages, "zh", "settings.language.title"), "界面语言");
    assert.equal(translate(messages, "zh", "settings.language.note"), "切换后立即生效，不需要刷新。");
    assert.equal(translate(messages, "en", "settings.language.title"), "Language");
});

test("取文案的回落链：当前语言 → zh → 兜底 → key", () => {
    // en 缺这一条时回落到 zh，而不是空白 —— 缺翻译最多是「这一处还是中文」
    const partial = { k: { zh: "中文文案" } as { zh: string; en?: string } };
    assert.equal(translate(partial as never, "en", "k"), "中文文案");
    // 表里没有这个 key：先用调用方给的兜底
    assert.equal(translate(messages, "en", "没有的 key", "兜底文案"), "兜底文案");
    // 连兜底都没有：显示 key 本身 —— 一眼看得出「这条还没翻译」，比空白好查
    assert.equal(translate(messages, "en", "settings.language.missing"), "settings.language.missing");
});

test("语言清单就是这两种，且默认必须是 zh（全站现有文案是中文）", () => {
    assert.deepEqual(LOCALES, ["zh", "en"]);
    assert.equal(DEFAULT_LOCALE, "zh");
    // 文案表里每一条 zh 都不能是空的：空文案在界面上就是一个「什么都没有」的按钮
    for (const [key, msg] of Object.entries(messages)) {
        assert.ok(msg.zh && msg.zh.trim(), `${key} 的 zh 列不能为空`);
    }
});
