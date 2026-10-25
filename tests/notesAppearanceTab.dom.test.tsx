// tests/notesAppearanceTab.dom.test.tsx
// 记事本设置·外观页（2026-10-25「笔记美化」新增「列表样式」三档后补的第一份用例）。
//
// 盯三件事 —— 任何一件断了，用户在设置里点了没反应，而组件本身一声不响：
//   1. 三档（无线 / 分隔线 / 卡片）真的都在；
//   2. 点哪档就回调哪档（dataKey 写错的话值进不了 settings）；
//   3. 受控值真的跟着高亮（否则用户看不出当前是哪一档）。
//
// 之所以直接渲染这个 tab 而不是整个设置弹窗：它是纯受控组件
// （值全在父级的 settings 里，自己只发 onChange），
// 单个 tab 的用例足够钉住这三条，也不必拖进弹窗的懒加载与主题上下文。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import NotesAppearanceTab from "../src/components/notes/NotesAppearanceTab";
import { DEFAULT_NOTES_SETTINGS, type NotesUiSettings } from "../src/utils/notesSettings";

function renderTab(over: Partial<NotesUiSettings> = {}) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const calls: Array<{ key: string; value: unknown }> = [];
    const settings: NotesUiSettings = { ...DEFAULT_NOTES_SETTINGS, ...over };
    const set = <K extends keyof NotesUiSettings>(key: K, value: NotesUiSettings[K]) => {
        calls.push({ key: String(key), value });
    };
    act(() => {
        root.render(<NotesAppearanceTab settings={settings} set={set} />);
    });
    return { host, calls, root };
}

test("列表样式：三档都在，默认档是「分隔线」", () => {
    const { host } = renderTab();
    for (const v of ["plain", "divider", "card"]) {
        assert.ok(
            host.querySelector(`[data-setting="listStyle:${v}"]`),
            `「${v}」档必须能点到 —— 少了它这一档就是死设置`
        );
    }
    assert.equal(
        DEFAULT_NOTES_SETTINGS.listStyle,
        "divider",
        "默认「分隔线」：变化最小、长列表的扫描性提升最明显"
    );
});

test("列表样式：点「卡片」回调 listStyle=card（dataKey 不能写错）", () => {
    const { host, calls } = renderTab();
    const card = host.querySelector('[data-setting="listStyle:card"]') as HTMLElement;
    assert.ok(card);
    act(() => {
        card.click();
    });
    assert.deepEqual(calls, [{ key: "listStyle", value: "card" }]);
});

test("列表样式：受控 —— 高亮跟着 settings 走（不是自己存状态）", () => {
    // ⚠️ 不能读 el.style：MUI 的 sx 走 emotion，样式在 <style> 里、元素上只有 class。
    // 用「同一档位在不同 settings 下的 class 是否互换」来验证受控性：
    // 传 card 时 card 该是「选中样式」、plain 是「未选中样式」；传 plain 时反过来。
    const cardFirst = renderTab({ listStyle: "card" });
    const cardActive = cardFirst.host.querySelector('[data-setting="listStyle:card"]')!.className;
    const plainIdle = cardFirst.host.querySelector('[data-setting="listStyle:plain"]')!.className;
    assert.notEqual(cardActive, plainIdle, "选中档与未选中档必须有不同样式（否则用户看不出当前是哪档）");

    const plainFirst = renderTab({ listStyle: "plain" });
    const cardIdle = plainFirst.host.querySelector('[data-setting="listStyle:card"]')!.className;
    const plainActive = plainFirst.host.querySelector('[data-setting="listStyle:plain"]')!.className;
    assert.equal(cardIdle, plainIdle, "未选中样式应稳定复用");
    assert.equal(plainActive, cardActive, "选中样式应稳定复用（说明高亮真的跟着 settings 走）");
});

test("外观页其它项没被这次改动碰掉（回归：内容宽度四档仍在）", () => {
    const { host } = renderTab();
    for (const v of ["narrow", "standard", "wide", "full"]) {
        assert.ok(host.querySelector(`[data-setting="contentWidth:${v}"]`), `内容宽度缺了「${v}」档`);
    }
    assert.ok(host.querySelector("[data-settings-preview='1']"), "效果预览块必须留着");
});
