import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundMaskOpacity, MIN_BACKGROUND_MASK } from "../src/utils/backgroundMask";

test("背景蒙版：滑块越大蒙版越淡", () => {
    assert.ok(backgroundMaskOpacity(0.2) > backgroundMaskOpacity(0.8));
});

test("背景蒙版：拉到最清晰也保留一层下限，保证文字可读", () => {
    assert.equal(backgroundMaskOpacity(1), MIN_BACKGROUND_MASK);
    assert.ok(backgroundMaskOpacity(1) > 0, "蒙版不能为 0");
    // 0.95 已经很接近上限，也要被夹到下限
    assert.equal(backgroundMaskOpacity(0.95), MIN_BACKGROUND_MASK);
});

test("背景蒙版：最模糊时接近全遮，但不会越界", () => {
    assert.equal(backgroundMaskOpacity(0), 1);
    assert.ok(backgroundMaskOpacity(0) <= 1);
});

test("背景蒙版：脏数据不会把整张图盖死，也不会崩", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5, 3]) {
        const v = backgroundMaskOpacity(bad);
        assert.ok(v >= MIN_BACKGROUND_MASK && v <= 1, `输入 ${bad} 得到 ${v}`);
    }
    // NaN 走「最清晰」分支，也就是只留下限
    assert.equal(backgroundMaskOpacity(Number.NaN), MIN_BACKGROUND_MASK);
});
