// tests/siteSearch.dom.test.tsx
// useSiteSearch 的用例。这里是搜索的**编排层**：utils/search 与 utils/advancedSearch
// 各自有单测，但「它们串起来之后对不对」没人管 —— 而踩过的坑恰恰都在这一层：
//   - 高级语法（tag: / is: / -排除）剥出来之后，剩下的自由词有没有正确交回普通检索；
//   - 语义命中为空时必须退回关键词结果（AI 没帮上忙不能变成「什么都看不到」）；
//   - 星标 / 失效 / 标签三档筛选是**叠在**搜索结果之上的，不是替代；
//   - 搜索上限：以前只截「每组 24 条」，五个分组各自命中就成了 120 张卡，
//     全局 60 的上限形同虚设 —— 这里用 3 个分组把它逼出来。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSiteSearch, type UseSiteSearchParams } from "../src/hooks/useSiteSearch";
import type { GroupWithSites } from "../src/types";
import type { Site } from "../src/API/http";
import type { TagMap } from "../src/utils/tagOps";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

// ⚠️ 必须有兜底清理：断言失败时用例末尾的 cleanup() 不会执行，
// 残留的 host 会让后面几条读到上一个测试的 DOM（查过一次，很费时间）
afterEach(() => {
    cleanup();
});

// ⚠️ 必须有兜底清理：断言失败时用例末尾的 cleanup() 不会执行，
// 残留的 host 会让后面几条读到上一个测试的 DOM（查过一次，很费时间）
afterEach(() => {
    cleanup();
});

const site = (id: number, groupId: number, name: string, url?: string): Site =>
    ({
        id,
        name,
        url: url ?? `https://${name}.com`,
        description: `${name} 的描述`,
        group_id: groupId,
        order_num: id,
    }) as unknown as Site;

const twoGroups = (): GroupWithSites[] => [
    {
        id: 1,
        name: "开发工具",
        order_num: 0,
        sites: [site(10, 1, "GitHub"), site(11, 1, "StackOverflow")],
    },
    {
        id: 2,
        name: "设计",
        order_num: 1,
        sites: [site(20, 2, "Figma"), site(21, 2, "Dribbble")],
    },
];

type Ctl = {
    starFilter: boolean;
    deadOnly: boolean;
    activeTags: string[];
    searchFocused: boolean;
    searchQuery: string;
};

interface Log {
    history: string[];
    opened: string[];
}

/** 受控外壳：筛选与查询都是 state，用例里改它们来驱动 hook 重算 */
function Harness({
    params,
    log,
    initial,
}: {
    params: Omit<
        UseSiteSearchParams,
        | "starFilter"
        | "deadOnly"
        | "activeTags"
        | "searchFocused"
        | "searchQuery"
        | "setStarFilter"
        | "setDeadOnly"
        | "setActiveTags"
        | "setSearchFocused"
        | "setSearchQuery"
    >;
    log: Log;
    initial: Ctl;
}) {
    const [ctl, setCtl] = useState<Ctl>(initial);
    const s = useSiteSearch({
        ...params,
        starFilter: ctl.starFilter,
        deadOnly: ctl.deadOnly,
        activeTags: ctl.activeTags,
        searchFocused: ctl.searchFocused,
        searchQuery: ctl.searchQuery,
        setStarFilter: v => setCtl(c => ({ ...c, starFilter: typeof v === "function" ? v(c.starFilter) : v })),
        setDeadOnly: v => setCtl(c => ({ ...c, deadOnly: typeof v === "function" ? v(c.deadOnly) : v })),
        setActiveTags: v => setCtl(c => ({ ...c, activeTags: typeof v === "function" ? v(c.activeTags) : v })),
        setSearchFocused: v => setCtl(c => ({ ...c, searchFocused: typeof v === "function" ? v(c.searchFocused) : v })),
        setSearchQuery: v => setCtl(c => ({ ...c, searchQuery: typeof v === "function" ? v(c.searchQuery) : v })),
        setActiveResult: () => {},
        pushSearchHistory: term => log.history.push(term),
    });
    Object.assign(window as unknown as Record<string, unknown>, { __s: s, __set: setCtl });
    return (
        <div>
            <span data-testid='matched'>{s.matchedCount}</span>
            <span data-testid='rendered'>{s.renderedCount}</span>
            <span data-testid='truncated'>{String(s.searchTruncated)}</span>
            <span data-testid='expanded'>{String(s.searchExpanded)}</span>
            <span data-testid='groups'>{JSON.stringify(s.displayedGroups.map(g => [g.name, g.sites.map(x => x.id)]))}</span>
            <span data-testid='flat'>{JSON.stringify(s.flatResults.map(r => r.site.id))}</span>
            <span data-testid='dropdown'>{String(s.dropdownOpen)}</span>
            <span data-testid='current'>{JSON.stringify(s.currentGroupSites.map(x => x.id))}</span>
            <span data-testid='anim'>{String(s.reduceEntryAnimation)}</span>
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
type Api = ReturnType<typeof useSiteSearch>;
const s = () => (window as unknown as { __s: Api }).__s;
const patch = (p: Partial<Ctl>) =>
    act(() => (window as unknown as { __set: (f: (c: Ctl) => Ctl) => void }).__set(c => ({ ...c, ...p })));

async function run(fn: () => void | Promise<void>) {
    await act(async () => {
        await fn();
    });
}

/** 推进宏任务：useDeferredValue 的延迟值需要一轮才能跟上 */
async function flush() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

function baseParams(over: Partial<UseSiteSearchParams> = {}) {
    return {
        groups: twoGroups(),
        usePinyin: false,
        semanticSearch: false,
        semanticHits: [],
        starred: [],
        tags: {} as TagMap,
        deadLinks: {},
        searchHistory: [] as string[],
        searchInputRef: { current: null },
        visits: {},
        favoritesEnabled: false,
        activeGroupId: null,
        ...over,
    } as Omit<
        UseSiteSearchParams,
        | "starFilter"
        | "deadOnly"
        | "activeTags"
        | "searchFocused"
        | "searchQuery"
        | "setStarFilter"
        | "setDeadOnly"
        | "setActiveTags"
        | "setSearchFocused"
        | "setSearchQuery"
    >;
}

const initial: Ctl = {
    starFilter: false,
    deadOnly: false,
    activeTags: [],
    searchFocused: false,
    searchQuery: "",
};

test("没输入关键词：原样返回所有分组，不做任何筛选", async () => {
    const log: Log = { history: [], opened: [] };
    mount(<Harness params={baseParams()} log={log} initial={initial} />);
    await flush();
    assert.equal(text("matched"), "4");
    assert.equal(text("truncated"), "false");
    assert.deepEqual(JSON.parse(text("groups")), [
        ["开发工具", [10, 11]],
        ["设计", [20, 21]],
    ]);
    cleanup();
});

test("关键词命中卡片就留下，命中的分组整组留下（按名称匹配）", async () => {
    const log: Log = { history: [], opened: [] };
    mount(<Harness params={baseParams()} log={log} initial={{ ...initial, searchQuery: "git" }} />);
    await flush();
    assert.equal(text("matched"), "1");
    assert.deepEqual(JSON.parse(text("groups")), [["开发工具", [10]]]);
    cleanup();
});

test("高级语法 tag: 与自由词叠加：两者都满足才留下", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ tags: { "10": ["代码"], "11": ["代码"] } as TagMap })}
            log={log}
            initial={{ ...initial, searchQuery: "tag:代码 git" }}
        />
    );
    await flush();
    assert.equal(text("matched"), "1", "tag:代码 有两个，但自由词 git 只剩 GitHub");
    assert.deepEqual(JSON.parse(text("groups")), [["开发工具", [10]]]);
    cleanup();
});

test("-排除词：显式踢掉某张卡片", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams()}
            log={log}
            // 自由词用「描述」而不是分组名：命中分组名时 hook 会**整组保留**，
            // 站点级的过滤（含 -排除词）根本不会跑到，那就测不到排除逻辑了
            initial={{ ...initial, searchQuery: "描述 -git" }}
        />
    );
    await flush();
    const groups = JSON.parse(text("groups")) as [string, number[]][];
    assert.equal(
        groups.flatMap(([, ids]) => ids).includes(10),
        false,
        "GitHub 的链接与描述里都有 git，应当被 -git 排除"
    );
    assert.equal(text("matched"), "3", "其余三张留下");
    cleanup();
});

test("语义命中为空：退回关键词结果（AI 没帮上忙不能变成什么都看不到）", async () => {
    const log: Log = { history: [], opened: [] };
    // 先拿「关着语义」的关键词结果当基准
    mount(
        <Harness
            params={baseParams({ semanticSearch: false, semanticHits: [] })}
            log={log}
            initial={{ ...initial, searchQuery: "git" }}
        />
    );
    await flush();
    // 再比「开着但没命中」——两者必须完全一致，
    // 否则就是「AI 没帮上忙反而把结果清空了」
    const baseline = text("matched");
    const baselineGroups = text("groups");
    assert.notEqual(baseline, "0", "前置条件：关键词 git 本身得有命中");
    cleanup();

    mount(
        <Harness
            params={baseParams({ semanticSearch: true, semanticHits: [] })}
            log={log}
            initial={{ ...initial, searchQuery: "git" }}
        />
    );
    await flush();
    assert.equal(text("matched"), baseline, "语义空命中必须原样退回关键词结果");
    assert.equal(text("groups"), baselineGroups, "连顺序都得一样");
    cleanup();
});

test("语义命中：只留命中的卡片，并按相似度重排", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({
                semanticSearch: true,
                // 语义排序是**组内**重排，不会把卡片跨分组搬动：
                // 所以两个命中要放在同一个分组里才看得出顺序变化
                semanticHits: [{ id: 11, score: 0.95 }, { id: 10, score: 0.7 }],
            })}
            log={log}
            initial={initial}
        />
    );
    await flush();
    const groups = JSON.parse(text("groups")) as [string, number[]][];
    assert.deepEqual(groups, [["开发工具", [11, 10]]], "分组内按相似度重排");
    cleanup();
});

test("标签筛选取交集：同时带两个标签才命中", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({
                tags: { "10": ["AI", "工具"], "11": ["AI"], "20": ["AI", "工具"] } as TagMap,
            })}
            log={log}
            initial={{ ...initial, activeTags: ["AI", "工具"] }}
        />
    );
    await flush();
    assert.equal(text("matched"), "2", "只有 10 与 20 同时带两个标签");
    cleanup();
});

test("星标 / 失效筛选是叠在搜索结果之上的，不是替代", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ starred: [10], deadLinks: { "https://GitHub.com": 1 } })}
            log={log}
            initial={initial}
        />
    );
    await flush();
    assert.equal(text("matched"), "4", "不筛选时全部可见");

    await patch({ starFilter: true });
    await flush();
    assert.equal(text("matched"), "1", "只看星标");

    await patch({ starFilter: false, deadOnly: true });
    await flush();
    assert.equal(text("matched"), "1", "只看失效");
    cleanup();
});

test("clearAllFilters 一次清掉三档筛选", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ starred: [10], tags: { "10": ["AI"] } as TagMap })}
            log={log}
            initial={{ ...initial, starFilter: true, activeTags: ["AI"] }}
        />
    );
    await flush();
    assert.equal(text("matched"), "1");
    await run(() => s().clearAllFilters());
    await flush();
    assert.equal(text("matched"), "4", "三档筛选都清掉了");
    cleanup();
});

test("toggleActiveTag：再点一次同一个标签是取消", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ tags: { "10": ["AI"] } as TagMap })}
            log={log}
            initial={initial}
        />
    );
    await flush();
    await run(() => s().toggleActiveTag("AI"));
    await flush();
    assert.equal(text("matched"), "1");
    await run(() => s().toggleActiveTag("AI"));
    await flush();
    assert.equal(text("matched"), "4", "再点一次取消选中");
    cleanup();
});

// ---- 搜索上限：这条是踩过坑的，3 个分组 × 各命中 30 条 ----

const manyGroups = (): GroupWithSites[] =>
    [1, 2, 3].map(gid => ({
        id: gid,
        name: `g${gid}`,
        order_num: gid,
        sites: Array.from({ length: 30 }, (_, i) => site(gid * 100 + i, gid, `s${gid}-${i}`)),
    }));

test("命中很多时截断渲染：计数按真实命中显示，DOM 上不超过 60 张", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ groups: manyGroups() })}
            log={log}
            initial={{ ...initial, searchQuery: "s" }}
        />
    );
    await flush();
    assert.equal(text("truncated"), "true", "90 条命中应当触发截断");
    assert.equal(text("matched"), "90", "计数要说真话");
    assert.ok(
        Number(text("rendered")) <= 60,
        `渲染出来的不能超过全局上限 60，实际 ${text("rendered")}`
    );
    assert.equal(text("anim"), "true", "卡片太多时关掉入场动画");
    cleanup();
});

test("「显示全部」跟着关键词走：换个词自动回到收起态", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ groups: manyGroups() })}
            log={log}
            initial={{ ...initial, searchQuery: "s" }}
        />
    );
    await flush();
    assert.equal(text("expanded"), "false");

    await run(() => s().expandAllResults());
    await flush();
    assert.equal(text("expanded"), "true");
    assert.equal(text("rendered"), "90", "展开后全部渲染");

    // 换个关键词：上一轮的展开不该带进新搜索
    await patch({ searchQuery: "s1-1" });
    await flush();
    assert.equal(text("expanded"), "false", "换词后回到收起态");
    cleanup();
});

test("collapseAllResults 收起后重新截断", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ groups: manyGroups() })}
            log={log}
            initial={{ ...initial, searchQuery: "s" }}
        />
    );
    await flush();
    await run(() => s().expandAllResults());
    await flush();
    assert.equal(text("rendered"), "90");
    await run(() => s().collapseAllResults());
    await flush();
    assert.ok(Number(text("rendered")) <= 60);
    cleanup();
});

test("没输入关键词时不截断（全量渲染本来就是常态）", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness params={baseParams({ groups: manyGroups() })} log={log} initial={initial} />
    );
    await flush();
    assert.equal(text("truncated"), "false", "没搜索就不该截");
    assert.equal(text("rendered"), "90");
    cleanup();
});

test("下拉面板：有关键词 + 聚焦 + 有结果才开，且最多 8 条", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams({ groups: manyGroups() })}
            log={log}
            initial={{ ...initial, searchQuery: "s", searchFocused: true }}
        />
    );
    await flush();
    assert.equal(text("dropdown"), "true");
    assert.equal((JSON.parse(text("flat")) as number[]).length, 8, "扁平结果最多 8 条");

    await patch({ searchFocused: false });
    await flush();
    assert.equal(text("dropdown"), "false", "失焦就收起");
    cleanup();
});

test("没输入关键词时下拉面板不开，也不产生扁平结果", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams()}
            log={log}
            initial={{ ...initial, searchFocused: true }}
        />
    );
    await flush();
    assert.equal(text("dropdown"), "false");
    assert.deepEqual(JSON.parse(text("flat")), []);
    cleanup();
});

test("openResult：记进搜索历史、收起面板，并打开站点", async () => {
    const log: Log = { history: [], opened: [] };
    mount(
        <Harness
            params={baseParams()}
            log={log}
            initial={{ ...initial, searchQuery: "git", searchFocused: true }}
        />
    );
    await flush();
    const groups = JSON.parse(text("groups")) as [string, number[]][];
    assert.equal(groups.length, 1);
    await run(() => s().openResult(s().flatResults[0].site));
    assert.deepEqual(log.history, ["git"], "从面板打开的，关键词要记进历史");
    cleanup();
});
