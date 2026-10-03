// tests/tagInput.test.ts
// 标签输入框 ⇄ 标签数组。
//
// 这两个函数是为了让「点一下候选就进输入框」只有一处实现：分隔符混着用
// （"AI，工具 效率"）时，手写 split 的地方多了迟早漏掉中文逗号。

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTagInput, toggleTagInInput } from "../src/utils/tagInput";

test("解析：中英文逗号与空白都算分隔", () => {
    assert.deepEqual(parseTagInput("AI，工具 效率"), ["AI", "工具", "效率"]);
    assert.deepEqual(parseTagInput("AI, 工具,效率"), ["AI", "工具", "效率"]);
});

test("解析：去空、去重、保序", () => {
    assert.deepEqual(parseTagInput("  AI  ,, 工具 ,AI "), ["AI", "工具"]);
});

test("解析：空串与纯分隔符都是空数组", () => {
    assert.deepEqual(parseTagInput(""), []);
    assert.deepEqual(parseTagInput("  ，， ,  "), []);
});

test("点候选：不在框里就追加到末尾", () => {
    assert.equal(toggleTagInInput("AI", "工具"), "AI, 工具");
    assert.equal(toggleTagInInput("", "AI"), "AI");
});

test("点候选：已经在框里就摘掉（再点一次取消）", () => {
    assert.equal(toggleTagInInput("AI, 工具", "AI"), "工具");
    assert.equal(toggleTagInInput("AI", "AI"), "");
});

test("点候选：忽略已有重复，去掉就都去掉", () => {
    // 手打成 "AI, AI" 时点一下取消，不该还剩一个 AI
    assert.equal(toggleTagInInput("AI, AI, 工具", "AI"), "工具");
});

test("点候选：顺手把乱七八糟的分隔符规整成 ', '", () => {
    assert.equal(toggleTagInInput("AI，工具", "效率"), "AI, 工具, 效率");
});

test("点候选：空标签名不动输入框", () => {
    assert.equal(toggleTagInInput("AI", "   "), "AI");
});

test("往返：加进去再点掉回到原样（忽略分隔写法差异）", () => {
    const start = "AI, 工具";
    assert.deepEqual(parseTagInput(toggleTagInInput(toggleTagInInput(start, "网盘"), "网盘")), [
        "AI",
        "工具",
    ]);
});
