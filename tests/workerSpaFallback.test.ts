// 两环境对照测试催出来的修复：Worker 入口对「非 API 路径」与「非法 JSON 请求体」的处理。
//
// 背景：Cloudflare Workers + Assets 形态下，compatibility_date >= 2025-04-01 启用
// assets_navigation_prefers_asset_serving —— 浏览器「导航请求」(带 Sec-Fetch-Mode: navigate)
// 由资产层直接回 index.html、不进 Worker；但 fetch / curl / 爬虫 / 探针这类「非导航请求」
// 会进 Worker。若 Worker 对非 /api/ 路径一律 404，/s/<token>、/sg/<token> 这类纯前端
// 分享路由就全部 404（实测 home 200、myhp 404）。修复：非 API 的「无扩展名」GET/HEAD
// 转发给 env.ASSETS 做 SPA 回退；带扩展名的未命中静态路径与 POST / 等保持 404。
//
// 另外：请求体非法 / 空 JSON 时 request.json() 抛 SyntaxError，应回 400 而非 500。

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index";

/** 造一个带 ASSETS 绑定的 env（Cloudflare 部署才有；自托管没有） */
function envWithAssets(fetchImpl: (req: Request) => Response | Promise<Response>) {
    return { ASSETS: { fetch: fetchImpl } } as never;
}

const HEX64 = "a".repeat(64);

test("非 API 无扩展名路径(GET) 转发给 env.ASSETS 做 SPA 回退", async () => {
    let delegated: Request | null = null;
    const env = envWithAssets(async (req) => {
        delegated = req;
        return new Response("<!doctype html><html><body>app</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    });
    const res = await worker.fetch(new Request(`https://nav.example.com/s/${HEX64}`), env);
    assert.ok(delegated, "应当转发给 env.ASSETS.fetch");
    assert.equal(delegated!.method, "GET");
    assert.equal(delegated!.url, `https://nav.example.com/s/${HEX64}`);
    assert.equal(res.status, 200);
});

test("根路径 / (GET) 也走 ASSETS 回退到 index.html", async () => {
    let delegated: Request | null = null;
    const env = envWithAssets(async (req) => {
        delegated = req;
        return new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const res = await worker.fetch(new Request("https://nav.example.com/"), env);
    assert.ok(delegated, "根路径应转发给 env.ASSETS.fetch");
    assert.equal(res.status, 200);
});

test("带扩展名的未命中静态路径不转发 ASSETS、直接 404", async () => {
    let called = false;
    const env = envWithAssets(async () => {
        called = true;
        return new Response("x");
    });
    const res = await worker.fetch(
        new Request("https://nav.example.com/assets/missing-DOESNOTEXIST.js"),
        env
    );
    assert.equal(called, false, "带扩展名的未命中路径不应走 SPA 回退");
    assert.equal(res.status, 404);
});

test("POST / 非 API 非 GET/HEAD 直接 404（不走 ASSETS）", async () => {
    let called = false;
    const env = envWithAssets(async () => {
        called = true;
        return new Response("x");
    });
    const res = await worker.fetch(new Request("https://nav.example.com/", { method: "POST" }), env);
    assert.equal(called, false, "POST / 不应走 ASSETS");
    assert.equal(res.status, 404);
});

test("自托管形态（无 ASSETS 绑定）非 API 无扩展名路径回 404", async () => {
    // 自托管经 server/entry.ts 的 serveStatic 处理 GET/HEAD 非 API 路径，
    // Worker 只会收到非 GET/HEAD 非 API 路径；这里验证无 ASSETS 时保持 404。
    const res = await worker.fetch(new Request(`https://nav.example.com/s/${HEX64}`), {} as never);
    assert.equal(res.status, 404);
});

test("非法 JSON 请求体回 400 而非 500", async () => {
    const res = await worker.fetch(
        new Request("https://nav.example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{ 不是合法JSON",
        }),
        {} as never
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "bad_request");
});

test("空请求体回 400 而非 500", async () => {
    const res = await worker.fetch(
        new Request("https://nav.example.com/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "",
        }),
        {} as never
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error?.code, "bad_request");
});
