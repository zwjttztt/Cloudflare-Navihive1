// tests/errorReporter.test.ts
// 客户端错误上报的 sanitize 纯逻辑测试。
// sendBeacon / window.addEventListener 这两块用 mock 替身。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    sanitize,
    cleanStr,
    reportError,
    normalizeError,
} from "../src/utils/errorReporter";

// 暴露 sanitize 与 cleanStr 供测试：当前模块没直接导出，加一个间接测试入口
// —— 通过 normalizeError + reportError 的输入侧验证 sanitize 行为

test("cleanStr 去掉控制字符并截断", () => {
    assert.equal(cleanStr("a\x00b\x01c"), "abc");
    assert.equal(cleanStr("x".repeat(100), 10), "x".repeat(10));
    assert.equal(cleanStr(123), "");
    assert.equal(cleanStr(null), "");
    assert.equal(cleanStr(undefined), "");
});

test("normalizeError 还原 Error", () => {
    const e = new TypeError("bad input");
    const n = normalizeError(e);
    assert.equal(n.name, "TypeError");
    assert.equal(n.message, "bad input");
    assert.match(n.stack, /TypeError/);
});

test("normalizeError 接受字符串", () => {
    const n = normalizeError("just a string");
    assert.equal(n.name, "NonError");
    assert.equal(n.message, "just a string");
});

test("sanitize：键名命中黑名单要重写", () => {
    const out = sanitize({
        username: "alice",
        password: "secret123",
        auth: "Bearer xyz",
        cookie: "sid=abc",
        authorization: "Bearer token",
        token: "tk",
    }) as Record<string, string>;
    assert.equal(out.username, "alice");
    assert.equal(out.password, "[redacted]");
    assert.equal(out.auth, "[redacted]");
    assert.equal(out.cookie, "[redacted]");
    assert.equal(out.authorization, "[redacted]");
    assert.equal(out.token, "[redacted]");
});

test("sanitize：键名大小写不敏感", () => {
    const out = sanitize({ Password: "x", AUTHORIZATION: "y" }) as Record<string, string>;
    assert.equal(out.Password, "[redacted]");
    assert.equal(out.AUTHORIZATION, "[redacted]");
});

test("sanitize：键名后缀匹配 token/password", () => {
    const out = sanitize({
        mytoken: "x",
        userPassword: "y",
        csrfToken: "z",
    }) as Record<string, string>;
    assert.equal(out.mytoken, "[redacted]");
    assert.equal(out.userPassword, "[redacted]");
    assert.equal(out.csrfToken, "[redacted]");
});

test("sanitize：URL 类字段去掉 query/hash/userinfo", () => {
    const out = sanitize({
        url: "https://example.com/path?token=abc&q=hi#frag",
        href: "https://user:pass@example.com/x?secret=y",
        src: "/relative/path",
        location: "https://x.com/",
    }) as Record<string, string>;
    assert.equal(out.url, "https://example.com/path");
    // userinfo 被 URL parser 解析成 host/user 里的一部分；至少 secret query 应被剥离
    assert.equal(out.href, "https://example.com/x");
    // 相对路径：相对 base 解析可能 host 为 placeholder；这里只验没带 query
    assert.equal(out.src.indexOf("?"), -1);
});

test("sanitize：嵌套对象递归", () => {
    const out = sanitize({
        user: { name: "alice", password: "p", inner: { token: "t" } },
    }) as { user: Record<string, string> };
    assert.equal(out.user.name, "alice");
    assert.equal(out.user.password, "[redacted]");
    assert.equal((out.user.inner as Record<string, string>).token, "[redacted]");
});

test("sanitize：数组截断到 50", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const out = sanitize({ list: arr }) as { list: number[] };
    assert.equal(out.list.length, 50);
    assert.equal(out.list[0], 0);
    assert.equal(out.list[49], 49);
});

test("sanitize：深度限制防无限嵌套", () => {
    // 构造 10 层嵌套对象
    let deep: Record<string, unknown> = { v: "leaf" };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    // 限制 depth=4，到第 5 层会返回 null
    const out = sanitize(deep) as Record<string, unknown>;
    // 顶部 n 是 dict，再下几层为 null
    let cur: Record<string, unknown> = out;
    let depth = 0;
    while (cur && typeof cur === "object" && "n" in cur) {
        cur = cur.n as Record<string, unknown>;
        depth++;
        if (depth > 8) break;
    }
    assert.ok(depth <= 6, `should clamp depth, got ${depth}`);
});

test("reportError 不抛错（同错误节流 + sendBeacon mock）", () => {
    // 模拟 sendBeacon 不在（Node 22 没 navigator），降级到 fetch；fetch 也 mock 掉
    const origFetch = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = (() => {
        // 不抛错，模拟成功
        return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
        // 第一次上报
        reportError(new Error("first"), { source: "test" });
        // 10s 内同错误被节流，直接返回
        reportError(new Error("first"), { source: "test" });
        // 不同错误通过
        reportError(new Error("second"), { source: "test" });
    } finally {
        (globalThis as { fetch?: typeof fetch }).fetch = origFetch;
    }
});

test("reportError 体积硬截断（超过 8KB 只发精简版）", () => {
    let captured = "";
    const origFetch = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        captured = String(init?.body || "");
        return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    try {
        // 大 stack 触发截断
        const err = new Error("boom");
        err.stack = "x".repeat(20_000);
        reportError(err, {
            source: "size",
            context: { big: "y".repeat(20_000) },
        });
        assert.ok(captured.length <= 8 * 1024, `payload too large: ${captured.length}`);
    } finally {
        (globalThis as { fetch?: typeof fetch }).fetch = origFetch;
    }
});