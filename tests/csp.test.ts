// tests/csp.test.ts
// worker/csp.ts：解析浏览器发来的 csp-report 并 warn 到日志。
// handleCspReport 返回 204 + 不抛错；测试通过 console.warn spy 间接验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCspReport } from "../worker/csp";

function makeReq(body: string): Request {
    return new Request("https://x/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body,
    });
}

test("csp 报告合法 JSON 被解析并 warn", async () => {
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
        captured.push(args.join(" "));
    };
    try {
        const r = await handleCspReport(
            makeReq(
                JSON.stringify({
                    "csp-report": {
                        "violated-directive": "script-src 'self'",
                        "blocked-uri": "https://evil.com/x.js",
                        "source-file": "https://x.com/",
                        "line-number": 12,
                    },
                })
            )
        );
        assert.equal(r.status, 204);
        assert.equal(captured.length, 1);
        assert.match(captured[0], /directive=script-src/);
        assert.match(captured[0], /blocked=https:\/\/evil\.com\/x\.js/);
    } finally {
        console.warn = orig;
    }
});

test("csp 报告使用 effective-directive 作为 fallback", async () => {
    const orig = console.warn;
    const captured: string[] = [];
    console.warn = (...args: unknown[]) => {
        captured.push(args.join(" "));
    };
    try {
        await handleCspReport(
            makeReq(
                JSON.stringify({
                    "csp-report": {
                        "effective-directive": "img-src",
                        "blocked-uri": "data:",
                    },
                })
            )
        );
        assert.match(captured[0], /directive=img-src/);
    } finally {
        console.warn = orig;
    }
});

test("csp 报告不合法 JSON 不抛错", async () => {
    const r = await handleCspReport(makeReq("not json {{{"));
    assert.equal(r.status, 204);
});

test("csp 报告缺 csp-report 字段也不抛错", async () => {
    const r = await handleCspReport(makeReq(JSON.stringify({ foo: "bar" })));
    assert.equal(r.status, 204);
});

test("csp 报告超 8KB 直接丢弃（不解析、不 warn）", async () => {
    const orig = console.warn;
    let called = false;
    console.warn = () => {
        called = true;
    };
    try {
        const big = "x".repeat(9000);
        const r = await handleCspReport(makeReq(big));
        assert.equal(r.status, 204);
        assert.equal(called, false);
    } finally {
        console.warn = orig;
    }
});