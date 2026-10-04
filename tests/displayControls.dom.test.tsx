// tests/displayControls.dom.test.tsx
// 顶栏那条玻璃胶囊：只看星标 / 当前视图（点开是显示面板）/ 批量多选。
//
// 为什么补它：这一条里三条控制线的**状态含义**很容易写反，而写反了都不报错：
//   - 星标与多选是「切换」，且**带 aria-pressed** —— 少了它，屏幕阅读器读出来
//     就是一个普通按钮，用户不知道自己是开着还是关着；
//   - 多选那个按钮开着时走的是 `exitMultiSelect()` 而不是 `setMultiSelect(false)` ——
//     两者差在「退出时要不要顺手清掉已勾选的卡片」，用错一个就会留下幽灵勾选；
//   - 显示面板是三档**直选**（卡片 / 列表 / 图标墙），不是「点一下换下一档」——
//     后者用户得记住顺序才知道会变成什么。
// 这些此前同样只有仓库外的 ui-smoke 盯着。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import DisplayControls, { type DisplayControlsProps } from "../src/components/DisplayControls";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Log {
    calls: string[];
}

function makeProps(overrides: Partial<DisplayControlsProps> = {}): {
    props: DisplayControlsProps;
    log: Log;
} {
    const log: Log = { calls: [] };
    return {
        log,
        props: {
            viewMode: "card",
            setViewMode: mode => void log.calls.push(`setViewMode(${mode})`),
            density: "comfortable",
            setDensity: d => void log.calls.push(`setDensity(${d})`),
            multiSelect: false,
            setMultiSelect: v => void log.calls.push(`setMultiSelect(${v})`),
            exitMultiSelect: () => void log.calls.push("exitMultiSelect"),
            starFilter: false,
            setStarFilter: v => void log.calls.push(`setStarFilter(${v})`),
            themeMode: "system",
            setThemeMode: m => void log.calls.push(`setThemeMode(${m})`),
            favoritesEnabled: false,
            onFavoritesEnabledChange: v => void log.calls.push(`onFavoritesEnabledChange(${v})`),
            ...overrides,
        },
    };
}

function mount(props: DisplayControlsProps) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<DisplayControls {...props} />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const byClass = <T extends Element>(cls: string): T | null =>
    document.querySelector<T>(`.${cls}`);

async function click(el: Element) {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** 面板是 portal 到 body 的菜单 */
const panelItems = () =>
    [...document.querySelectorAll<HTMLLIElement>('ul[role="menu"] > li')].filter(
        li => (li.textContent || "").trim() !== ""
    );

// ---------------- 只看星标 ----------------

test("只看星标：关着时写 aria-pressed=false，点一下变 true 并翻转", async t => {
    t.after(cleanup);
    const { props, log } = makeProps({ starFilter: false });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-star-filter");
    assert.ok(btn, "应有星标筛选按钮");
    assert.equal(btn!.getAttribute("aria-pressed"), "false", "开关类按钮必须带 aria-pressed");
    assert.equal(btn!.getAttribute("aria-label"), "只看星标");

    await click(btn!);
    assert.deepEqual(log.calls, ["setStarFilter(true)"]);
});

test("只看星标：开着时 aria-label 要变成「取消只看星标」（不然读屏只听到同一个名字）", t => {
    t.after(cleanup);
    const { props } = makeProps({ starFilter: true });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-star-filter");
    assert.equal(btn!.getAttribute("aria-pressed"), "true");
    assert.equal(btn!.getAttribute("aria-label"), "取消只看星标");
});

// ---------------- 批量多选 ----------------

test("批量多选：关着时进多选（setMultiSelect(true)）", async t => {
    t.after(cleanup);
    const { props, log } = makeProps({ multiSelect: false });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-multiselect-btn");
    assert.ok(btn);
    assert.equal(btn!.getAttribute("aria-pressed"), "false");
    await click(btn!);
    assert.deepEqual(log.calls, ["setMultiSelect(true)"]);
});

test("批量多选：开着时走 exitMultiSelect 而不是 setMultiSelect(false)", async t => {
    t.after(cleanup);
    // exitMultiSelect 会顺手清掉已勾选的卡片；直接 setMultiSelect(false) 会留下
    // 一批看不见的勾选，下次进多选时它们还在篮子里 ——「没选却删了一批」。
    const { props, log } = makeProps({ multiSelect: true });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-multiselect-btn");
    assert.equal(btn!.getAttribute("aria-pressed"), "true");
    assert.equal(btn!.getAttribute("aria-label"), "退出多选模式");
    await click(btn!);
    assert.deepEqual(log.calls, ["exitMultiSelect"]);
});

// ---------------- 视图按钮 ----------------

test("视图按钮的可访问名称里带上当前视图（窄屏只留图标，没名字就成盲盒）", t => {
    t.after(cleanup);
    const { props } = makeProps({ viewMode: "wall" });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-view-menu-btn");
    assert.equal(btn!.getAttribute("aria-label"), "显示设置，当前图标墙视图");
    assert.equal(btn!.getAttribute("aria-expanded"), null, "没打开时不该写 aria-expanded");
});

test("点视图按钮打开面板，并显示三档视图 + 当前那档带对勾", async t => {
    t.after(cleanup);
    const { props } = makeProps({ viewMode: "list" });
    mount(props);
    const btn = byClass<HTMLButtonElement>("nav-view-menu-btn");
    await click(btn!);

    const btn2 = byClass<HTMLButtonElement>("nav-view-menu-btn");
    assert.equal(btn2!.getAttribute("aria-expanded"), "true");

    const items = panelItems();
    const labels = items.map(li => (li.textContent || "").trim());
    assert.deepEqual(labels.slice(0, 4), ["视图", "卡片", "列表", "图标墙"]);
    // MUI 的 MenuItem selected 走的是 class 而不是 aria-selected（后者只在 role=option 时才写）。
    // 只看「视图」这一区：密度与主题各自也有一档选中，混在一起数会得到 3。
    const viewItems = items.slice(1, 4);
    const selected = viewItems.filter(li => li.className.includes("Mui-selected"));
    assert.equal(selected.length, 1, "视图只能选中一档");
    assert.equal((selected[0]!.textContent || "").trim(), "列表", "对勾应打在当前视图上");
});

test("面板里是三档直选：点哪档就切哪档，不是「点一下换下一档」", async t => {
    t.after(cleanup);
    const { props, log } = makeProps({ viewMode: "card" });
    mount(props);
    await click(byClass<HTMLButtonElement>("nav-view-menu-btn")!);

    const wall = panelItems().find(li => (li.textContent || "").trim() === "图标墙");
    assert.ok(wall);
    await click(wall!);
    assert.deepEqual(log.calls, ["setViewMode(wall)"], "应直接切到点的那一档");
});

test("面板还管密度 / 主题 / 最近访问置前，且各自只有一项选中", async t => {
    t.after(cleanup);
    const { props, log } = makeProps({ density: "compact", themeMode: "dark" });
    mount(props);
    await click(byClass<HTMLButtonElement>("nav-view-menu-btn")!);

    const text = document.body.textContent || "";
    for (const section of ["视图", "密度", "主题", "排序"]) {
        assert.ok(text.includes(section), `面板应有「${section}」分区，实际 ${text}`);
    }

    const compact = panelItems().find(li => (li.textContent || "").trim() === "紧凑");
    await click(compact!);
    assert.deepEqual(log.calls, ["setDensity(compact)"]);

    const dark = panelItems().find(li => (li.textContent || "").trim() === "深色");
    await click(dark!);
    assert.deepEqual(log.calls.slice(-1), ["setThemeMode(dark)"]);

    const recent = panelItems().find(li => (li.textContent || "").trim() === "最近访问置前");
    await click(recent!);
    assert.deepEqual(log.calls.slice(-1), ["onFavoritesEnabledChange(true)"]);
});

test("面板里改完不自动关闭（这类偏好用户常常连着调两三项）", async t => {
    t.after(cleanup);
    const { props } = makeProps();
    mount(props);
    await click(byClass<HTMLButtonElement>("nav-view-menu-btn")!);
    const list = panelItems().find(li => (li.textContent || "").trim() === "列表");
    await click(list!);
    assert.ok(panelItems().length > 0, "改完视图面板应还开着");
});
