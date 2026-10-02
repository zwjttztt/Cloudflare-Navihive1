// src/hooks/useAiAssistant.ts
// AI 助手的前端入口：把四个接口收成一个 hook，并统一「能不能用 / 为什么不能用」。
//
// 界面上任何一个 AI 按钮都要先过 ready 这道闸：没开就是没开，不要等点了才报一句错。
// 失败也一律变成 { ok:false, message }，调用方把 message 摆在按钮旁边就行，
// 不要弹窗 —— AI 帮不上忙是常态，用户正在做的那件事（加站、保存）不该被打断。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiStatus } from "../API/http";
import type { SiteMetaSuggestion, TagSuggestion } from "../utils/aiMeta";

export type AiOutcome<T> = { ok: true; data: T } | { ok: false; message: string };

interface AiApiLike {
    aiStatus(): Promise<AiStatus>;
    aiSiteMeta(payload: {
        url: string;
        name?: string;
        groups: string[];
        tags: string[];
    }): Promise<{ success: boolean; message?: string; suggestion?: SiteMetaSuggestion }>;
    aiSuggestTags(payload: {
        sites: { id: number; name: string; url: string; description?: string }[];
        groups: string[];
        tags: string[];
    }): Promise<{ success: boolean; message?: string; suggestions?: TagSuggestion[] }>;
    aiEmbed(force?: boolean): Promise<{
        success: boolean;
        message?: string;
        done?: number;
        total?: number;
    }>;
    aiSearch(query: string, limit?: number): Promise<{
        success: boolean;
        message?: string;
        results?: { id: number; score: number }[];
    }>;
}

export interface AiAssistant {
    status: AiStatus | null;
    /** 开关开着且配置齐全 */
    ready: boolean;
    /** 不能用时的一句话原因（直接摆在按钮旁）；能用时为 null */
    reason: string | null;
    refresh: () => Promise<void>;
    siteMeta: (
        url: string,
        opts: { name?: string; groups: string[]; tags: string[] }
    ) => Promise<AiOutcome<SiteMetaSuggestion>>;
    suggestTags: (
        sites: { id: number; name: string; url: string; description?: string }[],
        opts: { groups: string[]; tags: string[] }
    ) => Promise<AiOutcome<TagSuggestion[]>>;
    embed: (force?: boolean) => Promise<AiOutcome<{ done: number; total: number }>>;
    search: (query: string, limit?: number) => Promise<AiOutcome<{ id: number; score: number }[]>>;
}

export function useAiAssistant({ api }: { api: AiApiLike }): AiAssistant {
    const [status, setStatus] = useState<AiStatus | null>(null);

    const refresh = useCallback(async () => {
        try {
            setStatus(await api.aiStatus());
        } catch {
            // 查不到状态就当没开：AI 是可选功能，绝不能因为这一趟请求失败影响别的
            setStatus(null);
        }
    }, [api]);

    // 挂载时查一次。不放在每次聚焦/路由变化时刷 —— 配置改完会由设置弹窗自己调 refresh。
    useEffect(() => {
        void refresh();
    }, [refresh]);

    const reason =
        status === null
            ? "AI 助手状态未知"
            : !status.enabled
              ? "AI 助手没开（设置 → AI 助手）"
              : status.problem;

    const ready = status !== null && status.enabled && !status.problem;

    const search = useCallback(
        async (query: string, limit = 20): Promise<AiOutcome<{ id: number; score: number }[]>> => {
            const res = await api.aiSearch(query, limit);
            if (!res.success) return { ok: false, message: res.message || "语义搜索失败" };
            return { ok: true, data: res.results ?? [] };
        },
        [api]
    );

    const siteMeta = useCallback(
        async (
            url: string,
            opts: { name?: string; groups: string[]; tags: string[] }
        ): Promise<AiOutcome<SiteMetaSuggestion>> => {
            const res = await api.aiSiteMeta({ url, ...opts });
            if (!res.success || !res.suggestion) {
                return { ok: false, message: res.message || "AI 没给出建议" };
            }
            return { ok: true, data: res.suggestion };
        },
        [api]
    );

    const suggestTags = useCallback(
        async (
            sites: { id: number; name: string; url: string; description?: string }[],
            opts: { groups: string[]; tags: string[] }
        ): Promise<AiOutcome<TagSuggestion[]>> => {
            const res = await api.aiSuggestTags({ sites, ...opts });
            if (!res.success) return { ok: false, message: res.message || "AI 没给出建议" };
            return { ok: true, data: res.suggestions ?? [] };
        },
        [api]
    );

    const embed = useCallback(
        async (force = false): Promise<AiOutcome<{ done: number; total: number }>> => {
            const res = await api.aiEmbed(force);
            if (!res.success) return { ok: false, message: res.message || "生成索引失败" };
            return { ok: true, data: { done: res.done ?? 0, total: res.total ?? 0 } };
        },
        [api]
    );

    // 整个返回值必须 memo：App 会把它传给几百张卡片（SiteCard 是 memo 的），
    // 每次渲染都换新对象的话，所有卡片都会跟着重渲染一遍。
    return useMemo(
        () => ({ status, ready, reason, refresh, siteMeta, suggestTags, embed, search }),
        [status, ready, reason, refresh, siteMeta, suggestTags, embed, search]
    );
}

/** 站点弹窗用的那份：只需要「能不能补全」这一件事 */
export function useSiteAiMeta(ai: AiAssistant) {
    return useMemo(
        () => ({ ready: ai.ready, reason: ai.reason, siteMeta: ai.siteMeta }),
        [ai.ready, ai.reason, ai.siteMeta]
    );
}
