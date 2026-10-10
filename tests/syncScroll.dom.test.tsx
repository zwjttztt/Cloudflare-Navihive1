import { test } from "node:test";
import assert from "node:assert/strict";
import { createScrollSync } from "../src/utils/syncScroll";

test("预览主动滚动按源码锚点反向同步，清理后不再响应", async () => {
    const editor = document.createElement("div");
    const preview = document.createElement("div");
    for (const element of [editor, preview]) {
        Object.defineProperty(element, "scrollHeight", { value: 1000 });
        Object.defineProperty(element, "clientHeight", { value: 200 });
        document.body.appendChild(element);
    }
    const sync = createScrollSync({ editorScroller: editor, previewScroller: preview,
        lineCount: () => 100, editorLineAtScroll: () => 51,
        editorScrollForLine: line => line * 8, enabled: () => true });
    const cleanup = sync.bind();
    preview.dispatchEvent(new window.Event("wheel"));
    preview.scrollTop = 400;
    preview.dispatchEvent(new window.Event("scroll"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    assert.equal(editor.scrollTop, 400);
    preview.scrollTop = 800;
    preview.dispatchEvent(new window.Event("scroll"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    assert.equal(editor.scrollTop, 800);
    cleanup();
    preview.scrollTop = 0;
    preview.dispatchEvent(new window.Event("wheel"));
    preview.dispatchEvent(new window.Event("scroll"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    assert.equal(editor.scrollTop, 800);
    editor.remove(); preview.remove();
});
