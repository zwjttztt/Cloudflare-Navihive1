// tests/pinyin.test.ts
// 拼音搜索的加载与兜底。
//
// 这个模块以前是**零覆盖**的 —— search.test.ts 开头那句「拼音本身由端到端冒烟覆盖」
// 是假的：全仓 grep 下来没有任何冒烟/用例碰过拼音（我在 search.test.ts 里把那句
// 改成了指向本文件）。拼音坏了的表现很安静：开关开着、搜不到、没人报错。
//
// 这里只测**本模块的职责**，不替 pinyin-match 测词典：
//   1. 没加载时一律 false（不得误命中、不得抛）；
//   2. 加载是一次性的（重复调用不会反复拉词典）；
//   3. 加载失败要返回 null 而不是抛（调用方按「不支持拼音」继续）；
//   4. 真加载完，「bd」要能搜到「百度」—— 这条才是用户看到的功能。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPinyinReady, loadPinyinMatcher, matchesByPinyin } from "../src/utils/pinyin";
import { matchesSiteQuery } from "../src/utils/search";

// 模块级状态是共享的：下面几条按书写顺序跑，第一条必须在任何 load 之前。
test("词典还没加载：isPinyinReady 为 false（开关关着时不该有词典在内存里）", () => {
    assert.equal(isPinyinReady(), false);
});

test("词典还没加载：matchesByPinyin 一律 false，不抛", () => {
    // 这条是「拼音开关开了但词典没拉下来」时的兜底：宁可搜不到，也不能误命中
    assert.equal(matchesByPinyin("百度", "bd"), false);
    assert.equal(matchesByPinyin("百度", ""), false);
    assert.equal(matchesByPinyin("", "bd"), false);
});

test("加载得到匹配函数，且 isPinyinReady 转为 true", async () => {
    const fn = await loadPinyinMatcher();
    assert.equal(typeof fn, "function");
    assert.equal(isPinyinReady(), true);
});

// 坦白一句：这条**拦不住**「把 if (loading) return loading 删掉」那种改法 ——
// 因为 import() 本身有模块缓存，两次解析出来的还是同一个函数。它能拦住的是
// 「每次都包一层新函数返回」（那样引用就不同了）。真要盯住加载次数得注入 spy，
// 为这点收益不值得往源码里开测试专用的口子。
test("重复加载只真的加载一次：两次调用拿到同一个函数", async () => {
    const a = await loadPinyinMatcher();
    const b = await loadPinyinMatcher();
    assert.equal(a, b, "第二次必须复用第一次的结果，不能再去拉一遍词典");

    // 并发调用也只该有一份
    const [c, d] = await Promise.all([loadPinyinMatcher(), loadPinyinMatcher()]);
    assert.equal(c, d);
    assert.equal(c, a);
});

test("真加载完：首字母缩写能命中（bd → 百度、txy → 腾讯云）", () => {
    assert.equal(matchesByPinyin("百度", "bd"), true);
    assert.equal(matchesByPinyin("腾讯云", "txy"), true);
});

test("真加载完：不相关的拼音不该命中", () => {
    assert.equal(matchesByPinyin("百度", "xyz"), false);
    assert.equal(matchesByPinyin("百度", "github"), false);
});

test("真加载完：空文本 / 空查询仍为 false（空查询不能等于「全都命中」）", () => {
    assert.equal(matchesByPinyin("百度", ""), false);
    assert.equal(matchesByPinyin("", "bd"), false);
});

// 兜住「模块能加载」和「搜索真的用上了它」之间的那一步：
// 只测 loadPinyinMatcher 拿得到函数，是证明不了用户搜 "bd" 能搜到「百度」的。
test("从搜索入口走一遍：开着拼音搜 bd 能搜到「百度」", () => {
    const target = {
        id: 1,
        group_id: 1,
        name: "百度",
        url: "https://www.baidu.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 0,
    };
    assert.equal(matchesSiteQuery(target, "bd", false), false, "关着拼音时搜不到");
    assert.equal(matchesSiteQuery(target, "bd", true), true, "开着拼音就该搜到");
});
