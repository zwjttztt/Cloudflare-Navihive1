// HeaderSearchBox 的直测（284 行，此前零覆盖）。
//
// 它是**使用频率最高的一个控件**：搜索框 + 结果下拉 + 搜索历史。
// 零覆盖的代价是「改坏了没人知道」—— 而搜索坏掉的表现往往不是报错，
// 是「搜不到了」「按回车没反应」「历史记录点不动」，都很隐蔽。
//
// 可测的约定（挑的是「写反了界面依然正常」的那些）：
//   - 有关键词时下列表是**结果**，没关键词时是**历史**，两者不能串
//   - 悬停要能改选中项（不然只能一路按 ↓ 选）
//   - 面板关着时不许渲染内容（Popper 的 anchorEl 为 null 也不该硬塞）
//   - 语义搜索开关是 toggle，必须带 aria-pressed
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import HeaderSearchBox, { type SearchResult } from "../src/components/HeaderSearchBox";
import type { Site } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let anchor: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    anchor?.remove();
    root = null;
    host = null;
    anchor = null;
    document.body.innerHTML = "";
});

function makeSite(over: Partial<Site> = {}): Site {
    return {
        id: 1,
        group_id: 1,
        name: "示例站点",
        url: "https://example.com/",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
        ...over,
    } as Site;
}

interface Log {
    opened: Site[];
    active: number[];
    history: string[];
    cleared: number;
    semantic: boolean[];
    query: string[];
}

interface Opts {
    query?: string;
    results?: SearchResult[];
    activeResult?: number;
    dropdownOpen?: boolean;
    historyOpen?: boolean;
    searchHistory?: string[];
    semantic?: {
        enabled: boolean;
        ready: boolean;
        reason: string | null;
        busy?: boolean;
        onToggle: (on: boolean) => void;
    };
}

function render(opts: Opts = {}) {
    const log: Log = { opened: [], active: [], history: [], cleared: 0, semantic: [], query: [] };
    anchor = document.createElement("div");
    document.body.appendChild(anchor);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    const results = opts.results ?? [];
    act(() => {
        root!.render(
            <HeaderSearchBox
                searchInputRef={{ current: null }}
                searchPanelRef={{ current: null }}
                searchQuery={opts.query ?? ""}
                setSearchQuery={v => log.query.push(v)}
                setActiveResult={i => log.active.push(i)}
                setSearchFocused={() => {}}
                searchAnchor={anchor}
                setSearchAnchor={() => {}}
                dropdownOpen={opts.dropdownOpen ?? true}
                historyOpen={opts.historyOpen ?? false}
                query={opts.query ?? ""}
                results={results}
                activeResult={opts.activeResult ?? 0}
                openResult={site => log.opened.push(site)}
                searchHistory={opts.searchHistory ?? []}
                applyHistoryTerm={t => log.history.push(t)}
                clearSearchHistory={() => (log.cleared += 1)}
                headerCompact={false}
                semantic={opts.semantic}
            />
        );
    });
    return log;
}

const text = () => document.body.textContent || "";
const buttons = () => [...document.querySelectorAll<HTMLElement>("button")];
/** 结果项：MUI 的 ListItemButton 默认渲染成 div 而不是 li，按 class 取才稳 */
const resultItems = () => [
    ...document.querySelectorAll<HTMLElement>(".MuiListItemButton-root"),
];

test("有关键词时下列表是搜索结果，显示站点名与所属分组", () => {
    render({
        query: "示例",
        results: [
            { site: makeSite({ id: 1, name: "示例一" }), groupName: "常用" },
            { site: makeSite({ id: 2, name: "示例二" }), groupName: "工具" },
        ],
    });
    const t = text();
    assert.ok(t.includes("示例一"), "结果项要显示站点名");
    assert.ok(t.includes("常用"), "要显示所属分组，否则同名站点分不清");
    assert.ok(t.includes("示例二"));
    assert.ok(!t.includes("最近搜索"), "有关键词时不该显示历史列表");
    assert.ok(!t.includes("清空"), "历史列表的「清空」不该混进结果面板");
});

test("没有关键词时展示搜索历史，并能点某个词套用", () => {
    const log = render({ query: "", historyOpen: true, searchHistory: ["github", "mdn"] });
    assert.ok(text().includes("最近搜索"), "空查询时这个面板是搜索历史");

    const chip = buttons().find(b => (b.textContent || "").trim() === "github");
    assert.ok(chip, "历史词应该是一颗可点的 chip");
    act(() => {
        chip!.click();
    });
    assert.deepEqual(log.history, ["github"], "点了历史词要把这个词填回搜索框");
});

test("历史面板有「清空」", () => {
    const log = render({ query: "", historyOpen: true, searchHistory: ["github"] });
    const clear = buttons().find(b => (b.textContent || "").trim() === "清空");
    assert.ok(clear, "历史列表要能一键清空（搜索历史是隐私，留着不给出路不行）");
    act(() => {
        clear!.click();
    });
    assert.equal(log.cleared, 1);
});

test("点结果会打开对应站点", () => {
    const site = makeSite({ id: 42, name: "示例一" });
    const log = render({ query: "示例", results: [{ site, groupName: "常用" }] });
    const item = resultItems().find(li => (li.textContent || "").includes("示例一"));
    assert.ok(item, "没找到结果项");
    act(() => {
        item!.click();
    });
    assert.equal(log.opened.length, 1);
    assert.equal(log.opened[0].id, 42);
});

test("悬停结果项会把它设为选中项（否则只能一路按 ↓ 选）", () => {
    const log = render({
        query: "示例",
        results: [
            { site: makeSite({ id: 1, name: "示例一" }), groupName: "常用" },
            { site: makeSite({ id: 2, name: "示例二" }), groupName: "工具" },
        ],
    });
    const items = resultItems();
    assert.equal(items.length, 2);
    act(() => {
        items[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    assert.ok(
        log.active.includes(1),
        `悬停第二项要把选中项改成 1，实际调用：${JSON.stringify(log.active)}`
    );
});

test("当前选中项有高亮标记", () => {
    render({
        query: "示例",
        activeResult: 1,
        results: [
            { site: makeSite({ id: 1, name: "示例一" }), groupName: "常用" },
            { site: makeSite({ id: 2, name: "示例二" }), groupName: "工具" },
        ],
    });
    const items = resultItems();
    const selected = items.filter(li => li.className.includes("Mui-selected"));
    assert.equal(selected.length, 1, "有且只有一项是选中的");
    assert.ok(
        (selected[0].textContent || "").includes("示例二"),
        "高亮的应该是 activeResult 指向的那一项（第二项），不是第一项"
    );
});

test("面板关闭时什么都不渲染", () => {
    render({ query: "示例", dropdownOpen: false, historyOpen: false, results: [] });
    assert.ok(
        !text().includes("示例一"),
        "dropdownOpen / historyOpen 都为 false 时不该渲染面板内容"
    );
});

test("搜索框与清空按钮都有可访问名", () => {
    render({ query: "示例" });
    assert.ok(
        document.querySelector('[aria-label="搜索网站"]'),
        "搜索框要有 aria-label"
    );
    assert.ok(document.querySelector('[aria-label="清空搜索"]'), "清空按钮要有 aria-label");
});

test("语义搜索是开关，aria-pressed 跟着 enabled 走", () => {
    const log = render({
        query: "示例",
        semantic: { enabled: true, ready: true, reason: null, onToggle: v => log.semantic.push(v) },
    });
    const toggle = document.querySelector<HTMLElement>('[aria-label="语义搜索"]');
    assert.ok(toggle, "语义搜索入口要能拿到");
    assert.equal(
        toggle!.getAttribute("aria-pressed"),
        "true",
        "它是开关不是普通按钮，必须带 aria-pressed，读屏才知道开没开"
    );
    act(() => {
        toggle!.click();
    });
    assert.deepEqual(log.semantic, [false], "点一下要关掉（enabled=true 时传 false）");
});

test("语义搜索没准备好时入口是禁用的（避免点了没反应）", () => {
    const log = render({
        query: "示例",
        semantic: {
            enabled: false,
            ready: false,
            reason: "还没建索引",
            onToggle: v => log.semantic.push(v),
        },
    });
    const toggle = document.querySelector<HTMLElement>('[aria-label="语义搜索"]');
    assert.ok(toggle);
    assert.equal(
        toggle!.hasAttribute("disabled"),
        true,
        `ready 为假时不该可点（reason：还没建索引）`
    );
    assert.equal(toggle!.getAttribute("aria-pressed"), "false");
});
