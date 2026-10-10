// tests/noteWikiLink.test.ts
// `[[双链]]` 解析与反向链接的**纯函数**用例。
//
// 这块最容易出「看起来对其实错」的地方，所以判据写得比较细：
//   - 忽略行内代码 / 围栏代码 / 转义 / 链接目标内 / 标题行语法
//   - 标题比较忽略大小写与首尾空白（用户打 [[API]] 要能命中「api」）
//   - 死链（[[不存在]]）不给入口
//   - 自己链自己不算反向链接
import { test } from "node:test";
import assert from "node:assert/strict";

import { extractWikiLinks, buildBacklinks, resolveWikiLinks } from "../src/utils/noteWikiLink";

test("基本解析：提取 [[目标]]，去重且保持出现顺序", () => {
    assert.deepEqual(
        extractWikiLinks("看 [[甲]] 和 [[乙]]，再看 [[甲]]"),
        ["甲", "乙"]
    );
});

test("忽略代码与转义：代码块里的不算数", () => {
    assert.deepEqual(extractWikiLinks("行内 `[[代码]]` 不算"), []);
    assert.deepEqual(extractWikiLinks("```\n[[围栏]]\n```"), []);
    assert.deepEqual(extractWikiLinks("真实 [[要算]]"), ["要算"]);
});

test("忽略链接目标内部与转义写法", () => {
    // [文字]([[地址]]) 里的方括号不是双链
    assert.deepEqual(extractWikiLinks("[文字](https://a.com/[[x]])"), []);
    // 转义后不识别
    assert.deepEqual(extractWikiLinks("\\[[不是双链]]"), []);
});

test("三个方括号不识别（只认恰好两个）", () => {
    assert.deepEqual(extractWikiLinks("[[[文献]]]"), []);
});

test("空目标与超长目标：空的不给，太长的不给", () => {
    assert.deepEqual(extractWikiLinks("[[]]"), []);
    assert.deepEqual(extractWikiLinks("[[   ]]"), []);
    assert.deepEqual(extractWikiLinks(`[[${"长".repeat(200)}]]`), []);
});

test("目标里的首尾空白会被去掉", () => {
    assert.deepEqual(extractWikiLinks("[[  甲乙  ]]"), ["甲乙"]);
});

test("不含 [[ 时直接短路，不建解析器", () => {
    assert.deepEqual(extractWikiLinks("普通正文没有链接"), []);
});

const notes = [
    { id: 1, title: "设计稿", content: "参考 [[数据库设计]] 与 [[接口约定]]" },
    { id: 2, title: "数据库设计", content: "表结构见 [[设计稿]]" },
    { id: 3, title: "接口约定", content: "没有链接" },
    { id: 4, title: "随手记", content: "提到 [[不存在的笔记]]" },
];

test("反向链接：谁引用了这条", () => {
    const back = buildBacklinks(notes, notes[1]);
    assert.deepEqual(back.map(n => n.id), [1], "只有《设计稿》引用了《数据库设计》");
});

test("反向链接：标题比较忽略大小写与首尾空白", () => {
    const list = [
        { id: 1, title: "API 约定", content: "" },
        { id: 2, title: "  api 约定  ", content: "见 [[API 约定]]" },
    ];
    const back = buildBacklinks(list, list[0]);
    assert.deepEqual(back.map(n => n.id), [2]);
});

test("反向链接：自己链自己不算", () => {
    assert.deepEqual(buildBacklinks(notes, notes[0]).map(n => n.id), [2]);
});

test("反向链接：空标题的笔记不会收到一堆误报", () => {
    const list = [
        { id: 9, title: "   ", content: "" },
        { id: 10, title: "甲", content: "[[ ]]" },
    ];
    assert.deepEqual(buildBacklinks(list, list[0]), []);
});

test("正向解析：只给真实存在的目标（死链不返回）", () => {
    const out = resolveWikiLinks(notes, notes[0]);
    assert.deepEqual(out.map(n => n.id), [2, 3]);
});

test("正向解析：链到自己不算", () => {
    const self = { id: 5, title: "自链", content: "[[自链]]" };
    assert.deepEqual(resolveWikiLinks([self], self), []);
});

// ---------- N6 别名语法 `[[目标|显示名]]` ----------

test("N6 别名：extractWikiLinks 只给目标名（别名剥掉）", () => {
    assert.deepEqual(extractWikiLinks("见 [[目标|显示名]] 一眼"), ["目标"]);
    // 多个 | 只按第一个切，后面全算显示名
    assert.deepEqual(extractWikiLinks("[[目标|显示|名]]"), ["目标"]);
    // 没有别名的普通双链不受影响
    assert.deepEqual(extractWikiLinks("[[普通]]"), ["普通"]);
    // 目标名在 | 前面空着 → 不是双链
    assert.deepEqual(extractWikiLinks("[[|只有别名]]"), []);
});

test("N6 别名：反链按目标名命中（写别名也能被找到）", () => {
    const list = [
        { id: 1, title: "目标页", content: "" },
        { id: 2, title: "来源", content: "看 [[目标页|这篇]] 就懂了" },
    ];
    assert.deepEqual(buildBacklinks(list, list[0]).map(n => n.id), [2]);
    assert.deepEqual(resolveWikiLinks(list, list[1]).map(n => n.id), [1]);
});
