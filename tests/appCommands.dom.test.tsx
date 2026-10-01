// tests/appCommands.dom.test.tsx
// 命令面板的条目从 App 搬到 hooks/useAppCommands.ts 之后就能单测了。
// 这里盯的是「条目本身对不对」：站点命令带不带分组名、开关类命令的文案跟不跟着
// 状态变、按下去跑的是不是传进来的那个动作 —— 都是原来埋在 3700 行里没人验的部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppCommands, type AppCommandsInput } from "../src/hooks/useAppCommands";
import type { CommandItem } from "../src/components/CommandPalette";
import type { GroupWithSites } from "../src/types";

const site = (id: number, name: string, groupId: number) => ({
    id,
    group_id: groupId,
    name,
    url: `https://s${id}.com`,
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: 0,
});

const groups: GroupWithSites[] = [
    { id: 1, name: "常用工具", order_num: 0, sites: [site(11, "云设", 1)] },
    { id: 2, name: "开发", order_num: 1, sites: [site(21, "GitHub", 2)] },
];

type Calls = { viewMode: string[]; density: string[]; visits: number[]; undoRuns: number };

function fakeInput(calls: Calls, over: Partial<AppCommandsInput> = {}): AppCommandsInput {
    return {
        groups,
        setViewMode: mode => calls.viewMode.push(mode),
        density: "comfortable",
        setDensity: d => calls.density.push(d),
        toggleTheme: () => {},
        favoritesEnabled: false,
        setFavoritesEnabled: () => {},
        glassEffects: true,
        setGlassEffects: () => {},
        setOpenShortcuts: () => {},
        handleOpenAddGroup: () => {},
        startGroupSort: () => {},
        handleOpenConfig: () => {},
        setOpenAccount: () => {},
        fetchAccountList: () => {},
        handleOpenBackup: () => {},
        setBookmarkOpen: () => {},
        runLinkCheck: () => {},
        setOpenVisits: () => {},
        toggleCollapseAll: () => {},
        allGroupsCollapsed: false,
        multiSelect: false,
        setMultiSelect: () => {},
        exitMultiSelect: () => {},
        starFilter: false,
        setStarFilter: () => {},
        railCollapsed: false,
        setRailCollapsed: () => {},
        clearVisits: () => calls.visits.push(1),
        canUndo: true,
        runUndo: () => calls.undoRuns++,
        canRedo: false,
        runRedo: () => {},
        recordVisit: () => {},
        ...over,
    };
}

let latest: CommandItem[] = [];

function Probe({ input }: { input: AppCommandsInput }) {
    latest = useAppCommands(input);
    return null;
}

let container: HTMLDivElement;
let root: Root;

function render(input: AppCommandsInput) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root.render(<Probe input={input} />);
    });
}

function unmount() {
    act(() => root.unmount());
    container.remove();
}

const byId = (id: string) => latest.find(c => c.id === id);

test("站点命令：带分组名当副标题，两个分组的卡片都在", () => {
    const calls: Calls = { viewMode: [], density: [], visits: [], undoRuns: 0 };
    render(fakeInput(calls));

    const a = byId("cmd-site-1-11");
    const b = byId("cmd-site-2-21");
    assert.ok(a && b, "两个分组里的卡片都要有对应命令");
    assert.equal(a!.label, "云设");
    assert.equal(a!.hint, "常用工具", "副标题要告诉用户这张卡在哪个分组");
    assert.equal(a!.section, "打开网站");
    unmount();
});

test("开关类命令的文案跟着当前状态变（不是写死的「切换」）", () => {
    const calls: Calls = { viewMode: [], density: [], visits: [], undoRuns: 0 };
    render(fakeInput(calls, { density: "compact", multiSelect: true, starFilter: true }));

    assert.equal(byId("cmd-density")?.label, "切换到舒适密度", "已经是紧凑就该说切回舒适");
    assert.equal(byId("cmd-multiselect")?.label, "退出批量多选");
    assert.equal(byId("cmd-star-filter")?.label, "取消只看星标");
    unmount();
});

test("可撤销状态写进文案：没东西可撤销时不该还写着「撤销上一步」", () => {
    const calls: Calls = { viewMode: [], density: [], visits: [], undoRuns: 0 };
    render(fakeInput(calls, { canUndo: false, canRedo: false }));
    assert.match(byId("cmd-undo")?.label ?? "", /暂无可撤销/);
    assert.match(byId("cmd-redo")?.label ?? "", /暂无可重做/);
    unmount();
});

test("按下去跑的是传进来的那个动作（视图 / 清除访问记录）", () => {
    const calls: Calls = { viewMode: [], density: [], visits: [], undoRuns: 0 };
    render(fakeInput(calls));

    byId("cmd-view-wall")?.run();
    assert.deepEqual(calls.viewMode, ["wall"], "命令要真的调到 App 传进来的 setter");

    byId("cmd-clear-visits")?.run();
    assert.equal(calls.visits.length, 1, "「清除访问记录」要真的清");

    unmount();
});

test("站点命令有上限（几百张卡片不会把面板撑爆）", () => {
    const calls: Calls = { viewMode: [], density: [], visits: [], undoRuns: 0 };
    const many: GroupWithSites[] = [
        {
            id: 1,
            name: "大分组",
            order_num: 0,
            sites: Array.from({ length: 500 }, (_, i) => site(1000 + i, `站点${i}`, 1)),
        },
    ];
    render(fakeInput(calls, { groups: many }));

    const siteCommands = latest.filter(c => c.section === "打开网站");
    assert.ok(siteCommands.length > 0 && siteCommands.length <= 120, `站点命令应截断，实际 ${siteCommands.length} 条`);
    unmount();
});
