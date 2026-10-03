// tests/semanticSearch.dom.test.tsx
// useSemanticSearch 的组件级用例。标签合并的纯计算由 tests/tagOps.test.ts 覆盖，
// 这里盯的是那几条**改坏了不报错**的行为：
//   - 防抖：连着敲几个字只问模型一次；
//   - 取消：上一次请求回来晚了，不能把旧结果盖到新查询上；
//   - 降级：AI 挂了必须退回关键词结果（用户不能因此什么都看不到），且不许抛异常；
//   - 关开关：清空上一次的语义结果（不然列表看着像搜索坏了）；
//   - 建议的标签全都已经有了：别写库、也别弹「已给 N 个网站加上标签」骗人。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSemanticSearch, type SemanticSearchDeps } from "../src/hooks/useSemanticSearch";
import type { AiAssistant } from "../src/hooks/useAiAssistant";
import type { NotifySeverity } from "../src/hooks/useNotify";
import type { TagMap } from "../src/utils/tagOps";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

interface Log {
    searches: string[];
    embeds: (boolean | undefined)[];
    writes: TagMap[];
    notes: { text: string; level?: NotifySeverity; undo?: boolean }[];
    refreshes: number;
}

/** 可控的假 AI：search 可以挂住 / 失败 / 返回指定命中 */
function makeAi(opts: {
    fail?: boolean;
    hits?: { id: number; score: number }[];
    hangSearch?: boolean;
    failEmbed?: boolean;
    embed?: { done: number; total: number };
} = {}) {
    const log: Log = { searches: [], embeds: [], writes: [], notes: [], refreshes: 0 };
    let releaseSearch: (() => void) | null = null;
    let hangLeft = opts.hangSearch ? 1 : 0;
    // 可变开关：一条用例里要先成功再失败，光靠构造参数做不到
    const state = { fail: opts.fail ?? false };

    const ai = {
        status: null,
        ready: true,
        reason: null,
        refresh: async () => {
            log.refreshes++;
        },
        siteMeta: async () => ({ ok: true as const, data: { name: "", description: "" } }),
        suggestTags: async () => ({ ok: true as const, data: [] }),
        embed: async (force?: boolean) => {
            log.embeds.push(force);
            if (opts.failEmbed) return { ok: false as const, message: "嵌入服务不可用" };
            return { ok: true as const, data: opts.embed ?? { done: 3, total: 3 } };
        },
        search: async (q: string) => {
            log.searches.push(q);
            if (hangLeft > 0) {
                hangLeft--;
                await new Promise<void>(r => {
                    releaseSearch = r;
                });
            }
            if (state.fail) return { ok: false as const, message: "模型服务超时" };
            // 命中里带上查询词长度：这样「上一次请求回来晚了」会写成可区分的值，
            // 否则两次搜索返回一样的数据，取消逻辑写没写都看不出来
            return { ok: true as const, data: opts.hits ?? [{ id: q.length, score: 0.9 }] };
        },
        test: async () => ({ ok: true as const, data: { text: true, embedding: true } }),
    } as unknown as AiAssistant;

    return { ai, log, release: () => releaseSearch?.(), setFail: (v: boolean) => { state.fail = v; } };
}

const groups: GroupWithSites[] = [
    { id: 1, name: "g1", order_num: 0, sites: [{ id: 10, name: "a", url: "https://a.com" } as Site] },
];

function Harness({
    deps,
    log,
    initialQuery = "",
}: {
    deps: Omit<SemanticSearchDeps, "query">;
    log: Log;
    initialQuery?: string;
}) {
    const [query, setQuery] = useState(initialQuery);
    const [tags, setTags] = useState<TagMap>(deps.tags);
    const s = useSemanticSearch({
        ...deps,
        query,
        tags,
        applyTagOps: next => {
            log.writes.push(next);
            setTags(next);
        },
    });
    Object.assign(window as unknown as Record<string, unknown>, {
        __s: s,
        __setQuery: setQuery,
        __tags: tags,
    });
    return (
        <div>
            <span data-testid='on'>{String(s.semanticSearch)}</span>
            <span data-testid='hits'>{JSON.stringify(s.semanticHits)}</span>
            <span data-testid='note'>{s.semanticNote}</span>
            <span data-testid='busy'>{String(s.semanticBusy)}</span>
            <span data-testid='suggest-sites'>{JSON.stringify(s.aiSuggestSites)}</span>
        </div>
    );
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.textContent!.trim();
type Api = ReturnType<typeof useSemanticSearch>;
const s = () => (window as unknown as { __s: Api }).__s;
const setQuery = (q: string) =>
    act(() => (window as unknown as { __setQuery: (v: string) => void }).__setQuery(q));

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

/** 推进真实定时器（防抖 400ms 用的是 setTimeout，不能靠假 timer 糊弄过去） */
async function advance(ms: number) {
    const t0 = Date.now();
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, ms));
    });
    // 再给一轮**宏任务** act：setTimeout 回调里那批 setState 需要一个真正的
    // 宏任务边界才会 flush 到 DOM（微任务 Promise.resolve() 不行，试过）
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
    if (process.env.DIAG) console.log("advance", ms, "took", Date.now() - t0);
}

function makeNotify(log: Log) {
    return (
        text: string,
        level?: NotifySeverity,
        _ms?: number,
        action?: { label: string; onClick: () => void }
    ) => {
        log.notes.push({ text, level, undo: action?.label === "撤销" });
    };
}

test("防抖：连着改三次查询只问模型一次", async () => {
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => s().setSemanticSearch(true));

    await setQuery("云");
    await setQuery("云计");
    await setQuery("云计算");
    await advance(500);

    assert.deepEqual(log.searches, ["云计算"], "三次输入只应留下最后一次的查询");
    cleanup();
});

test("取消：上一次请求回来晚了，不能把旧结果盖到新查询上", async () => {
    const { ai, log, release } = makeAi({ hangSearch: true });
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => s().setSemanticSearch(true));

    // 命中里带的是查询词长度，所以两个词必须**长度不同**才区分得出来
    // （一开始用了「第一个词 / 第二个词」，两个都长 4，取消写了没写都看不出来）
    await setQuery("云");
    await advance(500); // 请求发出，挂在模型那头
    assert.equal(log.searches.length, 1);

    // 用户继续打字 → 旧请求应当被作废
    await setQuery("云计算");
    await advance(500);
    assert.equal(
        text("hits"),
        JSON.stringify([{ id: 3, score: 0.9 }]),
        "「云计算」长 3，先回来的应当是它的结果"
    );
    release(); // 这时候第一个请求才返回

    await advance(50);
    assert.equal(
        text("hits"),
        JSON.stringify([{ id: 3, score: 0.9 }]),
        "被取消的旧请求（长度 1）不许把结果盖回来——这正是竞态的表现"
    );
    cleanup();
});

test("降级：AI 失败时语义结果清空并留一句提示，关键词结果照常", async () => {
    const { ai, log, setFail } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => s().setSemanticSearch(true));
    await setQuery("云计算");
    await advance(500);
    assert.notEqual(text("hits"), "[]", "前置条件：先真的拿到过一次命中");

    // 模型这时候挂了
    setFail(true);
    await setQuery("云原生");
    await advance(500);

    assert.deepEqual(text("hits"), "[]", "失败时必须清空上一次的命中，不能拿旧结果继续过滤");
    assert.match(text("note"), /模型服务超时/);
    assert.equal(text("busy"), "false", "失败也要把 busy 收掉，否则按钮一直转");
    cleanup();
});

test("关掉开关：清空上一次的语义结果（不然列表看着像搜索坏了）", async () => {
    const { ai, log } = makeAi({ hits: [{ id: 10, score: 0.9 }] });
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => s().setSemanticSearch(true));
    await setQuery("云计算");
    await advance(500);
    assert.notEqual(text("hits"), "[]");

    await run(() => s().setSemanticSearch(false));
    assert.equal(text("hits"), "[]");
    assert.equal(text("note"), "");
    cleanup();
});

test("开关关着 / 查询为空：一个字都不问模型", async () => {
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await setQuery("   ");
    await advance(500);
    assert.deepEqual(log.searches, [], "开关没开，不该发请求");

    await run(() => s().setSemanticSearch(true));
    await advance(500);
    assert.deepEqual(log.searches, [], "查询是空串，不该发请求");
    cleanup();
});

test("建索引：成功给条数提示，失败只提示不写状态", async () => {
    const { ai, log } = makeAi({ embed: { done: 5, total: 8 } });
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => void s().buildSemanticIndex(true));
    assert.deepEqual(log.embeds, [true], "force 要一路传给 embed");
    assert.equal(log.refreshes, 1, "建完要刷新一次状态");
    assert.ok(log.notes.some(n => n.level === "success" && /5 个站点/.test(n.text)));
    cleanup();
});

test("建索引失败：提示错误，且不刷新状态", async () => {
    const { ai, log } = makeAi({ failEmbed: true });
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: () => {}, notify }}
        />
    );
    await run(() => void s().buildSemanticIndex());
    assert.ok(log.notes.some(n => n.level === "error" && /嵌入服务不可用/.test(n.text)));
    assert.equal(log.refreshes, 0, "失败了不该刷新状态");
    cleanup();
});

test("应用标签建议：写回合并后的整表，提示条上挂撤销", async () => {
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: next => log.writes.push(next), notify }}
        />
    );
    await run(() => s().applyAiTagSuggestions([{ id: 10, tags: ["效率"] }]));

    assert.equal(log.writes.length, 1);
    assert.deepEqual(log.writes[0]["10"], ["AI", "效率"]);
    const note = log.notes.at(-1);
    assert.ok(note?.undo, "提示条上必须有「撤销」");
    assert.match(note!.text, /1 个网站/);
    cleanup();
});

test("建议的标签全都已有：不写库也不弹提示（别骗用户说加上了）", async () => {
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups, tags: { "10": ["AI"] }, applyTagOps: next => log.writes.push(next), notify }}
        />
    );
    await run(() => s().applyAiTagSuggestions([{ id: 10, tags: ["AI"] }]));
    assert.deepEqual(log.writes, [], "没有变化就不该写库");
    assert.deepEqual(log.notes, [], "也不该弹「已给 1 个网站加上标签」");
    cleanup();
});

test("一批站点里只有真正变化的才算进提示条的数字", async () => {
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{
                ai,
                groups,
                tags: { "10": ["AI"], "11": ["AI"] },
                applyTagOps: next => log.writes.push(next),
                notify,
            }}
        />
    );
    await run(() =>
        s().applyAiTagSuggestions([
            { id: 10, tags: ["效率"] },
            { id: 11, tags: ["AI"] }, // 已经有了
        ])
    );
    const note = log.notes.at(-1);
    assert.match(note!.text, /1 个网站/, "只有站点 10 真的变了");
    cleanup();
});

test("aiSuggestSites 最多送 40 个站点（跟 aiMeta 的 MAX_SUGGEST_SITES 对齐）", async () => {
    const many: GroupWithSites[] = [
        {
            id: 1,
            name: "g",
            order_num: 0,
            sites: Array.from({ length: 60 }, (_, i) => ({
                id: i + 1,
                name: `s${i}`,
                url: `https://s${i}.com`,
            }) as Site),
        },
    ];
    const { ai, log } = makeAi();
    const notify = makeNotify(log);
    mount(
        <Harness
            log={log}
            deps={{ ai, groups: many, tags: {}, applyTagOps: () => {}, notify }}
        />
    );
    const sites = JSON.parse(text("suggest-sites")) as unknown[];
    assert.equal(sites.length, 40);
    cleanup();
});
