// tests/editorPaste.dom.test.tsx
// N3 + N5 编辑器粘贴 / 拖拽：
//   - 粘贴图片 → 先插「上传中…」占位符，上传完把占位符里的 token 换成最终 url；
//   - 粘贴富文本 HTML（无图片无纯文本）→ 转 Markdown 进正文；
//   - 没传 uploadImage（后端没配存储）→ 原生行为，正文不动。
// 钉住的是「占位符必须被替换掉」—— 占位符留在正文里就是一条坏链。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NoteEditor from "../src/components/NoteEditor";
import type { NoteEditorHandle } from "../src/utils/noteEditorHandle";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mountEditor(value: string, opts: { uploadImage?: (f: File) => Promise<{ url: string; filename: string }>; onDetachedUpload?: (placeholder: string, replacement: string) => Promise<void> } = {}) {
    let latest = value;
    host = document.createElement("div");
    document.body.appendChild(host);
    const editorRef = { current: null as NoteEditorHandle | null };
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteEditor
                editorRef={editorRef}
                value={value}
                onChange={v => { latest = v; }}
                uploadImage={opts.uploadImage}
                onDetachedUpload={opts.onDetachedUpload}
            />
        );
    });
    return {
        ref: editorRef as { current: NoteEditorHandle },
        doc: () => latest,
    };
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

function firePaste(files: File[], data: Record<string, string> = {}) {
    const content = host!.querySelector(".cm-content") as HTMLElement;
    const ev = new window.Event("paste", { bubbles: true, cancelable: true }) as Event & {
        clipboardData?: DataTransfer;
    };
    Object.defineProperty(ev, "clipboardData", {
        value: {
            files,
            getData: (t: string) => data[t] ?? "",
        },
    });
    act(() => content.dispatchEvent(ev));
    return ev;
}

test("上传结束前销毁编辑器走原笔记回写兜底", async () => {
    let finish!: (result: { url: string; filename: string }) => void;
    let restored = "";
    const mounted = mountEditor("原笔记", {
        uploadImage: () => new Promise(resolve => { finish = resolve; }),
        onDetachedUpload: async (placeholder, replacement) => { restored = mounted.doc().replace(placeholder, replacement); },
    });
    firePaste([new File(["x"], "late.png", { type: "image/png" })]);
    assert.ok(mounted.doc().includes("uploading-"));
    cleanup();
    await act(async () => { finish({ url: "https://cdn.test/late.png", filename: "late.png" }); await Promise.resolve(); });
    assert.ok(restored.includes("![late.png](https://cdn.test/late.png)"));
    assert.ok(!restored.includes("uploading-"));
});

test("N3 粘贴图片：先插占位符，上传完替换成最终 url", async () => {
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const { ref, doc } = mountEditor("第一行\n", {
        uploadImage: async f => ({ url: `https://cdn.test/${f.name}`, filename: f.name }),
    });
    act(() => ref.current?.focus());
    firePaste([file]);
    assert.ok(doc().includes("上传中…<!-- uploading-"), `粘贴后应有占位符，实际：${doc()}`);
    // 等上传 Promise 落地（microtask）
    await act(async () => { await Promise.resolve(); });
    assert.ok(doc().includes("![shot.png](https://cdn.test/shot.png)"), `上传后应回写 url，实际：${doc()}`);
    assert.ok(!doc().includes("uploading-"), `占位符 token 应被替换干净，实际：${doc()}`);
    cleanup();
});

test("N3 粘贴图片但上传失败：占位符换成「上传失败」，不留死链 token", async () => {
    const file = new File(["x"], "bad.png", { type: "image/png" });
    const { ref, doc } = mountEditor("", {
        uploadImage: async () => { throw new Error("boom"); },
    });
    act(() => ref.current?.focus());
    firePaste([file]);
    await act(async () => { await Promise.resolve(); });
    assert.ok(doc().includes("上传失败"), `应替换成「上传失败」，实际：${doc()}`);
    assert.ok(!doc().includes("uploading-"), doc());
    cleanup();
});

test("N5 粘贴富文本 HTML（无图片无纯文本）转 Markdown 进正文", () => {
    const { ref, doc } = mountEditor("已有内容\n", {});
    act(() => ref.current?.focus());
    firePaste([], {
        "text/html": "<h2>标题</h2><p>带<strong>加粗</strong>的文字</p>",
        "text/plain": "标题 带加粗的文字",
    });
    const d = doc();
    assert.ok(d.includes("## 标题"), `HTML 应转成二级标题，实际：${d}`);
    assert.ok(d.includes("**加粗**"), `strong 应转加粗，实际：${d}`);
    cleanup();
});

test("N3 没传 uploadImage：粘贴图片不插占位符（原生行为）", () => {
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const { ref, doc } = mountEditor("原文\n");
    act(() => ref.current?.focus());
    firePaste([file]);
    assert.ok(!doc().includes("上传中"), "不应插占位符");
    assert.ok(!doc().includes("shot.png"), "不应回写文件名");
    cleanup();
});

test("选中文本粘贴 URL 替换为链接", () => {
    const { ref, doc } = mountEditor("选中其余");
    act(() => ref.current.setSelectionRange(0, 2));
    firePaste([], { "text/plain": "https://a.test/x" });
    assert.equal(doc(), "[选中](https://a.test/x)其余");
    cleanup();
});
test("HTML 粘贴替换选区，不保留旧选中文字", () => {
    const { ref, doc } = mountEditor("旧文字尾巴");
    act(() => ref.current.setSelectionRange(0, 3));
    firePaste([], { "text/plain": "新内容", "text/html": "<strong>新内容</strong>" });
    assert.equal(doc(), "**新内容**尾巴");
    cleanup();
});
test("编辑器格式快捷键确实调用注入动作", () => {
    let called = 0;
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    act(() => root!.render(<NoteEditor value='内容' onChange={() => {}} editorRef={{ current: null }} shortcutActions={{ bold: () => { called++; } }} />));
    const content = host.querySelector(".cm-content")!;
    act(() => content.dispatchEvent(new window.KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: !/Mac/i.test(navigator.platform), metaKey: /Mac/i.test(navigator.platform), bubbles: true, cancelable: true })));
    assert.equal(called, 1);
    cleanup();
});

test("非图片附件写入普通 Markdown 链接", async () => {
    const { doc } = mountEditor("", { uploadImage: async f => ({ url: "https://a.test/a.pdf", filename: f.name }) });
    firePaste([new File(["pdf"], "a.pdf", { type: "application/pdf" })]);
    await act(async () => { await Promise.resolve(); });
    assert.ok(doc().includes("[a.pdf](https://a.test/a.pdf)"));
    assert.ok(!doc().includes("!["));
    cleanup();
});
