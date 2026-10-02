// worker/ai.ts
// 调模型的唯一出口。两种 provider（Workers AI 的 REST 接口 / OpenAI 兼容接口）
// 都收在这里，路由层只认 aiText / aiEmbed 两个函数和一种失败形状。
//
// 为什么走 HTTP 而不是 ai binding：
//   binding 必须写进 wrangler.jsonc，账号没开通 Workers AI 时**部署会直接失败** ——
//   为一个锦上添花的功能让整站上不了线，不划算。走 REST 的话配置是可选项：
//   没配就是「功能没开」，站点照常跑。代价是用户要自己去填一个 token，
//   换来的好处是 provider 也能换成任何 OpenAI 兼容的服务。

import { safeFetch } from "./safeFetch";
import type { AiSettings } from "../src/utils/aiConfig";
import { aiConfigProblem } from "../src/utils/aiConfig";

/** 文本生成的超时：8b 模型几百个 token 通常 2-4 秒，留足余量 */
const TEXT_TIMEOUT_MS = 25_000;
const EMBED_TIMEOUT_MS = 20_000;
/** 一次最多嵌多少条：批量补向量时前端分批，这里再兜一道 */
export const EMBED_BATCH_MAX = 32;

export type AiFailReason =
    | "off"
    | "incomplete"
    | "blocked"
    | "timeout"
    | "network"
    | "http"
    | "empty"
    | "bad-response";

export type AiResult<T> =
    | { ok: true; data: T }
    | { ok: false; reason: AiFailReason; message: string; status: number };

function fail(reason: AiFailReason, message: string, status: number): AiResult<never> {
    return { ok: false, reason, message, status };
}

/** 端点 URL：openai-compatible 用用户填的地址；workers-ai 拼 Cloudflare 的 REST 地址 */
function endpointFor(settings: AiSettings, path: string): { url: URL } | { error: string } {
    if (settings.provider === "workers-ai") {
        const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
            settings.cfAccount
        )}/ai/run/${path}`;
        try {
            return { url: new URL(base) };
        } catch {
            return { error: "Cloudflare 账号 ID 看着不对" };
        }
    }
    // openai-compatible：endpoint 是 base URL（…/v1），后面接 /chat/completions 或 /embeddings
    const base = settings.endpoint.replace(/\/+$/, "");
    try {
        return { url: new URL(`${base}${path}`) };
    } catch {
        return { error: "接口地址不是一个合法 URL" };
    }
}

function authHeaders(settings: AiSettings): Record<string, string> {
    return settings.provider === "workers-ai"
        ? { Authorization: `Bearer ${settings.cfToken}`, "Content-Type": "application/json" }
        : { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" };
}

/** 统一的出站调用：超时 / 被拦 / 非 2xx 都变成同一种失败，路由层不用各写一遍 */
async function callAi(
    settings: AiSettings,
    path: string,
    body: unknown,
    timeoutMs: number
): Promise<AiResult<Response>> {
    const problem = aiConfigProblem(settings);
    if (problem) return fail("incomplete", problem, 400);

    const target = endpointFor(settings, path);
    if ("error" in target) return fail("incomplete", target.error, 400);

    const result = await safeFetch(target.url, {
        timeoutMs,
        headers: authHeaders(settings),
        fetchInit: { method: "POST", body: JSON.stringify(body) },
    });
    if (!result.ok) {
        // blocked = 目标被 SSRF 黑名单挡下（内网 / 非 80-443 端口）
        const reason: AiFailReason = result.kind === "blocked" ? "blocked" : "network";
        return fail(reason, result.message, result.status);
    }
    if (!result.response.ok) {
        const text = await result.response.text().catch(() => "");
        return fail("http", `模型服务返回 ${result.response.status}：${text.slice(0, 200)}`, 502);
    }
    return { ok: true, data: result.response };
}

/** 文本生成：给一段提示词，拿到模型的回答原文（解析交给 utils/aiMeta） */
export async function aiText(
    settings: AiSettings,
    prompt: string,
    opts?: { maxTokens?: number }
): Promise<AiResult<string>> {
    const body =
        settings.provider === "workers-ai"
            ? { prompt, max_tokens: opts?.maxTokens ?? 700, temperature: 0.2 }
            : {
                  model: settings.textModel,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.2,
                  max_tokens: opts?.maxTokens ?? 700,
              };
    const path = settings.provider === "workers-ai" ? settings.textModel : "/chat/completions";
    const res = await callAi(settings, path, body, TEXT_TIMEOUT_MS);
    if (!res.ok) return res;

    let payload: unknown;
    try {
        payload = await res.data.json();
    } catch {
        return fail("bad-response", "模型返回的不是 JSON", 502);
    }

    const text =
        settings.provider === "workers-ai"
            ? (payload as { result?: { response?: string } })?.result?.response
            : (payload as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
                  ?.content;
    if (typeof text !== "string" || !text.trim()) {
        return fail("empty", "模型没给出内容", 502);
    }
    return { ok: true, data: text };
}

/** 批量嵌入：返回与输入等长的向量数组 */
export async function aiEmbed(
    settings: AiSettings,
    texts: string[]
): Promise<AiResult<number[][]>> {
    if (texts.length === 0) return { ok: true, data: [] };
    if (texts.length > EMBED_BATCH_MAX) {
        return fail("incomplete", `一次最多嵌 ${EMBED_BATCH_MAX} 条`, 400);
    }
    const body =
        settings.provider === "workers-ai"
            ? { text: texts }
            : { model: settings.embedModel, input: texts };
    const path = settings.provider === "workers-ai" ? settings.embedModel : "/embeddings";
    const res = await callAi(settings, path, body, EMBED_TIMEOUT_MS);
    if (!res.ok) return res;

    let payload: unknown;
    try {
        payload = await res.data.json();
    } catch {
        return fail("bad-response", "模型返回的不是 JSON", 502);
    }

    // Workers AI: { result: { data: number[][], shape: [n, dim] } }
    // OpenAI 兼容: { data: [{ embedding: number[], index }] }（顺序不保证，按 index 归位）
    const rows =
        settings.provider === "workers-ai"
            ? ((payload as { result?: { data?: number[][] } })?.result?.data ?? [])
            : (() => {
                  const list = (payload as { data?: { embedding?: number[]; index?: number }[] })
                      ?.data;
                  if (!Array.isArray(list)) return [];
                  return list
                      .slice()
                      .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
                      .map(item => item?.embedding ?? []);
              })();

    if (!Array.isArray(rows) || rows.length === 0) {
        return fail("bad-response", "模型没返回向量", 502);
    }
    const vectors = rows.filter(row => Array.isArray(row) && row.length > 0).map(row =>
        row.map(n => (Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0))
    );
    if (vectors.length !== texts.length) {
        return fail("bad-response", `要了 ${texts.length} 条向量，只回来 ${vectors.length} 条`, 502);
    }
    return { ok: true, data: vectors };
}
