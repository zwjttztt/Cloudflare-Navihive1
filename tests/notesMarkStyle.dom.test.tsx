// tests/notesMarkStyle.dom.test.tsx
// 「Markdown 结构记号」色的 DOM 级证据（2026-10-31，配套 tests/notesMarkColor.test.ts）。
//
// 静态守卫只能证明「源码里写了 var(--notes-mark)」和「顺序写对了」；这条用例把真的
// CodeMirror 编辑器挂起来，去读 CodeMirror 通过 StyleModule 注入到 <head> 的样式文本，
// 证明：
//   1. 那条规则**真的被注册进样式表**了（不是写了个没人用的常量）；
//   2. 它排在那条写死 #404740 的规则**之后** —— 这才是「生效」的充要条件：
//      两条规则的类名特异性相同（都是一个类），谁在样式表里靠后谁赢。
//
// ⚠️ 只断言样式文本，不断言 computed color：jsdom 不做布局、也不解析 var() 自定义属性，
//    读 getComputedStyle 会拿到空串 —— 那样写出来的「绿」是假的，比没有更糟。

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
        root!.render(<NoteEditor editorRef={editorRef} value={value} onChange={() => {}} />);
    });
    return { editorRef, host: host! };
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

/** CodeMirror 用 StyleModule 往 <head> 塞 `<style>`；把所有样式文本拼起来看 */
function injectedCss(): string {
    return [...document.head.querySelectorAll("style")]
        .map(tag => tag.textContent || "")
        .join("\n");
}

test("结构记号覆盖：编辑器挂载后，CodeMirror 注入的样式里真的有 var(--notes-mark)", () => {
    mountEditor("# 标题\n- 列表项\n> 引用\n");
    const css = injectedCss();
    assert.ok(css.length > 0, "CodeMirror 没往 <head> 注入任何样式（StyleModule 没挂上）");
    assert.ok(
        css.includes("var(--notes-mark)"),
        "注入的样式表里没有 var(--notes-mark)：说明 markHighlight 没被 syntaxHighlighting 带上，" +
            "或者常量被删了 —— `#` / `-` 会退回 #404740"
    );
    cleanup();
});

test("结构记号覆盖：自定义规则排在写死 #404740 的规则之后（同等特异性，靠后者赢）", () => {
    mountEditor("# 标题\n");
    const css = injectedCss();

    const custom = css.indexOf("var(--notes-mark)");
    // ⚠️ 用 `#404740` 搜而不是搜 defaultHighlightStyle 的类名：类名是运行期生成的随机串
    const legacy = css.indexOf("#404740");

    assert.ok(custom >= 0, "注入的样式里没有 var(--notes-mark)");
    assert.ok(legacy >= 0, "注入的样式里没有 #404740 —— defaultHighlightStyle 没装上？");
    assert.ok(
        custom > legacy,
        "自定义规则必须排在 #404740 那条**之后**（样式表里越靠后优先级越高）。" +
            "排在前面说明 NoteEditor 里两个 syntaxHighlighting 的顺序反了：不会报错，但静默失效。"
    );
    cleanup();
});
