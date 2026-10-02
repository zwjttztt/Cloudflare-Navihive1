// src/utils/aiConfig.ts
// AI 助手的配置：开关、provider、端点与模型的默认值，以及「还缺什么」的判定。
//
// 从 configs 里读出来的都是字符串，判「能不能用」的规则必须只有一份 ——
// 前端拿它决定按钮置不置灰，Worker 拿它决定要不要发请求，两边说不到一块去的话
// 就会出现「界面上能点、一点就报 500」。

import {
    AI_API_KEY_KEY,
    AI_CF_ACCOUNT_KEY,
    AI_CF_TOKEN_KEY,
    AI_EMBED_MODEL_KEY,
    AI_ENABLED_KEY,
    AI_ENDPOINT_KEY,
    AI_PROVIDER_KEY,
    AI_TEXT_MODEL_KEY,
} from "../API/configKeys";

export type AiProvider = "workers-ai" | "openai-compatible";

export interface AiSettings {
    enabled: boolean;
    provider: AiProvider;
    endpoint: string;
    textModel: string;
    embedModel: string;
    apiKey: string;
    cfToken: string;
    cfAccount: string;
}

// 默认值：不填模型就用这个，省得用户还得去查模型名
export const WORKERS_TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const WORKERS_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const OPENAI_TEXT_MODEL = "deepseek-chat";
export const OPENAI_EMBED_MODEL = "text-embedding-3-small";

export const AI_PROVIDERS: { value: AiProvider; label: string; hint: string }[] = [
    {
        value: "workers-ai",
        label: "Cloudflare Workers AI",
        hint: "用 Cloudflare 自己的模型，需要一个有 Workers AI 权限的 API token 和账号 ID",
    },
    {
        value: "openai-compatible",
        label: "OpenAI 兼容接口",
        hint: "DeepSeek / 智谱 / OpenAI / 硅基流动等，填端点、模型名和密钥即可",
    },
];

export function aiSettingsFromConfigs(configs: Record<string, string>): AiSettings {
    const provider: AiProvider =
        (configs[AI_PROVIDER_KEY] || "").trim() === "openai-compatible"
            ? "openai-compatible"
            : "workers-ai";
    const textModel = (configs[AI_TEXT_MODEL_KEY] || "").trim();
    const embedModel = (configs[AI_EMBED_MODEL_KEY] || "").trim();
    return {
        // 只认显式 "true"：配错了、读失败了都当关着，绝不默认把数据往外发
        enabled: (configs[AI_ENABLED_KEY] || "").trim() === "true",
        provider,
        endpoint: (configs[AI_ENDPOINT_KEY] || "").trim(),
        textModel: textModel || (provider === "workers-ai" ? WORKERS_TEXT_MODEL : OPENAI_TEXT_MODEL),
        embedModel: embedModel || (provider === "workers-ai" ? WORKERS_EMBED_MODEL : OPENAI_EMBED_MODEL),
        apiKey: (configs[AI_API_KEY_KEY] || "").trim(),
        cfToken: (configs[AI_CF_TOKEN_KEY] || "").trim(),
        cfAccount: (configs[AI_CF_ACCOUNT_KEY] || "").trim(),
    };
}

/**
 * 还缺什么就说清楚什么，让设置界面能直接把这句话摆在按钮旁边。
 * 返回 null 表示配置完整、可以发请求。
 */
export function aiConfigProblem(settings: AiSettings): string | null {
    if (!settings.enabled) return "AI 助手没开（设置 → AI 助手）";
    if (settings.provider === "workers-ai") {
        if (!settings.cfToken) return "还没填 Cloudflare API token";
        if (!settings.cfAccount) return "还没填 Cloudflare 账号 ID";
        return null;
    }
    if (!settings.endpoint) return "还没填接口地址";
    if (!/^https?:\/\//i.test(settings.endpoint)) return "接口地址要以 http:// 或 https:// 开头";
    if (!settings.apiKey) return "还没填 API 密钥";
    return null;
}
