// tests/groupCard.dom.test.tsx
// GroupCard 831 行，和 SiteCard 一样之前零覆盖。这里盯的是几条「用户肉眼可见、
// 但改代码时最容易改坏」的行为：星标卡片提前、排序模式下不重排、虚拟分组不给
// 增删改入口、收起状态落本机、空分组引导、多选时的全选本组。
//
// 两点环境注意事项：
//   1. 启动脚本给 jsdom 补的 IntersectionObserver 是「永不触发」的替身，
//      正好用来测懒挂载（视口外不建卡片）；要让它挂上就得手动触发回调。
//   2. 挂载走的是 requestAnimationFrame 分帧队列，触发后要等几帧才真的 setState。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import GroupCard from "../src/components/GroupCard";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Site } from "../src/API/http";
import type { GroupWithSites } from "../src/types";
import { COLLAPSED_GROUPS_KEY } from "../src/utils/collapse";

// DOM 用例的启动脚本补了 window / document，但没挂 localStorage ——
// 组件里是直接写 `localStorage.getItem` 的（星标、收起状态都在这儿）。
if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

// ── IntersectionObserver 替身：手动放行 ──
// 默认一个都不触发，用来断言「还没进视口就不建卡片」；需要时统一放行一次。
type IOCallback = (entries: Array<{ isIntersecting: boolean }>, observer: unknown) => void;
let ioCallbacks: IOCallback[] = [];
class ManualIntersectionObserver {
    constructor(cb: IOCallback) {
        ioCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return [];
    }
}
Object.defineProperty(globalThis, "IntersectionObserver", {
    value: ManualIntersectionObserver,
    configurable: true,
    writable: true,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeSite(id: number, name: string): Site {
    return {
        id,
        group_id: 1,
        name,
        url: `https://example.com/${id}`,
        icon: "",
        description: "",
        notes: "",
        order_num: id,
    };
}

function makeGroup(over: Partial<GroupWithSites> = {}): GroupWithSites {
    return {
        id: 1,
        name: "常用工具",
        order_num: 0,
        sites: [makeSite(1, "甲站点"), makeSite(2, "星标站点"), makeSite(3, "丙站点")],
        ...over,
    };
}

type RenderOpts = {
    group?: GroupWithSites;
    sortMode?: "None" | "GroupSort" | "SiteSort";
    currentSortingGroupId?: number | null;
    searchQuery?: string;
    selectMode?: boolean;
    selectedIds?: number[];
    onToggleSelect?: (id: number) => void;
    onAddSite?: (groupId: number) => void;
    prefs?: Record<string, string>;
};

function renderCard(opts: RenderOpts = {}) {
    localStorage.clear();
    ioCallbacks = [];
    for (const [k, v] of Object.entries(opts.prefs ?? {})) localStorage.setItem(k, v);
    const group = opts.group ?? makeGroup();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <GroupCard
                    group={group}
                    sortMode={opts.sortMode ?? "None"}
                    currentSortingGroupId={opts.currentSortingGroupId ?? null}
                    onUpdate={() => {}}
                    onDelete={() => {}}
                    onSaveSiteOrder={() => {}}
                    onStartSiteSort={() => {}}
                    onAddSite={opts.onAddSite}
                    onUpdateGroup={() => {}}
                    onDeleteGroup={() => {}}
                    searchQuery={opts.searchQuery ?? ""}
                    selectMode={opts.selectMode ?? false}
                    selectedIds={opts.selectedIds ?? []}
                    onToggleSelect={opts.onToggleSelect}
                />
            </UIPrefsProvider>
        );
    });
    return group;
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 让所有待观察的元素进入视口，并等分帧挂载队列走完 */
async function enterViewport() {
    await act(async () => {
        const pending = ioCallbacks;
        ioCallbacks = [];
        for (const cb of pending) cb([{ isIntersecting: true }], null);
        // 挂载走 requestAnimationFrame 队列，每帧放行一个，多等几帧稳一点
        for (let i = 0; i < 5; i++) {
            await new Promise<void>(r => setTimeout(r, 20));
        }
    });
}

const byLabel = (label: string) =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const byText = (text: string) =>
    [...document.querySelectorAll("button")].find(b =>
        (b.textContent ?? "").includes(text)
    );
/** 页面上卡片的先后顺序（按卡片名去匹配，避开图标/描述里的同名文本） */
function cardOrder(): string[] {
    return [...document.querySelectorAll("[data-nav-card='true']")].map(el =>
        (el.textContent ?? "").trim()
    );
}

test.afterEach(cleanup);

test("分组标题与站点数渲染出来，视口外的卡片先不建", async () => {
    renderCard();
    assert.match(document.body.textContent ?? "", /常用工具/);
    assert.match(document.body.textContent ?? "", /\(3\)/);
    assert.ok(
        document.querySelector("[data-group-anchor='1']"),
        "缺少分组锚点（滚动定位靠它）"
    );
    // 懒挂载：还没进视口时只有占位高度，一张卡片都不建
    assert.equal(cardOrder().length, 0, "没进视口就建了卡片，懒挂载没生效");

    await enterViewport();
    assert.equal(cardOrder().length, 3, "进入视口后应该补齐 3 张卡片");
});

test("加了星标的卡片排到分组最前面", async () => {
    renderCard({ prefs: { "navihive:starred": JSON.stringify([2]) } });
    await enterViewport();

    const order = cardOrder();
    assert.equal(order.length, 3);
    const starIdx = order.findIndex(t => t.includes("星标站点"));
    const firstIdx = order.findIndex(t => t.includes("甲站点"));
    assert.ok(starIdx >= 0 && firstIdx >= 0, "卡片没有全部渲染出来");
    assert.ok(starIdx < firstIdx, "星标卡片没有排到最前面");
});

test("排序模式下保持原顺序，不把星标提前", async () => {
    // 拖拽中重排会让落点跟着漂移，所以排序模式一律用原顺序。
    // 传 GroupSort：非 None 会跳过懒挂载直接全量渲染，同时不会命中「编辑中分组」分支
    renderCard({
        sortMode: "GroupSort",
        prefs: { "navihive:starred": JSON.stringify([2]) },
    });
    await enterViewport();

    const order = cardOrder();
    assert.equal(order.length, 3);
    assert.deepEqual(
        order.map(t => (t.includes("甲站点") ? 1 : t.includes("星标站点") ? 2 : 3)),
        [1, 2, 3],
        "排序模式下不该重排星标"
    );
});

test("「最近访问」虚拟分组只给一键清空，不给增删改", () => {
    renderCard({
        group: makeGroup({ id: -1, name: "最近访问", sites: [makeSite(1, "甲站点")] }),
        prefs: { "navihive:visits": JSON.stringify({ "1": { count: 2, last: 1 } }) },
    });

    assert.equal(byText("添加卡片"), undefined, "虚拟分组不该有添加入口");
    assert.equal(byText("排序"), undefined, "虚拟分组不该有排序入口");

    const clear = byText("清空");
    assert.ok(clear, "「最近访问」应该有一键清空");
    act(() => {
        clear!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.equal(
        localStorage.getItem("navihive:visits"),
        null,
        "清空后本机访问统计应该被删掉"
    );
});

test("负 id 的虚拟分组一律不给管理入口（避免写到不存在的 group_id）", () => {
    // 用 -2 而不是「最近访问」的 -1：-1 会被「清空」分支接管，
    // 光测它验证不到 canManageGroup，改坏了也照样通过。
    renderCard({
        group: makeGroup({ id: -2, name: "虚拟分组", sites: [makeSite(1, "甲站点")] }),
        onAddSite: () => {},
    });

    assert.equal(byText("添加卡片"), undefined, "虚拟分组不该有添加入口");
    assert.equal(byText("排序"), undefined, "虚拟分组不该有排序入口");
    assert.equal(byLabel("编辑分组"), null, "虚拟分组不该有编辑入口");
    assert.equal(byText("清空"), undefined, "清空是「最近访问」专属");
});

test("收起状态读本机，点按钮写回本机", () => {
    renderCard({ prefs: { [COLLAPSED_GROUPS_KEY]: JSON.stringify(["1"]) } });
    const toggle = byLabel("展开分组");
    assert.ok(toggle, "本机记着收起，按钮应该是「展开分组」");
    assert.equal(toggle?.getAttribute("aria-expanded"), "false");

    act(() => {
        toggle!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(
        JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? "null"),
        [],
        "展开后应该把分组从收起名单里去掉"
    );
    assert.ok(byLabel("收起分组"), "展开后按钮应该变回「收起分组」");
});

test("空分组给引导入口，搜索没命中时不给", () => {
    // 用 GroupSort 跳过懒挂载，直接看空状态
    const added: number[] = [];
    renderCard({
        group: makeGroup({ sites: [] }),
        sortMode: "GroupSort",
        onAddSite: id => added.push(id),
    });
    assert.match(document.body.textContent ?? "", /这个分组还没有卡片/);
    const add = document.querySelector<HTMLElement>(".nav-empty-add-site");
    assert.ok(add, "空分组应该直接给一个添加入口");
    act(() => {
        add!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(added, [1], "空分组的添加入口应该带上分组 id");

    cleanup();
    renderCard({ group: makeGroup({ sites: [] }), sortMode: "GroupSort", searchQuery: "xyz" });
    assert.match(document.body.textContent ?? "", /本组没有匹配的网站/);
    assert.equal(
        document.querySelector(".nav-empty-add-site"),
        null,
        "搜索无结果时不该再诱导添加卡片"
    );
});

test("多选模式下「全选本组」整组勾选，再点是取消", async () => {
    const picked: number[] = [];
    renderCard({ selectMode: true, onToggleSelect: id => picked.push(id) });
    await enterViewport();

    const selectAll = document.querySelector<HTMLElement>(".nav-select-group-btn");
    assert.ok(selectAll, "多选模式下应该有「全选本组」");
    assert.match(selectAll!.textContent ?? "", /全选本组/);
    act(() => {
        selectAll!.dispatchEvent(
            new window.MouseEvent("click", { bubbles: true, cancelable: true })
        );
    });
    assert.deepEqual(picked, [1, 2, 3], "全选应该把本组卡片都勾上");

    cleanup();
    const unpicked: number[] = [];
    renderCard({
        selectMode: true,
        selectedIds: [1, 2, 3],
        onToggleSelect: id => unpicked.push(id),
    });
    await enterViewport();
    const cancel = document.querySelector<HTMLElement>(".nav-select-group-btn");
    assert.match(cancel?.textContent ?? "", /取消本组/, "全选后按钮应该变成「取消本组」");
    act(() => {
        cancel!.dispatchEvent(
            new window.MouseEvent("click", { bubbles: true, cancelable: true })
        );
    });
    assert.deepEqual(unpicked, [1, 2, 3], "再点一次应该整组取消");
});
