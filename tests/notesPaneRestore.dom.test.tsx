// tests/notesPaneRestore.dom.test.tsx
// 真实挂载 NotesPage 验证「关掉再打开 = 卸载再挂载」后档位恢复，
// 而不是只靠源码静态断言。分栏与否用 role='separator' 那根拖动条判定：
// 它只在 finePane === "split" 时渲染，是布局的真实信号，不是样式猜测。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesPage from "../src/components/NotesPage";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/http";
import { NOTES_PANE_KEY, readNotesPane } from "../src/utils/notesSettings";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function oneNote(): Note {
    return {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        order_num: 0,
        site_id: null,
    };
}

function mount(): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={[oneNote()]}
                    onCreate={async () => oneNote()}
                    onUpdate={async () => {}}
                    onDelete={async () => {}}
                    onTogglePin={async () => {}}
                    trashedNotes={[]}
                    onLoadTrash={async () => {}}
                    onRestoreTrashed={async () => {}}
                    onPurgeTrashed={async () => {}}
                    onEmptyTrash={async () => {}}
                    onToggleArchive={async () => {}}
                />
            </UIPrefsProvider>
        );
    });
}

async function unmount(): Promise<void> {
    if (root) {
        const target = root;
        root = null;
        // 用 async act 包卸载：MarkdownPreview 的异步重绘可能还在队列里，
        // 同步 unmount 会撞上 React 正在渲染（测试虽绿但会打竞态警告）。
        await act(async () => { target.unmount(); });
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
}

function setWide(): void {
    Object.defineProperty(window, "innerWidth", {
        value: 1440, configurable: true, writable: true,
    });
}

const splitSeparator = () =>
    document.querySelector("[role='separator'][aria-label='拖动调整源码与预览的比例']");

async function clickMode(label: string): Promise<void> {
    const btn = document.querySelector<HTMLElement>(`button[aria-label='${label}']`);
    assert.ok(btn, `找不到「${label}」档位按钮`);
    await act(async () => { btn!.click(); });
}

afterEach(async () => {
    await unmount();
    // 本组用例会写 localStorage，必须清干净，别串味到别的 DOM 用例。
    localStorage.removeItem(NOTES_PANE_KEY);
    Object.defineProperty(window, "innerWidth", {
        value: 1024, configurable: true, writable: true,
    });
});

test("存了 edit：打开记事本不再回到分栏，切换后立刻落盘", async () => {
    setWide();
    localStorage.setItem(NOTES_PANE_KEY, "edit");
    mount();
    assert.equal(splitSeparator(), null, "edit 档不该渲染源码/预览分隔条");
    assert.equal(readNotesPane(), "edit", "单纯打开不该改写已存的档位");

    await clickMode("分栏");
    assert.ok(splitSeparator(), "切到分栏要出现分隔条");
    assert.equal(localStorage.getItem(NOTES_PANE_KEY), "split", "切换要立刻落盘");
});

test("关闭再打开（卸载重挂）恢复的是上次档位，不是固定分栏", async () => {
    setWide();
    localStorage.clear();
    mount();
    assert.ok(splitSeparator(), "从没存过时默认仍是分栏");

    await clickMode("编辑");
    assert.equal(splitSeparator(), null, "切到编辑后不再分栏");
    assert.equal(localStorage.getItem(NOTES_PANE_KEY), "edit");

    await unmount();
    mount();
    assert.equal(splitSeparator(), null, "重新打开应恢复 edit，而不是又回分栏");
    assert.equal(readNotesPane(), "edit");
});

test("preview 同样能恢复，三档控件都还在（没把切换入口藏掉）", () => {
    setWide();
    localStorage.setItem(NOTES_PANE_KEY, "preview");
    mount();
    assert.equal(splitSeparator(), null, "preview 档也不该有分栏分隔条");
    for (const label of ["编辑", "分栏", "预览"]) {
        assert.ok(
            document.querySelector(`button[aria-label='${label}']`),
            `恢复成 preview 后「${label}」仍应可点`
        );
    }
});
