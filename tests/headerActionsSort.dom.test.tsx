// tests/headerActionsSort.dom.test.tsx
// 排序模式的「保存 / 取消编辑」工具条（2026-10-17 用户要求：从顶栏移到页面右侧，
// 滚动时固定跟随）。
//
// 钉三件事：
//   1. 非排序模式下整条不渲染（不该跟「新增 / 设置」抢位置）；
//   2. 两种排序模式都有工具条，保存按钮文案按模式区分（分组顺序 / 站点顺序）；
//   3. 点保存 / 取消分别回调对应 handler —— 拖了一屏幕终于保存下去，
//      结果回调接错了线，比不挪位置更糟。
// 位置本身（position:fixed、右缘居中）是 CSS，jsdom 里量不到，
// 由仓库外的浏览器实测把关；这里保证结构与行为正确。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import HeaderActions, { type HeaderActionsProps } from "../src/components/HeaderActions";
import { SortMode } from "../src/constants";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeProps(overrides: Partial<HeaderActionsProps> = {}): {
    props: HeaderActionsProps;
    log: string[];
} {
    const log: string[] = [];
    return {
        log,
        props: {
            sortMode: SortMode.None,
            onSaveGroupOrder: () => void log.push("onSaveGroupOrder"),
            onSaveSiteSort: () => void log.push("onSaveSiteSort"),
            onCancelSort: () => void log.push("onCancelSort"),
            onQuickAdd: () => void log.push("onQuickAdd"),
            onOpenAddGroup: () => void log.push("onOpenAddGroup"),
            onMenuOpen: () => void log.push("onMenuOpen"),
            onOpenNotes: () => void log.push("onOpenNotes"),
            notesCount: 0,
            menuOpen: false,
            menu: null,
            ...overrides,
        },
    };
}

function mount(props: HeaderActionsProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<HeaderActions {...props} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const dock = () => document.querySelector<HTMLElement>("[data-sort-dock='1']");

const buttonByText = (text: string): HTMLButtonElement | null => {
    const all = [...document.querySelectorAll<HTMLButtonElement>("button")];
    return all.find(b => (b.textContent || "").trim() === text) ?? null;
};

test("排序工具条：非排序模式下整条不渲染（不跟新增/设置抢位置）", () => {
    const { props } = makeProps();
    mount(props);
    assert.equal(dock(), null, "普通模式下没有工具条");
    assert.equal(buttonByText("保存"), null, "普通模式下没有保存按钮");
    assert.equal(buttonByText("取消编辑"), null, "普通模式下没有取消编辑按钮");
    cleanup();
});

test("排序工具条：站点排序有「保存 + 取消编辑」，各自回调接对线", async () => {
    const { props, log } = makeProps({ sortMode: SortMode.SiteSort });
    mount(props);

    assert.ok(dock(), "站点排序要渲染右侧工具条");
    assert.ok(buttonByText("保存"), "站点排序的保存按钮就叫「保存」");
    assert.ok(buttonByText("取消编辑"), "取消编辑两种模式都有");

    await act(async () => {
        buttonByText("保存")!.click();
        await Promise.resolve();
    });
    await act(async () => {
        buttonByText("取消编辑")!.click();
        await Promise.resolve();
    });
    assert.deepEqual(log, ["onSaveSiteSort", "onCancelSort"], "保存走站点排序、取消走取消");
    cleanup();
});

test("排序工具条：分组排序的保存按钮叫「保存分组顺序」", async () => {
    const { props, log } = makeProps({ sortMode: SortMode.GroupSort });
    mount(props);

    assert.ok(dock(), "分组排序也要有工具条");
    assert.ok(buttonByText("保存分组顺序"), "分组排序保存的是分组顺序，文案要说清");
    assert.equal(buttonByText("保存"), null, "不能同时出现两种保存文案");

    await act(async () => {
        buttonByText("保存分组顺序")!.click();
        await Promise.resolve();
    });
    assert.deepEqual(log, ["onSaveGroupOrder"]);
    cleanup();
});

test("排序工具条：两颗按钮都在工具条里（不让任何一颗漂回顶栏）", () => {
    const { props } = makeProps({ sortMode: SortMode.SiteSort });
    mount(props);
    const bar = dock();
    assert.ok(bar);
    assert.ok(bar!.contains(buttonByText("保存")), "保存按钮必须住在工具条里");
    assert.ok(bar!.contains(buttonByText("取消编辑")), "取消编辑按钮必须住在工具条里");
    cleanup();
});
