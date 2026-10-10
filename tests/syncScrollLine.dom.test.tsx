// tests/syncScrollLine.dom.test.ts
// 滚动同步的**行号口径**回归。
//
// 这一条存在的理由：2026-10-10 清注释时翻出来一个真实的差一错误 ——
// `editorLineAtScroll` 的注释写「1 基」，可调用方（`topLineNumber() - 1`）
// 交的已经是 0 基，syncScroll 内部又减了一次 1，于是源码 → 预览的同步
// 永远比实际位置晚一行。差一行在短笔记里看不出来，滚到长文档下半部分
// 就变成「两边对着看但始终错一个段落」。
//
// 所以这里用**真滚轮事件 + 真 rAF** 跑一遍，断言预览落在第 N 行的锚点上，
// 而不是 N-1 的插值 —— 那两个数只差几像素，肉眼「差不多得了」，
// 但错了就是错了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrollSync } from "../src/utils/syncScroll";

/** 造一个带 `data-line` 子块的预览容器，每块的行数为 key、像素 top 为 value */
function makePreview(anchors: Record<number, number>) {
    const preview = document.createElement("div");
    Object.defineProperty(preview, "scrollHeight", { value: 1000 });
    Object.defineProperty(preview, "clientHeight", { value: 200 });
    preview.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    for (const [line, top] of Object.entries(anchors)) {
        const el = document.createElement("div");
        el.setAttribute("data-line", line);
        el.getBoundingClientRect = () => ({ top, left: 0, bottom: top, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
        preview.appendChild(el);
    }
    document.body.appendChild(preview);
    return preview;
}

function makeEditor() {
    const editor = document.createElement("div");
    Object.defineProperty(editor, "scrollHeight", { value: 1000 });
    Object.defineProperty(editor, "clientHeight", { value: 200 });
    document.body.appendChild(editor);
    return editor;
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

test("源码主动滚动：预览按 0 基行号定位，不再整体滞后一行", async () => {
    // 预览锚点：第 0 行在 0px、第 10 行在 40px、第 50 行在 200px、第 90 行在 360px
    const preview = makePreview({ 0: 0, 10: 40, 50: 200, 90: 360 });
    const editor = makeEditor();
    // 源码说「视口顶部停在第 50 行」（0 基，调用方已经把 CM 的 1 基减过）
    const sync = createScrollSync({
        editorScroller: editor,
        previewScroller: preview,
        lineCount: () => 100,
        editorLineAtScroll: () => 50,
        enabled: () => true,
    });
    const cleanup = sync.bind();
    editor.dispatchEvent(new window.Event("wheel"));
    editor.scrollTop = 100;
    editor.dispatchEvent(new window.Event("scroll"));
    await nextFrame();

    // 第 50 行对应的预览位置就是 200px（锚点值本身）。
    // ⚠️ 如果 syncScroll 内部多减了 1，算的是第 49 行 → 插值出来是 **196**。
    assert.equal(preview.scrollTop, 200, "预览要停在第 50 行对应的锚点上（196 就是减多了那次 1）");
    cleanup();
    editor.remove();
    preview.remove();
});

test("源码滚到第 10 行：落在 40px，而不是第 9 行的插值", async () => {
    const preview = makePreview({ 0: 0, 10: 40, 50: 200, 90: 360 });
    const editor = makeEditor();
    const sync = createScrollSync({
        editorScroller: editor,
        previewScroller: preview,
        lineCount: () => 100,
        editorLineAtScroll: () => 10,
        enabled: () => true,
    });
    const cleanup = sync.bind();
    editor.dispatchEvent(new window.Event("wheel"));
    editor.scrollTop = 20;
    editor.dispatchEvent(new window.Event("scroll"));
    await nextFrame();
    assert.equal(preview.scrollTop, 40);
    cleanup();
    editor.remove();
    preview.remove();
});
