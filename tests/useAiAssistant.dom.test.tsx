// src/hooks/useAiAssistant.ts 的直测（181 行，此前零覆盖）。
//
// 为什么是它：App 把这个 hook 的返回值传给几百张 memo 的 SiteCard，
// 「返回对象跨渲染稳定」是界面性能的硬契约；而 ready/reason 与「失败一律
// 变 {ok:false, message} 不抛异常」则是所有 AI 按钮的公共闸门。这些都没测过。
//
// 用 Probe 组件直挂 hook（hook 离不开 React），api 是按结构实现的假体 ——
// 不引真 client，免得测试变成测 fetch。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
    useAiAssistant,
    useSiteAiMeta,
    type AiAssistant,
} from "../src/hooks/useAiAssistant";
import type { AiStatus, AiTestResponse } from "../src/API/types";
import type { SiteMetaSuggestion, TagSuggestion } from "../src/utils/aiMeta";

interface ApiLike {
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
    aiEmbed(force?: boolean): Promise<{ success: boolean; message?: string; done?: number; total?: number }>;
    aiSearch(query: string, limit?: number): Promise<{
        success: boolean;
        message?: string;
        results?: { id: number; score: number }[];
    }>;
    aiTest(settings: Partial<Record<string, string>>): Promise<AiTestResponse>;
}

function statusOf(over: Partial<AiStatus> = {}): AiStatus {
    return {
        enabled: true,
        provider: "workers-ai",
        textModel: "text-model",
        embedModel: "embed-model",
        embedded: 0,
        problem: null,
        ...over,
    };
}

interface Recorded {
    siteMeta: unknown[];
    suggestTags: unknown[];
    embed: (boolean | undefined)[];
    search: [string, number | undefined][];
    test: Partial<Record<string, string>>[];
}

function makeApi(
    over: Partial<{
        aiStatus: () => Promise<AiStatus>;
        aiSiteMeta: ApiLike["aiSiteMeta"];
        aiSuggestTags: ApiLike["aiSuggestTags"];
        aiEmbed: ApiLike["aiEmbed"];
        aiSearch: ApiLike["aiSearch"];
        aiTest: ApiLike["aiTest"];
    }> = {}
): { api: ApiLike; calls: Recorded } {
    const calls: Recorded = {
        siteMeta: [],
        suggestTags: [],
        embed: [],
        search: [],
        test: [],
    };
    const api: ApiLike = {
        aiStatus: over.aiStatus ?? (async () => statusOf()),
        // ⚠️ 记录桩在最外层：override 只负责决定返回值，不负责记录 ——
        // 否则「override + 断言 calls」的用例永远拿不到调用记录。
        aiSiteMeta: async payload => {
            calls.siteMeta.push(payload);
            if (over.aiSiteMeta) return over.aiSiteMeta(payload);
            return {
                success: true,
                suggestion: { name: "名字", description: "描述", group: "分组", tags: ["标签"] },
            };
        },
        aiSuggestTags: async payload => {
            calls.suggestTags.push(payload);
            if (over.aiSuggestTags) return over.aiSuggestTags(payload);
            return { success: true, suggestions: [] };
        },
        aiEmbed: async force => {
            calls.embed.push(force);
            if (over.aiEmbed) return over.aiEmbed(force);
            return { success: true, done: 1, total: 2 };
        },
        aiSearch: async (query, limit) => {
            calls.search.push([query, limit]);
            if (over.aiSearch) return over.aiSearch(query, limit);
            return { success: true, results: [{ id: 7, score: 0.42 }] };
        },
        aiTest: async settings => {
            calls.test.push(settings);
            if (over.aiTest) return over.aiTest(settings);
            return { success: true, text: { ok: true }, embed: { ok: true, dim: 768 } };
        },
    };
    return { api, calls };
}

interface Latest {
    ai: AiAssistant | null;
    site: { enabled: boolean; ready: boolean; reason: string | null } | null;
    render: number;
}

function Probe({ api, latest, tick }: { api: ApiLike; latest: Latest; tick: number }) {
    const ai = useAiAssistant({ api });
    const site = useSiteAiMeta(ai);
    latest.ai = ai;
    latest.site = site;
    latest.render = tick;
    return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountHarness(api: ApiLike, latest: Latest) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Probe api={api} latest={latest} tick={0} />);
    });
    // 冲掉挂载时 effect 里的那次 aiStatus
    await act(async () => {});
}

function rerender(api: ApiLike, latest: Latest, tick: number) {
    act(() => {
        root!.render(<Probe api={api} latest={latest} tick={tick} />);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(cleanup);

test("状态未知：查状态抛错就当没开，原因固定为「AI 助手状态未知」", async () => {
    const { api } = makeApi({
        aiStatus: async () => {
            throw new Error("断网");
        },
    });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    assert.ok(latest.ai, "hook 要有返回值");
    assert.equal(latest.ai.status, null);
    assert.equal(latest.ai.ready, false);
    assert.equal(latest.ai.reason, "AI 助手状态未知");
    assert.ok(latest.site, "useSiteAiMeta 要有返回值");
    assert.equal(latest.site.enabled, false);
    assert.equal(latest.site.reason, "AI 助手状态未知");
});

test("没开：enabled=false → 原因指路到设置入口", async () => {
    const { api } = makeApi({ aiStatus: async () => statusOf({ enabled: false }) });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    assert.equal(latest.ai!.ready, false);
    assert.equal(latest.ai!.reason, "AI 助手没开（更多选项 → AI 助手）");
});

test("开了但缺配置：problem 原样透出，ready false", async () => {
    const { api } = makeApi({
        aiStatus: async () => statusOf({ problem: "还没填 Cloudflare API token" }),
    });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    assert.equal(latest.ai!.ready, false);
    assert.equal(latest.ai!.reason, "还没填 Cloudflare API token");
    assert.equal(latest.site!.enabled, true, "开了之后站点入口要显示");
});

test("开了且配置齐全：ready true、reason null", async () => {
    const { api } = makeApi();
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    assert.equal(latest.ai!.ready, true);
    assert.equal(latest.ai!.reason, null);
    assert.equal(latest.site!.ready, true);
});

test("返回对象跨渲染稳定（几百张 memo 卡片依赖这个契约）", async () => {
    const { api } = makeApi();
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    const first = latest.ai!;
    const firstSite = latest.site!;
    rerender(api, latest, 1);
    rerender(api, latest, 2);
    assert.equal(latest.render, 2, "确实重渲染了");
    assert.ok(latest.ai === first, "useAiAssistant 的返回值必须是同一个对象");
    assert.ok(latest.site === firstSite, "useSiteAiMeta 的返回值也要稳定");
});

test("siteMeta：成功透传建议、参数原样进 api", async () => {
    const { api, calls } = makeApi();
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);

    const ok = await latest.ai!.siteMeta("https://x.example/", {
        name: "站点",
        groups: ["g1"],
        tags: ["t1"],
    });
    assert.deepEqual(ok, {
        ok: true,
        data: { name: "名字", description: "描述", group: "分组", tags: ["标签"] },
    });
    assert.deepEqual(calls.siteMeta.at(-1), {
        url: "https://x.example/",
        name: "站点",
        groups: ["g1"],
        tags: ["t1"],
    });
});

test("siteMeta：失败带原因；成功但没建议也算失败", async () => {
    const { api: failApi } = makeApi({
        aiSiteMeta: async () => ({ success: false, message: "模型没配好" }),
    });
    const l1: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(failApi, l1);
    assert.deepEqual(await l1.ai!.siteMeta("https://x/", { groups: [], tags: [] }), {
        ok: false,
        message: "模型没配好",
    });

    const { api: emptyApi } = makeApi({ aiSiteMeta: async () => ({ success: true }) });
    const l2: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(emptyApi, l2);
    assert.deepEqual(await l2.ai!.siteMeta("https://x/", { groups: [], tags: [] }), {
        ok: false,
        message: "AI 没给出建议",
    });
});

test("suggestTags：成功给清单；失败兜底「AI 没给出建议」；成功但缺字段给空数组", async () => {
    const SITES = [{ id: 1, name: "a", url: "https://a/" }];
    const suggestions: TagSuggestion[] = [{ id: 1, tags: ["t"], group: "g" }];

    const { api, calls } = makeApi({ aiSuggestTags: async () => ({ success: true, suggestions }) });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    const ok = await latest.ai!.suggestTags(SITES, { groups: ["g"], tags: ["t"] });
    assert.deepEqual(ok, { ok: true, data: suggestions });
    assert.deepEqual(calls.suggestTags.at(-1), { sites: SITES, groups: ["g"], tags: ["t"] });

    const { api: failApi } = makeApi({ aiSuggestTags: async () => ({ success: false }) });
    const l2: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(failApi, l2);
    assert.deepEqual(await l2.ai!.suggestTags(SITES, { groups: [], tags: [] }), {
        ok: false,
        message: "AI 没给出建议",
    });

    const { api: emptyApi } = makeApi({ aiSuggestTags: async () => ({ success: true }) });
    const l3: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(emptyApi, l3);
    assert.deepEqual(await l3.ai!.suggestTags(SITES, { groups: [], tags: [] }), {
        ok: true,
        data: [],
    });
});

test("embed：force 透传、成功补默认 done/total=0；失败兜底「生成索引失败」", async () => {
    const { api, calls } = makeApi({ aiEmbed: async () => ({ success: true }) });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    const ok = await latest.ai!.embed(true);
    assert.deepEqual(ok, { ok: true, data: { done: 0, total: 0 } });
    assert.deepEqual(calls.embed, [true], "force 参数要传到底");

    const { api: failApi } = makeApi({ aiEmbed: async () => ({ success: false }) });
    const l2: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(failApi, l2);
    assert.deepEqual(await l2.ai!.embed(), { ok: false, message: "生成索引失败" });
});

test("search：默认 limit 20 传给 api；失败兜底「语义搜索失败」", async () => {
    const { api, calls } = makeApi();
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    const ok = await latest.ai!.search("怎么搜");
    assert.deepEqual(ok, { ok: true, data: [{ id: 7, score: 0.42 }] });
    assert.deepEqual(calls.search.at(-1), ["怎么搜", 20]);

    const { api: failApi } = makeApi({ aiSearch: async () => ({ success: false }) });
    const l2: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(failApi, l2);
    assert.deepEqual(await l2.ai!.search("q"), { ok: false, message: "语义搜索失败" });

    const { api: noResApi } = makeApi({ aiSearch: async () => ({ success: true }) });
    const l3: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(noResApi, l3);
    assert.deepEqual(await l3.ai!.search("q"), { ok: true, data: [] });
});

test("test：settings 透传；成功带分项；失败保留分项结果；失败没 message 有兜底文案", async () => {
    const { api, calls } = makeApi();
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    const ok = await latest.ai!.test({ "ai.cfToken": "tok" });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok === true && ok.text?.ok, true);
    assert.equal(ok.ok === true && ok.embed?.dim, 768);
    assert.deepEqual(calls.test, [{ "ai.cfToken": "tok" }]);

    const { api: partialApi } = makeApi({
        aiTest: async () => ({
            success: false,
            message: "嵌入没通",
            text: { ok: true },
            embed: { ok: false, message: "维度不支持" },
        }),
    });
    const l2: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(partialApi, l2);
    const partial = await l2.ai!.test({});
    assert.equal(partial.ok, false);
    assert.equal(partial.message, "嵌入没通");
    assert.equal(partial.text?.ok, true, "失败也要把通的那一半摆出来");
    assert.equal(partial.embed?.message, "维度不支持");

    const { api: bareApi } = makeApi({ aiTest: async () => ({ success: false, message: "" }) });
    const l3: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(bareApi, l3);
    assert.deepEqual(await l3.ai!.test({}), {
        ok: false,
        message: "测试连接失败",
        text: undefined,
        embed: undefined,
    });
});

test("refresh 失败把已拿到的状态打回「未知」", async () => {
    let shouldThrow = false;
    const { api } = makeApi({
        aiStatus: async () => {
            if (shouldThrow) throw new Error("断网");
            return statusOf({ enabled: false });
        },
    });
    const latest: Latest = { ai: null, site: null, render: 0 };
    await mountHarness(api, latest);
    assert.equal(latest.ai!.reason, "AI 助手没开（更多选项 → AI 助手）");

    shouldThrow = true;
    await act(async () => {
        await latest.ai!.refresh();
    });
    assert.equal(latest.ai!.status, null, "查不到状态要归零，不能拿旧状态当真相");
    assert.equal(latest.ai!.reason, "AI 助手状态未知");
});
