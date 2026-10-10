// tests/editorSearch.dom.test.tsx
// N2 编辑器内查找/替换：接 @codemirror/search 后，⌘F / 「更多操作 → 查找/替换」
// 都能开面板，面板里有查找输入框、能高亮命中。
//
// 为什么补它：之前编辑器⌘F 走浏览器整页查找（markdownToReact 旧注释承认过），
// 长笔记里定位/改词很别扭。这是「接好扩展 + keymap 派发到 openSearchPanel」的回归钉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import NoteEditor from "../src/components/NoteEditor";
import type { NoteEditorHandle } from "../src/utils/noteEditorHandle";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mountEditor(value: string) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const editorRef = createRef<NoteEditorHandle>();
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteEditor editorRef={editorRef} value={value} onChange={() => {}} />
        );
    });
    return editorRef;
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

test("N2 查找面板：editorRef.openSearch() 打开 .cm-panel.cm-search 并带查找输入框", () => {
    const ref = mountEditor("hello world\nhello again\n");
    act(() => {
        ref.current?.focus();
        ref.current?.openSearch();
    });
    const panel = host!.querySelector(".cm-panel.cm-search");
    assert.ok(panel, "查找面板（.cm-panel.cm-search）应出现");
    const input = panel!.querySelector("input.cm-textfield");
    assert.ok(input, "查找输入框（input.cm-textfield）应出现");
    cleanup();
});

test("N2 查找面板：⌘F（Ctrl/Cmd+F）按键也能开面板", () => {
    const isMac = /mac|iphone|ipad|ipod/i.test(
        navigator.platform || navigator.userAgent || ""
    );
    const ref = mountEditor("alpha beta gamma\n");
    act(() => ref.current?.focus());
    const content = host!.querySelector(".cm-content") as HTMLElement | null;
    assert.ok(content, "编辑器内容区应挂载");
    act(() => {
        content!.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "f",
                code: "KeyF",
                ctrlKey: !isMac,
                metaKey: isMac,
                bubbles: true,
            })
        );
    });
    const panel = host!.querySelector(".cm-panel.cm-search");
    assert.ok(panel, "⌘F 应打开查找面板");
    cleanup();
});

test("N2 查找面板：输入查询词会高亮所有命中", () => {
    const ref = mountEditor("hello world\nhello again\nhello third\n");
    act(() => {
        ref.current?.focus();
        ref.current?.openSearch();
    });
    const input = host!.querySelector(
        ".cm-panel.cm-search input.cm-textfield"
    ) as HTMLInputElement | null;
    assert.ok(input, "查找输入框应存在");
    // ⚠️ CM 的查找输入框靠 onkeyup / onchange 提交（不是 oninput），
    // 所以这里设完值要派发一次 keyup 才会更新查询并高亮命中。
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, "hello");
        input!.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
    });
    const matches = host!.querySelectorAll(".cm-searchMatch");
    assert.ok(matches.length >= 3, `应高亮至少 3 处「hello」，实际 ${matches.length}`);
    cleanup();
});
