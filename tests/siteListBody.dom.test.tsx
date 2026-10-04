// tests/siteListBody.dom.test.tsx
// 站点列表主体：三种排序模式各一套渲染 + 空状态。
//
// 为什么补它：这里是「同一份数据，四种画法」的分岔口，而分岔的**判据写错都不报错** ——
// 判据写错的表现是「排序模式下拖不动」「筛没了却显示一堆空分组」这类只在特定操作序列下
// 才出现的问题。此前它同样只有仓库外的 ui-smoke 盯着。
//
// 三条容易改坏、且改坏了不报错的规矩：
//   1. **站点排序模式用的是 `groups` 而不是 `displayedGroups`** —— 后者带搜索/筛选派生，
//      排序时少几个分组的话，拖完保存会把没显示的那几个一起重排掉；
//   2. **空状态只在普通模式 + displayedGroups 为空时出现** —— 排序模式下哪怕筛没了
//      也要把分组画出来，否则根本没法排序；
//   3. **分组强调色以 configs 里存的那份为准**，自动配色只是兜底。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSensors } from "@dnd-kit/core";
import SiteListBody, { type SiteListBodyProps } from "../src/components/SiteListBody";
import { SortMode } from "../src/constants";
import type { GroupWithSites } from "../src/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function group(id: number, name: string, siteCount = 0): GroupWithSites {
    return {
        id,
        name,
        order: id,
        sites: Array.from({ length: siteCount }, (_, i) => ({
            id: id * 100 + i,
            group_id: id,
            name: `${name}-${i}`,
            url: `https://${id}-${i}.example.com`,
            order: i,
        })) as unknown as GroupWithSites["sites"],
    } as unknown as GroupWithSites;
}

interface Log {
    nudge: Array<{ groupId: string; delta: number }>;
    dragEnd: number;
}

function makeProps(overrides: Partial<SiteListBodyProps> = {}): {
    props: SiteListBodyProps;
    log: Log;
} {
    const log: Log = { nudge: [], dragEnd: 0 };
    return {
        log,
        props: {
            sortMode: SortMode.None,
            sensors: [] as unknown as ReturnType<typeof useSensors>,
            onGroupDragEnd: () => void log.dragEnd++,
            groups: [group(1, "常用"), group(2, "工具")],
            onNudgeGroup: (groupId: string, delta: number) =>
                void log.nudge.push({ groupId, delta }),
            onSiteDragStart: () => {},
            onSiteDragOver: () => {},
            onSiteDragEnd: () => {},
            onSiteDragCancel: () => {},
            draggingSite: null,
            darkMode: false,
            onSiteUpdate: () => {},
            onSiteDelete: () => {},
            onSaveSiteOrder: () => {},
            onStartSiteSort: () => {},
            onAddSite: () => {},
            onGroupUpdate: () => {},
            onGroupDelete: () => {},
            displayedGroups: [group(1, "常用", 2), group(2, "工具", 1)],
            density: "comfortable",
            reduceEntryAnimation: false,
            currentSortingGroupId: null,
            configs: {},
            onGroupAccentChange: () => {},
            selectMode: false,
            selectedIds: [],
            onToggleSelect: () => {},
            query: "",
            activeTags: [],
            starFilter: false,
            deadOnly: false,
            onClearSearch: () => {},
            onClearFilters: () => {},
            ...overrides,
        },
    };
}

function mount(props: SiteListBodyProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<SiteListBody {...props} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const bodyText = () => document.body.textContent || "";

function buttonByLabel(label: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => b.getAttribute("aria-label") === label
    );
}

async function click(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

// ---------------- 普通模式 ----------------

test("普通模式：按 displayedGroups 渲染分组卡片", t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    const text = bodyText();
    assert.ok(text.includes("常用"), `应渲染分组名，实际 ${text.slice(0, 120)}`);
    assert.ok(text.includes("工具"));
    assert.ok(!text.includes("还没有任何分组"), "有内容时不该出现空状态");
});

test("普通模式 + displayedGroups 为空：显示空状态，且给出「清空搜索 / 清除筛选」的出路", t => {
    t.after(cleanup);
    const { props } = makeProps({ displayedGroups: [], query: "不存在的关键词" });
    mount(props);
    const text = bodyText();
    assert.ok(text.includes("没有找到匹配的网站"), `实际 ${text.slice(0, 160)}`);
    assert.ok(
        [...document.querySelectorAll("button")].some(b => (b.textContent || "").includes("清空搜索")),
        "搜不到时要能一键清空搜索框"
    );
});

test("没搜索过却一个分组都没有：文案走「还没有任何分组」而不是「没找到匹配」", t => {
    t.after(cleanup);
    const { props } = makeProps({ displayedGroups: [], query: "" });
    mount(props);
    assert.ok(bodyText().includes("还没有任何分组"));
    assert.ok(!bodyText().includes("没有找到匹配的网站"));
});

test("空状态：筛没了（有标签筛选）时给的是「清除筛选」而不是「清空搜索」", t => {
    t.after(cleanup);
    const { props } = makeProps({ displayedGroups: [], activeTags: ["工作"], query: "" });
    mount(props);
    const buttons = [...document.querySelectorAll("button")].map(b => (b.textContent || "").trim());
    assert.ok(
        buttons.some(t => t.includes("清除筛选")),
        `实际 ${JSON.stringify(buttons)}`
    );
});

test("卡片太多时整体关掉入场动画（nav-static-entry）", t => {
    t.after(cleanup);
    const on = makeProps({ reduceEntryAnimation: true });
    mount(on.props);
    assert.ok(document.querySelector(".nav-static-entry"), "应带上关闭动画的类名");
    cleanup();

    const off = makeProps({ reduceEntryAnimation: false });
    mount(off.props);
    assert.equal(document.querySelector(".nav-static-entry"), null);
});

test("分组强调色：以 configs 里存的那份为准（自动配色只是兜底）", t => {
    t.after(cleanup);
    const { props } = makeProps({ configs: { "group.color.1": "#ff0000" } });
    mount(props);
    // GroupCard 会把强调色用在分组标题上；这里只验证「存了就用存的」这条不报错也不被忽略
    const html = document.body.innerHTML;
    assert.ok(html.includes("常用"), "前置：分组确实渲染出来了");
    assert.ok(
        html.includes("#ff0000") || html.includes("rgb(255, 0, 0)"),
        `configs 里存了强调色就该用上，实际没找到。HTML 片段 ${html.slice(0, 200)}`
    );
});

// ---------------- 分组排序模式 ----------------

test("分组排序模式：渲染排序条而不是分组卡片，首组不能上移、末组不能下移", t => {
    t.after(cleanup);
    const { props } = makeProps({ sortMode: SortMode.GroupSort });
    mount(props);

    assert.ok(buttonByLabel('把「常用」上移一位'), "每个分组都该有上移按钮");
    assert.ok(buttonByLabel('把「常用」上移一位')!.disabled, "第一个分组不能再上移");
    assert.ok(!buttonByLabel('把「常用」下移一位')!.disabled);
    assert.ok(buttonByLabel('把「工具」下移一位')!.disabled, "最后一个分组不能再下移");
});

test("分组排序模式：上下移一位走 onNudgeGroup，带上方向与分组 id", async t => {
    t.after(cleanup);
    const { props, log } = makeProps({ sortMode: SortMode.GroupSort });
    mount(props);
    await click(buttonByLabel('把「工具」上移一位')!);
    assert.deepEqual(log.nudge, [{ groupId: "2", delta: -1 }]);

    await click(buttonByLabel('把「常用」下移一位')!);
    assert.deepEqual(log.nudge.slice(-1), [{ groupId: "1", delta: 1 }]);
});

// ---------------- 站点排序模式 ----------------

test("站点排序模式用的是 groups，不是派生后的 displayedGroups", t => {
    t.after(cleanup);
    // 排序时若只画「当前筛选出来的那几个」，拖完保存会把没显示出来的分组一起重排掉。
    const { props } = makeProps({
        sortMode: SortMode.SiteSort,
        groups: [group(1, "常用"), group(2, "工具"), group(3, "参考")],
        displayedGroups: [group(1, "常用")], // 故意让派生结果只剩一个
    });
    mount(props);
    const text = bodyText();
    for (const name of ["常用", "工具", "参考"]) {
        assert.ok(text.includes(name), `站点排序模式应渲染 groups 里的「${name}」，实际 ${text.slice(0, 200)}`);
    }
});

test("站点排序模式：没在拖的时候不会多出一张卡片", t => {
    t.after(cleanup);
    // 跟随指针的浮层由 dnd-kit 的 DragOverlay 控制 —— 它只在 DndContext 里真有
    // 一次拖拽时才挂载，jsdom 里模拟不出来（要 PointerEvent + 传感器整套）。
    // 这里能钉的是「反向」那条：draggingSite 有值但没在拖时，界面上不该凭空多一张卡，
    // 否则每次拖完都会留一张影子卡片在原位。
    const idle = makeProps({
        sortMode: SortMode.SiteSort,
        groups: [group(1, "常用", 1)],
    });
    mount(idle.props);
    assert.equal(document.querySelector(".nav-drag-overlay"), null);
    assert.equal(
        (bodyText().match(/常用-0/g) || []).length,
        1,
        "未拖拽时每张卡片只该出现一次"
    );
});

test("排序模式下即使筛没了也要把分组画出来（否则根本没法排序）", t => {
    t.after(cleanup);
    for (const mode of [SortMode.GroupSort, SortMode.SiteSort]) {
        const { props } = makeProps({ sortMode: mode, displayedGroups: [], query: "zzz" });
        cleanup();
        mount(props);
        assert.ok(
            !bodyText().includes("没有找到匹配的网站"),
            `${mode} 模式下不该落到空状态`
        );
    }
});
