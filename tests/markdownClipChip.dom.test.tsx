// tests/markdownClipChip.dom.test.tsx
// 行内复制胶囊的**渲染与交互**用例（真实 DOM，jsdom）。
//
// 这一段钉四件事：
//   1. 渲染出的是可点的胶囊（role=button + aria-label），尾部字形既不在可访问名里、
//      也不在「全选复制」能带走的文本里（user-select:none）；
//   2. 版式不被破坏：display 必须是 inline、line-height 必须继承父级
//      （v31 那次 inline-block 把行高顶开过，用户当场报「版面乱了」）；
//   3. 点击/Enter/Space 都走同一条复制路径，成功变绿约 1.2s 再复原；
//   4. ⚠️ 最要紧的一条：**点胶囊之后笔记正文一个字都没变**（这是「复制」与
//      「编辑」的分界线，写错了就是把用户正文改坏）。
//
// ⚠️ 断言一律布尔化（`assert.equal(x === null, true)`）：node:assert 失败时会
//    util.inspect 参数，把 jsdom 元素里的 React __reactFiber$ 图展开能把堆打爆。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import NotesPage from "../src/components/NotesPage";
import { editorHandle, type NoteEditorHandle } from "../src/utils/noteEditorHandle";
import { EditorView } from "@codemirror/view";
import type { Note } from "../src/API/http";

/** 渲染一段 Markdown 到真实 DOM（等价于编辑器预览 / 阅读态 / 分享页那条路） */
async function renderToDom(md: string): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = await renderMarkdownToReact(md);
    const root = createRoot(host);
    act(() => {
        root.render(<UIPrefsProvider>{node}</UIPrefsProvider>);
    });
    return host;
}

/**
 * 给 navigator.clipboard 装一个替身。
 *
 * 为什么不 mock 模块：copyToClipboard 的行为（含非安全上下文回落）本身是被测契约的一部分，
 * 从它的**可观测副作用**（writeText 收到的文本）反推「被调用且参数正确」更贴近真实。
 * @param mode "ok" 正常写入；"fail" 让 Clipboard API 抛错（走回落，jsdom 里也失败）
 */
function stubClipboard(mode: "ok" | "fail"): string[] {
    const calls: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                calls.push(text);
                if (mode === "fail") throw new Error("clipboard denied");
            },
        },
    });
    // 不安全上下文会跳过 Clipboard API 直接走 execCommand —— 测试里两态都要明确
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    return calls;
}

/** 把微任务刷干净（复制是 Promise 链） */
async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function chipOf(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>("[data-clip-chip]");
}

test("胶囊元素存在：role=button、可访问名带内容、内容以纯文本呈现", async () => {
    const host = await renderToDom("前面 {{clip:要复制的文本}} 后面");
    const chip = chipOf(host);
    assert.equal(chip === null, false, "没渲染出胶囊");
    assert.equal(chip!.getAttribute("role"), "button", "要有 button 语义");
    assert.equal(chip!.getAttribute("tabindex"), "0", "要能 Tab 到");
    assert.equal(
        chip!.getAttribute("aria-label"),
        "复制：要复制的文本",
        "可访问名必须是「复制：<内容>」（audit:a11y 按 aria-label 判，不看 title）"
    );
    // 内容是**纯文本**（不嵌套解析）：所见 = 复制出去的
    assert.equal(chip!.firstChild?.textContent, "要复制的文本");
    // 正文没丢
    const text = (host.textContent ?? "").replace(/\s+/g, " ");
    assert.equal(text.includes("前面") && text.includes("后面"), true, `正文丢了：${text}`);
});

test("尾部字形不在可复制文本里：user-select:none + aria-hidden", async () => {
    const host = await renderToDom("{{clip:甲}}");
    const chip = chipOf(host)!;
    const glyph = chip.querySelector<HTMLElement>("[aria-hidden='true']");
    assert.equal(glyph === null, false, "尾部字形要单独一个 span");
    assert.equal(glyph!.getAttribute("aria-hidden"), "true", "字形不该进可访问名");
    // 浏览器的复制严格按选区取文本 —— user-select:none 的子树不进选区，
    // 所以「阅读态全选复制」只会得到内容本身（含 ⧉ 就会被带出去）
    assert.equal(
        (glyph!.style.userSelect || glyph!.style.getPropertyValue("user-select")) === "none",
        true,
        "字形必须 user-select:none"
    );
    assert.equal(glyph!.textContent, "⧉", "静止态的尾部字形");
});

test("版式：display 是 inline、行高继承父级（不允许顶开行高）", async () => {
    const host = await renderToDom("{{clip:甲}}");
    const chip = chipOf(host)!;
    // ⚠️ 这两条是 v31 那次事故的直接教训：inline-block 会让行内盒自带高度，
    //    长正文里胶囊出现的那几行会被顶高、整段排版抖一下。
    assert.equal(chip.style.display, "inline", "必须是 inline（inline-block / inline-flex 都会顶开行高）");
    assert.equal(chip.style.lineHeight, "inherit", "行高必须继承父级，否则它自己变成更高的行内盒");
    assert.equal(chip.style.padding, "2px 9px", "内边距按视觉规格");
    // 上下内边距 + 边框只画出去，不参与行盒高度计算（CSS 2.1 §10.6.1）
    assert.equal(chip.style.borderStyle, "dashed", "虚线边框");
    assert.equal(chip.style.borderRadius, "999px", "整圆胶囊");
});

test("点击：写进剪贴板的是内容本身，胶囊变已复制态，约 1.2s 后复原", async () => {
    const calls = stubClipboard("ok");
    const host = await renderToDom("{{clip:甲 乙}}");
    const chip = chipOf(host)!;
    assert.equal(chip.getAttribute("data-clip-state"), "idle");

    await act(async () => {
        chip.click();
    });
    await flush();
    assert.deepEqual(calls, ["甲 乙"], "写进剪贴板的内容必须与原文字节一致");
    assert.equal(chip.getAttribute("data-clip-state"), "copied", "成功之后要进已复制态");
    assert.equal(chip.textContent?.includes("✓"), true, "已复制态尾部字形换成 ✓");

    // 500ms 时还在已复制态（说明不是「立刻复原」）
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
    });
    assert.equal(chip.getAttribute("data-clip-state"), "copied", "1.2s 内不该提前复原");

    // 再等 900ms（累计 ~1.4s）→ 复原
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 900));
    });
    assert.equal(chip.getAttribute("data-clip-state"), "idle", "约 1.2s 之后必须复原");
    assert.equal(chip.textContent?.includes("⧉"), true, "复原后尾部字形回到 ⧉");
});

test("复制失败：不进已复制态（不给假信号）", async () => {
    stubClipboard("fail");
    const host = await renderToDom("{{clip:甲}}");
    const chip = chipOf(host)!;
    await act(async () => {
        chip.click();
    });
    await flush();
    assert.equal(chip.getAttribute("data-clip-state"), "idle", "复制失败必须保持静止态");
});

test("键盘：Enter 与 Space 都能触发复制", async () => {
    const calls = stubClipboard("ok");
    const host = await renderToDom("第一个 {{clip:甲}} 第二个 {{clip:乙}}");
    const chips = host.querySelectorAll<HTMLElement>("[data-clip-chip]");
    assert.equal(chips.length, 2);

    await act(async () => {
        chips[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    assert.deepEqual(calls, ["甲"], "Enter 要能复制");

    await act(async () => {
        chips[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    });
    await flush();
    assert.deepEqual(calls, ["甲", "乙"], "Space 也要能复制");
});

test("分享页上下文（不传任何 options）也能渲染并点击，不抛错", async () => {
    // 公开分享页就是 renderMarkdownToReact(content) —— 没有 onNotify / resolveNote
    const calls = stubClipboard("ok");
    const node = await renderMarkdownToReact("分享正文 {{clip:甲}}");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
        root.render(<UIPrefsProvider>{node}</UIPrefsProvider>);
    });
    const chip = host.querySelector<HTMLElement>("[data-clip-chip]")!;
    assert.equal(chip === null, false, "分享页也要渲染出胶囊");
    await act(async () => {
        chip.click();
    });
    await flush();
    assert.deepEqual(calls, ["甲"]);
});

// ── 页面级：工具栏插入 + 点胶囊改不改正文 ───────────────────────────────────

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) {
        act(() => root!.unmount());
        root = null;
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
});

function note(over: Partial<Note> = {}): Note {
    return {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        order_num: 0,
        site_id: null,
        ...over,
    };
}

function getEditor(): NoteEditorHandle {
    const dom = document.querySelector<HTMLElement>(".cm-content")!;
    return editorHandle(EditorView.findFromDOM(dom)!);
}

/** 挂一整页记事本（与 notes.dom.test.tsx 同款最小 props 集，只用得到的那几个） */
function mountPanel(notes: Note[], handlers: Record<string, unknown> = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={notes}
                    onCreate={async () => note({ id: 99 })}
                    onUpdate={async () => {}}
                    onDelete={async () => {}}
                    onTogglePin={async () => {}}
                    trashedNotes={[]}
                    onLoadTrash={async () => {}}
                    onRestoreTrashed={async () => {}}
                    onPurgeTrashed={async () => {}}
                    onEmptyTrash={async () => {}}
                    onToggleArchive={async () => {}}
                    {...handlers}
                />
            </UIPrefsProvider>
        );
    });
}

/** 打开工具栏「笔记工具」下拉 */
async function openNoteToolsMenu() {
    await act(async () => {
        (document.querySelector('button[aria-label="笔记工具"]') as HTMLElement).click();
    });
}

test("工具栏「复制胶囊」：选中文字包成语法，再点一次摘掉（复用包裹开关）", async () => {
    mountPanel([note({ content: "第一段第二段" })]);
    const editor = getEditor();
    act(() => editor.setSelectionRange(3, 6)); // 选中「第二段」

    await openNoteToolsMenu();
    await act(async () => {
        (document.querySelector('[data-insert-op="clip-chip"]') as HTMLElement).click();
    });
    // ① 选区被包成新语法
    assert.equal(editor.value, "第一段{{clip:第二段}}", "选中的文字要被包成复制胶囊");

    // ② 同一颗按钮的第二下要摘掉标记（insertAtCursor 的「再点一次取消」语义）
    await openNoteToolsMenu();
    await act(async () => {
        (document.querySelector('[data-insert-op="clip-chip"]') as HTMLElement).click();
    });
    const afterUndo: string = editor.value;
    assert.equal(afterUndo, "第一段第二段", "再点一次应当只摘掉标记、正文原样留下");
});

test("工具栏「复制胶囊」：没有选区时插入占位符", async () => {
    mountPanel([note({ content: "正文" })]);
    const editor = getEditor();
    act(() => editor.setSelectionRange(1, 1)); // 光标落在「文」后面，没有选区
    await openNoteToolsMenu();
    await act(async () => {
        (document.querySelector('[data-insert-op="clip-chip"]') as HTMLElement).click();
    });
    const inserted: string = editor.value;
    assert.equal(inserted.includes("{{clip:要复制的内容}}"), true, `没选中时该插占位符，实际：${inserted}`);
});

test("点胶囊只复制，笔记正文一个字都没变", async () => {
    const calls = stubClipboard("ok");
    const source = "前置文字 {{clip:要复制的内容}} 后置文字";
    const updates: string[] = [];
    mountPanel([note({ id: 1, title: "甲", content: source })], {
        onUpdate: async (_id: number, patch: { content?: string }) => {
            updates.push(patch.content ?? "");
        },
    });
    // 打开这篇笔记
    await act(async () => {
        (document.querySelector('[data-note-list] [role="button"]') as HTMLElement).click();
    });
    // 预览是异步渲染的（markdown-it 走动态 import），给它几拍
    let chip: HTMLElement | null = null;
    for (let i = 0; i < 40 && chip === null; i++) {
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 25));
        });
        chip = document.querySelector<HTMLElement>("[data-preview-content='1'] [data-clip-chip]");
    }
    assert.equal(chip === null, false, "预览区里没渲染出胶囊");

    const before = getEditor().value;
    assert.equal(before.includes("{{clip:要复制的内容}}"), true, "源码里应当还是原样的语法");

    await act(async () => {
        chip!.click();
    });
    await flush();

    // ① 复制真的发生了
    assert.deepEqual(calls, ["要复制的内容"], "点击要把内容写进剪贴板");
    // ② 正文一个字都没变（源码 + 保存回调两条都要钉住）
    assert.equal(getEditor().value, before, "点胶囊把正文改了 —— 复制不该是编辑操作");
    assert.equal(updates.length, 0, "点胶囊触发了保存 —— 只该复制，不该产生 update");
    // ③ 语法还在（没有被「渲染成胶囊」顺手回写成别的东西）
    assert.equal(getEditor().value.includes("{{clip:要复制的内容}}"), true);
});
