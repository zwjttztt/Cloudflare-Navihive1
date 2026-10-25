// tests/tagPalette.test.ts
// 标签自动配色（2026-10-25 笔记美化）的纯函数用例。
//
// 为什么值得单独钉：这个哈希决定「同一个标签在所有设备、所有会话里都是同一个颜色」。
// 一旦写成不确定的形态（Math.random、时间种子），今天蓝明天绿，
// 用户会以为标签颜色是随机的、进而完全不看它 —— 那这个功能等于没做。

import { test } from "node:test";
import assert from "node:assert/strict";
import { TAG_COLOR_COUNT, tagColorIndex, tagColorVar } from "../src/utils/tagPalette";

test("同一名字永远同一档（跨调用 / 跨会话稳定）", () => {
    assert.equal(tagColorIndex("工作"), tagColorIndex("工作"));
    assert.equal(tagColorIndex("reading-list"), tagColorIndex("reading-list"));
    // 首尾空格不影响（tagNamesOf 的名字可能带空白，调用方也先 trim）
    assert.equal(tagColorIndex("  工作  "), tagColorIndex("工作"));
});

test("档位落在 0..5 —— 与 index.css 的 --tag-1-fg … --tag-6-fg 一一对应", () => {
    const names = ["工作", "生活", "读书", "a", "bb", "ccc", "项目/alphago", "待办", "重要", "english"];
    for (const n of names) {
        const idx = tagColorIndex(n);
        assert.ok(idx !== null);
        assert.ok(idx! >= 0 && idx! < TAG_COLOR_COUNT, `${n} → ${idx} 越界`);
        assert.equal(Number.isInteger(idx), true);
    }
});

test("空名字 / 纯空白返回 null（调用方据此退回中性灰，不猜颜色）", () => {
    assert.equal(tagColorIndex(""), null);
    assert.equal(tagColorIndex("   "), null);
});

test("分布够散：20 个常用标签至少落到 4 档（不能全挤一档）", () => {
    const names = Array.from({ length: 20 }, (_, i) => `标签${i}`);
    const buckets = new Set(names.map(n => tagColorIndex(n)));
    assert.ok(buckets.size >= 4, `20 个标签只用到 ${buckets.size} 档，哈希太挤`);
});

test("tagColorVar 输出 1..6 的 CSS 变量，越界值钳回范围内", () => {
    assert.equal(tagColorVar(0), "var(--tag-1-fg)");
    assert.equal(tagColorVar(5), "var(--tag-6-fg)");
    // 越界不该产出 var(--tag-7-fg) 这种不存在的变量
    assert.equal(tagColorVar(6), "var(--tag-1-fg)");
    assert.equal(tagColorVar(-1), "var(--tag-6-fg)");
});
