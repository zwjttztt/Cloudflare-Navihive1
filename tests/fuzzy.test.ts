// tests/fuzzy.test.ts
//
// 模糊匹配（2026-10-09 照 inkstone 的 client/lib/fuzzy.ts 搬的）。
// 钉死的是「用户为什么搜得到 / 搜不到」的那几条手感，改评分会直接影响排序。
import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyFilter, fuzzyMatch, splitByRanges } from "../src/utils/fuzzy";

test("直接子串命中：区间就是那一整段", () => {
    const m = fuzzyMatch("数据库设计说明", "设计");
    assert.ok(m, "要命中");
    assert.deepEqual(m!.ranges, [[3, 5]]);
    assert.ok(m!.score > 900, `整串命中要高分，实际 ${m!.score}`);
});

test("分散命中：跳过中间字也能匹配上；挨着的两字合并成一段", () => {
    // 「库设」在「数据库设计说明」里是库(2) 设(3) —— 中间没有隔字，
    // 于是命中「连击」分支：两段合并成一段，这也是标题高亮想要的效果
    // （「库设」连着标一整块，而不是拆成两个单字块）。
    const m = fuzzyMatch("数据库设计说明", "库设");
    assert.ok(m, "分散命中也要算命中");
    assert.deepEqual(m!.ranges, [[2, 4]], "挨着的两字要并成一段区间");
});

test("分散命中：真隔了字就是两段区间", () => {
    // 数(0) 设(3)：中间隔了「据库」→ 两段
    const m = fuzzyMatch("数据库设计说明", "数设");
    assert.ok(m);
    assert.deepEqual(m!.ranges, [[0, 1], [3, 4]]);
});

test("缺字就不该命中（不是「包含任意一字」）", () => {
    assert.equal(fuzzyMatch("数据库设计", "库设Z"), null, "有一个字符找不到就整条不命中");
});

test("空查询：给零分零区间，不筛掉任何东西", () => {
    const m = fuzzyMatch("随便什么", "");
    assert.ok(m);
    assert.equal(m!.score, 0);
    assert.deepEqual(m!.ranges, []);
});

test("排序：标题里直接命中的排在正文里捎带命中的前面", () => {
    const items = [
        { id: "b", text: "一堆无关的文字里提到了设计这两个字" },
        { id: "a", text: "设计稿" },
    ];
    const ranked = fuzzyFilter(items, "设计", item => item.text, 10);
    assert.equal(ranked[0].item.id, "a", "标题/开头命中的更相关");
});

test("fuzzyFilter 无查询时原样返回（不再算分）", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const out = fuzzyFilter(items, "   ", () => "x", 10);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(o => o.item.id), ["a", "b"]);
});

test("splitByRanges：命中段打标，其余原样，合并相邻区间", () => {
    const parts = splitByRanges("abcdef", [[1, 2], [2, 3], [5, 6]]);
    assert.deepEqual(parts, [
        { text: "a", hit: false },
        { text: "bc", hit: true },
        { text: "de", hit: false },
        { text: "f", hit: true },
    ]);
});

test("splitByRanges 越界区间不会炸（模糊匹配出来的区间只在标题内有效）", () => {
    // ⚠️ 真实场景：在「标题 + 正文」上跑出来的区间拿去标标题，可能整段都在标题外
    const parts = splitByRanges("ab", [[5, 9]]);
    assert.deepEqual(parts, [{ text: "ab", hit: false }], "区间全在文本外 → 原样输出");
});
