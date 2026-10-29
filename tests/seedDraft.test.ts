// tests/seedDraft.test.ts
// 草稿播种决策的规则守卫（src/components/notes/seedDraft.ts）。
//
// 这套规则直接决定「用户写的字还在不在编辑器里」，而它已经被线上打过两次脸：
//   · 摘要态灌进草稿 → 一保存整篇被砍成开头一段；
//   · 摘要态一律清草稿 → 保存后列表刷新，编辑器当场变空（2026-10-29 线上反馈）。
// 所以四条分支逐条钉住，别让第三个人第三次踩进来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDraftSeed } from "../src/components/notes/seedDraft";

const FULL = { id: 9, title: "笔记", content: "123".repeat(50) };
const SUMMARY = { id: 9, title: "笔记", content: "123", content_truncated: true };

test("换到一条还没补全的笔记：清空草稿（防止上一条正文被当成本条改动写过去）", () => {
    const decision = decideDraftSeed(SUMMARY, 3, { title: "上一条", content: "上一条的正文" });
    assert.equal(decision.kind, "clear");
});

test("同一条笔记刷新回摘要态：保留草稿（这就是「写着写着变空」的修复点）", () => {
    const decision = decideDraftSeed(SUMMARY, 9, { title: "笔记", content: "用户刚打的字" });
    assert.equal(decision.kind, "keep");
});

test("同一条笔记补全回全文且已有草稿：不覆盖用户正在编辑的内容", () => {
    const decision = decideDraftSeed(FULL, 9, { title: "笔记", content: "用户刚打的字" });
    assert.equal(decision.kind, "keep");
});

test("第一次拿到全文（手上没有草稿）：把全文灌进去", () => {
    const decision = decideDraftSeed(FULL, 9, null);
    assert.deepEqual(decision, { kind: "set", draft: { title: "笔记", content: FULL.content } });
});

test("从别的笔记切过来且立刻拿到全文：照常灌入", () => {
    const decision = decideDraftSeed(FULL, 3, { title: "上一条", content: "上一条的正文" });
    assert.deepEqual(decision, { kind: "set", draft: { title: "笔记", content: FULL.content } });
});

test("字段缺失按空串处理，不会把 undefined 灌进草稿", () => {
    const decision = decideDraftSeed({ id: 5 }, null, null);
    assert.deepEqual(decision, { kind: "set", draft: { title: "", content: "" } });
});

test("没有选中笔记：什么都不做", () => {
    assert.equal(decideDraftSeed(null, 9, { title: "x", content: "y" }).kind, "keep");
});
