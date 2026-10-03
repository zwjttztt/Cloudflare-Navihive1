// tests/tagSuggest.test.ts
// 「网站设置」里标签快捷候选的取值规则。规则本身简单，但**去重**那条容易漏：
// 同一排里出现两个一样的词，用户点哪个都一样，看着像卡住了。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    pickExistingTags,
    pickRecommendedTags,
    RECOMMENDED_TAGS,
} from "../src/utils/tagSuggest";

test("现有标签：去掉这张卡片已经加过的", () => {
    const next = pickExistingTags(["AI", "工具", "效率"], ["工具"]);
    assert.deepEqual(next, ["AI", "效率"], "保持原顺序（调用方已按使用次数排好）");
});

test("现有标签：受 limit 限制", () => {
    const all = Array.from({ length: 20 }, (_, i) => `t${i}`);
    assert.equal(pickExistingTags(all, []).length, 8, "默认取 8 个");
    assert.equal(pickExistingTags(all, [], 3).length, 3);
});

test("现有标签：全被这张卡片用过 → 空", () => {
    assert.deepEqual(pickExistingTags(["AI", "工具"], ["AI", "工具"]), []);
});

test("推荐标签：排除卡片已有的，也排除已经在「现有」里露出的", () => {
    // 「工具」同时出现在两边：不该在推荐里再露一次
    const next = pickRecommendedTags(["工具", "网盘"], ["AI"]);
    assert.equal(next.includes("工具"), false, "现有标签里已经有了");
    assert.equal(next.includes("AI"), false, "卡片已经有了");
    assert.equal(next.includes("网盘"), false, "现有标签里已经有了");
});

test("推荐标签：默认取 6 个，且都来自 RECOMMENDED_TAGS", () => {
    const next = pickRecommendedTags([], []);
    assert.equal(next.length, 6);
    for (const tag of next) assert.ok(RECOMMENDED_TAGS.includes(tag));
});

test("推荐标签：limit 生效", () => {
    // 把 RECOMMENDED_TAGS 全占了才能看出 limit —— 用现有标签全遮住再取 0/2 个
    assert.equal(pickRecommendedTags(RECOMMENDED_TAGS, []).length, 0);
    assert.equal(pickRecommendedTags([], [], 2).length, 2);
});

test("两排候选不会撞车：现有全部用过的卡片，推荐里也不会重复出现它们", () => {
    const existing = pickExistingTags(["AI", "工具"], []);
    const recommended = pickRecommendedTags(["AI", "工具"], []);
    const overlap = recommended.filter(tag => existing.includes(tag));
    assert.deepEqual(overlap, [], "同一排里不能出现两个一样的词");
});
