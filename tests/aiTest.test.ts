// tests/aiTest.test.ts
// 「测试连接」端点（POST ai/test）的三条硬性质。
//
// 这个端点的特殊之处在于：它拿的是**表单上还没保存的**配置，所以不能拿库里那份
// 「配置不全就 400」的闸去挡它。放开的同时必须保证另外几件事：
//   1. 填不全就一个字节都不往外发（没填密钥还发请求 = 白送一次调用 + 泄露意图）
//   2. 请求体里认的键有白名单，值只认字符串 —— 别让它变成可配置的出站参数
//   3. 文本与嵌入分开报：一个通一个不通要说清楚，不能只说一句「连接失败」

import { test } from "node:test";
import assert from "node:assert/strict";
import type { NavigationAPI } from "../src/API/navigationApi";
import { handleAiRoutes } from "../worker/routes/ai";
import type { RouteCtx } from "../worker/routes/types";

const realFetch = globalThis.fetch;
const calls: string[] = [];
let embedShouldFail = false;

// 按 URL 里带的模型名区分是文本还是嵌入请求
globalThis.fetch = async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const isEmbed = url.includes("bge-base");
    if (isEmbed && embedShouldFail) {
        return new Response(JSON.stringify({ errors: [{ message: "model not found" }] }), {
            status: 404,
            headers: { "content-type": "application/json" },
        });
    }
    const payload = isEmbed
        ? { result: { data: [[0.1, 0.2, 0.3]], shape: [1, 3] } }
        : { result: { response: "OK" } };
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};

function ctxFor(payload: unknown): RouteCtx {
    return {
        request: new Request("https://nav.example/api/ai/test", {
            method: "POST",
            body: JSON.stringify(payload),
        }),
        path: "ai/test",
        method: "POST",
        // 这个分支只用到「当前是谁」来做限速分桶
        api: { getCurrentUserId: () => 1 } as unknown as NavigationAPI,
        env: {} as RouteCtx["env"],
        url: new URL("https://nav.example/api/ai/test"),
        ip: "1.2.3.4",
        trustXFF: false,
        secureCookie: true,
        currentJti: "jti",
        currentTokenExp: 0,
    };
}

const call = async (payload: unknown) => {
    const res = await handleAiRoutes(ctxFor(payload));
    assert.ok(res, "ai/test 应该被认领");
    return (await res.json()) as {
        success: boolean;
        message?: string;
        text?: { ok: boolean; message?: string };
        embed?: { ok: boolean; dim?: number; message?: string };
    };
};

test("配置没填全：400 且一次外网请求都不发", async () => {
    calls.length = 0;
    const bad = await call({ "ai.provider": "workers-ai", "ai.cfAccount": "abc" });
    assert.equal(bad.success, false);
    assert.match(bad.message ?? "", /API token/);
    assert.deepEqual(calls, [], "没填密钥就不该往外发任何请求");
});

test("填全了：文本与嵌入各发一次，并回报维度", async () => {
    calls.length = 0;
    embedShouldFail = false;
    const ok = await call({
        "ai.provider": "workers-ai",
        "ai.cfAccount": "abc",
        "ai.cfToken": "tok",
    });
    assert.equal(ok.success, true);
    assert.equal(ok.text?.ok, true);
    assert.equal(ok.embed?.ok, true);
    assert.equal(ok.embed?.dim, 3);
    assert.equal(calls.length, 2, "文本与嵌入各一次");
});

test("一项通一项不通：说清楚是哪一项，不笼统报失败", async () => {
    calls.length = 0;
    embedShouldFail = true;
    const mixed = await call({
        "ai.provider": "workers-ai",
        "ai.cfAccount": "abc",
        "ai.cfToken": "tok",
    });
    assert.equal(mixed.success, false);
    assert.equal(mixed.text?.ok, true, "文本模型是通的");
    assert.equal(mixed.embed?.ok, false);
    assert.match(mixed.message ?? "", /嵌入模型没通/);
    assert.match(mixed.embed?.message ?? "", /404/);
});

test("请求体只认白名单里的键、且只认字符串值", async () => {
    calls.length = 0;
    // provider 用数字 → 被忽略 → 回落 workers-ai；endpoint 不在白名单认知之外但属于允许键，
    // 关键是 apiKey 给了数字不算数，于是「还没填 API 密钥」。
    const ignored = await call({
        "ai.provider": "openai-compatible",
        "ai.endpoint": "https://api.example.com/v1",
        "ai.apiKey": 12345,
    });
    assert.equal(ignored.success, false);
    assert.deepEqual(calls, []);

    // 顺带确认：不在白名单里的键（哪怕是字符串）也不会被当成配置用
    embedShouldFail = false;
    const injected = await call({
        "ai.provider": "workers-ai",
        "ai.cfAccount": "abc",
        "ai.cfToken": "tok",
        "ai.textModel": "whatever-model",
        "site.title": "改不了站点标题",
    });
    // textModel 在白名单里，会被拿去拼 URL —— 这是预期内的（它就是个模型名）
    assert.equal(injected.success, true, "textModel 本来就该生效");
    assert.ok(
        !calls.join(" ").includes("site.title"),
        "白名单外的键不该出现在出站请求里"
    );
});

test.after(() => {
    globalThis.fetch = realFetch;
});
