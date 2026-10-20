// tests/pbkdf2Iters.test.ts
// 口令哈希迭代数：按运行时取值，且**老哈希必须永远验得过**。
//
// 为什么值得钉住：迭代数写在哈希串里（pbkdf2$<iters>$salt$hash），校验时按串里的数算。
// 所以「改默认值」这件事本身不会让存量账号登不进去 —— 真正会出事的是
// ① 在 Workers 上用了超过 10 万的值（运行时直接抛错），② 把自托管的库搬到 Workers
// 而没先改密码。这两条都由下面的用例守着，别等线上才发现。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_PBKDF2_ITERS,
    PBKDF2_MAX_ITERS,
    PBKDF2_MIN_ITERS,
    WORKERS_PBKDF2_MAX_ITERS,
    currentPbkdf2Iterations,
    hashPassword,
    isNodeRuntime,
    isWeakPbkdf2Hash,
    resolvePbkdf2Iterations,
    storedPbkdf2Iterations,
    verifyPassword,
} from "../src/API/crypto";

test("Workers / 浏览器侧恒为 10 万：env 也不放行，避免踩运行时上限", () => {
    assert.equal(resolvePbkdf2Iterations(undefined, { node: false }), WORKERS_PBKDF2_MAX_ITERS);
    assert.equal(resolvePbkdf2Iterations(600_000, { node: false }), WORKERS_PBKDF2_MAX_ITERS);
    assert.equal(resolvePbkdf2Iterations("1000000", { node: false }), WORKERS_PBKDF2_MAX_ITERS);
});

test("Node 侧默认 60 万，env 可覆盖，且夹在 [10 万, 100 万]", () => {
    assert.equal(resolvePbkdf2Iterations(undefined, { node: true }), DEFAULT_PBKDF2_ITERS);
    assert.equal(resolvePbkdf2Iterations("250000", { node: true }), 250_000);
    // 低于下限：取下限（再低就是拿 2020 年的强度糊弄人）
    assert.equal(resolvePbkdf2Iterations(1_000, { node: true }), PBKDF2_MIN_ITERS);
    // 高于上限：取上限（再高登录要等得太久，不划算）
    assert.equal(resolvePbkdf2Iterations(5_000_000, { node: true }), PBKDF2_MAX_ITERS);
    // 不是数字：回落默认值，而不是 NaN 钻进 pbkdf2
    assert.equal(resolvePbkdf2Iterations("abc", { node: true }), DEFAULT_PBKDF2_ITERS);
    assert.equal(resolvePbkdf2Iterations("", { node: true }), DEFAULT_PBKDF2_ITERS);
});

test("写出的哈希串里记的就是当前迭代数", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(storedPbkdf2Iterations(stored), currentPbkdf2Iterations());
    assert.ok(stored.startsWith(`pbkdf2$${currentPbkdf2Iterations()}$`));
    assert.ok(await verifyPassword("correct horse battery staple", stored));
    assert.equal(await verifyPassword("wrong", stored), false);
});

test("存量 10 万的哈希照旧验得过（迭代数从串里读，不跟着默认值走）", async () => {
    // 手工拼一条 10 万次的历史哈希：派生过程与 hashPassword 完全一致，只是迭代数固定
    const salt = new Uint8Array(16).fill(7);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("legacy"), {
        name: "PBKDF2",
    }, false, ["deriveBits"]);
    const bits = new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
            key,
            256
        )
    );
    const b64url = (bytes: Uint8Array) =>
        btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const legacy = `pbkdf2$100000$${b64url(salt)}$${b64url(bits)}`;
    assert.equal(storedPbkdf2Iterations(legacy), 100_000);
    assert.ok(await verifyPassword("legacy", legacy));
    assert.equal(await verifyPassword("legacy-wrong", legacy), false);
});

test("storedPbkdf2Iterations 对非哈希值返回 null（明文存量密码不是错误）", () => {
    assert.equal(storedPbkdf2Iterations("123456"), null);
    assert.equal(storedPbkdf2Iterations(""), null);
    assert.equal(storedPbkdf2Iterations("pbkdf2$"), null);
    assert.equal(storedPbkdf2Iterations("pbkdf2$abc$x$y"), null);
});

test("isWeakPbkdf2Hash 只在「低于当前标准」时为真", () => {
    // 用显式入参避开运行时差异（Workers 上限 10 万时这条也成立）
    const node = isNodeRuntime();
    const now = currentPbkdf2Iterations();
    assert.equal(isWeakPbkdf2Hash(`pbkdf2$${now}$x$y`), false);
    assert.equal(isWeakPbkdf2Hash(`pbkdf2$${now + 1}$x$y`), false);
    if (node && now > PBKDF2_MIN_ITERS) {
        assert.equal(isWeakPbkdf2Hash(`pbkdf2$${PBKDF2_MIN_ITERS}$x$y`), true);
    }
    // 明文存量：不是「弱哈希」，是「还没哈希」，不该混为一谈
    assert.equal(isWeakPbkdf2Hash("plain-password"), false);
});
