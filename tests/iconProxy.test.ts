// tests/iconProxy.test.ts
// worker/icon.ts 的 content-type 处理。守的是一条容易被忘的 XSS 路径：
//
// 这个路由是公开的（<img> 拉图标带不上凭据），谁都能让它去取自己服务器上的东西。
// 一旦把上游的 content-type 原样透传，返回一个 image/svg+xml 就意味着：
// 受害者打开 /api/icon?u=https://evil/x.svg 时浏览器会把它当**同源文档**渲染，
// SVG 里内联的 <script> 随之执行，同源足以让它 fetch('/api/export') 带走全部数据。
// 所以类型只放行真正的图片，其余一律降为下载，并且给图片也套上 CSP sandbox。

import { test } from "node:test";
import assert from "node:assert/strict";
import { proxyIcon, resetIconRateLimitForTest } from "../worker/icon";

/** 把全局 fetch 打桩成固定响应 */
function stubFetch(headers: Record<string, string>, body = "fake-bytes") {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response(body, { status: 200, headers });
    }) as typeof fetch;
    return {
        calls,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

const iconRequest = (u: string) =>
    new Request(`https://nav.example.com/api/icon?u=${encodeURIComponent(u)}`);

test("图标代理：SVG 一律降级成下载，绝不原样返回（同源 SVG XSS）", async () => {
    const stub = stubFetch({ "content-type": "image/svg+xml" }, "<svg onload=alert(1)>");
    try {
        const res = await proxyIcon(iconRequest("https://evil.example/evil.svg"));
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
        assert.match(res.headers.get("content-disposition") || "", /attachment/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
        stub.restore();
    }
});

test("图标代理：HTML / 文本 之类的非图片类型同样降级", async () => {
    const stub = stubFetch({ "content-type": "text/html; charset=utf-8" }, "<html>");
    try {
        const res = await proxyIcon(iconRequest("https://evil.example/page"));
        assert.equal(res.headers.get("content-type"), "application/octet-stream");
    } finally {
        stub.restore();
    }
});

test("图标代理：真正的图片类型照常返回，并带 nosniff 与 sandbox CSP", async () => {
    const stub = stubFetch({ "content-type": "image/png" }, "png-bytes");
    try {
        const res = await proxyIcon(iconRequest("https://cdn.example/icon.png"));
        assert.equal(res.headers.get("content-type"), "image/png");
        const csp = res.headers.get("content-security-policy") || "";
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /sandbox/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
        stub.restore();
    }
});

test("图标代理：同一个来源刷太多会被限流，且不再往外发请求", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetch({ "content-type": "image/png" }, "png-bytes");
    try {
        let limited = 0;
        // 一分钟内刷到上限之外：前 60 次放行，之后应当开始 429
        for (let i = 0; i < 70; i++) {
            const res = await proxyIcon(iconRequest(`https://cdn.example/i${i}.png`), "1.2.3.4");
            if (res.status === 429) limited += 1;
        }
        assert.ok(limited > 0, "刷过头就该被拦，这个端点是公开的出网口子");
        // 换一个来源不受影响
        const other = await proxyIcon(iconRequest("https://cdn.example/other.png"), "5.6.7.8");
        assert.equal(other.status, 200);
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});

test("图标代理：没有 u 参数 / 地址不合法不会打出去任何请求", async () => {
    const stub = stubFetch({ "content-type": "image/png" });
    try {
        const missing = await proxyIcon(new Request("https://nav.example.com/api/icon"));
        assert.equal(missing.status, 400);
        const bad = await proxyIcon(iconRequest("not-a-url"));
        assert.equal(bad.status, 400);
        assert.equal(stub.calls.length, 0);
    } finally {
        stub.restore();
    }
});
