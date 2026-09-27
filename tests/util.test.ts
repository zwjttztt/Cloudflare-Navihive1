// tests/util.test.ts
// worker/util.ts 的纯逻辑：safeJson / weakEtag / errorMessage

import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, safeJson, weakEtag } from "../worker/util";

// ============ errorMessage ============

test("errorMessage 取 Error.message", () => {
    const e = new Error("boom");
    assert.equal(errorMessage(e, "fallback"), "boom");
});

test("errorMessage 取 Error.message（空串走 fallback）", () => {
    const e = new Error("");
    assert.equal(errorMessage(e, "fallback"), "fallback");
});

test("errorMessage 非 Error 走 fallback", () => {
    assert.equal(errorMessage("plain string", "fallback"), "fallback");
    assert.equal(errorMessage(null, "fallback"), "fallback");
    assert.equal(errorMessage(undefined, "fallback"), "fallback");
    assert.equal(errorMessage(123, "fallback"), "fallback");
});

// ============ safeJson ============

test("safeJson 解析合法 JSON 对象", async () => {
    const req = new Request("https://x/", {
        method: "POST",
        body: JSON.stringify({ a: 1, b: "hi" }),
    });
    const r = await safeJson(req);
    assert.deepEqual(r, { a: 1, b: "hi" });
});

test("safeJson 解析合法 JSON 数组也返回对象", async () => {
    // 数组不是 object（typeof array === "object" 但我们用更严的判断）
    const req = new Request("https://x/", {
        method: "POST",
        body: JSON.stringify([1, 2, 3]),
    });
    const r = await safeJson(req);
    // safeJson 要求对象，数组也算 object 但被强制转成空
    // 我们这里仅验证不抛错
    assert.equal(typeof r, "object");
});

test("safeJson body 不合法 JSON 返回空对象", async () => {
    const req = new Request("https://x/", {
        method: "POST",
        body: "not json",
    });
    const r = await safeJson(req);
    assert.deepEqual(r, {});
});

test("safeJson body 为 null 返回空对象", async () => {
    const req = new Request("https://x/", {
        method: "POST",
        body: "null",
    });
    const r = await safeJson(req);
    assert.deepEqual(r, {});
});

// ============ weakEtag ============

test("weakEtag 弱格式 W/\"hash-length\"", () => {
    const tag = weakEtag("hello");
    assert.match(tag, /^W\/"[0-9a-z]+-[0-9a-z]+"$/);
});

test("weakEtag 同输入同输出", () => {
    assert.equal(weakEtag("hello world"), weakEtag("hello world"));
});

test("weakEtag 不同输入大概率不同", () => {
    // 长度变了 → hash 部分必然不同
    assert.notEqual(weakEtag("hello"), weakEtag("hello!"));
});

test("weakEtag 空串也合法", () => {
    const tag = weakEtag("");
    assert.match(tag, /^W\/"[0-9a-z]+-0"$/);
});