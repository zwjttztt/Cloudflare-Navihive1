// src/hooks/useSemanticSearch.ts
// AI 语义搜索 + 标签建议这一块的状态机。原来内联在 App.tsx 里约 100 行。
//
// 抽它的理由（不是因为行数，是因为这块**改坏了不报错**）：
//   - 搜索有 400ms 防抖，还有「上一次请求回来晚了不能覆盖这一次」的取消逻辑；
//     写反了只会表现为「结果偶尔闪一下」，没人会去查。
//   - AI 挂了必须降级成普通关键词搜索（用户不能因此什么都看不到），
//     这条是产品底线，靠 code review 记不住。
//   - 关掉开关要清空上一次的结果，不然列表看着像「搜索坏了」。
//
// 只做编排：合并标签的纯计算在 utils/tagOps.ts 的 applyTagSuggestions（有单测）。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiAssistant } from "./useAiAssistant";
import type { NotifySeverity } from "./useNotify";
import type { NotifyAction } from "../context/NotifyContext";
import { applyTagSuggestions, type TagMap } from "../utils/tagOps";
import { MAX_SUGGEST_SITES } from "../utils/aiMeta";
import type { GroupWithSites } from "../types";

export interface SemanticNotify {
    (message: string, level?: NotifySeverity, ms?: number, action?: NotifyAction): void;
}

export interface SemanticSearchDeps {
    ai: AiAssistant;
    /** 已经 trim 过的查询词：空串时不问模型 */
    query: string;
    groups: GroupWithSites[];
    tags: TagMap;
    applyTagOps: (next: TagMap) => void;
    notify: SemanticNotify;
}

/** 防抖时长：短了每个字都打一次模型，长了用户以为没反应 */
export const SEMANTIC_DEBOUNCE_MS = 400;

export function useSemanticSearch({
    ai,
    query,
    groups,
    tags,
    applyTagOps,
    notify,
}: SemanticSearchDeps) {
    /** 「更多选项 → AI 助手」：AI 的开关与凭据单独一个弹窗 */
    const [openAiAssistant, setOpenAiAssistant] = useState(false);

    // 要送去整理的站点：太多就只取前 40 个（跟 utils/aiMeta 的 MAX_SUGGEST_SITES 对齐）
    const aiSuggestSites = useMemo(
        () =>
            groups
                .flatMap(g => g.sites ?? [])
                .slice(0, MAX_SUGGEST_SITES)
                .map(site => ({
                    id: Number(site.id),
                    name: site.name,
                    url: site.url,
                    description: site.description,
                })),
        [groups]
    );

    /** 语义搜索开关：开着且查询非空时才去问模型，关着就是一个普通搜索框 */
    const [semanticSearch, setSemanticSearch] = useState(false);
    // 全空格（"   "）也要当「没输」，不然会为一条空查询去打模型。
    // 调用方（App）传的是 searchQuery.trim()，这里再兜一次是防以后有人传原值。
    const trimmedQuery = query.trim();
    const [semanticHits, setSemanticHits] = useState<{ id: number; score: number }[]>([]);
    const [semanticNote, setSemanticNote] = useState("");
    const [semanticBusy, setSemanticBusy] = useState(false);

    // 关掉开关就清空：不然会留着上一次的语义结果继续过滤列表，看着像搜索坏了
    useEffect(() => {
        if (!semanticSearch) {
            setSemanticHits([]);
            setSemanticNote("");
        }
    }, [semanticSearch]);

    // 开关关着 / 查询为空：一个字都不问模型
    useEffect(() => {
        if (!semanticSearch || !ai.ready || !trimmedQuery) return;
        let cancelled = false;
        setSemanticBusy(true);
        const timer = setTimeout(async () => {
            const res = await ai.search(trimmedQuery);
            if (cancelled) return;
            setSemanticBusy(false);
            if (!res.ok) {
                setSemanticHits([]);
                setSemanticNote(res.message);
                return;
            }
            setSemanticHits(res.data);
            setSemanticNote(res.data.length === 0 ? "语义上没找到很像的站点，下面是关键词结果" : "");
        }, SEMANTIC_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            setSemanticBusy(false);
        };
    }, [semanticSearch, ai.ready, trimmedQuery, ai]);

    /** 给站点建语义索引（站点改了很多之后要重跑一次） */
    const buildSemanticIndex = useCallback(
        async (force = false) => {
            setSemanticBusy(true);
            const res = await ai.embed(force);
            setSemanticBusy(false);
            if (!res.ok) {
                notify(res.message, "error");
                return;
            }
            await ai.refresh();
            notify(
                res.data.done > 0
                    ? `已给 ${res.data.done} 个站点建好语义索引（共 ${res.data.total} 个）`
                    : `${res.data.total} 个站点都已经有索引了`,
                "success"
            );
        },
        [ai, notify]
    );

    /**
     * 应用 AI 给的标签建议：整份写回 + 提示条上挂撤销。
     * 跟标签重命名/合并走同一条路（撤销 = 写回旧表），所以「AI 帮我改错了」也能一键撤回。
     */
    const applyAiTagSuggestions = useCallback(
        (picked: { id: number; tags: string[] }[]) => {
            if (picked.length === 0) return;
            const next = applyTagSuggestions(tags, picked);
            // 建议里的标签全都已经有了 → 写库是空操作，别弹「已给 N 个网站加上标签」
            // 骗用户（页面看着没变化，还会以为搜索坏了）。
            if (next === tags) return;
            const touched = picked.filter(
                item => (next[String(item.id)] ?? []).length !== (tags[String(item.id)] ?? []).length
            ).length;
            applyTagOps(next);
            notify(`已按 AI 建议给 ${touched} 个网站加上标签`, "success", undefined, {
                label: "撤销",
                onClick: () => applyTagOps(tags),
            });
        },
        [tags, applyTagOps, notify]
    );

    return {
        openAiAssistant,
        setOpenAiAssistant,
        aiSuggestSites,
        semanticSearch,
        setSemanticSearch,
        semanticHits,
        semanticNote,
        semanticBusy,
        buildSemanticIndex,
        applyAiTagSuggestions,
    };
}
