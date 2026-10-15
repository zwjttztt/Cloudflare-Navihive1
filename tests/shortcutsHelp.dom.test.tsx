// tests/shortcutsHelp.dom.test.tsx
// 「帮助」弹窗（ShortcutsDialog）：快捷键表 + 安装到桌面入口。
//
// 2026-10-15 菜单瘦身时，「安装到桌面」从「更多选项」菜单并入这个弹窗 ——
// 它只有在浏览器真的给了安装事件时才出现（Chrome/Edge 用得够多才抛
// beforeinstallprompt），没给事件时弹窗底部不该留一个点了没反应的按钮。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ShortcutsDialog from "../src/components/ShortcutsDialog";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let anchor: HTMLButtonElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    anchor?.remove();
    root = null;
    host = null;
    anchor = null;
    document.body.innerHTML = "";
}

function mount(ui: ReactElement) {
    anchor = document.createElement("button");
    document.body.appendChild(anchor);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(ui));
}

const bodyText = () => document.body.textContent ?? "";
const buttons = () =>
    [...document.querySelectorAll<HTMLElement>("button")].map(b => (b.textContent || "").trim());

test("快捷键表齐全，标题是「帮助」", t => {
    t.after(cleanup);
    mount(<ShortcutsDialog open onClose={() => { }} />);
    assert.ok(bodyText().includes("帮助"), "标题应为「帮助」");
    assert.ok(bodyText().includes("聚焦搜索框"), "快捷键表应在");
    assert.ok(bodyText().includes("命令面板"), "Ctrl+K 那条应在");
});

test("浏览器给了安装事件：底部出现「安装到桌面」，点了真的触发安装", t => {
    t.after(cleanup);
    let installed = 0;
    mount(
        <ShortcutsDialog
            open
            onClose={() => { }}
            canInstall
            onInstallApp={() => {
                installed += 1;
            }}
        />
    );
    assert.ok(buttons().includes("安装到桌面"), `实际 ${JSON.stringify(buttons())}`);
    const btn = [...document.querySelectorAll<HTMLElement>("button")].find(
        b => (b.textContent || "").trim() === "安装到桌面"
    );
    act(() => {
        btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(installed, 1, "点了要真的调 onInstallApp");
});

test("没给安装事件：不出现「安装到桌面」（别放一个点了没反应的按钮）", t => {
    t.after(cleanup);
    mount(<ShortcutsDialog open onClose={() => { }} canInstall={false} onInstallApp={() => { }} />);
    assert.ok(!buttons().includes("安装到桌面"), `实际 ${JSON.stringify(buttons())}`);
    assert.ok(buttons().includes("知道了"), "关闭按钮照旧");
});
