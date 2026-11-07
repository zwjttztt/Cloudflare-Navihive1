// tests/scrollHysteresis.test.ts
// 头部收紧的双阈值滞回（hysteresis / Schmitt trigger）单测。
//
// 背景：头部收紧会让内容整体上移约 21px（gap / mb / pt 三处同时收），
// 而滚动位置不变 —— 于是「刚越过阈值」的那一帧元素相对视口又挪回阈值以内。
// 旧实现是滚动差分判定（`y > 90 && y > lastY + 2`），在临界点上逐帧翻面，
// 用户看到的就是头部持续抽搐、顶栏和列表跟着上下抖。
//
// 这里把六个拐点全部喂进去钉死：
//   · 从「未收紧」出发，159 还不收紧、160 收紧（ON 线上沿）
//   · 从「已收紧」出发，131 还保持、130 才放开（OFF 线下沿）
//   · **155 必须保持收紧** —— 这是滞回的核心：155 处在 130~160 的中间带里，
//     收紧导致的上移就落在这个区间，只有保持原状态才不会抖
//   · 100 远在 OFF 线以下，必须放开
//
// 反向变异自证：把 resolveHeaderCompact 的函数体换成单点阈值
// `return y >= HEADER_COMPACT_ON;`，第 5 条（true,155 → true）必红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHeaderCompact } from "../src/hooks/useViewportUi";

test("未收紧时滚到 159px：还没越过 ON 线，保持未收紧", () => {
    assert.strictEqual(resolveHeaderCompact(false, 159), false);
});

test("未收紧时滚到 160px：正好踩上 ON 线，收紧", () => {
    assert.strictEqual(resolveHeaderCompact(false, 160), true);
});

test("已收紧时回到 131px：仍在 OFF 线上方，保持收紧", () => {
    assert.strictEqual(resolveHeaderCompact(true, 131), true);
});

test("已收紧时回到 130px：踩上 OFF 线，放开", () => {
    assert.strictEqual(resolveHeaderCompact(true, 130), false);
});

test("已收紧时停在 155px：处在滞回中间带，必须保持收紧（核心防抖）", () => {
    // 头部收起自身会让内容上移约 21px，160 附近收紧后会「掉回」155 上下；
    // 单点阈值在这里会翻回 false、下一帧又翻回 true —— 就是用户看到的抽搐。
    assert.strictEqual(resolveHeaderCompact(true, 155), true);
});

test("未收紧时停在 100px：远低于 OFF 线，保持未收紧", () => {
    assert.strictEqual(resolveHeaderCompact(false, 100), false);
});

test("滞回带内反复微抖（160 → 155 → 152 → 158）不产生任何翻转", () => {
    // 模拟头部收起后滚动位置没动、只是内容位移带来的那几帧抖动
    let state = resolveHeaderCompact(false, 160);
    const seen: boolean[] = [state];
    for (const y of [155, 152, 158]) {
        state = resolveHeaderCompact(state, y);
        seen.push(state);
    }
    assert.deepStrictEqual(seen, [true, true, true, true]);
});

test("越过 OFF 线之后立刻能再次收紧：滞回不会把状态粘死", () => {
    // 一路滚回顶部 → 放开；再滚回 200 → 重新收紧
    assert.strictEqual(resolveHeaderCompact(true, 0), false);
    assert.strictEqual(resolveHeaderCompact(false, 200), true);
});
