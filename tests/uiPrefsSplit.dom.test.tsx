// tests/uiPrefsSplit.dom.test.tsx
// 第四章第 4 项「状态渲染」的验收（审查报告原文）：
//   「拆分频繁变化的访问统计、标签、选择态 Context，避免大 Context 更新全页。」
//
// 盯的是这一条：**点一次卡片记一次访问，不该让跟访问次数无关的组件重渲染。**
// 访问统计是全站变化最频繁的状态（每点一次卡片一次），以前它和版式 / 密度 / 分组栏
// 收起状态挤在同一个 Context 里 —— Context 没有选择器，value 一变订阅者全体重来。
//
// 这里不数「重渲染了几次」以外的东西：渲染次数是唯一能直接观察 Context 订阅关系的量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
// Provider 之外的东西都住在 uiPrefsStore：那边现在是纯数据模块，不含组件
import {
    useUIPrefsPrefs,
    useUIPrefsStable,
    useUIPrefsVisits,
} from "../src/context/uiPrefsStore";

if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

let stableRenders = 0;
let prefsRenders = 0;
let visitsRenders = 0;
let mergedRenders = 0;

/** ① 只订阅设置项 + 写操作回调 */
function StableProbe() {
    const { viewMode, recordVisit, toggleStar } = useUIPrefsStable();
    stableRenders++;
    return (
        <>
            <button id='visit' onClick={() => recordVisit(1)}>
                {viewMode}
            </button>
            <button id='star' onClick={() => toggleStar(11)} />
        </>
    );
}

/** ② 只订阅星标 / 标签 / 死链 */
function PrefsProbe() {
    const { starred } = useUIPrefsPrefs();
    prefsRenders++;
    return <span id='starred'>{starred.length}</span>;
}

/** ③ 只订阅访问统计 */
function VisitsProbe() {
    const { visits } = useUIPrefsVisits();
    visitsRenders++;
    return <span id='visits'>{Object.keys(visits).length}</span>;
}

/** 合并版：订阅全部（App 用的就是这个） */
function MergedProbe() {
    const { visits } = useUIPrefsVisits();
    const { viewMode } = useUIPrefsStable();
    mergedRenders++;
    return <span id='merged'>{viewMode}:{Object.keys(visits).length}</span>;
}

function Harness() {
    const [, force] = useState(0);
    return (
        <>
            <StableProbe />
            <PrefsProbe />
            <VisitsProbe />
            <MergedProbe />
            <button id='force' onClick={() => force(n => n + 1)} />
        </>
    );
}

let container: HTMLDivElement;
let root: Root;

function mount() {
    stableRenders = 0;
    prefsRenders = 0;
    visitsRenders = 0;
    mergedRenders = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
        root.render(
            <UIPrefsProvider>
                <Harness />
            </UIPrefsProvider>
        );
    });
}

function click(id: string) {
    const el = container.querySelector<HTMLButtonElement>(`#${id}`);
    assert.ok(el, `找不到 #${id}`);
    act(() => {
        el!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
}

function unmount() {
    act(() => root.unmount());
    container.remove();
}

test("记一次访问：不订阅访问统计的组件一次都不重渲染", () => {
    mount();
    const base = { stable: stableRenders, prefs: prefsRenders, visits: visitsRenders };
    assert.ok(base.stable > 0 && base.prefs > 0 && base.visits > 0, "首次都该渲染过");

    // 连点三次卡片
    click("visit");
    click("visit");
    click("visit");

    assert.equal(
        stableRenders,
        base.stable,
        `只订阅「设置 + 写操作」的组件不该因为访问统计变化而重渲染（${base.stable} → ${stableRenders}）`
    );
    assert.equal(
        prefsRenders,
        base.prefs,
        `星标 / 标签那份也不该跟着动（${base.prefs} → ${prefsRenders}）`
    );
    assert.ok(
        visitsRenders > base.visits,
        "订阅了访问统计的那个必须看到变化（否则热度显示不会更新）"
    );
    assert.ok(mergedRenders > 0, "合并版照旧会跟着更新（App 需要它）");
    unmount();
});

test("写操作回调引用恒定：只调用它的组件不会因为别人写状态而重渲染", () => {
    mount();
    const before = stableRenders;
    // 触发的是 StableProbe 自己的 onClick，它拿 recordVisit 用的就是 stable 那份
    click("visit");
    assert.equal(
        stableRenders,
        before,
        "recordVisit 必须待在稳定那份里 —— 否则每张卡片点一下都会重渲染自己"
    );
    unmount();
});

test("星标变化只影响订阅 prefs 的那份（访问统计与设置订阅者都不动）", () => {
    mount();
    const before = { stable: stableRenders, prefs: prefsRenders, visits: visitsRenders };

    // toggleStar 放在稳定那份（引用恒定），但它改的是 prefs 那份的值
    click("star");

    assert.equal(visitsRenders, before.visits, "改星标不该动到访问统计的订阅者");
    assert.equal(stableRenders, before.stable, "改星标不该动到只订阅设置的组件");
    assert.ok(prefsRenders > before.prefs, "订阅星标的那份必须看到变化，否则星标不会亮");
    assert.equal(
        container.querySelector("#starred")?.textContent,
        "1",
        "星标真的加上了（不是只有渲染次数变了）"
    );
    unmount();
});
