// tests/groupColor.test.ts
// 分组配色的单测：核心是「生成出来的颜色在浅底上真的够看清」。
// 这里刻意独立实现一遍对比度计算，不复用源码里的函数 —— 否则改坏了公式两边一起错，测了等于没测。
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAccent } from "../src/utils/groupColor";

/** 解析 `hsl(h s% l%)` */
function parseHsl(value: string): [number, number, number] {
    const m = /^hsl\((\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\)$/.exec(value);
    assert.ok(m, `颜色格式不对: ${value}`);
    return [Number(m![1]), Number(m![2]) / 100, Number(m![3]) / 100];
}

/** HSL → 相对亮度（WCAG） */
function luminance(h: number, s: number, l: number): number {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r1, g1, b1] =
        hp < 1 ? [c, x, 0]
        : hp < 2 ? [x, c, 0]
        : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c]
        : hp < 5 ? [x, 0, c]
        : [c, 0, x];
    const m = l - c / 2;
    const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r1 + m) + 0.7152 * lin(g1 + m) + 0.0722 * lin(b1 + m);
}

const ratioOnWhite = (lum: number) => 1.05 / (lum + 0.05);

test("亮色下每个色相的强调色都达到 AA（≥4.5:1）", () => {
    for (let id = 0; id < 30; id++) {
        const color = groupAccent(id, "light");
        const [h, s, l] = parseHsl(color);
        const ratio = ratioOnWhite(luminance(h, s, l));
        assert.ok(
            ratio >= 4.5,
            `id=${id} 的 ${color} 对比度只有 ${ratio.toFixed(2)}，低于 4.5`
        );
    }
});

test("亮色下的颜色不会暗到发黑（否则十个分组看起来全一样）", () => {
    const lightnesses: number[] = [];
    for (let id = 0; id < 10; id++) {
        const [, , l] = parseHsl(groupAccent(id, "light"));
        lightnesses.push(l);
    }
    // 每个色相取的都是「刚好达标的最亮值」，理论上都贴着 4.6:1 的线。
    // 黄绿系（色相 42 / 96 / 142）为了达到 4.6 本来就只能压到 32% 上下，这是物理限制，
    // 所以这条只兜住「整体塌到发黑」这种情况。
    assert.ok(
        lightnesses.every(l => l >= 0.3),
        `有分组被压得过深: ${lightnesses.map(l => l.toFixed(2)).join(", ")}`
    );
});

test("不同色相允许有不同亮度（这正是修 12px 小字对比度问题的关键）", () => {
    const all = Array.from({ length: 10 }, (_, id) => parseHsl(groupAccent(id, "light"))[2]);
    const spread = Math.max(...all) - Math.min(...all);
    assert.ok(spread > 0.05, `各色相亮度几乎一样（差 ${spread.toFixed(3)}），说明又退回统一亮度了`);
});

test("同一个 id 每次结果一致（决定颜色的是 id，不是渲染顺序）", () => {
    for (let id = 0; id < 12; id++) {
        assert.equal(groupAccent(id, "light"), groupAccent(id, "light"));
    }
});

test("负数 id（虚拟分组）不会算出 NaN", () => {
    const color = groupAccent(-7, "light");
    assert.match(color, /^hsl\(\d/);
    assert.ok(!color.includes("NaN"));
});

test("暗色背景下的强调色也达标（暗底按 #121212 算）", () => {
    // 与浅底相反：暗底上要够亮才行
    const darkBg = luminance(0, 0, 0.07);
    for (let id = 0; id < 30; id++) {
        const color = groupAccent(id, "dark");
        const [h, s, l] = parseHsl(color);
        const lum = luminance(h, s, l);
        const ratio = (lum + 0.05) / (darkBg + 0.05);
        assert.ok(
            ratio >= 4.5,
            `id=${id} 暗色 ${color} 对比度只有 ${ratio.toFixed(2)}`
        );
    }
});
