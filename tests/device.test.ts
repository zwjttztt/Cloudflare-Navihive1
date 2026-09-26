// tests/device.test.ts
// 触屏判定的单测。这块逻辑只有两条输入，但每一条都踩过坑：
// - 只看媒体查询 `(hover: none) and (pointer: coarse)`：无头浏览器 / 没有输入设备的
//   CI 容器也这么报，桌面端被误判成触屏、卡片浮层常显（CI 红过一次）。
// - 只看 navigator.maxTouchPoints：Windows 桌面上它默认就是 10，桌面端直接被判成触屏。
// 所以必须两条同时成立。这里把真值表钉住，免得以后有人「顺手简化」成一条。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTouchDevice, isTouchDevice } from "../src/utils/device";

test("真手机/平板：没有悬停能力 + 有触摸点 → 触屏", () => {
    assert.equal(decideTouchDevice(true, 1), true);
    assert.equal(decideTouchDevice(true, 5), true);
});

test("无输入设备的容器（CI 的 headless）：媒体说没有悬停，但没有触摸点 → 不是触屏", () => {
    assert.equal(decideTouchDevice(true, 0), false);
});

test("普通桌面（有鼠标，media 说能悬停）→ 不是触屏", () => {
    assert.equal(decideTouchDevice(false, 0), false);
});

test("Windows 桌面：maxTouchPoints 默认是 10，但指针能悬停 → 不是触屏", () => {
    // 这条就是「只看 maxTouchPoints」会漏掉的场景
    assert.equal(decideTouchDevice(false, 10), false);
});

test("带触摸屏的笔记本：指针仍能悬停 → 保留悬停浮出", () => {
    assert.equal(decideTouchDevice(false, 10), false);
});

test("没有 window（单测 / SSR 环境）时不误判", () => {
    assert.equal(isTouchDevice(), false);
});
