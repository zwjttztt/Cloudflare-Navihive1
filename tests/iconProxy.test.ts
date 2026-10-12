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
import { proxyIcon, proxyIcons, resetIconRateLimitForTest } from "../worker/icon";

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

// ---------------------------------------------------------------------------
// 批量接口 /api/icons
// ---------------------------------------------------------------------------
// 存在的理由：首屏十几个 <img> 各发一次 /api/icon，在这条链路上就是十几次
// 1~3 秒的固定往返。合并之后塌缩成一次请求。
// 但它是**批量出网口子**，所以这些用例守的是「批量不等于放宽限制」：
// 条数上限、按条数计限速、类型白名单，一条都不能比单条接口松。

/** 按 URL 返回不同响应（有的站点给 png、有的给 svg，真实世界就是这样） */
function stubFetchBy(responder: (url: string) => Response) {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return responder(String(input));
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

const iconsRequest = (urls: string[]) =>
    new Request(
        `https://nav.example.com/api/icons?${urls.map(u => `u=${encodeURIComponent(u)}`).join("&")}`
    );

test("批量取图标：一次拿回多个，key 是原始地址、值是 data URL", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetchBy(url =>
        url.includes(".svg")
            ? new Response("<svg>", { status: 200, headers: { "content-type": "image/svg+xml" } })
            : new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } })
    );
    try {
        const res = await proxyIcons(
            iconsRequest(["https://a.example/i.png", "https://b.example/i.png"]),
            "9.9.9.9"
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as { icons: Record<string, string> };
        assert.match(body.icons["https://a.example/i.png"], /^data:image\/png;base64,/);
        assert.match(body.icons["https://b.example/i.png"], /^data:image\/png;base64,/);
        // base64 内容要能还原成原来的字节，否则前端拿到的就是一堆乱码
        const b64 = body.icons["https://a.example/i.png"].split(",")[1];
        assert.equal(atob(b64), "png-bytes");
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});

test("批量取图标：SVG 不进结果（批量也不能放宽类型白名单）", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetchBy(() =>
        new Response("<svg onload=alert(1)>", {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
        })
    );
    try {
        const res = await proxyIcons(iconsRequest(["https://evil.example/x.svg"]), "9.9.9.1");
        const body = (await res.json()) as { icons: Record<string, string>; failed: Record<string, string> };
        assert.equal(body.icons["https://evil.example/x.svg"], undefined, "SVG 绝不能进批量结果");
        assert.ok(body.failed["https://evil.example/x.svg"], "要能在 failed 里看到原因");
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});

test("批量取图标：缺 u / 条数超限都是 400，且一个请求都不往外发", async () => {
    const stub = stubFetchBy(() => new Response("png", { headers: { "content-type": "image/png" } }));
    try {
        const missing = await proxyIcons(new Request("https://nav.example.com/api/icons"), "9.9.9.2");
        assert.equal(missing.status, 400);

        const tooMany = await proxyIcons(
            iconsRequest(Array.from({ length: 31 }, (_, i) => `https://x.example/${i}.png`)),
            "9.9.9.3"
        );
        assert.equal(tooMany.status, 400);
        assert.equal(stub.calls.length, 0, "超限就该当场拒绝，别等抓完再扔");
    } finally {
        stub.restore();
    }
});

test("批量取图标：限速按**条数**计（批量不是刷出网配额的捷径）", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetchBy(() => new Response("png", { headers: { "content-type": "image/png" } }));
    try {
        const urls = Array.from({ length: 30 }, (_, i) => `https://x.example/${i}.png`);
        const first = await proxyIcons(iconsRequest(urls), "8.8.8.8");
        assert.equal(first.status, 200, "一窗口 60 次，第一批 30 条应当放行");
        const second = await proxyIcons(iconsRequest(urls), "8.8.8.8");
        assert.equal(second.status, 200, "第二批 30 条刚好把 60 次窗口用完，仍在额度内");
        const third = await proxyIcons(iconsRequest(urls), "8.8.8.8");
        assert.equal(third.status, 429, "第三批就该被拦了 —— 批量不等于无限出网");
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});

test("批量取图标：某几条挂了不影响其它条（整批作废就白搭一次往返）", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetchBy(url =>
        url.includes("bad")
            ? new Response("boom", { status: 500 })
            : new Response("png-bytes", { status: 200, headers: { "content-type": "image/png" } })
    );
    try {
        const res = await proxyIcons(
            iconsRequest(["https://bad.example/i.png", "https://good.example/i.png"]),
            "7.7.7.7"
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as { icons: Record<string, string>; failed: Record<string, string> };
        assert.ok(body.icons["https://good.example/i.png"], "好的那条必须还在");
        assert.ok(body.failed["https://bad.example/i.png"], "坏的那条单独记原因");
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});

test("批量取图标：响应标记为 private（含的是这个用户的站点列表，不能进共享缓存）", async () => {
    resetIconRateLimitForTest();
    const stub = stubFetchBy(() => new Response("png", { headers: { "content-type": "image/png" } }));
    try {
        const res = await proxyIcons(iconsRequest(["https://a.example/i.png"]), "6.6.6.6");
        assert.match(res.headers.get("cache-control") || "", /private/);
        assert.equal(res.headers.get("vary"), "Cookie");
    } finally {
        stub.restore();
        resetIconRateLimitForTest();
    }
});
