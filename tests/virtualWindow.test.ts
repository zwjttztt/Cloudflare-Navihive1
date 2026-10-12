// tests/virtualWindow.test.ts
// 虚拟化的区间计算。虚拟列表翻车的方式很固定：滚到底多渲染一行空白、
// 滚到顶算出负数下标、行高 0 时整窗 NaN —— 全是边界，全都不碰 DOM 就能验。

import test from "node:test";
import assert from "node:assert/strict";
import {
    VIRTUALIZE_THRESHOLD,
    computeWindow,
    shouldVirtualize,
} from "../src/utils/virtualWindow";

test("空列表与脏行高：整窗空，不抛 NaN", () => {
    const empty = computeWindow({ count: 0, rowHeight: 40, scrollTop: 0, viewportHeight: 600 });
    assert.deepEqual(empty, { start: 0, end: 0, padTop: 0, totalHeight: 0 });
    // 行高 0 是「调用方还没量到高度」：此时算区间毫无意义，退化成空窗
    const zero = computeWindow({ count: 100, rowHeight: 0, scrollTop: 0, viewportHeight: 600 });
    assert.equal(zero.end, 0);
    assert.equal(Number.isNaN(zero.padTop), false);
});

test("顶部：从 0 开始，padTop 为 0", () => {
    const w = computeWindow({ count: 100, rowHeight: 40, scrollTop: 0, viewportHeight: 600 });
    assert.equal(w.start, 0);
    assert.equal(w.padTop, 0);
    assert.equal(w.totalHeight, 4000);
    // 视口 600 / 行高 40 = 15 行，加 overscan 4 → end = 19
    assert.equal(w.end, 19);
});

test("中间：start/end 随滚动前移，padTop 撑出被跳过的高度", () => {
    const w = computeWindow({ count: 100, rowHeight: 40, scrollTop: 800, viewportHeight: 600 });
    assert.equal(w.start, 16); // 800/40=20，减 overscan 4
    assert.equal(w.padTop, 640); // 16 * 40
    assert.ok(w.end > w.start);
});

test("底部：end 不超过总数（多渲染一行空白就是可见 bug）", () => {
    const w = computeWindow({ count: 100, rowHeight: 40, scrollTop: 99999, viewportHeight: 600 });
    assert.equal(w.end, 100, "end 不能超过 count");
    assert.ok(w.start < 100);
    assert.equal(w.totalHeight, 4000);
});

test("负滚动与脏 count 都被夹到安全值", () => {
    const w = computeWindow({ count: 10, rowHeight: 40, scrollTop: -500, viewportHeight: 600 });
    assert.equal(w.start, 0);
    assert.equal(w.padTop, 0);
    const w2 = computeWindow({ count: -5, rowHeight: 40, scrollTop: 0, viewportHeight: 600 });
    assert.equal(w2.end, 0);
});

test("渲染条数有上限：不会因为滚到哪里就多渲染一堆", () => {
    const a = computeWindow({ count: 1000, rowHeight: 40, scrollTop: 0, viewportHeight: 600 });
    const mid1 = computeWindow({ count: 1000, rowHeight: 40, scrollTop: 20000, viewportHeight: 600 });
    const mid2 = computeWindow({ count: 1000, rowHeight: 40, scrollTop: 30000, viewportHeight: 600 });
    const b = computeWindow({ count: 1000, rowHeight: 40, scrollTop: 99999, viewportHeight: 600 });
    const rendered = (w: typeof a) => w.end - w.start;
    const cap = Math.ceil(600 / 40) + 4 * 2; // visible + 2*overscan
    for (const [name, w] of Object.entries({ a, mid1, mid2, b })) {
        assert.ok(rendered(w) <= cap, `${name} 渲染了 ${rendered(w)} 行，超过上限 ${cap}`);
    }
    // 远离两端时条数恒定（顶部 / 底部会少几个 overscan，那是应该的）
    assert.equal(rendered(mid1), rendered(mid2), "中间位置渲染条数该恒定");
    assert.ok(rendered(a) < cap, "顶部贴着边，该少渲染几个 overscan");
});

test("阈值：小列表不虚拟化（保持 DOM 结构与滚动行为原样）", () => {
    assert.equal(shouldVirtualize(VIRTUALIZE_THRESHOLD - 1), false);
    assert.equal(shouldVirtualize(VIRTUALIZE_THRESHOLD), true);
    assert.equal(shouldVirtualize(1000), true);
});
