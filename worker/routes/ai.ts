// worker/routes/ai.ts
// AI 助手的五个端点：状态、测试连接、补全元信息、批量建议、向量与语义搜索。
//
// 三条硬规矩，别改：
//   1. **默认关**。没在设置里显式打开，一律 400，一个字节都不往外发。
//   2. **AI 只给建议**。这里不写站点、不改标签、不建分组 —— 拿到的东西一律交给前端摆在
//      界面上等人点确认。模型说错一次没事，自动写错一次就是事故。
//   3. **失败不影响站点**。超时 / 密钥错 / 模型胡说，都是「这次没帮上忙」，
//      绝不能让加站、保存这类操作失败。

import { EMBED_BATCH_MAX, aiEmbed, aiText } from "../ai";
import { aiConfigProblem, aiSettingsFromConfigs } from "../../src/utils/aiConfig";
import {
    MAX_SUGGEST_SITES,
    buildSiteMetaPrompt,
    buildTagSuggestionPrompt,
    embeddingText,
    parseSiteMeta,
    parseTagSuggestions,
    topMatches,
    type PromptSite,
} from "../../src/utils/aiMeta";
import { createMemoryLimiter } from "../rateLimit";
import type { RouteCtx } from "./types";

// 每分钟最多 20 次文本生成 / 30 次搜索：AI 是按量付费的，一个手滑的循环就能刷掉一天额度。
// 用户维度而不是 IP 维度 —— AI 配置是跟着账号走的。
const textLimiter = createMemoryLimiter({ windowMs: 60_000, max: 20, maxKeys: 2_000 });
const embedLimiter = createMemoryLimiter({ windowMs: 60_000, max: 10, maxKeys: 2_000 });
const searchLimiter = createMemoryLimiter({ windowMs: 60_000, max: 30, maxKeys: 2_000 });

/** 语义搜索的分数门槛：最像的那个都不到 0.25，就当没搜到（免得硬塞给用户一堆无关卡片） */
const SEARCH_MIN_SCORE = 0.25;
const SEARCH_MAX_RESULTS = 50;

/** 测试连接认哪些配置键：其余的一律忽略，避免请求体变成可配置的出站参数 */
const ALLOWED_TEST_KEYS = new Set([
    "ai.provider",
    "ai.endpoint",
    "ai.textModel",
    "ai.embedModel",
    "ai.apiKey",
    "ai.cfToken",
    "ai.cfAccount",
]);

/** 一项探测的结果：通了就通了，没通就把模型那边原话摆出来（密钥错、模型不存在一眼能看出来） */
interface AiProbe {
    ok: boolean;
    message?: string;
    /** 嵌入向量维度：换模型时维度对不上就该重算索引 */
    dim?: number;
}

function bad(message: string, status = 400) {
    return Response.json({ success: false, message }, { status });
}

/** 读当前账号的 AI 配置；配置不全时直接给出原因，调用方不用再判一遍 */
async function readSettings(ctx: RouteCtx) {
    const keys = [
        "ai.enabled",
        "ai.provider",
        "ai.endpoint",
        "ai.textModel",
        "ai.embedModel",
    ];
    const values: Record<string, string> = {};
    for (const key of keys) {
        values[key] = (await ctx.api.getConfig(key)) || "";
    }
    // 两个凭据单独读：它们落库时是加密的，走同一套 getConfig 自动解密
    values["ai.apiKey"] = (await ctx.api.getConfig("ai.apiKey")) || "";
    values["ai.cfToken"] = (await ctx.api.getConfig("ai.cfToken")) || "";
    values["ai.cfAccount"] = (await ctx.api.getConfig("ai.cfAccount")) || "";
    return aiSettingsFromConfigs(values);
}

function limiterKey(ctx: RouteCtx, scope: string): string {
    const uid = ctx.api.getCurrentUserId();
    return `${scope}:${uid ?? "anon"}`;
}

export async function handleAiRoutes(ctx: RouteCtx): Promise<Response | null> {
    const { request, path, method } = ctx;
    if (path !== "ai" && !path.startsWith("ai/")) return null;

    // 状态：前端拿它决定「AI 补全」按钮是可用还是置灰并说明原因
    if (path === "ai/status" && method === "GET") {
        const settings = await readSettings(ctx);
        const embedded = settings.enabled
            ? await ctx.api
                  .countEmbeddings(settings.embedModel)
                  .catch(() => 0)
            : 0;
        return Response.json({
            success: true,
            enabled: settings.enabled,
            provider: settings.provider,
            textModel: settings.textModel,
            embedModel: settings.embedModel,
            embedded,
            problem: aiConfigProblem(settings),
        });
    }

    // ⑤ 测试连接：拿请求体里这份（很可能还没保存的）配置真跑一次，验证填的东西对不对。
    //
    // 必须放在「已保存配置不全就 400」那道闸之前 —— 用户就是想先试通再决定要不要保存，
    // 这时候库里当然是空的。测的是「能不能连上」，所以强制当成启用。
    if (path === "ai/test" && method === "POST") {
        if (!textLimiter.allow(limiterKey(ctx, "text"))) {
            return bad("刚用了太多次 AI，歇一分钟再试", 429);
        }
        const body = (await request.json().catch(() => null)) as
            | Record<string, unknown>
            | null;
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(body ?? {})) {
            // 只认白名单里的键，且只认字符串：别让请求体变成往模型那边塞东西的通道
            if (ALLOWED_TEST_KEYS.has(key) && typeof value === "string") {
                values[key] = value.slice(0, 500);
            }
        }
        const settings = { ...aiSettingsFromConfigs(values), enabled: true };
        const problem = aiConfigProblem(settings);
        if (problem) return bad(problem, 400);

        // 两个都测：文本模型坏了「AI 补全」就不能用，嵌入模型坏了语义搜索就是摆设，
        // 只报一个「连接成功」会让人以为全都好了。
        const text = await aiText(settings, "只回复两个字：OK", { maxTokens: 8 });
        const embed = await aiEmbed(settings, ["连接测试"]);
        const textPart: AiProbe = text.ok
            ? { ok: true }
            : { ok: false, message: text.message };
        const embedPart: AiProbe = embed.ok
            ? { ok: true, dim: embed.data[0]?.length ?? 0 }
            : { ok: false, message: embed.message };
        return Response.json({
            success: textPart.ok && embedPart.ok,
            message:
                textPart.ok && embedPart.ok
                    ? undefined
                    : !textPart.ok && !embedPart.ok
                      ? "文本与嵌入都没通，多半是密钥或账号 ID 不对"
                      : textPart.ok
                        ? "文本模型通了，但嵌入模型没通（语义搜索会不可用）"
                        : "嵌入模型通了，但文本模型没通（补全与整理会不可用）",
            text: textPart,
            embed: embedPart,
        });
    }

    const settings = await readSettings(ctx);
    const problem = aiConfigProblem(settings);
    if (problem) return bad(problem, 400);

    // ① 加站时补全名称 / 描述 / 分组 / 标签
    if (path === "ai/site-meta" && method === "POST") {
        if (!textLimiter.allow(limiterKey(ctx, "text"))) {
            return bad("刚用了太多次 AI，歇一分钟再试", 429);
        }
        const body = (await request.json().catch(() => null)) as
            | { url?: string; name?: string; groups?: string[]; tags?: string[] }
            | null;
        const url = (body?.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return bad("需要一个 http(s) 网址");
        const result = await aiText(
            settings,
            buildSiteMetaPrompt({
                url,
                name: body?.name,
                groups: body?.groups ?? [],
                tags: body?.tags ?? [],
            })
        );
        if (!result.ok) return bad(result.message, result.status);
        const suggestion = parseSiteMeta(result.data, {
            groups: body?.groups ?? [],
            tags: body?.tags ?? [],
        });
        if (!suggestion) return bad("没看懂模型这次的回答，再试一次", 502);
        return Response.json({ success: true, suggestion });
    }

    // ② 给存量站点批量建议标签 / 分组
    if (path === "ai/suggest-tags" && method === "POST") {
        if (!textLimiter.allow(limiterKey(ctx, "text"))) {
            return bad("刚用了太多次 AI，歇一分钟再试", 429);
        }
        const body = (await request.json().catch(() => null)) as
            | { sites?: PromptSite[]; groups?: string[]; tags?: string[] }
            | null;
        const sites = Array.isArray(body?.sites) ? body!.sites : [];
        if (sites.length === 0) return bad("没有要整理的站点");
        const result = await aiText(
            settings,
            buildTagSuggestionPrompt({
                sites: sites.slice(0, MAX_SUGGEST_SITES),
                groups: body?.groups ?? [],
                tags: body?.tags ?? [],
            }),
            { maxTokens: 1200 }
        );
        if (!result.ok) return bad(result.message, result.status);
        const allowedIds = sites.slice(0, MAX_SUGGEST_SITES).map(s => Number(s.id));
        const suggestions = parseTagSuggestions(result.data, {
            allowedIds,
            groups: body?.groups ?? [],
            tags: body?.tags ?? [],
        });
        return Response.json({ success: true, suggestions });
    }

    // ③ 语义搜索的准备工作：把站点文本整批换成向量
    if (path === "ai/embed" && method === "POST") {
        if (!embedLimiter.allow(limiterKey(ctx, "embed"))) {
            return bad("刚补过向量，歇一分钟再试", 429);
        }
        const body = (await request.json().catch(() => null)) as { force?: boolean } | null;
        const sites = await ctx.api.querySites();
        const existing = await ctx.api.listEmbeddings(settings.embedModel);
        const doneIds = new Set(existing.map(e => e.id));
        const todo = body?.force ? sites : sites.filter(s => !doneIds.has(Number(s.id)));
        if (todo.length === 0) {
            return Response.json({
                success: true,
                done: 0,
                total: sites.length,
                model: settings.embedModel,
            });
        }

        // 分批：一次最多 EMBED_BATCH_MAX 条，失败就停在这一批（已经写入的留着，下次补）
        let written = 0;
        for (let i = 0; i < todo.length; i += EMBED_BATCH_MAX) {
            const batch = todo.slice(i, i + EMBED_BATCH_MAX);
            const result = await aiEmbed(
                settings,
                batch.map(s => embeddingText(s))
            );
            if (!result.ok) {
                return Response.json(
                    {
                        success: false,
                        message: result.message,
                        done: written,
                        total: sites.length,
                    },
                    { status: result.status }
                );
            }
            written += await ctx.api.replaceEmbeddings(
                batch.map((s, idx) => ({ siteId: Number(s.id), vec: result.data[idx] ?? [] })),
                settings.embedModel
            );
        }
        return Response.json({
            success: true,
            done: written,
            total: sites.length,
            model: settings.embedModel,
        });
    }

    // ③ 语义搜索：把问题也变成向量，跟库里的比一遍
    if (path === "ai/search" && method === "POST") {
        if (!searchLimiter.allow(limiterKey(ctx, "search"))) {
            return bad("搜得太快了，歇一分钟再试", 429);
        }
        const body = (await request.json().catch(() => null)) as
            | { query?: string; limit?: number }
            | null;
        const query = (body?.query || "").trim();
        if (!query) return bad("空搜索");
        const limit = Math.min(Math.max(Number(body?.limit) || 20, 1), SEARCH_MAX_RESULTS);

        const [vector, rows] = await Promise.all([
            aiEmbed(settings, [query]),
            ctx.api.listEmbeddings(settings.embedModel),
        ]);
        if (!vector.ok) return bad(vector.message, vector.status);
        if (rows.length === 0) {
            return Response.json({ success: true, results: [], empty: true });
        }
        const results = topMatches(vector.data[0] ?? [], rows, limit, SEARCH_MIN_SCORE);
        return Response.json({ success: true, results });
    }

    return bad("没有这个 AI 接口", 404);
}
