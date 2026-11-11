// tests/aiRetry.test.ts
// 站点 AI 补全的「偶发出站超时自愈」+ 502 文案兜底。
//
// 背景（2026-11-11）：线上 /api/ai/site-meta 出现过一次 25s 硬超时 → 502，
// 但同配置 / 同 prompt 实测只要 0.5~3.2s（网络、token、模型、SSRF 注入层逐项排除）。
// 所以修法是短单跳 + 一次自愈重试，而不是放宽 SSRF 或改外部配置。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    SITE_META_RETRIES,
    SITE_META_TIMEOUT_MS,
    aiText,
    shouldRetryAiFailure,
} from "../worker/ai";
import { setFetchImpl } from "../worker/safeFetch";
import { friendlyAiSiteMetaError } from "../src/utils/aiMeta";
import type { AiSettings } from "../src/utils/aiConfig";

const settings: AiSettings = {
    enabled: true,
    provider: "workers-ai",
    endpoint: "",
    textModel: "@cf/meta/llama-3.1-8b-instruct-fp8",
    embedModel: "@cf/baai/bge-base-en-v1.5",
    apiKey: "",
    cfToken: "dummy-token",
    cfAccount: "dummy-account",
};

function projectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

afterEach(() => {
    setFetchImpl(null);
});

test("只重试超时类失败，不重试配置错 / 上游错 / 模型胡说", () => {
    assert.equal(shouldRetryAiFailure("timeout"), true);
    for (const reason of [
        "off", "incomplete", "blocked", "network", "http", "empty", "bad-response",
    ] as const) {
        assert.equal(shouldRetryAiFailure(reason), false, `${reason} 不该重复烧额度`);
    }
});

test("站点补全预算：12s 单跳 + 一次重试，最坏仍小于前端 30s 超时", () => {
    assert.equal(SITE_META_TIMEOUT_MS, 12_000);
    assert.equal(SITE_META_RETRIES, 1);
    assert.ok(SITE_META_TIMEOUT_MS * (SITE_META_RETRIES + 1) < 30_000);
});

test("aiText：第一次出站超时 → 自动重试一次并成功", async () => {
    let calls = 0;
    setFetchImpl(async () => {
        calls += 1;
        if (calls === 1) throw new DOMException("boom", "TimeoutError");
        // workers-ai 的响应形状是 result.response（不是 OpenAI 的 choices）
        return Response.json({ result: { response: "模型回答" }, success: true });
    });
    const res = await aiText(settings, "prompt", {
        timeoutMs: SITE_META_TIMEOUT_MS,
        retries: SITE_META_RETRIES,
    });
    assert.equal(calls, 2, "超时后要重试一次");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.data, "模型回答");
});

test("aiText：上游 4xx 不重试，具体原因原样带回", async () => {
    let calls = 0;
    setFetchImpl(async () => {
        calls += 1;
        return new Response("invalid token", { status: 401 });
    });
    const res = await aiText(settings, "prompt", {
        timeoutMs: SITE_META_TIMEOUT_MS,
        retries: SITE_META_RETRIES,
    });
    assert.equal(calls, 1, "密钥错不该重试（重复烧额度）");
    assert.equal(res.ok, false);
    if (!res.ok) {
        assert.equal(res.reason, "network");
        assert.match(res.message, /401/);
    }
});

test("aiText：两次都超时就认输，不无限重试", async () => {
    let calls = 0;
    setFetchImpl(async () => {
        calls += 1;
        throw new DOMException("boom", "TimeoutError");
    });
    const res = await aiText(settings, "prompt", {
        timeoutMs: SITE_META_TIMEOUT_MS,
        retries: SITE_META_RETRIES,
    });
    assert.equal(calls, 2, "最多首发 + 一次重试");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "timeout");
});

test("aiText：配置不全时一个出站请求都不发", async () => {
    let calls = 0;
    setFetchImpl(async () => {
        calls += 1;
        return Response.json({});
    });
    const res = await aiText({ ...settings, cfToken: "" }, "prompt", { retries: 1 });
    assert.equal(calls, 0);
    assert.equal(res.ok, false);
});

test("friendlyAiSiteMetaError：CDN 把 502 body 换成 HTML 后给人话", () => {
    for (const raw of [
        "API错误: 502", "API错误: 504", "抓取超时 (HTTP 502)",
        "整段请求超时", "未能拿到上游响应", "抓取超时",
    ]) {
        assert.match(friendlyAiSiteMetaError(raw), /已自动重试一次/, `${raw} 该翻成人话`);
    }
});

test("friendlyAiSiteMetaError：具体原因原样保留，空值给兜底", () => {
    assert.equal(
        friendlyAiSiteMetaError("模型服务返回 401：Invalid token"),
        "模型服务返回 401：Invalid token"
    );
    assert.equal(
        friendlyAiSiteMetaError("还没填 Cloudflare API token"),
        "还没填 Cloudflare API token"
    );
    assert.equal(friendlyAiSiteMetaError("网络超时"), "网络超时");
    assert.equal(friendlyAiSiteMetaError("AI 没给出建议"), "AI 没给出建议");
    assert.equal(friendlyAiSiteMetaError(""), "AI 补全失败，请重试");
});

test("接线守卫：站点补全路由与前端 hook 都用上了新逻辑", () => {
    const root = projectDir();
    const route = readFileSync(resolve(root, "worker", "routes", "ai.ts"), "utf8");
    // 只盯调用点：光扫全文件会被 import 里那两个名字骗过去（参数被删也照样「通过」）。
    const start = route.indexOf('path === "ai/site-meta"');
    const seg = start >= 0 ? route.slice(start, start + 1400) : "";
    assert.ok(start >= 0, "找不到站点补全路由");
    assert.match(seg, /timeoutMs:\s*SITE_META_TIMEOUT_MS/, "站点补全要用短单跳预算");
    assert.match(seg, /retries:\s*SITE_META_RETRIES/, "站点补全要开一次重试");
    const hook = readFileSync(resolve(root, "src", "hooks", "useAiAssistant.ts"), "utf8");
    assert.match(hook, /friendlyAiSiteMetaError/, "站点补全失败要走文案兜底");
});
