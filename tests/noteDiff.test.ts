// tests/noteDiff.test.ts
//
// 版本历史的行级 diff（2026-10-09 照 inkstone 的 VersionsPanel.computeLineDiff）。
// 三条必须钉死的性质，少一条都会在真机上变成「看不懂的 diff」：
//   1. 前后缀剥离 —— 只改中间一行时，不该把整篇都标成增删；
//   2. 大文本降级 —— 中间段超过 MAX_LCS_CELLS 时不跑 LCS（否则算几秒）；
//   3. 渲染上限 —— 超过 MAX_RENDERED_DIFF_LINES 时插一行「N 行未改动，已省略」。
import assert from "node:assert/strict";
import test from "node:test";
import { computeLineDiff } from "../src/utils/noteDiff";

test("只改中间一行：前后缀不动，只出一条删 + 一条加", () => {
    const before = "一\n二\n三\n四\n五";
    const after = "一\n二\n三改了\n四\n五";
    const diff = computeLineDiff(before, after);
    assert.equal(diff.removed, 1, "只删了一行");
    assert.equal(diff.added, 1, "只加了一行");
    assert.equal(diff.simplified, false);
    assert.deepEqual(
        diff.lines.filter(l => l.kind !== "same").map(l => `${l.kind}:${l.text}`),
        ["remove:三", "add:三改了"]
    );
});

test("内容一致：没有增删，也没有降级", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nb\nc");
    assert.equal(diff.added, 0);
    assert.equal(diff.removed, 0);
    assert.equal(diff.simplified, false);
    assert.ok(diff.lines.every(l => l.kind === "same"));
});

test("整段替换：前缀剥离后剩下的是纯删 + 纯加", () => {
    const before = "头\n甲\n乙\n尾";
    const after = "头\n丙\n丁\n戊\n尾";
    const diff = computeLineDiff(before, after);
    assert.equal(diff.removed, 2);
    assert.equal(diff.added, 3);
    // 头尾那两行必须是 same（剥掉了才可能只算中间）
    assert.equal(diff.lines[0].kind, "same");
    assert.equal(diff.lines[0].text, "头");
    assert.equal(diff.lines[diff.lines.length - 1].kind, "same");
    assert.equal(diff.lines[diff.lines.length - 1].text, "尾");
});

test("空串与空数组：不炸，给出确定结果", () => {
    const a = computeLineDiff("", "");
    assert.equal(a.added, 0);
    assert.equal(a.removed, 0);
    // ⚠️ `""` split 出来是**一行空行**（不是零行），所以「空 → 一行」是
    // 「删掉那行空的、加上这行有字的」= 1 删 1 加，别想当然写成 0 删 1 加。
    const b = computeLineDiff("", "一行");
    assert.equal(b.added, 1);
    assert.equal(b.removed, 1);
    const c = computeLineDiff("一行", "");
    assert.equal(c.removed, 1);
    assert.equal(c.added, 1);
});

test("大文本降级：中间段超过 LCS 格子上限时走快速比对", () => {
    // 两侧各 900 行、且**完全不同** → 中间段 810000 格 > 600000，触发降级。
    const before = Array.from({ length: 900 }, (_, i) => `旧 ${i}`).join("\n");
    const after = Array.from({ length: 900 }, (_, i) => `新 ${i}`).join("\n");
    const diff = computeLineDiff(before, after);
    assert.equal(diff.simplified, true, "超阈值要降级");
    assert.equal(diff.removed, 900);
    assert.equal(diff.added, 900);
});

test("渲染上限：超长 diff 中间插一行省略提示", () => {
    // 6000 行完全不同 → 中间段 3600 万格，先降级，再被 limits 截断到 4000 行
    const before = Array.from({ length: 6000 }, (_, i) => `旧 ${i}`).join("\n");
    const after = Array.from({ length: 6000 }, (_, i) => `新 ${i}`).join("\n");
    const diff = computeLineDiff(before, after);
    assert.equal(diff.lines.length, 4000, "渲染行数被截到上限");
    const omitted = diff.lines.filter(l => l.text.includes("已省略"));
    assert.equal(omitted.length, 1, "中间要有一行省略提示");
    assert.ok(omitted[0].text.includes("8001 行未改动"), `提示里要写清隐藏了多少行，实际：${omitted[0].text}`);
});

test("LCS 能认出「把一段挪到另一处」这类重排", () => {
    const before = "A\nB\nC\nD";
    const after = "C\nD\nA\nB";
    const diff = computeLineDiff(before, after);
    // A/B/C/D 四行都在，只是位置变了：LCS 会保留 2 行 same，删 2 行加 2 行
    assert.equal(diff.removed, 2);
    assert.equal(diff.added, 2);
    assert.ok(diff.lines.some(l => l.kind === "same"));
});
