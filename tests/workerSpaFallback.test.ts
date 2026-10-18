// 两环境对照测试催出来的修复：Worker 入口对「非 API 路径」与「非法 JSON 请求体」的处理。
//
// 背景：Cloudflare Workers + Assets 形态下，compatibility_date >= 2025-04-01 启用
// assets_navigation_prefers_asset_serving —— 浏览器「导航请求」(带 Sec-Fetch-Mode: navigate)
// 由资产层直接回 index.html、不进 Worker；但 fetch / curl / 爬虫 / 探针这类「非导航请求」
// 会进 Worker。若 Worker 对非 /api/ 路径一律 404，/s/<token>、/sg/<token> 这类纯前端
// 分享路由就全部 404（实测 home 200、myhp 404）。修复：run_worker_first: true 让所有请求
// 先进 Worker，非 API 的 GET/HEAD 转发 env.ASSETS.fetch()——真实静态资产（带扩展名）原样转发、
// SPA 路由（无扩展名，如 /s/<token>）显式取 /index.html 做回退（绕开 Cloudflare 在
// run_worker_first 下对「转发原始 SPA 路径」的再入保护 1101）；POST / 等非 GET/HEAD 回 404。
//
// 另外：请求体非法 / 空 JSON 时 request.json() 抛 SyntaxError，应回 400 而非 500。

import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index";

/** 造一个带 ASSETS 绑定的 env（Cloudflare 部署才有；自托管没有） */
function envWithAssets(fetchImpl: (req: Request) => Response | Promise<Response>) {
    return { ASSETS: { fetch: fetchImpl } } as never;
}

/**
 * 模拟 Workers 运行时 ASSETS.fetch() 返回的 Response：headers immutable——
 * set/append/delete 抛 "Can't modify immutable headers."（TypeError）。
 * 2026-10-18 myhp 全站 500（1101）的根因：mock 用普通可变 Response，
 * withSecurityHeaders 对 immutable headers 直接 set 就炸，真机语义从未被测到。
 */
function immutableResponse(body: string, init?: ResponseInit): Response {
    const res = new Response(body, init);
    const boom = () => {
        throw new TypeError("Can't modify immutable headers.");
    };
    for (const m of ["set", "append", "delete"] as const) {
        Object.defineProperty(res.headers, m, { value: boom });
    }
    return res;
}

const HEX64 = "a".repeat(64);

test("非 API 无扩展名路径(GET) 取入口 /index.html 做 SPA 回退（规避 1101）", async () => {
    let seenMethod = "";
    let seenUrl = "";
    const env = envWithAssets(async (req) => {
        seenMethod = req.method;
        seenUrl = req.url;
        // 真机语义：ASSETS.fetch 返回 immutable headers 的 Response
        return immutableResponse("<!doctype html><html><body>app</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    });
    const res = await worker.fetch(new Request(`https://nav.example.com/s/${HEX64}`), env);
    assert.equal(seenMethod, "GET");
    // SPA 路由（无扩展名）必须显式取 /index.html，不能转发原始 /s/<token> 路径
    // —— 后者在 run_worker_first 下会触发 Cloudflare SPA 回退再入保护（平台级 1101）。
    assert.equal(seenUrl, `https://nav.example.com/index.html`);
    assert.equal(res.status, 200);
    // immutable 响应经 withSecurityHeaders 重建后仍能补安全头、body 原样透传
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.ok((await res.text()).includes("app"));
});

test("根路径 / (GET) 也取 /index.html 回退", async () => {
    let seenUrl = "";
    const env = envWithAssets(async (req) => {
        seenUrl = req.url;
        return immutableResponse("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } });
    });
    const res = await worker.fetch(new Request("https://nav.example.com/"), env);
    assert.equal(seenUrl, "https://nav.example.com/index.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("带扩展名的未命中静态路径转发 ASSETS、由资产层回 404（不返回 HTML，避免 MIME 不符）", async () => {
    let called = false;
    const env = envWithAssets(async () => {
        called = true;
        return immutableResponse("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    });
    const res = await worker.fetch(
        new Request("https://nav.example.com/assets/missing-DOESNOTEXIST.js"),
        env
    );
    assert.equal(called, true, "run_worker_first 下所有静态资源 GET/HEAD 都进 Worker 再转发 ASSETS");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
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

test("ASSETS 返回 immutable headers 的 Response 不炸（真机 Workers 语义，2026-10-18 1101 根因守卫）", async () => {
    const env = envWithAssets(async () =>
        immutableResponse("<!doctype html><html><body>asset</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
        })
    );
    const res = await worker.fetch(new Request("https://nav.example.com/"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
    assert.ok((await res.text()).includes("asset"));
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
