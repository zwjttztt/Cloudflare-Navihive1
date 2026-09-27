// tests/safeFetch.test.ts
// worker/safeFetch 的纯逻辑单测：
//   - scheme/port/host 黑名单每一跳都校验（不只是初始 URL）
//   - 重定向每跳重验 host（攻击者借 302 跳到内网被拦下）
//   - 跳数超限返回 redirect 错误
//   - 跳数内的合法重定向能拿到最终响应
//
// safeFetch 用全局 fetch，所以这里把 fetch 打桩成可注入的 handler，按场景返回不同结果。

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetch } from "../worker/safeFetch";

/** 一个 mock fetch：按 (URL → Response) 映射返回 */
function makeFetcher(map: Map<string, Response | { status: number; location?: string; body?: string }>) {
    const calls: string[] = [];
    return {
        fetch: (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            calls.push(url);
            const v = map.get(url);
            if (!v) throw new Error(`unexpected fetch: ${url}`);
            if (v instanceof Response) return v;
            return new Response(v.body ?? "", {
                status: v.status,
                headers: v.location ? { location: v.location } : {},
            });
        },
        calls,
    };
}

// 临时替换全局 fetch
function withFetch<T>(fetcher: { fetch: (i: RequestInfo | URL) => Response }, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetcher.fetch as unknown as typeof fetch;
    return fn().finally(() => {
        (globalThis as { fetch: typeof fetch }).fetch = orig;
    });
}

test("safeFetch 拒绝 http 之外的 scheme", async () => {
    const r = await safeFetch(new URL("ftp://example.com/file"));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "blocked");
        assert.equal(r.status, 400);
    }
});

test("safeFetch 拒绝非 80/443 端口", async () => {
    const r = await safeFetch(new URL("https://example.com:8080/"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "blocked");
});

test("safeFetch 拒绝内网 hostname", async () => {
    const r = await safeFetch(new URL("https://10.0.0.1/"));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "blocked");
        assert.match(r.message, /内网/);
    }
});

test("safeFetch 成功路径：返回上游 Response", async () => {
    const { fetch: f, calls } = makeFetcher(
        new Map([["https://example.com/", { status: 200, body: "ok" }]])
    );
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://example.com/")));
    assert.equal(r.ok, true);
    if (r.ok) {
        assert.equal(r.response.status, 200);
        assert.equal(await r.response.text(), "ok");
    }
    assert.deepEqual(calls, ["https://example.com/"]);
});

test("safeFetch 重定向每跳重验 host（拦下 302 跳内网）", async () => {
    // 第一次跳公网 → 第二次跳内网。第二次必须被拦
    const { fetch: f, calls } = makeFetcher(
        new Map([
            ["https://evil.com/", { status: 302, location: "http://10.0.0.1/admin" }],
        ])
    );
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://evil.com/")));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "blocked");
        assert.match(r.message, /内网/);
    }
    // 只发了第一次的请求；第二次根本没发出
    assert.equal(calls.length, 1);
});

test("safeFetch 重定向每跳重验 host（拦下 302 跳非 http 端口）", async () => {
    const { fetch: f } = makeFetcher(
        new Map([["https://a.com/", { status: 302, location: "https://a.com:22/" }]])
    );
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://a.com/")));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, "blocked");
});

test("safeFetch 重定向超过 4 跳返回 redirect 错误", async () => {
    // 构造一个 5 跳链
    const map = new Map<string, { status: number; location?: string; body?: string }>();
    map.set("https://a.com/0", { status: 302, location: "https://a.com/1" });
    map.set("https://a.com/1", { status: 302, location: "https://a.com/2" });
    map.set("https://a.com/2", { status: 302, location: "https://a.com/3" });
    map.set("https://a.com/3", { status: 302, location: "https://a.com/4" });
    map.set("https://a.com/4", { status: 302, location: "https://a.com/5" });
    map.set("https://a.com/5", { status: 200, body: "ok" });
    const { fetch: f } = makeFetcher(map);
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://a.com/0")));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "redirect");
        assert.match(r.message, /次数过多|跳板/);
    }
});

test("safeFetch 重定向 4 跳以内放行", async () => {
    const map = new Map<string, { status: number; location?: string; body?: string }>();
    map.set("https://a.com/0", { status: 302, location: "https://a.com/1" });
    map.set("https://a.com/1", { status: 302, location: "https://a.com/2" });
    map.set("https://a.com/2", { status: 302, location: "https://a.com/3" });
    map.set("https://a.com/3", { status: 302, location: "https://a.com/4" });
    map.set("https://a.com/4", { status: 200, body: "ok" });
    const { fetch: f } = makeFetcher(map);
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://a.com/0")));
    assert.equal(r.ok, true);
});

test("safeFetch 上游 4xx/5xx 返回 http 错误", async () => {
    const { fetch: f } = makeFetcher(
        new Map([["https://a.com/", { status: 404 }]])
    );
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://a.com/")));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "http");
        assert.equal(r.upstreamStatus, 404);
    }
});

test("safeFetch 重定向缺少 Location 返回 redirect 错误", async () => {
    // 302 但没 location
    const map = new Map<string, { status: number }>();
    map.set("https://a.com/", { status: 302 });
    const { fetch: f } = makeFetcher(map);
    const r = await withFetch({ fetch: f }, () => safeFetch(new URL("https://a.com/")));
    assert.equal(r.ok, false);
    if (!r.ok) {
        assert.equal(r.kind, "redirect");
        assert.match(r.message, /Location/);
    }
});