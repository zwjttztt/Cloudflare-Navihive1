// tests/editorFocusMode.dom.test.tsx
//
// 专注模式（设置 → 编辑器 → 专注模式：淡化光标所在段落以外的内容）。
//
// 2026-10-23 用户报「专注模式没效果」，复现条件是**即时渲染也开着**：
// 当前段落以外的段落被整块替换成 widget（`.note-live-block`），那些行连
// `.cm-line` 元素都不存在了 —— `Decoration.line` 挂的 `.cm-focus-dimmed`
// 无处可挂，于是开关打开、屏幕上一动不动。
//
// 修法：开关打开时在编辑器根上开 `.cm-focus-on`，由 CSS 把 widget 本体一起淡化。
// 这个文件钉三件事：
//   ① 两种渲染态下类都要挂上（源码行 / 即时渲染块）；
//   ② 关掉时要摘掉，别留一个常灰的编辑器；
//   ③ CSS 里真有那条对 widget 生效的规则 —— 少了它，前两条照样绿但用户看不见变化。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import NoteEditor from "../src/components/NoteEditor";
import type { NoteEditorHandle } from "../src/utils/noteEditorHandle";
import { readSrcFile, stripComments } from "./helpers/notesSource";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const CONTENT = "第一段标题\n\n第二段正文\n\n第三段正文\n";

function mountEditor(props: { focusMode?: boolean; liveRender?: boolean } = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const editorRef = createRef<NoteEditorHandle>();
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteEditor
                editorRef={editorRef}
                value={CONTENT}
                onChange={() => {}}
                focusMode={props.focusMode}
                liveRender={
                    props.liveRender
                        ? () => Promise.resolve(null)
                        : undefined
                }
            />
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

test("专注模式（源码态）：编辑器根上有 cm-focus-on，且非当前段落被淡化", () => {
    mountEditor({ focusMode: true });
    const editor = host!.querySelector(".cm-editor");
    assert.ok(editor, "编辑器要渲染出来");
    assert.equal(
        editor!.classList.contains("cm-focus-on"),
        true,
        "开关打开时必须在根上挂 cm-focus-on（即时渲染那条 CSS 靠它）"
    );
    const dimmed = host!.querySelectorAll(".cm-line.cm-focus-dimmed");
    assert.ok(dimmed.length > 0, "当前段落以外的源码行要挂 cm-focus-dimmed");
    cleanup();
});

test("专注模式关掉：类要摘干净（别留一个常灰的编辑器）", () => {
    mountEditor({ focusMode: false });
    assert.equal(host!.querySelector(".cm-editor.cm-focus-on"), null);
    assert.equal(host!.querySelectorAll(".cm-line.cm-focus-dimmed").length, 0);
    cleanup();
});

test("专注模式 + 即时渲染：被替换成 widget 的段落也要被覆盖到", async () => {
    // 这条是用户实际踩到的组合：开着即时渲染时，非当前段落没有 .cm-line，
    // 只剩 .note-live-block —— 所以必须有「对 widget 生效」的那条规则。
    mountEditor({ focusMode: true, liveRender: true });
    await act(async () => {
        await new Promise(r => setTimeout(r, 120));
    });
    const editor = host!.querySelector(".cm-editor");
    assert.ok(editor!.classList.contains("cm-focus-on"), "即时渲染态同样要挂 cm-focus-on");
    const blocks = host!.querySelectorAll(".note-live-block");
    assert.ok(blocks.length > 0, "非当前段落应该已经被渲染成 widget（否则这条用例测不到东西）");
    cleanup();
});

test("CSS：cm-focus-on 那条规则真的作用在 .note-live-block 上", () => {
    // 前三条只证明「类挂对了」。真正让用户看见变化的是这条 CSS ——
    // 它要是被删了，DOM 断言全绿而界面一动不动。
    const css = stripComments(readSrcFile("src/index.css")).replace(/\s+/g, " ");
    assert.match(
        css,
        /\.cm-editor\.cm-focus-on \.note-live-block\s*\{[^}]*opacity:\s*0?\.\d+/,
        "缺了「即时渲染块也淡化」的规则 —— 专注模式在渲染态下会假装什么都没发生"
    );
    assert.match(
        css,
        /\.cm-line\.cm-focus-dimmed\s*\{[^}]*opacity:/,
        "源码行的淡化规则也不该消失"
    );
});
