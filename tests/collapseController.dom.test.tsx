// tests/collapseController.dom.test.tsx
// 折叠域的 React 胶水层：hooks/useCollapseController。
//
// 为什么单独测它：utils/collapse 的纯读写与 isAllCollapsed 都有用例，但**中间这层没有**。
// 而这一层恰好是「点一下『全部折叠』到底发生了什么」的地方：
//   useState 初值（从 localStorage 读）→ toggleCollapseAll（写回并广播）→
//   事件监听（别处改了要跟着变）→ resetCollapsed（换账号时清空）
// 任何一环断掉的表现都是「按钮按了没反应」，纯函数用例一条都抓不到。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCollapseController } from "../src/hooks/useCollapseController";
import {
    COLLAPSED_EVENT,
    COLLAPSED_GROUPS_KEY,
    readCollapsedGroupIds,
} from "../src/utils/collapse";

type Collapse = ReturnType<typeof useCollapseController>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: Collapse | null = null;

/** 只为了把 hook 的返回值掏出来的空壳组件 */
function Probe({ groups }: { groups: { id?: number | string }[] }) {
    latest = useCollapseController(groups);
    return null;
}

const mount = (groups: { id?: number | string }[]) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Probe groups={groups} />);
    });
};

const cleanup = () => {
    if (root) {
        act(() => root!.unmount());
    }
    host?.remove();
    root = null;
    host = null;
    latest = null;
};

const GROUPS = [{ id: 1 }, { id: 2 }, { id: 3 }];

beforeEach(() => {
    localStorage.removeItem(COLLAPSED_GROUPS_KEY);
});
afterEach(cleanup);

test("初次挂载：折叠表从 localStorage 读初值，不是空着从头开始", () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["2"]));
    mount(GROUPS);
    assert.deepEqual(latest!.collapsedIds, ["2"]);
});

test("「全部折叠」：把所有真实分组写进本机，并让 allGroupsCollapsed 翻上来", () => {
    mount(GROUPS);
    assert.equal(latest!.allGroupsCollapsed, false);
    act(() => latest!.toggleCollapseAll());
    assert.deepEqual(readCollapsedGroupIds(), ["1", "2", "3"]);
    assert.equal(latest!.allGroupsCollapsed, true, "写完之后开关该显示「展开全部」");
});

test("还没保存的临时分组（id 为空）不参与全部折叠", () => {
    mount([{ id: 1 }, { id: undefined }, {}]);
    act(() => latest!.toggleCollapseAll());
    assert.deepEqual(readCollapsedGroupIds(), ["1"]);
});

test("再点一次「展开全部」：折叠表清空", () => {
    mount(GROUPS);
    act(() => latest!.toggleCollapseAll());
    act(() => latest!.toggleCollapseAll());
    assert.deepEqual(readCollapsedGroupIds(), []);
    assert.deepEqual(latest!.collapsedIds, []);
    assert.equal(latest!.allGroupsCollapsed, false);
});

// 这条盯的是那两个事件监听：GroupCard 自己改了 localStorage 之后，
// 顶栏的开关必须跟着变，否则按钮按下去像没反应。
test("别处改了本机折叠表并广播：这边跟着更新（storage / 自定义事件两条路）", () => {
    mount(GROUPS);
    assert.deepEqual(latest!.collapsedIds, []);

    // 本页写入：走自定义事件（storage 事件在同页面不会触发）
    act(() => {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["3"]));
        window.dispatchEvent(new Event(COLLAPSED_EVENT));
    });
    assert.deepEqual(latest!.collapsedIds, ["3"]);

    // 另一个标签页写入：走 storage 事件
    act(() => {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["1", "3"]));
        window.dispatchEvent(new Event("storage"));
    });
    assert.deepEqual(latest!.collapsedIds, ["1", "3"]);
});

test("换账号时的 resetCollapsed：state 与本机存储一起清空", () => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["1", "2"]));
    mount(GROUPS);
    assert.deepEqual(latest!.collapsedIds, ["1", "2"]);

    act(() => latest!.resetCollapsed());
    assert.deepEqual(latest!.collapsedIds, []);
    // 只清 state 不清本机的话，刷新一下旧账号的折叠状态又回来了
    assert.deepEqual(readCollapsedGroupIds(), []);
});

test("没有分组时 allGroupsCollapsed 为 false（开关不该显示成「已全部折叠」）", () => {
    mount([]);
    assert.equal(latest!.allGroupsCollapsed, false);
    act(() => latest!.toggleCollapseAll());
    assert.deepEqual(readCollapsedGroupIds(), []);
});
