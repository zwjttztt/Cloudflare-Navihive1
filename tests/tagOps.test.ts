// tests/tagOps.test.ts
// 标签重命名 / 合并的纯计算。这两件事手做必然出错（改一个错别字要动几十张卡片），
// 所以规则必须钉死：**不凭空造新标签、不让任何一张卡片丢标签、撞车时按合并处理**。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    allTags,
    countSitesWithTag,
    mergeTags,
    planRename,
    renameTag,
    applyTagSuggestions,
    type TagMap,
} from "../src/utils/tagOps";

const tags: TagMap = {
    "1": ["AI", "工具"],
    "2": ["AI"],
    "3": ["人工智能", "工具"],
    "4": ["设计"],
};

test("重命名：所有带旧标签的卡片换成新名字，其余标签不动", () => {
    const result = renameTag(tags, "AI", "人工智能");
    assert.ok(result, "有卡片带着 AI，应当有结果");
    assert.deepEqual(result!.tags["1"].slice().sort(), ["人工智能", "工具"]);
    assert.deepEqual(result!.tags["2"], ["人工智能"]);
    // 没带 AI 的卡片一个都不许动（连对象引用都该保持原样）
    assert.deepEqual(result!.tags["4"], ["设计"]);
    // 站点 3 原本只有「人工智能」，不在「AI」的影响面里
    assert.deepEqual(result!.affected.slice().sort(), [1, 2]);
});

test("重命名撞上已有标签 = 合并，同一张卡片上不出现两次", () => {
    // 站点 3 原本就有「人工智能」，站点 1/2 有「AI」，合并后都是一份
    const result = renameTag(tags, "AI", "人工智能");
    assert.ok(result);
    const dupes = Object.entries(result!.tags).filter(([, list]) => {
        const hit = list.filter(t => t === "人工智能");
        return hit.length > 1;
    });
    assert.deepEqual(dupes, [], "合并后同一张卡片上不能出现两个同名标签");
    assert.equal(countSitesWithTag(result!.tags, "人工智能"), 3);
    assert.equal(countSitesWithTag(result!.tags, "AI"), 0, "旧标签应彻底消失");
});

test("planRename：撞车时要如实告诉 UI 这是合并", () => {
    const plan = planRename(tags, "AI", "人工智能");
    assert.equal(plan.affectedCount, 2);
    assert.equal(plan.mergesIntoExisting, true, "目标名已存在，应标成合并");
    assert.equal(plan.noop, false);

    const plain = planRename(tags, "设计", "设计素材");
    assert.equal(plain.mergesIntoExisting, false);
    assert.equal(plain.affectedCount, 1);
});

test("planRename：空名 / 同名 / 源标签没人用，都是「没有可做的」", () => {
    assert.equal(planRename(tags, "AI", "AI").noop, true, "改成一个名字等于没改");
    assert.equal(planRename(tags, "AI", "  ").noop, true, "空名字不能改");
    assert.equal(planRename(tags, "   ", "AI").noop, true);
    assert.equal(planRename(tags, "不存在的标签", "新名").noop, true, "没人用的标签改不动");
    assert.equal(renameTag(tags, "不存在的标签", "新名"), null);
});

test("合并：多个源标签一起并到目标名下，源标签全部消失", () => {
    const result = mergeTags(tags, ["AI", "人工智能"], "智能工具");
    assert.ok(result);
    assert.equal(countSitesWithTag(result!.tags, "AI"), 0);
    assert.equal(countSitesWithTag(result!.tags, "人工智能"), 0);
    assert.equal(countSitesWithTag(result!.tags, "智能工具"), 3);
    // 非目标标签要留着
    assert.ok(result!.tags["1"].includes("工具"));
    assert.deepEqual(result!.tags["4"], ["设计"], "不相关的卡片不动");
});

test("合并：目标名已经在 sources 里也不会出错", () => {
    const result = mergeTags(tags, ["AI", "人工智能"], "人工智能");
    assert.ok(result);
    assert.equal(countSitesWithTag(result!.tags, "人工智能"), 3);
    const dupes = Object.values(result!.tags).filter(
        list => list.filter(t => t === "人工智能").length > 1
    );
    assert.deepEqual(dupes, [], "不能出现重复标签");
});

test("合并：源标签一个都没人用时返回 null（不要造出一个空操作）", () => {
    assert.equal(mergeTags(tags, ["压根没有"], "目标"), null);
    assert.equal(mergeTags(tags, [], "目标"), null);
    assert.equal(mergeTags(tags, ["  "], "目标"), null);
    assert.equal(mergeTags(tags, ["AI"], "  "), null);
});

test("脏输入：空白名被 trim，前后空格不会留下两个版本的标签", () => {
    const dirty: TagMap = { "1": ["  AI  ", "工具"] };
    const result = renameTag(dirty, " AI ", "人工智能");
    assert.ok(result);
    assert.deepEqual(result!.tags["1"], ["工具", "人工智能"]);
    assert.deepEqual(allTags(result!.tags).sort(), ["工具", "人工智能"].sort());
});

test("allTags / countSitesWithTag：统计口径与实际一致", () => {
    assert.deepEqual(allTags(tags).sort(), ["AI", "工具", "人工智能", "设计"].sort());
    assert.equal(countSitesWithTag(tags, "工具"), 2);
    assert.equal(countSitesWithTag(tags, "AI"), 2);
    assert.equal(countSitesWithTag(tags, "不存在"), 0);
    assert.equal(countSitesWithTag(tags, "  "), 0);
});

// ---- AI 标签建议的合并（纯追加）----

test("应用 AI 建议：给指定站点追加标签，已有的不重复加", () => {
    const next = applyTagSuggestions(tags, [{ id: 1, tags: ["效率"] }]);
    assert.deepEqual(next["1"], ["AI", "工具", "效率"]);
    // 没在清单里的站点原样保留
    assert.deepEqual(next["2"], ["AI"]);
});

test("应用 AI 建议：建议里已有的标签不会再补一份", () => {
    const next = applyTagSuggestions(tags, [{ id: 1, tags: ["AI", "工具"] }]);
    assert.equal(next, tags, "一条要加的都没有 → 返回原引用");
});

test("应用 AI 建议：空串与重复建议会被压掉", () => {
    const next = applyTagSuggestions(tags, [{ id: 2, tags: ["AI", "AI", "  ", ""] }]);
    assert.equal(next, tags, "除了已存在的 AI 全是空的 → 无事发生");
    const next2 = applyTagSuggestions(tags, [{ id: 2, tags: ["AI", "AI", "新标签"] }]);
    assert.deepEqual(next2["2"], ["AI", "新标签"]);
});

test("应用 AI 建议：绝不摘掉用户原有的标签（与 mergeTags 的关键区别）", () => {
    const next = applyTagSuggestions(tags, [{ id: 1, tags: ["效率"] }]);
    assert.ok(next["1"].includes("AI"), "AI 必须还在");
    assert.ok(next["1"].includes("工具"), "工具必须还在");
});

test("应用 AI 建议：一批站点里只有真正变化的才被改写", () => {
    const before = tags;
    const next = applyTagSuggestions(before, [
        { id: 1, tags: ["效率"] },
        { id: 2, tags: ["AI"] }, // 已经有了，不该产生变化
    ]);
    assert.notEqual(next, before);
    assert.deepEqual(next["1"], ["AI", "工具", "效率"]);
    assert.equal(next["2"], before["2"], "没变化的站点保持原数组引用");
});

test("应用 AI 建议：没在 tag 表里的站点 id 也能加（新建的卡片）", () => {
    const next = applyTagSuggestions(tags, [{ id: 999, tags: ["新"] }]);
    assert.deepEqual(next["999"], ["新"]);
});

test("应用 AI 建议：picked 为空 / 全是空数组 → 返回原引用", () => {
    assert.equal(applyTagSuggestions(tags, []), tags);
    assert.equal(applyTagSuggestions(tags, [{ id: 1, tags: [] }]), tags);
});
