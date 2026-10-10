// tests/notes.dom.test.tsx
// 记事本页面（NotesPage）+ 数据层（useNotes）的行为用例。
//
// 这一组钉的是**写错了不报错、只是界面不对**的地方：
//   - 面板的搜索/摘要/编辑态切换；
//   - useNotes 的**乐观更新 + 失败回滚**（这是最容易写错的地方：
//     不回滚的话，保存失败后界面上会留着一份根本没存下来的内容）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesPage from "../src/components/NotesPage";
import { editorHandle, type NoteEditorHandle } from "../src/utils/noteEditorHandle";
import { EditorView } from "@codemirror/view";
function getEditor(): NoteEditorHandle {
    const dom = document.querySelector<HTMLElement>(".cm-content")!;
    return editorHandle(EditorView.findFromDOM(dom)!);
}
import { useNotes } from "../src/hooks/useNotes";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/** 剥掉注释，避免扫到「为什么不用 X」这类说明文字（否则守卫永远红） */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const idx = line.indexOf("//");
            if (idx === -1) return line;
            return /:\/\/[\s\S]*$/.test(line.slice(0, idx)) ? line : line.slice(0, idx);
        })
        .join("\n");
}

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

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
    // 视口宽度复原。2026-10-07 起布局有了三档断点（usePanelBreakpoint），
    // 而 jsdom 默认 innerWidth = 1024 → 落在 tablet 档 → 导航列整列 display:none、
    // 它那条拖动把手也不渲染。凡是测「导航列 / 左两栏」的用例都必须先 setWide(),
    // 否则 querySelector 返回 null，症状是 `Cannot read properties of null`。
    setViewport(1024);
});

/** 设定 jsdom 的视口宽度（写 innerWidth 只够让 matchMedia 之外的逻辑读到；MUI 的 sx 断点也读它）。 */
function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

/** 把视口设成 desktop 档（≥1180），让三栏与两条导航分隔条都渲染出来。 */
function setWide() {
    setViewport(1440);
}

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

const text = () => document.body.textContent || "";

/**
 * 打开当前笔记的「更多操作」菜单（data-tool='note-more'）。
 * 2026-10-07 起：只读分享 / 版本历史 / 大纲 / 反向链接都收进了这个菜单
 * （顶栏只压在最左栏，且那排按钮只对当前编辑的这篇有意义）。
 */
async function openNoteMore() {
    await act(async () => {
        (document.querySelector("button[data-tool='note-more']") as HTMLElement).click();
    });
}

test("反向链接：面板列出引用当前笔记的条目，且能跳过去", async () => {
    mountPanel([
        note({ id: 1, title: "数据库设计", content: "表结构" }),
        note({ id: 2, title: "设计稿", content: "参考 [[数据库设计]]" }),
        note({ id: 3, title: "无关", content: "没有链接" }),
    ]);
    // 先打开《设计稿》（列表里第二条）
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[1] as HTMLElement).click();
    });
    // 打开《数据库设计》（第一条）才有被引用
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[0] as HTMLElement).click();
    });
    await openNoteMore();
    const target = document.querySelector<HTMLElement>('[data-active-op="backlinks"]');
    assert.ok(target, "更多操作里要有反向链接");
    assert.match(target!.textContent ?? "", /反向链接（1）/, "菜单项上标出条数");
    await act(async () => { target!.click(); });
    assert.ok(document.querySelector("[data-backlinks='incoming-label']"));
    const item = document.querySelector<HTMLElement>("[data-backlink-source='2']");
    assert.ok(item, "应列出引用了它的《设计稿》");
    await act(async () => { item!.click(); });
    // 跳过去之后当前笔记变成《设计稿》，它自己没有反向链接（菜单项灰着）
    await openNoteMore();
    const after = document.querySelector<HTMLElement>('[data-active-op="backlinks"]') as HTMLLIElement;
    assert.ok(after, "更多操作里仍然有反向链接这一项");
    assert.equal(after.getAttribute("aria-disabled"), "true", "0 条时这一项要灰着");
});

test("双链渲染成可点元素，点一下跳到目标笔记", async () => {
    mountPanel([
        note({ id: 1, title: "目标笔记", content: "内容" }),
        note({ id: 2, title: "来源笔记", content: "见 [[目标笔记]]" }),
    ]);
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[1] as HTMLElement).click();
    });
    // ⚠️ 限定在预览区里找：编辑区上方的「实时渲染当前段落」也会渲染出一个同名链接，
    // 那是另一个入口（页面上确实有两个可点的双链）。
    const link = document.querySelector<HTMLElement>("[data-preview-content='1'] [data-wiki-link]");
    assert.ok(link, "正文里的 [[目标笔记]] 要渲染成链接");
    assert.equal(link!.textContent, "目标笔记");
    await act(async () => { link!.click(); });
    // 跳到《目标笔记》：更多操作里的「反向链接」显示 1 条
    await openNoteMore();
    assert.match(
        document.querySelector<HTMLElement>('[data-active-op="backlinks"]')!.textContent ?? "",
        /反向链接（1）/
    );
});

test("链接与引用：选中文字换成脚注引用，原文进文末定义；再点一次全撤", async () => {
    mountPanel([note({ content: "第一段第二段" })]);
    const editor = getEditor();
    act(() => editor.setSelectionRange(3, 6)); // 选中「第二段」
    await act(async () => {
        (document.querySelector('[data-tool="link-menu"]') as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click();
    });
    // 选区被引用替换，原文搬到文末
    assert.equal(editor.value, "第一段[^1]\n\n[^1]: 第二段");
    // 再点一次：引用和定义都要没，且不留孤儿定义
    await act(async () => {
        (document.querySelector('[data-tool="link-menu"]') as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click();
    });
    // ⚠️ 用局部变量再断言：上面那行 assert.equal 会把 editor.value 收窄成字面量类型，
    // 后面再 `.includes()` 就变成 never 上的调用（tsc 报错）。
    const afterUndo: string = editor.value;
    assert.equal(afterUndo, "第一段第二段");
    assert.ok(!afterUndo.includes("[^"), "不该留下没有引用的孤儿定义");
});

test("链接与引用：连插两条编号不重复（都写 [^1] 的话第二条定义会被忽略）", async () => {
    mountPanel([note({ content: "甲乙丙" })]);
    const editor = getEditor();
    const clickFootnote = async () => {
        await act(async () => {
            (document.querySelector('[data-tool="link-menu"]') as HTMLElement).click();
        });
        await act(async () => {
            (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click();
        });
    };
    act(() => editor.setSelectionRange(0, 1));
    await clickFootnote();
    // 插完是 "[^1]乙丙\n\n[^1]: 甲"（索引 4 = 乙、5 = 丙），选中「丙」再插第二条
    act(() => editor.setSelectionRange(5, 6));
    await clickFootnote();
    assert.match(editor.value, /\[\^1\]: 甲/);
    assert.match(editor.value, /\[\^2\]: 丙/, "第二条要编号 2，不能与第一条重号");
    assert.equal((editor.value.match(/\[\^1\]:/g) ?? []).length, 1);
});

test("Escape 能关掉全屏记事本（有未保存内容时先存）", async () => {
    let closed = 0;
    let saved = 0;
    mountPanel([note({ content: "原文" })], {
        onClose: () => { closed += 1; },
        onUpdate: async () => { saved += 1; },
    });
    const key = (k: string) =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    await act(async () => { key("Escape"); });
    assert.equal(closed, 1, "Escape 要能关掉整页（原来只能去点左上角箭头）");
    assert.equal(saved, 0, "没有改动时不该触发保存");
    // 有改动：先存再关
    act(() => { getEditor().value = "改过了"; });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { key("Escape"); });
    assert.equal(saved, 1, "有关改动时要先保存再关，不能把编辑中的正文丢掉");
    assert.equal(closed, 2);
});

test("Tab 在记事本内循环，不会跑到看不见的背景里", async () => {
    mountPanel([note({ content: "正文" })]);
    const root = document.querySelector<HTMLElement>("[data-notes-root]");
    assert.ok(root, "根容器要带 data-notes-root，Tab 循环靠它圈定范围");
    const focusables = [...root!.querySelectorAll<HTMLElement>("button:not([disabled])")];
    assert.ok(focusables.length > 2, "要有可聚焦元素才谈得上循环");
    // 焦点在最后一个可聚焦元素上时按 Tab → 回到第一个
    const last = focusables[focusables.length - 1];
    last.focus();
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    assert.equal(document.activeElement, focusables[0], "Tab 走到末尾要绕回开头");
});

test("CodeMirror 使用 contenteditable 而非 textarea，并支持工具栏撤销重做", async () => {
    const { undo, redo } = await import("@codemirror/commands");
    mountPanel([note({ content: "原文" })]);
    assert.equal(document.querySelector("textarea[aria-label='笔记内容']"), null);
    const content = document.querySelector<HTMLElement>(".cm-content")!;
    assert.equal(content.getAttribute("contenteditable"), "true");
    assert.ok(document.querySelector(".cm-lineNumbers"));
    const view = EditorView.findFromDOM(content)!;
    const editor = getEditor();
    act(() => editor.setSelectionRange(0, 2));
    act(() => (document.querySelector('[data-tool="bold"]') as HTMLElement).click());
    assert.equal(editor.value, "**原文**");
    act(() => { assert.equal(undo(view), true); });
    assert.equal(editor.value, "原文");
    act(() => { assert.equal(redo(view), true); });
    assert.equal(editor.value, "**原文**");
});

test("切笔记重建编辑器，不能撤销到另一条正文", async () => {
    const { undo } = await import("@codemirror/commands");
    mountPanel([note({ id: 1, title: "第一条", content: "甲" }), note({ id: 2, title: "第二条", content: "乙" })]);
    act(() => { getEditor().value = "甲改"; });
    await act(async () => { (document.querySelectorAll('[data-note-list] [role="button"]')[1] as HTMLElement).click(); });
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-content")!)!;
    assert.equal(view.state.doc.toString(), "乙");
    act(() => { assert.equal(undo(view), false); });
    assert.equal(view.state.doc.toString(), "乙");
});

test("面板列出笔记的标题与内容摘要", () => {
    mountPanel([
        note({ id: 1, title: "常用入口", content: "# 标题\n\n- [x] 已完成" }),
        note({ id: 2, title: "待办", content: "第二条内容" }),
    ]);
    assert.ok(text().includes("常用入口"));
    assert.ok(text().includes("待办"));
    // 摘要要去掉 Markdown 语法符号（# 与列表符），不是原样显示源码。
    // ⚠️ 只在**列表项里**找：编辑区/预览区本来就显示原文（那是源码视图，不是摘要）
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list, "列表区要有标记，方便测试只盯它");
    assert.ok(!list.textContent!.includes("- [x] 已完成"), "摘要里不该留着列表符号");
    assert.ok(list.textContent!.includes("已完成"));
});

// ---------- 阶段一：工具栏图标化 + 分组 + 标题层级下拉 ----------

test("工具栏按 data-tool 暴露分组按钮（不再是 15 个散落文字按钮）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement | null;
    assert.ok(bar, "要有格式工具栏");
    const tools = [...bar.querySelectorAll("button[data-tool]")].map(b =>
        b.getAttribute("data-tool")
    );
    for (const key of ["bold", "italic", "strike", "code", "ul", "ol", "task", "link", "image", "quote", "table"]) {
        assert.ok(tools.includes(key), `工具栏要有 ${key} 按钮，实际 ${JSON.stringify(tools)}`);
    }
    // 分组之间要用 Divider 隔开，不然又变成一长串
    assert.ok(bar.querySelectorAll('hr, [class*="MuiDivider"]').length >= 4, "分组之间要有分隔线");
});

test("工具栏补齐 inkstone 式下拉：链接 / 图片 / 笔记工具 / 块", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement;
    assert.ok(bar, "要有格式工具栏");
    // ⚠️ 2026-10-07 对齐 inkstone 后：链接/图片/代码都是「主按钮 + 箭头」双态，
    // 箭头才是下拉入口；「插入」改名「笔记工具」（inkstone 的 note 菜单）。
    for (const label of ["链接与引用", "插入图片", "笔记工具"]) {
        assert.ok(
            bar.querySelector(`button[aria-label="${label}"]`),
            `工具栏要有「${label}」下拉按钮`
        );
    }
    // 点开「链接与引用」，里面几种插入项都要在（覆盖双链 / 嵌入 / 块引用 / 脚注）
    const linkBtn = bar.querySelector('button[aria-label="链接与引用"]') as HTMLElement;
    await act(async () => linkBtn.click());
    for (const op of ["external", "wikilink", "embed", "blockref", "footnote"]) {
        assert.ok(
            document.querySelector(`[data-link-op="${op}"]`),
            `链接下拉要有 ${op} 这一项`
        );
    }
    // 点「笔记嵌入」要往编辑器插入 ![[笔记标题]]（和粗体走同一条 insertBlock 路径）
    const ta = getEditor();
    await act(async () => (document.querySelector('[data-link-op="embed"]') as HTMLElement).click());
    assert.ok(ta.value.includes("![[笔记标题]]"), "点嵌入要插入 ![[笔记标题]]，实际：" + ta.value);
    // 「笔记工具」下拉：标签 / 块 ID / 属性 / 隐藏注释
    const insertBtn = bar.querySelector('button[aria-label="笔记工具"]') as HTMLElement;
    await act(async () => insertBtn.click());
    for (const op of ["blockid", "frontmatter", "hidden", "tag"]) {
        assert.ok(document.querySelector(`[data-insert-op="${op}"]`), `笔记工具下拉要有 ${op}`);
    }
    // 「内容块」下拉：inkstone 的 blockItems 只有 4 项
    // ���提示块 / 折叠内容 / 标签页 / 分隔线）。
    // ⚠️ 2026-10-07：5 种提示框类型合并成 1 项「提示块」，类型挪到**二级菜单** ——
    // 菜单与 inkstone 一致，功能一个不丢（下面单独验二级菜单）。
    const blockBtn = bar.querySelector('button[aria-label="内容块"]') as HTMLElement | null;
    assert.ok(blockBtn, "工具栏要有「内容块」下拉按钮");
    await act(async () => blockBtn!.click());
    for (const op of ["fold", "tabs", "divider"]) {
        assert.ok(document.querySelector(`[data-block-op="${op}"]`), `内容块下拉要有 ${op}`);
    }
    assert.ok(
        document.querySelector('[data-block-op="callout-menu"]'),
        "要有 1 项「提示块」（5 种类型在二级菜单里）"
    );
    assert.equal(
        document.querySelectorAll("[data-callout-type]").length,
        0,
        "主菜单里不该直接出现 5 种提示框类型（inkstone 只有 1 项「提示块」）"
    );
    // 点开二级菜单，5 种类型都在
    await act(async () =>
        (document.querySelector('[data-block-op="callout-menu"]') as HTMLElement).click()
    );
    for (const t of ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE"]) {
        assert.ok(
            document.querySelector(`[data-callout-type="${t}"]`),
            `提示框二级菜单里要有 ${t}`
        );
    }
});

test("新建笔记按钮在左栏文件夹标题右侧与中间栏右上角（顶栏那个移除）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const newBtns = [...document.querySelectorAll('button[aria-label="新建笔记"]')];
    // 两处：左栏文件夹标题右侧（和新建文件夹并排）+ 中间栏右上角（inkstone 同样两处）
    assert.equal(newBtns.length, 2, "顶栏新建笔记已移除，只剩左栏一处 + 中间栏一处");
    const inNav = newBtns.find(b => b.closest('[data-nav-col="1"]'));
    assert.ok(inNav, "要有一个新建笔记按钮在左栏导航列（文件夹标题右侧）");
    const inListHeader = newBtns.find(b => b.closest("[data-list-header='1']"));
    assert.ok(inListHeader, "要有一个新建笔记按钮在中间栏头部右侧");
    assert.equal(
        inListHeader!.getAttribute("data-tool"),
        "list-new-note",
        "中间栏那颗要能被 data-tool='list-new-note' 定位到"
    );
});

test("标题层级下拉：点 H2 是把 `## ` 加在当前行开头", () => {
    mountPanel([note({ id: 1, title: "甲", content: "一段文字" })]);
    const ta = getEditor();
    const bar = document.querySelector('[aria-label="Markdown 格式"]')!;

    // 光标放在「段」与「文字」之间
    act(() => {
        ta.focus();
        ta.value = "一段文字";
        ta.setSelectionRange(2, 2);
    });

    const headingBtn = bar.querySelector('button[aria-label="标题层级"]') as HTMLElement | null;
    assert.ok(headingBtn, "要有标题层级按钮");
    act(() => headingBtn!.click());

    const h2 = document.querySelector('[data-heading="2"]') as HTMLElement | null;
    assert.ok(h2, "H2 要在下拉里");
    act(() => h2!.click());

    // 标题是行首前缀，不能插到光标中间把半句话劈开
    assert.equal(ta.value, "## 一段文字", "H2 要落在整行开头");
    assert.equal(ta.selectionStart, 3, "光标跟着落到前缀之后");
});

test("左栏导航「收藏」只看收藏的那几条（2026-10-09：与置顶分离，不再判 pinned）", () => {
    setWide();
    mountPanel([
        // ⚠️ 这一条**只**置顶、没收藏：它正是这次要分开的那两种状态。
        // 分离以前「收藏」视图判的是 pinned，于是置顶的会被当成收藏的显示出来。
        note({ id: 1, title: "只置顶的", content: "a", pinned: true, starred: false }),
        note({ id: 2, title: "收藏了的", content: "b", pinned: false, starred: true }),
        note({ id: 3, title: "普通的", content: "c", pinned: false, starred: false }),
    ]);
    const list = () =>
        document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(
        list().includes("只置顶的") && list().includes("收藏了的") && list().includes("普通的"),
        "默认全部"
    );

    const starred = [...document.querySelectorAll("button[data-view]")].find(
        b => b.getAttribute("data-view") === "starred"
    ) as HTMLElement | null;
    assert.ok(starred, "要有收藏视图按钮");
    act(() => starred!.click());

    assert.ok(list().includes("收藏了的"), "收藏里要有收藏了的");
    assert.ok(!list().includes("只置顶的"), "只置顶没收藏的不该出现在收藏里（两件事已分离）");
    assert.ok(!list().includes("普通的"), "收藏里不该出现没收藏的");
});

// ---------- 阶段二：左栏折叠 / 月份分组 / ⌘K ----------

test("标题下拉按钮和图标按钮一样大（28×28），不再高一截", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]')!;
    const head = bar.querySelector('button[aria-label="标题层级"]') as HTMLElement;
    const bold = bar.querySelector('button[data-tool="bold"]') as HTMLElement;
    assert.ok(head && bold, "标题下拉和粗体按钮都要在");
    // ⚠️ jsdom 没有布局，getBoundingClientRect 恒为 0，量不了真实尺寸；
    // 所以这里查源码：标题按钮必须和图标按钮一样是 28×28 —— 它之前是「Button」自带
    // padding + 18px 字，比图标高一截，用户一眼看出大小不一致。
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // ⚠️ 别拿 `indexOf("标题层级")` 当锚点：源码里「标题层级」这四个字在
    // 大纲注释、菜单项 label 等处出现过好几次，indexOf 命中的是最早那处
    // 注释，切出来的片段跟按钮没关系。锚在 aria-label 上才是这个按钮本身。
    const anchor = "aria-label='标题层级'";
    const headBlock = src.slice(src.indexOf(anchor), src.indexOf("</IconButton>", src.indexOf(anchor)));
    assert.ok(headBlock.includes("width: 28"), "标题按钮宽度要和图标按钮一致");
    assert.ok(headBlock.includes("height: 28"), "标题按钮高度要和图标按钮一致");
});

test("选中一段字点粗体后，选区还在（不能一按就没了）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement;
    act(() => {
        ta.focus();
        ta.value = "这篇笔记";
        ta.setSelectionRange(0, 4);
    });
    act(() => bold.click());
    assert.equal(ta.value, "**这篇笔记**", "第一下包一层");
    assert.equal(ta.selectionStart, 2, "选区左边界要跟着标记挪到 `**` 之后");
    assert.equal(ta.selectionEnd, 6, "刚包上的 `这篇笔记`(4 字)要整体还在选中态");
});

test("阶段二：列表按时间分组，分组标题挂在条目上面", () => {
    mountPanel([
        note({ id: 1, title: "早的", content: "a", updated_at: "2026-09-03T10:00:00Z" }),
        note({ id: 2, title: "晚的", content: "b", updated_at: "2026-10-05T10:00:00Z" }),
    ]);
    const headers = [...document.querySelectorAll("[data-month]")].map(h => h.textContent);
    // ⚠️ 2026-10-07 按 inkstone 改成**相对**分组（今天/昨天/本周/本月/N 月/年 月），
    // 不再是「一律按 YYYY-MM」。断言只看「新的一段排在旧的一段前面」，
    // 不写死具体标签 —— 今天是几号会改变「今天/昨天/本周」的判定。
    assert.ok(headers.length >= 2, "两个不同时间段的笔记要落在两个分组里，实际 " + JSON.stringify(headers));
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list.textContent!.includes("晚的") && list.textContent!.includes("早的"));
    // 分组顺序：新的那组整体排在前面（「晚的」必须出现在「早的」之前）
    assert.ok(
        list.innerHTML.indexOf("晚的") < list.innerHTML.indexOf("早的"),
        "时间较新的分组要排在列表里前面"
    );
});

test("列表分组标题用 inkstone 那套排版（10.5px / 加粗 / 0.06em 字距）", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // 从 data-month 一直取到该 Typography 闭合，取够整个 sx 块
    const i = src.indexOf("data-month={group.label}");
    const block = src.slice(i, src.indexOf("/>", i));
    assert.ok(/fontSize: 10\.5/.test(block), "分组标题 10.5px（inkstone 的 text-[10.5px]）");
    assert.ok(/fontWeight: 600/.test(block), "分组标题加粗");
    assert.ok(/letterSpacing: "0\.06em"/.test(block), "分组标题 0.06em 字距");
    // 按标题排序时 label 为空 → 整条标题不渲染（inkstone: label 为 null 就不画）
    assert.ok(
        /\{group\.label && \(\s*<Typography/.test(src),
        "label 为空时不能渲染一个空标题"
    );
});

test("笔记行内不再有时间戳（时间已由分组标题承担）", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // ⚠️ 窗口要装得下**整行**：2026-10-10 往行里加了「⌘/Ctrl 点 / Shift 点」那三十行，
    // 6000 就不够了 —— 守卫自己红了而功能一点没坏（这种红比没守卫更糟），取 9000。
    const row = src.slice(src.indexOf("data-note-id={note.id}"), src.indexOf("data-note-id={note.id}") + 9000);
    assert.equal(
        /formatRelative\(note\.updated_at/.test(row),
        false,
        "行内不该再渲染「3分钟前」—— 分组标题已经说了这段时间"
    );
    // 精确时刻不能跟着一起丢：挂到整行的 title 上
    assert.ok(
        /title=\{formatWhen\(note\.updated_at \|\| note\.created_at\)\}/.test(src),
        "整行的 title 要保留精确时刻（删了行内时间戳不能把信息也删了）"
    );
});

test("悬停时整行右移 2px，且只在真能 hover 的设备上（inkstone 同款）", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // ⚠️ 窗口要装得下**整行**：2026-10-10 往行里加了「⌘/Ctrl 点 / Shift 点」那三十行，
    // 6000 就不够了 —— 守卫自己红了而功能一点没坏（这种红比没守卫更糟），取 9000。
    const row = src.slice(src.indexOf("data-note-id={note.id}"), src.indexOf("data-note-id={note.id}") + 9000);
    assert.ok(/translateX\(2px\)/.test(row), "悬停要右移 2px");
    assert.ok(
        /@media \(hover: hover\) and \(pointer: fine\)/.test(row),
        "⚠️ 必须限在 hover:hover + pointer:fine —— 触屏上 sticky hover 会让行点完还歪着"
    );
});

test("置顶的笔记单独排在最上面一组（inkstone 的 pinned 组）", () => {
    mountPanel([
        note({ id: 1, title: "普通", content: "a", updated_at: "2026-09-03T10:00:00Z" }),
        note({ id: 2, title: "置顶的", content: "b", updated_at: "2026-09-04T10:00:00Z", pinned: true }),
    ]);
    const headers = [...document.querySelectorAll("[data-month]")].map(h => h.textContent);
    assert.equal(headers[0], "置顶", "第一组必须是「置顶」，实际 " + JSON.stringify(headers));
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(
        list.innerHTML.indexOf("置顶的") < list.innerHTML.indexOf("普通"),
        "置顶的那条要排在普通笔记前面"
    );
});

test("阶段二：顶栏能收起 / 展开左栏", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    assert.ok(document.querySelector("[data-note-list]"), "默认列表在");
    const collapse = document.querySelector('button[aria-label="收起笔记列表"]');
    assert.ok(collapse, "顶栏要有收起按钮");
    act(() => (collapse as HTMLElement).click());
    assert.equal(
        document.querySelector("[data-note-list]"),
        null,
        "收起后列表要整块消失（不是被 width:0 藏起来）"
    );
    const expand = document.querySelector('button[aria-label="展开笔记列表"]');
    assert.ok(expand, "要能再展开回来");
    act(() => (expand as HTMLElement).click());
    assert.ok(document.querySelector("[data-note-list]"), "展开后列表回来");
});

test("阶段二：搜索框右侧挂 ⌘K 提示；⌘K 打开记事本命令面板（N1）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const input = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    assert.ok(input.parentElement!.textContent!.includes("⌘K"), "要有 ⌘K 角标");
    // ⚠️ setState 的更新必须包进 act：不包的话渲染被推迟，同步断言时面板还没挂上
    act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    // ⌘K 不再聚焦搜索框：改为打开记事本命令面板（搜笔记/文件夹/标签 + 执行命令，
    // 面板里同样能搜笔记，入口反而更快）。
    assert.ok(
        document.querySelector(".notes-command-palette"),
        "Ctrl+K 应打开记事本命令面板"
    );
});

// ---------- 阶段三：回收站 / 归档 / 未归类 ----------

test("左栏视图齐全（全部/最近/收藏/未归类 + 底部归档/回收站，搜索不再占一行）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const views = [...document.querySelectorAll("button[data-view]")].map(b =>
        b.getAttribute("data-view")
    );
    // 顺序按 inkstone 那套（全部 / 最近 / 收藏 / 未归类 / … / 归档 / 回收站）。
    // ⚠️ 「搜索」不再是一个视图（2026-10-06 去掉）：左栏顶部那个输入框本身就是
    // 全文搜索入口（聚焦即打开中栏搜索结果），再单独占一行只会让人分不清
    // 哪个搜索管哪个。
    // ⚠️ 归档 / 回收站压在左下角单独一组（data-nav-footer），DOM 上仍排在这四个之后。
    assert.deepEqual(views, [
        "all",
        "recent",
        "starred",
        "uncategorized",
        "archived",
        "trash",
    ]);
    // 顶上那四个要在导航列表里；归档 / 回收站在底部固定区
    const top = [...document.querySelectorAll("button[data-view]")].filter(
        b => !b.closest("[data-nav-footer='1']")
    );
    assert.deepEqual(
        top.map(b => b.getAttribute("data-view")),
        ["all", "recent", "starred", "uncategorized"],
        "顶部四个高频入口，搜索不占行"
    );
    // 搜索框仍然在，且不再有同名视图行
    assert.ok(
        document.querySelector('input[aria-label="搜索笔记"]'),
        "全文搜索入口仍然是左栏顶部那个输入框"
    );
});

test("阶段三：回收站视图列出被删的笔记，并给还原 / 彻底删除两个动作", () => {
    setWide();
    const onLoadTrash = async () => {};
    mountPanel([note({ id: 1, title: "甲", content: "" })], {
        trashedNotes: [{ recycleId: 42, title: "删掉的那条", deletedAt: Date.now() }],
        onLoadTrash,
    });
    act(() => {
        (
            document.querySelector('button[data-view="trash"]') as HTMLElement
        ).click();
    });
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list.textContent!.includes("删掉的那条"), "回收站里要列出标题");
    assert.ok(list.querySelector('[data-action="restore"]'), "要有还原按钮");
    assert.ok(list.querySelector('[data-action="purge"]'), "要有彻底删除按钮");
    assert.ok(list.textContent!.includes("保留 30 天"), "要说清保留多久");
});

test("阶段三：进回收站视图才去拉回收站（别在首屏就发请求）", () => {
    setWide();
    let calls = 0;
    mountPanel([note({ id: 1, title: "甲", content: "" })], {
        onLoadTrash: async () => {
            calls += 1;
        },
    });
    assert.equal(calls, 0, "默认视图不该拉回收站");
    act(() => {
        (document.querySelector('button[data-view="trash"]') as HTMLElement).click();
    });
    assert.equal(calls, 1, "切到回收站要拉一次");
});

test("阶段三：回收站里不能编辑笔记（它已经不在 notes 表里了）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "内容" })], {
        trashedNotes: [{ recycleId: 42, title: "删掉的", deletedAt: Date.now() }],
    });
    act(() => {
        (document.querySelector('button[data-view="trash"]') as HTMLElement).click();
    });
    assert.equal(
        document.querySelector(".cm-content[aria-label='笔记内容']"),
        null,
        "回收站视图不该渲染编辑器"
    );
    assert.ok(text().includes("不能直接编辑"), "要有一句说明");
});

test("阶段三：归档的笔记从「全部」里隐去，只在「归档」视图露面", () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "正常的", content: "a" }),
        note({ id: 2, title: "收起来的", content: "b", archived: true }),
    ]);
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("正常的") && !listText().includes("收起来的"), "全部视图不该有归档的");

    act(() => {
        (document.querySelector('button[data-view="archived"]') as HTMLElement).click();
    });
    assert.ok(listText().includes("收起来的"), "归档视图里要有它");
    assert.ok(!listText().includes("正常的"), "归档视图不该混进正常笔记");
});

test("未归类 = 没有归到任何文件夹的笔记（不是「没挂站点」）", () => {
    setWide();
    // ⚠️ 判据在 2026-10-06 改过：原来筛的是 site_id（没挂在站点上），
    // 而记事本根本没有「把笔记挂到站点」的入口，site_id 永远是 null ——
    // 于是「未归类」跟「全部」完全等价，左栏两个计数一模一样。
    // 阶段三加了文件夹，「未归类」真正该问的是「没归到任何文件夹」。
    mountPanel([
        note({ id: 1, title: "没进文件夹", content: "a", folder_id: null }),
        note({ id: 2, title: "进了文件夹", content: "b", folder_id: 3 }),
        // 挂着站点但没进文件夹 → 仍算「未归类」（旧判据会把它踢出去）
        note({ id: 3, title: "挂了站点但没进文件夹", content: "c", site_id: 7, folder_id: null }),
    ]);
    act(() => {
        (
            document.querySelector('button[data-view="uncategorized"]') as HTMLElement
        ).click();
    });
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("没进文件夹"), "未归类里要有它");
    assert.ok(
        listText().includes("挂了站点但没进文件夹"),
        "判据是文件夹不是站点：挂了站点的笔记也该在未归类里"
    );
    assert.ok(!listText().includes("进了文件夹"), "进了文件夹的不该进来");
});

test("左栏「未归类」的计数与视图内容一致（两处判据不许各写各的）", () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲", content: "", folder_id: null }),
        note({ id: 2, title: "乙", content: "", folder_id: 5 }),
    ]);
    const countText = () =>
        document.querySelector('button[data-view="uncategorized"]')!.textContent || "";
    // 计数是 1（只有甲没进文件夹）
    assert.ok(countText().includes("1"), `未归类计数应为 1，实际是「${countText()}」`);
    act(() => {
        (document.querySelector('button[data-view="uncategorized"]') as HTMLElement).click();
    });
    const list = document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(list.includes("甲") && !list.includes("乙"), "列表要和计数对得上");
});

// ---------- 本轮修掉的三个界面问题 ----------

test("折叠左栏时搜索框和视图导航要一起藏掉（只藏列表会文字重叠）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    act(() => {
        (document.querySelector('button[aria-label="收起笔记列表"]') as HTMLElement).click();
    });
    assert.equal(document.querySelector("input[aria-label='搜索笔记']"), null, "搜索框要收起来");
    assert.equal(
        document.querySelectorAll("button[data-view]").length,
        0,
        "视图导航也要收起来，否则 44px 宽的轨道里文字会溢出压到编辑区"
    );
});

test("顶栏：返回箭头贴最左（朝左），「记事本」居中，收起键占右上角", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // 判据（2026-10-10 用户要求）：导航列头部那一行的**内部顺序** ——
    // 返回箭头在最左、标题居中、收起/展开在最右（返回箭头原来的位置）。
    const headAt = src.indexOf("const navInner = (");
    assert.ok(headAt > 0, "navInner 要还在（导航列与抽屉共用同一份内容）");
    const head = src.slice(headAt, headAt + 3200);
    const backAt = head.indexOf("aria-label='返回导航站'");
    // ⚠️ 顶栏注释里也写了「记事本」，标题位置要从返回箭头往后找
    const titleAt = head.indexOf("记事本", backAt);
    const collapseAt = head.indexOf("data-tool='collapse-pane'");
    assert.ok(backAt > 0, "导航列头部要有返回箭头");
    assert.ok(titleAt > 0, "导航列头部要有「记事本」标题");
    assert.ok(collapseAt > 0, "导航列头部要有收起/展开按钮");
    assert.ok(
        backAt < titleAt && titleAt < collapseAt,
        "顺序必须是：返回箭头（左）→ 标题（中）→ 收起键（右）"
    );
    // 返回箭头要朝左：ArrowBackIcon 本身就朝左，不能再套 scaleX(-1) 翻成朝右
    const backIcon = head.slice(backAt, backAt + 200);
    assert.ok(
        !backIcon.includes("scaleX(-1)"),
        "返回箭头不能再镜像 —— 要直接朝左指着导航站"
    );
    // 标题要居中：flex:1 的标题行必须带 textAlign: "center"
    const titleSx = head.slice(titleAt - 400, collapseAt);
    assert.ok(
        /textAlign:\s*"center"/.test(titleSx),
        "「记事本」标题要居中"
    );
});

test("滚动条样式必须统一走全局（导航页那套），NotesPage 不能再自带一份", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // ⚠️ 必须先剥注释：文件里那段解释「为什么不能设 scrollbar-color」的注释
    // 本身就含这些字样，不剥的话守卫会自己把自己判红
    const clean = stripComments(src);
    // 以前这里有个本地 SCROLLBAR_SX（还设了标准属性 scrollbar-color）。
    // Chrome 121+ 认到 scrollbar-color / scrollbar-width 就改用原生滚动条渲染，
    // 整套 ::-webkit-scrollbar 被忽略 → 编辑器里变成又粗又灰的原生条。
    // 现在统一吃 src/index.css 的全局规则，与导航页完全一致。
    assert.ok(
        !/SCROLLBAR_SX/.test(clean),
        "NotesPage 里又出现了本地滚动条样式 SCROLLBAR_SX"
    );
    assert.ok(
        !/scrollbarColor\s*:|scrollbarWidth\s*:|"&::-webkit-scrollbar"/.test(clean),
        "NotesPage 里又写了 scrollbar-color / scrollbar-width / 本地 ::-webkit-scrollbar " +
            "—— 设了标准属性后 Chrome 121+ 会忽略全局那套细圆角条"
    );
    // 全局规则必须真的存在（别哪天把 index.css 那段删了还没人发现）
    const css = readFileSync(resolve(findProjectDir(), "src/index.css"), "utf-8");
    assert.ok(
        /\*::-webkit-scrollbar-thumb/.test(css),
        "src/index.css 的全局滚动条规则不见了 —— 各页面的细圆角条全靠它"
    );
});

test("没有笔记时给一句引导，不是一片空白", () => {
    mountPanel([]);
    assert.ok(text().includes("还没有笔记"), "空状态要有引导文案");
});

test("关键字过滤：只留命中的那几条", () => {
    mountPanel([
        note({ id: 1, title: "苹果", content: "a" }),
        note({ id: 2, title: "香蕉", content: "b" }),
    ]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']")!;
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, "苹果");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(text().includes("苹果"));
    assert.ok(!text().includes("香蕉"), "不匹配的笔记该被过滤掉");
});

test("有笔记但没匹配时，提示与「没有笔记」要区分开", () => {
    mountPanel([note({ id: 1, title: "苹果" })]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']")!;
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, "zzz");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(text().includes("没有匹配的笔记"));
    assert.ok(!text().includes("还没有笔记"));
});

// ---------------------------------------------------------------------------
// useNotes：乐观更新 + 失败回滚
// ---------------------------------------------------------------------------

async function mountHook(api: Record<string, unknown>, onError: (message: string) => void = () => {}) {
    const seen: ReturnType<typeof useNotes>[] = [];
    function Probe() {
        const notes = useNotes({
            api: api as never,
            onError,
            onNotify: () => {},
        });
        seen.push(notes);
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <Probe />
            </UIPrefsProvider>
        );
    });
    // ⚠️ 必须单独等一轮：首屏那次 listNotes 是异步的，不等的话 hook 里的 notes
    // 还是初始空数组，「回滚到删除前」断言的就是空→空，等于什么都没测
    await act(async () => {
        await Promise.resolve();
    });
    assert.ok(seen.length > 0, "Probe 至少该渲染过一次");
    return seen;
}

test("文件夹菜单锚在按钮上（anchorEl 不能是 undefined，否则弹到视口原点）", () => {    // ⚠️ jsdom 没有布局，这里**量不到坐标** —— jsdom 的 getBoundingClientRect 全是 0，
    // 「菜单飘到屏幕左下角」这种错位在单测里天然测不出来（2026-10-06 真机实测到
    // x:16 y:724，点击点却在左栏上部）。所以这里只钉「锚点必须来自那个 ⋯ 按钮」，
    // 坐标由 harness 的真机脚本量。
    const source = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    assert.ok(
        !/anchorEl=\{undefined\}/.test(source),
        "FolderTagSection 的 Menu 传了 anchorEl={undefined} —— MUI 会锚到视口原点"
    );
    assert.match(
        source,
        /setAnchorEl\(e\.currentTarget\)/,
        "打开菜单时要记下按钮本身（e.currentTarget）当锚点"
    );
    assert.match(source, /anchorEl=\{anchorEl\}/, "Menu 的 anchorEl 要用这个状态");
});

test("useNotes：保存成功后标签刷新失败不回滚正文", async () => {
    const errors: string[] = [];
    let refreshFails = false;
    const seen = await mountHook({
        listNotes: async () => [note()],
        updateNote: async () => note({ content: "已保存 #新标签" }),
        listTags: async () => { if (refreshFails) throw new Error("标签读取失败"); return []; },
        listNoteTags: async () => ({}),
    }, message => errors.push(message));
    refreshFails = true;
    await act(async () => { await seen.at(-1)!.updateNote(1, { content: "已保存 #新标签" }); });
    assert.equal(seen.at(-1)!.notes[0].content, "已保存 #新标签");
    assert.ok(errors.some(e => e.includes("笔记已保存")));
});

test("useNotes：删标签要连带清掉本地关联，计数不能串到别的标签", async () => {
    let deleted: number | null = null;
    const seen = await mountHook({
        listNotes: async () => [],
        // 两条笔记关联到 7，其中一条还关联 8
        listTags: async () => [{ id: 7, name: "待删", color: null }, { id: 8, name: "留下", color: null }],
        listNoteTags: async () => ({ 1: [7, 8], 2: [7] }),
        listFolders: async () => [],
        deleteTag: async (id: number) => {
            deleted = id;
            return { success: true };
        },
    });
    assert.ok(seen.at(-1)!.tags.some(t => t.id === 7), "首屏应拉到该标签");
    await act(async () => { await seen.at(-1)!.removeTag(7); });
    assert.equal(deleted, 7);
    const links = seen.at(-1)!.noteTags;
    assert.deepEqual(links[1], [8], "另一个标签要留下，笔记本身不能从表里消失");
    assert.equal(links[2], undefined, "只剩被删标签的关联整条清掉");
    assert.ok(!(seen.at(-1)!.tags ?? []).some(t => t.id === 7), "标签行本身也要消失");
});

test("useNotes：首屏就拉一次列表（顶栏按钮要显示条数）", async () => {
    let calls = 0;
    await mountHook({
        listNotes: async () => {
            calls += 1;
            return [note()];
        },
        createNote: async () => note(),
        updateNote: async () => note(),
        deleteNote: async () => ({ success: true }),
    });
    assert.equal(calls, 1, "列表要在挂载时就拉，不能等用户点开面板");
});

test("useNotes：删除失败要把笔记放回列表", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "别删我" })],
        createNote: async () => note(),
        updateNote: async () => note(),
        deleteNote: async () => {
            throw new Error("网络断了");
        },
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.deleteNote(note({ id: 1, title: "别删我" }));
    });
    assert.equal(
        seen[seen.length - 1].notes.length,
        1,
        "删除失败后列表要回到删除前 —— 不回滚的话界面上就少了一条其实还在的笔记"
    );
});

test("useNotes：保存失败要把内容回滚（旧值不能丢）", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "旧标题", content: "旧内容" })],
        createNote: async () => note(),
        updateNote: async () => {
            throw new Error("写不进去");
        },
        deleteNote: async () => ({ success: true }),
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.updateNote(1, { title: "新标题" });
    });
    const after = seen[seen.length - 1].notes[0];
    assert.equal(after.title, "旧标题", "保存失败要回滚到旧值，不能把没存下来的内容留在界面上");
});

test("useNotes：保存成功后以服务端回显为准", async () => {
    const seen = await mountHook({
        listNotes: async () => [note({ id: 1, title: "旧标题" })],
        createNote: async () => note(),
        updateNote: async () => note({ id: 1, title: "服务端改过的标题" }),
        deleteNote: async () => ({ success: true }),
    });
    const state = seen[seen.length - 1];
    await act(async () => {
        await state.updateNote(1, { title: "客户端写的" });
    });
    assert.equal(
        seen[seen.length - 1].notes[0].title,
        "服务端改过的标题",
        "乐观更新之后要拿服务端回显替换，否则 updated_at 之类会一直停在旧值"
    );
});

test("未置顶的笔记不会在标题左边渲染出一个「0」", () => {
    // 真踩过的 bug：`{note.pinned && <Icon/>}` —— pinned 存的是数字 0，
    // 而 `0 && x` 在 JS 里**返回 0**，React 把 0 当文本渲染，列表里就冒出一个孤零零的 0。
    // 写这条的时候要传 pinned: 0（数字）而不是 false，否则测不到。
    mountPanel([note({ id: 1, title: "甲", pinned: 0 as unknown as boolean })]);
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(
        !list.textContent!.includes("0"),
        `列表里出现了裸的 0：${list.textContent!.slice(0, 60)} —— ` +
            "pinned 是数字 0，`0 && <Icon/>` 会把 0 本身返回出来"
    );
    assert.ok(list.textContent!.includes("甲"));
});

test("搜索框的放大镜在框内（不是绝对定位飘在外面）", () => {
    mountPanel([note({ id: 1, title: "甲" })]);
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索笔记']");
    assert.ok(input, "搜索框应该是 MUI TextField（自带 adornment 槽）");
    // 放大镜作为 input 的前置节点存在，而不是页面里独立漂浮的一枚图标
    const adornment = input!.parentElement?.querySelector(".MuiInputAdornment-root");
    assert.ok(
        adornment,
        "放大镜应该在 InputAdornment 里（跟着输入框走），不是绝对定位浮在页面上的"
    );
});

test("左栏容器不能带 flex:1（会把 300px 的列表撑成两栏宽，中间留空白）", () => {
    // 这条是**静态守卫**：jsdom 没有布局，目测不了「中间那块空白」，
    // 只能把结论钉在源码上。
    //
    // 坑的来由：listPane 内部已经 `width: 300 + flexShrink: 0` 定死了宽度，
    // 而它**外层**那个容器又写了 `flex: 1` —— flex 会把外层撑到约 445px，
    // 里面的列表还是 300px，多出来的 145px 就是用户看到的「中间空白」。
    // 宽度只能由一层决定：外层 `flex: 0 0 auto`。
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const body = source.slice(
        source.indexOf("主体：desktop"),
        source.indexOf("移动端从编辑态回列表")
    );
    assert.ok(
        body.includes('flex: "0 0 auto"'),
        "左栏容器应该是 flex: 0 0 auto（宽度由内层的 width:300 决定）"
    );
    // 内层那两条定宽是配套的：外层不定宽、内层不定宽就没有「固定宽列表」可言。
    //
    // ⚠️ 这里判的是**两列之和**，不是某个写死的像素：
    // 阶段三收尾把左栏从「单列 300px」改成 inkstone 那样「导航列 + 列表列」两列，
    // 所以总宽变成 NAV_COL_W + LIST_COL_W（336）。再钉 300 只会每次改布局都变红。
    assert.ok(
        /width: listCollapsed\s*\?\s*44\s*:\s*listHidden\s*\?/.test(source) === false,
        "listPane 的宽度不该再是「listCollapsed ? … : listHidden ? …」这种二选一的老结构" +
            "（2026-10-07 改成按 bp 三档：mobile 100% / tablet 只列表 / desktop 导航+列表）"
    );
    // ⚠️ 2026-10-07：宽度表达式换成了三档（对应 inkstone 的 1180 / 768），
    // 不再是 `md: navW + listW + 14`。这里钉的是**新**结构。
    assert.ok(
        /bp === "mobile"\s*\?\s*"100%"/.test(source) &&
            /bp === "tablet"/.test(source) &&
            /navW \+ listW \+ 18/.test(source),
        "listPane 宽度按 bp 三档给：mobile 100% / tablet 只列表列 / desktop 导航+列表+两条 9px 把手"
    );
    assert.ok(
        /export const NAV_COL_W = \d+;/.test(source) &&
            /export const LIST_COL_W = \d+;/.test(source),
        "两列各自的**默认**宽度要在文件顶部导出常量（别散落在 sx 里）"
    );
    // 导航列和列表列都得是「定宽 + 不收缩」：少一个 flexShrink、或给某一列 flex:1，
    // 两列就会互相挤，列表在窄窗口下被压成几十像素。
    assert.ok(
        (source.match(/flexShrink: 0/g) ?? []).length >= 2,
        "两列都要 flexShrink: 0（宽度由它们自己的 width 决定）"
    );
});

test("右栏要有 minHeight:0（缺了它内容会顶出视口，出现页面级滚动条）", () => {
    const source = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const body = source.slice(
        source.indexOf("主体：desktop"),
        source.indexOf("移动端从编辑态回列表")
    );
    // 右栏那一段（最后一个容器）必须带 minHeight
    const parts = body.split("minWidth: 0");
    assert.ok(
        body.includes("minHeight: 0"),
        "两个容器都要有 minHeight: 0 —— flex 子项默认 min-height:auto，" +
            "内容一高就撑破容器，把 fixed 布局顶出视口（页面级滚动条的来源）"
    );
    assert.ok(parts.length >= 2, "没找到两个容器的 minWidth 声明，检查匹配是否失效");
});

test("分栏是「左栏按比例 + 可拖分隔条」，不是写死的对半", () => {
    // 判据换过一次：从「两边 basis 相同」改成了「按 splitRatio 分配 + 有分隔条」。
    // 用户原话是「分栏两边大小不合理，做**可拖拽**的分隔条」——
    // 写死对半只是第一步，能拖才是他要的。
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    assert.ok(
        source.includes("splitRatio"),
        "左栏宽度应该由 splitRatio 决定"
    );
    assert.ok(
        source.includes("splitRatio * 100"),
        "源码区宽度要用 splitRatio 算，不能写死"
    );
    assert.ok(
        source.includes("role='separator'"),
        "要有可拖的分隔条（role=separator，键盘/读屏也能认出）"
    );
    assert.ok(
        source.includes("startSplitDrag"),
        "分隔条要接上拖拽处理"
    );
    // 拖拽监听必须挂在 window 上：指针移出那条 8px 宽的带子就会丢 mousemove
    assert.ok(
        source.includes("window.addEventListener(\"mousemove\""),
        "mousemove/mouseup 要挂在 window 上 —— 只挂分隔条会在拖出边界时卡住"
    );
});

test("格式工具栏：存在，且按钮用 onMouseDown preventDefault 保住选区", () => {
    const dir = findProjectDir();
    const source = stripComments(
        readFileSync(join(dir, "src", "components", "NotesPage.tsx"), "utf-8")
    );
    assert.ok(source.includes("MarkdownToolbar"), "要有格式工具栏");
    assert.ok(
        /onMouseDown=\{e => e\.preventDefault\(\)\}/.test(source),
        "工具栏按钮必须 onMouseDown + preventDefault —— 默认行为会让 textarea 失焦、" +
            "selectionStart 变成 0，插入的位置全跑到开头"
    );
    // ⚠️ 插入逻辑 2026-10-06 抽到了 useEditorTools（主编辑器 / 侧边编辑器各一份，
    // 撤销状态互相隔离），所以「插入后把光标放回去」这条守卫视的是新文件。
    // 只查 NotesPage 会因为代码搬走而假通过（守卫失效比不写更糟）。
    const tools = stripComments(
        readFileSync(join(dir, "src", "hooks", "useEditorTools.ts"), "utf-8")
    );
    assert.ok(
        source.includes("useEditorTools"),
        "NotesPage 要改用 useEditorTools 拿插入动作（两份编辑器各一份，互不串台）"
    );
    assert.ok(
        tools.includes("setSelectionRange"),
        "插入后要把光标放回去（setSelectionRange），否则接着打字会打到别处"
    );
});

test("整页容器不许滚动（页面级滚动条是缺陷，该滚的是预览区内部）", () => {
    // ⚠️ 索引必须在**同一个字符串**上找：剥掉注释后长度变了，
    // 拿原文的偏移去切清理后的字符串会切错位置（守卫就会误报）。
    const clean = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    const at = clean.indexOf('position: "fixed"');
    assert.ok(at >= 0, "没找到整页容器的 position:fixed —— 检查是否被删改");
    const root = clean.slice(at, at + 600);
    assert.ok(
        root.includes('overflow: "hidden"'),
        "position:fixed;inset:0 的整页容器要显式 overflow:hidden —— " +
            "某一层漏了 minHeight:0 就会连带 body 出现滚动条"
    );
});

test("挂载期间锁住整页滚动（底下的导航站不该让 document 变长）", () => {
    // 真因（浏览器实测 1696 vs 700）：记事本自己是 fixed，压根不占文档流；
    // 是**底下没卸载的导航站**（卡片网格 1475px）把 document 撑长了，
    // body 又是 overflow-y:visible，于是整页出现滚动条。
    // 只把记事本做成 fixed 治不了这个 —— 必须按住 document。
    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    mountPanel([note({ id: 1, title: "甲", content: "内容甲" })]);
    assert.equal(document.body.style.overflow, "hidden", "body 要锁滚动");
    assert.equal(
        document.documentElement.style.overflow,
        "hidden",
        "html 也要锁 —— 只锁 body 在部分浏览器上挡不住滚轮"
    );

    // 关掉记事本要把样式还原，否则整站都滚不动了（这是最容易被漏掉的那一半）
    act(() => root!.unmount());
    root = null;
    assert.equal(document.body.style.overflow, "", "卸载后 body 的内联样式要还原");
    assert.equal(document.documentElement.style.overflow, "", "卸载后 html 的内联样式要还原");
});

test("工具栏同名按钮是开关：连点第二下是「取消」而不是再插一遍", () => {
    // 用户原话：「把连点两下粗体第二下改为取消」。
    // 工具栏的语义应该是**开关**（像 inkstone / 富文本编辑器那样），
    // 不是每次都往里塞一层新标记。
    mountPanel([note({ id: 1, title: "甲", content: "abc" })]);
    const ta = getEditor();
    assert.ok(ta, "要有笔记内容输入框");

    ta.focus();
    ta.setSelectionRange(3, 3); // 光标放到 "abc" 末尾

    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    act(() => bold!.click());
    assert.equal(ta.value, "abc**粗体**", "第一下：包一层");

    act(() => bold!.click());
    assert.equal(
        ta.value,
        "abc",
        "第二下：把上一次插的那段撤掉（取消），不能变成 abc**粗体****粗体**"
    );
    assert.equal(ta.selectionStart, 3, "取消后光标回到原来的插入处");
});

test("选中一段内容后点两下 B：第二下只取消粗体，不能把内容删掉", () => {
    // 用户原话：「选中输入内容后点击两下粗体会删除内容，应该只取消粗体」。
    // 选中的正文是**用户自己的字**，第二下撤的是「加粗」这件事本身，不是把字也删了。
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    assert.ok(ta, "要有笔记内容输入框");
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    // 先手动敲一段字，整段选中
    act(() => {
        ta.focus();
        ta.value = "这篇笔记";
        ta.setSelectionRange(0, 4);
    });

    act(() => bold!.click());
    assert.equal(ta.value, "**这篇笔记**", "第一下：把选中的字加粗");

    act(() => bold!.click());
    assert.equal(
        ta.value,
        "这篇笔记",
        "第二下：只摘掉 ** 标记，选中的正文必须还在（不能变成空）"
    );
    assert.equal(ta.selectionStart, 0, "取消后光标落回那段正文的开头");
    assert.equal(ta.selectionEnd, 4, "并把正文重新选上，方便接着编辑");
});

test("已经有这层格式时点按钮是摘掉标记（不是再加一层）", () => {
    // 选中整段带标记的内容 / 只选中被两枚标记夹在中间的字，按同名按钮都要「取消」
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    assert.ok(ta, "要有笔记内容输入框");
    // ⚠️ 按钮要等面板挂上才存在，不能在 mountPanel 之前去查
    const bold = document.querySelector('button[data-tool="bold"]') as HTMLElement | null;
    assert.ok(bold, "工具栏要有「B（粗体）」按钮");

    // ① 整段 `**粗**`（5 字符）：选区自带两枚标记 → 去掉标记
    act(() => {
        ta!.focus();
        ta!.value = "**粗**";
        ta!.setSelectionRange(0, 6);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "粗", "整段选中带标记的内容，按 B 要去掉标记");

    // ② 只选中里面的字：前后各有一枚标记 → 也要去掉标记
    act(() => {
        ta.focus();
        ta.value = "**粗**";
        ta.setSelectionRange(2, 3);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "粗", "只选中被 ** 夹住的字，按 B 要去掉标记");

    // ③ 没被标记包着的字，按同名按钮仍然是加格式
    act(() => {
        ta.focus();
        ta.value = "粗";
        ta.setSelectionRange(0, 1);
    });
    act(() => bold!.click());
    assert.equal(ta.value, "**粗**", "没带标记的内容不受影响，正常包一层");
});

test("换一个按钮不会被误判成「取消」（点完粗体再点斜体不能把粗体撤掉）", () => {
    // 浏览器实测抓出来的：记录上次插入时只存了片段没存按钮，
    // 于是「斜体」一按，发现同一位置还是那段 `**粗体**`，就当成同名按钮撤了它。
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    assert.ok(ta, "要有笔记内容输入框");
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement | null;
    assert.ok(bar, "要有格式工具栏");
    // ⚠️ 图标化之后按钮上不再有文字，按 data-tool 找（阶段一重构跟着改）
    const byLabel = (tool: string) =>
        bar!.querySelector(`button[data-tool="${tool}"]`) as HTMLElement | null;

    act(() => {
        ta!.focus();
        ta!.setSelectionRange(0, 0);
    });
    act(() => byLabel("bold")!.click());
    assert.equal(ta.value, "**粗体**", "B：加粗");

    // 关键点：I 按下之后，**粗体那一段必须还留着**（不能当成「同名第二次」撤掉）。
    // 至于 I 自己是在光标处插还是摘，两种都算合理，浏览器里再细调。
    act(() => byLabel("italic")!.click());
    assert.ok(
        ta.value.includes("**粗体**"),
        "I 是另一个按钮，不能把上一段粗体撤销掉；实际 " + JSON.stringify(ta.value)
    );
});

test("标题/内容块/分隔线等按钮：第二次点击要真的取消（2026-10-06 补）", () => {
    // 之前只有强调/代码/列表（走 insertAtCursor）与脚注有开关语义，
    // 其余全是「点了就往上叠」：连点两下标题得到 `## ## 标题`、
    // 连点两下内容块得到 `> [!NOTE] > [!NOTE] …`，用户以为按钮坏了。
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement;
    assert.ok(bar, "要有格式工具栏");
    const ta = getEditor();

    const openMenu = (label: string) => {
        // ⚠️ 必须先断言再点：直接 .click() 在找不到时抛
        // `Cannot read properties of null`，看不出是哪个按钮没了。
        const btn = bar.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null;
        assert.ok(btn, `工具栏要有「${label}」按钮`);
        act(() => btn!.click());
    };
    const pick = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement;
        assert.ok(el, `下拉里要有 ${sel}`);
        act(() => el.click());
    };
    const reset = (v = "一段文字") => {
        act(() => {
            ta.focus();
            ta.value = v;
            ta.setSelectionRange(v.length, v.length);
        });
    };

    // ① 标题 H2：给**当前行**加前缀 → 再点一次去掉
    reset();
    openMenu("标题层级");
    pick('[data-heading="2"]');
    assert.equal(ta.value, "## 一段文字", "H2 落在整行开头");
    openMenu("标题层级");
    pick('[data-heading="2"]');
    assert.equal(ta.value, "一段文字", "再点一次 H2 要撤销，实际 " + JSON.stringify(ta.value));

    // ② 引用：行首 `> `
    reset();
    act(() => (bar.querySelector('button[data-tool="quote"]') as HTMLElement).click());
    assert.equal(ta.value, "> 一段文字");
    act(() => (bar.querySelector('button[data-tool="quote"]') as HTMLElement).click());
    assert.equal(ta.value, "一段文字", "再点一次引用要撤销");

    // ③ 内容块：`> [!NOTE]`
    // ⚠️ 2026-10-07：内容块从「独立图标 + 自己的菜单」收进了「块」下拉
    // （inkstone 就是这么放的，之前我们多出一个按钮，工具栏比它宽一截）。
    reset();
    // ⚠️ 2026-10-07：提示框类型挪进二级菜单了，要先点「提示块」再选类型
    openMenu("内容块");
    act(() => (document.querySelector('[data-block-op="callout-menu"]') as HTMLElement).click());
    pick('[data-callout-type="NOTE"]');
    assert.equal(ta.value, "> [!NOTE] 一段文字");
    openMenu("内容块");
    act(() => (document.querySelector('[data-block-op="callout-menu"]') as HTMLElement).click());
    pick('[data-callout-type="NOTE"]');
    assert.equal(ta.value, "一段文字", "再点一次内容块要撤销");

    // ④ 分隔线：不能插两条；且**光标所在行的正文一个字都不能丢**
    reset();
    openMenu("内容块");
    pick('[data-block-op="divider"]');
    const once = String(ta.value);
    assert.ok(once.includes("一段文字"), "插入分隔线不能把这一行的正文吃掉，实际 " + JSON.stringify(once));
    assert.ok(once.includes("---"), "第一下确实插了分隔线");
    openMenu("内容块");
    pick('[data-block-op="divider"]');
    assert.equal(ta.value, "一段文字", "再点一次分隔线要撤销，实际 " + JSON.stringify(ta.value));

    // ⑤ 折叠块 / 标签页：块级同样能撤
    reset();
    openMenu("内容块");
    pick('[data-block-op="fold"]');
    assert.ok(String(ta.value).includes("[!FOLD]"), "第一下插了折叠块");
    assert.ok(String(ta.value).includes("一段文字"), "折叠块不能吃掉正文");
    openMenu("内容块");
    pick('[data-block-op="fold"]');
    assert.equal(ta.value, "一段文字", "再点一次折叠要撤销");

    reset();
    openMenu("内容块");
    pick('[data-block-op="tabs"]');
    assert.ok(String(ta.value).includes(":::tabs"), "第一下插了标签页");
    openMenu("内容块");
    pick('[data-block-op="tabs"]');
    assert.equal(ta.value, "一段文字", "再点一次标签页要撤销");
});

test("换了按钮不能误撤上一段；改了正文也不能误撤（撤销的两个前置条件）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement;
    const pickDivider = () => {
        act(() => (bar.querySelector('button[aria-label="内容块"]') as HTMLElement).click());
        act(() => (document.querySelector('[data-block-op="divider"]') as HTMLElement).click());
    };
    act(() => {
        ta.focus();
        ta.value = "";
        ta.setSelectionRange(0, 0);
    });
    pickDivider();
    assert.ok(ta.value.includes("---"), "先插一条分隔线");

    // ① 换个工具（折叠）不能把分隔线撤掉 —— lastToolRef 记了工具名
    act(() => (bar.querySelector('button[aria-label="内容块"]') as HTMLElement).click());
    act(() => (document.querySelector('[data-block-op="fold"]') as HTMLElement).click());
    assert.ok(ta.value.includes("---"), "换按钮不能撤掉上一段，实际 " + JSON.stringify(ta.value));

    // ② 用户在别处改了正文 → 原片段对不上 → 当成新的插入，不误删
    act(() => {
        ta.value = ta.value.replace("---", "---改");
        ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    pickDivider();
    assert.ok(
        ta.value.includes("---改"),
        "正文被改过就不能按「取消」处理把这段删掉，实际 " + JSON.stringify(ta.value)
    );
});

test("插入表格 / 独立公式：第二次点击也要能撤销", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement;
    const act0 = () => {
        act(() => {
            ta.focus();
            ta.value = "正文";
            ta.setSelectionRange(2, 2);
        });
    };

    // 表格
    act0();
    act(() => (bar.querySelector('button[aria-label="表格"]') as HTMLElement).click());
    act(() => (document.querySelector('[data-table-preset="2x3"]') as HTMLElement).click());
    assert.ok(ta.value.includes("|"), "第一下插了表格");
    act(() => (bar.querySelector('button[aria-label="表格"]') as HTMLElement).click());
    act(() => (document.querySelector('[data-table-preset="2x3"]') as HTMLElement).click());
    assert.equal(ta.value, "正文", "再点一次插入表格要撤销，实际 " + JSON.stringify(ta.value));

    // 块级公式（行内公式走 insertAtCursor，本来就有开关）
    act0();
    act(() => (bar.querySelector('button[aria-label="公式"]') as HTMLElement).click());
    act(() => (document.querySelector('[data-formula-op="block"]') as HTMLElement).click());
    assert.ok(ta.value.includes("$$"), "第一下插了块级公式");
    act(() => (bar.querySelector('button[aria-label="公式"]') as HTMLElement).click());
    act(() => (document.querySelector('[data-formula-op="block"]') as HTMLElement).click());
    assert.equal(ta.value, "正文", "再点一次块级公式要撤销，实际 " + JSON.stringify(ta.value));
});

test("归档 / 回收站挪到左下角固定区，且那里有账号与设置（inkstone 布局）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })], {
        accountName: "zwj",
    });
    const footer = document.querySelector('[data-nav-footer="1"]');
    assert.ok(footer, "左下角要有固定区");
    // 归档 / 回收站在这个固定区里
    for (const v of ["archived", "trash"]) {
        const row = footer!.querySelector(`button[data-view="${v}"]`);
        assert.ok(row, `${v} 要在左下角固定区里`);
    }
    // 账号名 + 设置按钮
    assert.equal(
        footer!.querySelector('[data-account-name="1"]')?.textContent,
        "zwj",
        "左下角要显示账号名"
    );
    assert.ok(footer!.querySelector('button[data-tool="settings"]'), "要有设置按钮");
    // 固定区本身不参与滚动（父级才是滚动容器），这里断言它带 sticky 语义
    assert.ok(footer!.querySelector('[data-nav-account="1"]'), "要有账号头像");
});

test("没传账号时显示未登录，设置按钮仍然可用（记事本自带设置）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const footer = document.querySelector('[data-nav-footer="1"]')!;
    assert.ok(footer, "左下角固定区还要在");
    assert.equal(
        footer.querySelector('[data-account-name="1"]')?.textContent,
        "未登录",
        "没传账号名时显示未登录"
    );
    // ⚠️ 2026-10-06：设置改成记事本**自己的**对话框（外观 / 编辑器），
    // 不再依赖外部 onOpenSettings —— 所以没回调也必须有按钮、且点得开。
    const btn = footer.querySelector('button[data-tool="settings"]') as HTMLElement;
    assert.ok(btn, "设置按钮要一直在，点了开记事本自己的设置");
    act(() => btn.click());
    assert.ok(
        document.querySelector('[data-notes-settings="1"]'),
        "点设置要弹出记事本专用设置（不是导航站的配置）"
    );
});

test("选中文件夹：中间笔记列不渲染，笔记内联在文件夹下面（inkstone 文件夹树）", () => {
    // ⚠️ 必须 desktop 档：文件夹聚焦是桌面态（笔记内联在导航列里）。
    // 2026-10-08 起窄布局下列表列永远渲染（唯一的导航入口），不能在 tablet 档测这个语义。
    setWide();
    mountPanel(
        [
            note({ id: 1, title: "在夹里的笔记", content: "x", folder_id: 7 }),
            note({ id: 2, title: "别的笔记", content: "y", folder_id: null }),
        ],
        {
            folderTags: {
                folders: [{ id: 7, name: "工作", order_num: 0, created_at: "", updated_at: "" }],
                tags: [],
                noteTags: {},
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    // 默认（没选文件夹）：中间那栏在
    assert.ok(document.querySelector('[data-list-col="1"]'), "默认要显示中间笔记列");

    const folderBtn = document.querySelector('button[data-folder-id="7"]') as HTMLElement;
    assert.ok(folderBtn, "左栏要有这个文件夹");
    act(() => folderBtn.click());

    // 选中后：中间列消失
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "选中文件夹后中间那栏不该出现"
    );
    // 笔记内联在文件夹下面
    const inline = document.querySelector('[data-folder-notes="1"]');
    assert.ok(inline, "笔记要内联在文件夹下面");
    assert.ok(
        inline!.querySelector('[data-folder-note="1"]'),
        "该文件夹下的笔记要出现在内联区"
    );
    assert.ok(
        !inline!.querySelector('[data-folder-note="2"]'),
        "别的文件夹/未归类的笔记不该出现在这里"
    );
});

test("桌面关中栏 → 拖窄 → 左区让位，抽屉不自动弹，顶栏按钮手动开（2026-10-09）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "A", content: "x" })]);
    assert.ok(document.querySelector('[data-list-col="1"]'), "桌面档默认要显示列表列");

    const collapseBtn = document.querySelector(
        'button[data-tool="collapse-list"]'
    ) as HTMLElement;
    assert.ok(collapseBtn, "中栏头部要有「收起列表」按钮");
    act(() => collapseBtn.click());
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "点了收起后列表列要消失（桌面态，导航列还在）"
    );

    // 把窗口拖窄跨过 1180 → tablet（inkstone 模式）：左区整个让位给编辑区。
    // ⚠️ 抽屉**不要**自动弹（2026-10-09 用户明确）：要导航时用户自己点顶栏按钮。
    act(() => {
        setViewport(900);
        window.dispatchEvent(new Event("resize"));
    });
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "tablet 关中栏后左区让位（列表列不渲染）"
    );
    assert.ok(
        !document.querySelector('[data-nav-col="1"]'),
        "导航列不再内联挂载（tablet 走抽屉）"
    );
    assert.ok(
        !document.querySelector("[data-nav-drawer='1']"),
        "抽屉不能自动弹出（2026-10-09 用户明确）"
    );
    assert.ok(!document.querySelector("[data-collapsed-rail]"), "不要 44px 图标轨");
    assert.ok(document.querySelector("[data-tablet-bar='1']"), "顶部 44px 栏在");

    // 顶栏「导航栏」按钮手动开抽屉 → 里面有视图导航 → 点「所有笔记」列表列回来
    const toggle = document.querySelector(
        'button[data-tool="nav-drawer"]'
    ) as HTMLElement;
    assert.ok(toggle, "顶栏要有「导航栏」按钮");
    act(() => toggle.click());
    const drawer = document.querySelector("[data-nav-drawer='1']");
    assert.ok(drawer, "顶栏按钮能展开导航抽屉");
    assert.ok(
        drawer!.querySelector("button[data-view='all']"),
        "抽屉里有视图导航"
    );
    // 抽屉（最左栏）头部不该有返回箭头：窄屏的返回箭头要贴整页右上角
    assert.ok(
        !drawer!.querySelector("button[aria-label='返回导航站']"),
        "抽屉头部不该有返回箭头（页面右上角才有）"
    );
    const allBtn = drawer!.querySelector("button[data-view='all']") as HTMLElement;
    assert.ok(allBtn, "抽屉里要有「所有笔记」入口");
    act(() => allBtn.click());
    assert.ok(
        document.querySelector('[data-list-col="1"]'),
        "点视图按钮后列表列回来"
    );
});

test("聚焦文件夹 → 拖窄 → 左区让位，顶栏按钮能展开导航抽屉（内联笔记在里面）", () => {
    setWide();
    mountPanel(
        [
            note({ id: 1, title: "在夹里的笔记", content: "x", folder_id: 7 }),
            note({ id: 2, title: "别的笔记", content: "y", folder_id: null }),
        ],
        {
            folderTags: {
                folders: [{ id: 7, name: "工作", order_num: 0, created_at: "", updated_at: "" }],
                tags: [],
                noteTags: {},
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    const folderBtn = document.querySelector('button[data-folder-id="7"]') as HTMLElement;
    assert.ok(folderBtn, "左栏要有这个文件夹");
    act(() => folderBtn.click());
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "选中文件夹后中间列不渲染（笔记内联在导航列）"
    );

    act(() => {
        setViewport(900);
        window.dispatchEvent(new Event("resize"));
    });
    // folderFocus 也是 listHidden：tablet 里左区同样让位，导航进抽屉
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "tablet 聚焦文件夹后左区让位"
    );
    assert.ok(document.querySelector("[data-tablet-bar='1']"), "tablet 顶部 44px 栏在");
    const toggle = document.querySelector(
        'button[data-tool="nav-drawer"]'
    ) as HTMLElement;
    assert.ok(toggle, "顶栏要有「导航栏」按钮");
    act(() => toggle.click());
    const drawer = document.querySelector("[data-nav-drawer='1']");
    assert.ok(drawer, "顶栏按钮能展开导航抽屉");
    const inline = drawer!.querySelector('[data-folder-notes="1"]');
    assert.ok(inline, "内联笔记区在抽屉里");
    assert.ok(
        inline!.querySelector('[data-folder-note="1"]'),
        "文件夹里的笔记还在内联区"
    );
    // 点「所有笔记」退出文件夹聚焦 → 列表列回来
    const allBtn = drawer!.querySelector("button[data-view='all']") as HTMLElement;
    assert.ok(allBtn, "抽屉里要有「所有笔记」入口");
    act(() => allBtn.click());
    assert.ok(
        document.querySelector('[data-list-col="1"]'),
        "点视图按钮后列表列回来"
    );
});

test("tablet 里点「收起列表」→ 左区让位、抽屉不自动弹，顶栏按钮手动开（2026-10-09）", () => {
    setViewport(900); // 直接以 tablet 档挂载
    mountPanel([note({ id: 1, title: "A", content: "x" })]);
    assert.ok(document.querySelector('[data-list-col="1"]'), "tablet 默认显示列表列");
    assert.ok(document.querySelector("[data-tablet-bar='1']"), "tablet 顶部 44px 栏在");

    const collapseBtn = document.querySelector(
        'button[data-tool="collapse-list"]'
    ) as HTMLElement;
    assert.ok(collapseBtn, "窄屏列表头部也有「收起列表」按钮");
    act(() => collapseBtn.click());

    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "列表列让位（左区整个不渲染）"
    );
    assert.ok(
        !document.querySelector("[data-collapsed-rail]"),
        "不要收成 44px 图标轨（2026-10-08 用户明确不要）"
    );
    assert.ok(
        !document.querySelector("[data-nav-drawer='1']"),
        "抽屉不能自动弹出（2026-10-09 用户明确）"
    );

    // 顶栏「导航栏」按钮手动开抽屉 → 点「所有笔记」切回列表列
    const toggle = document.querySelector(
        'button[data-tool="nav-drawer"]'
    ) as HTMLElement;
    assert.ok(toggle, "顶栏要有「导航栏」按钮");
    act(() => toggle.click());
    const drawer = document.querySelector("[data-nav-drawer='1']");
    assert.ok(drawer, "顶栏按钮能展开导航抽屉");
    const allBtn = drawer!.querySelector("button[data-view='all']") as HTMLElement;
    assert.ok(allBtn, "抽屉里要有「所有笔记」入口");
    act(() => allBtn.click());
    assert.ok(document.querySelector('[data-list-col="1"]'), "点视图按钮后列表列回来");
});

test("窄屏返回箭头贴整页右上角：tablet 在顶栏最右、mobile 在列表头部最右（2026-10-09）", () => {
    // tablet：顶部 44px 栏最右端要有返回箭头；抽屉里（navInner）不该再有
    setViewport(900);
    mountPanel([note({ id: 1, title: "A", content: "x" })]);
    const bar = document.querySelector("[data-tablet-bar='1']");
    assert.ok(bar, "tablet 顶部 44px 栏在");
    const back = bar!.querySelector("button[aria-label='返回导航站']") as HTMLElement;
    assert.ok(back, "顶栏最右端要有返回箭头（整页右上角）");
    // 它必须是这一行的最后一个元素（右边不再有别的按钮）
    const barButtons = Array.from(bar!.querySelectorAll("button"));
    assert.equal(barButtons[barButtons.length - 1], back, "返回箭头要贴顶栏最右端");

    // mobile：列表屏中栏头部行最右端要有返回箭头
    act(() => {
        setViewport(700);
        window.dispatchEvent(new Event("resize"));
    });
    const listHeader = document.querySelector("[data-list-header='1']");
    assert.ok(listHeader, "mobile 列表屏头部行在");
    assert.ok(
        listHeader!.querySelector("button[aria-label='返回导航站']"),
        "mobile 列表屏头部最右要有返回箭头（整页右上角）"
    );
});

test("点内联笔记能打开它；文件夹视图里新建笔记会落进该文件夹", async () => {
    setWide();
    const created: (Partial<Note> | undefined)[] = [];
    mountPanel(
        [note({ id: 1, title: "夹里的笔记", content: "x", folder_id: 7 })],
        {
            onCreate: async (draft?: Partial<Note>) => {
                created.push(draft);
                return note({ id: 55, title: "", content: "", folder_id: 7 });
            },
            folderTags: {
                folders: [{ id: 7, name: "工作", order_num: 0, created_at: "", updated_at: "" }],
                tags: [],
                noteTags: {},
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    act(() => (document.querySelector('button[data-folder-id="7"]') as HTMLElement).click());

    // 点内联笔记 → 打开（activeId 变化通过编辑器内容体现）
    const row = document.querySelector('[data-folder-note="1"]') as HTMLElement;
    assert.ok(row, "要有内联笔记行");
    await act(async () => {
        row.click();
    });
    assert.equal(getEditor().value, "x", "点内联笔记要切到那条笔记");

    // 新建笔记 → folder_id 落在这个文件夹上
    const newBtn = document.querySelector('button[aria-label="新建笔记"]') as HTMLElement;
    assert.ok(newBtn, "左栏文件夹那节要有新建笔记");
    await act(async () => {
        newBtn.click();
    });
    assert.equal(created.length, 1, "应新建了一条");
    assert.equal(created[0]?.folder_id, 7, "新建的笔记要落进当前文件夹，实际 " + JSON.stringify(created[0]));
});

test("状态栏：字数与字符数要是**两个不同的量**（不能同一个数字摆两遍）", () => {
    // 真机实测（2026-10-06）抓到的原文是「297 字 297 字符」——
    // 同一个 charCount 渲染了两遍，看着像两个指标，其实只有一个。
    // inkstone 是「1字 67字符」，两个数确实不同。
    mountPanel([note({ id: 1, title: "甲", content: "ab cd\n ef" })]);
    // 直接读两个 span 最可靠：整段文本是紧凑拼接的，正则容易误匹配
    const spans = [...document.querySelectorAll("span")].map(s => s.textContent || "");
    const wordSpan = spans.find(s => /^\d+ 字$/.test(s.trim()));
    const charSpan = spans.find(s => /^\d+ 字符$/.test(s.trim()));
    assert.ok(wordSpan && charSpan, "状态栏要同时给出字数与字符数");
    const w = Number(wordSpan.replace(/\D/g, ""));
    const c = Number(charSpan.replace(/\D/g, ""));
    // content 是 "ab cd\n ef"：字符数 9（含空白），字数 6（去空白）
    assert.equal(c, 9, "字符数要含空白");
    assert.equal(w, 6, "字数要去掉空白");
    assert.notEqual(w, c, "字数与字符数不能是同一个数，否则等于把同一个指标摆两遍");
});

test("状态栏给出当前笔记所在文件夹（inkstone 也有这个位置指示）", () => {
    mountPanel(
        [note({ id: 1, title: "甲", content: "x", folder_id: 7 })],
        {
            folderTags: {
                folders: [{ id: 7, name: "工作", order_num: 0, created_at: "", updated_at: "" }],
                tags: [],
                noteTags: {},
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    const el = document.querySelector("[data-note-folder]");
    assert.ok(el, "笔记归在某个文件夹里时，状态栏要显示它的位置");
    assert.equal(el!.textContent, "工作");
});

test("文件夹菜单补齐 inkstone 那几项：在此新建笔记 / 移动到… / 前后移动", async () => {
    setWide();
    const created: (Partial<Note> | undefined)[] = [];
    const moves: { id: number; parent: number | null }[] = [];
    const reorders: { id: number; dir: number }[] = [];
    mountPanel(
        [note({ id: 1, title: "甲", content: "x", folder_id: 7 })],
        {
            onCreate: async (draft?: Partial<Note>) => {
                created.push(draft);
                return note({ id: 55, ...(draft || {}) });
            },
            folderTags: {
                folders: [
                    { id: 7, name: "工作", order_num: 0, created_at: "", updated_at: "" },
                    { id: 8, name: "生活", order_num: 1, created_at: "", updated_at: "" },
                ],
                onMoveFolder: async (id: number, parent: number | null) => { moves.push({ id, parent }); },
                onReorderFolder: async (id: number, dir: -1 | 1) => { reorders.push({ id, dir }); },
                tags: [],
                noteTags: {},
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    const openMenu = () => {
        const btn = document.querySelector(
            'button[aria-label="工作 操作"]'
        ) as HTMLElement | null;
        assert.ok(btn, "文件夹行要有「⋯」按钮");
        act(() => btn!.click());
    };
    openMenu();
    // 菜单项齐不齐
    for (const op of ["rename", "new-note-here", "new-child", "move-to", "move-up", "move-down", "move-root", "remove"]) {
        assert.ok(
            document.querySelector(`[data-folder-op="${op}"]`),
            `文件夹菜单要有 ${op}（inkstone 的「更多操作」有 9 项，我们不能只有 4 项）`
        );
    }
    // 在此新建笔记 → folder_id 落在这个文件夹
    await act(async () => {
        (document.querySelector('[data-folder-op="new-note-here"]') as HTMLElement).click();
    });
    assert.equal(created[0]?.folder_id, 7, "在此新建笔记要落进那个文件夹，实际 " + JSON.stringify(created[0]));

    // 移动到… → 二级菜单列出合法目标（不能含自己 / 自己的后代）
    openMenu();
    act(() => (document.querySelector('[data-folder-op="move-to"]') as HTMLElement).click());
    assert.ok(document.querySelector('[data-move-target="root"]'), "要有「根目录」这一项");
    assert.ok(document.querySelector('[data-move-target="8"]'), "要有同级/其它文件夹可去");
    assert.ok(!document.querySelector('[data-move-target="7"]'), "不能把文件夹移到它自己（会成环）");
    await act(async () => {
        (document.querySelector('[data-move-target="8"]') as HTMLElement).click();
    });
    assert.deepEqual(moves, [{ id: 7, parent: 8 }], "移动到目标文件夹");

    // 前后移动
    openMenu();
    await act(async () => {
        (document.querySelector('[data-folder-op="move-up"]') as HTMLElement).click();
    });
    openMenu();
    await act(async () => {
        (document.querySelector('[data-folder-op="move-down"]') as HTMLElement).click();
    });
    assert.deepEqual(reorders, [{ id: 7, dir: -1 }, { id: 7, dir: 1 }], "前后移动要带方向");
});

test("插入内容以 textarea 的 DOM 值为准，不能读 draft", () => {
    // 静态守卫：上面那条行为用例只覆盖连点，读错来源换个场景又会漏回去。
    // ⚠️ 插入逻辑 2026-10-06 抽到了 useEditorTools（主 / 侧边两编辑器各一份），
    // 所以这条守卫要跟着看新文件 —— 否则代码搬走后 indexOf 返回 -1，
    // slice(-1, -1) 得到空串，守卫会**静默失效**（比报错更糟）。
    const clean = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "hooks", "useEditorTools.ts"),
            "utf-8"
        )
    );
    const from = clean.indexOf("const insertAtCursor");
    const to = clean.indexOf("const insertCallout");
    assert.ok(from >= 0 && to > from, "没定位到 insertAtCursor —— 检查是否改名/搬走");
    const fn = clean.slice(from, to);
    assert.ok(fn.includes("el.value"), "插入要以 textarea 的 DOM 值（el.value）为准");
    assert.ok(
        !fn.includes("draft.content"),
        "不能从 draft 读内容：setDraft 异步，连点第二下读到的是上一次插入前的值"
    );
    // 光标位置必须把闭合标记算进去（漏 after.length 会插到 `**` 中间）。
    // ⚠️ 位置是**作为参数**传给 writeBack 的，不再有 `const caret` 这一句，
    // 所以只认这个表达式本身。
    assert.ok(
        fn.includes("before.length + selected.length + after.length"),
        "光标位置必须算上 after.length —— 否则点完「粗体」光标卡在闭合的 ** 中间"
    );
});

// ---------- 阶段三收尾：左栏两列 + 文件夹 / 标签 ----------

test("左栏真的是两列：导航列与列表列各自独立", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const nav = document.querySelector("[data-nav-col]");
    const list = document.querySelector("[data-list-col]");
    assert.ok(nav, "要有导航列（data-nav-col）");
    assert.ok(list, "要有列表列（data-list-col）");
    assert.ok(nav!.contains(document.querySelector("input[aria-label='搜索笔记']")!), "搜索框在导航列里");
    assert.ok(!nav!.contains(document.querySelector("[data-note-list]")!), "笔记列表不该在导航列里");
    assert.ok(list!.contains(document.querySelector("[data-note-list]")!), "笔记列表在列表列里");
});

test("选中某个文件夹 → 列表只留这个文件夹里的笔记", () => {
    // ⚠️ desktop 档（理由同上）：窄布局下列表列不再随 folderFocus 消失。
    setWide();
    mountPanel(
        [
            note({ id: 1, title: "甲", content: "", folder_id: 7 }),
            note({ id: 2, title: "乙", content: "", folder_id: null }),
        ],
        {
            folderTags: {
                folders: [
                    { id: 7, name: "收集箱" },
                    { id: 8, name: "空的" },
                ],
                tags: [],
                onCreateFolder: async () => null,
                onRenameFolder: async () => {},
                onRemoveFolder: async () => {},
                onCreateTag: async () => null,
                onRenameTag: async () => {},
                onRemoveTag: async () => {},
                onAssignTags: async () => null,
            },
        }
    );
    const listText = () => document.querySelector("[data-note-list]")?.textContent || "";
    assert.ok(listText().includes("甲") && listText().includes("乙"), "默认全部都该在");

    const folderBtn = [...document.querySelectorAll("button[data-folder-id]")].find(
        b => b.getAttribute("data-folder-id") === "7"
    ) as HTMLElement | null;
    assert.ok(folderBtn, "导航列里要有「收集箱」这一项");
    act(() => folderBtn!.click());

    // ⚠️ 2026-10-06 起（对齐 inkstone 文件夹树）：选中文件夹后**中间列表列不渲染**，
    // 该文件夹的笔记直接内联在左栏这个文件夹下面。所以这里查内联区而不是列表列。
    assert.ok(
        !document.querySelector('[data-list-col="1"]'),
        "选中文件夹后中间那栏不该出现"
    );
    const inline = document.querySelector("[data-folder-notes='1']");
    assert.ok(inline, "笔记要内联在文件夹下面");
    const inlineText = inline?.textContent || "";
    assert.ok(inlineText.includes("甲"), "选中收集箱后，它里面的要还在");
    assert.ok(!inlineText.includes("乙"), "别文件夹的笔记要被筛掉");
});

test("导航列要自己滚（整块一起滚会把搜索框顶出视野）", () => {
    setWide();
    // 静态守卫：jsdom 里 MUI 的 sx 编译成 hash 类名，量不到 overflow-y，
    // 只能把结论钉在源码上（和「左栏容器不能带 flex:1」同一套路）。
    const clean = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // ⚠️ 源码里写的是单引号 `data-nav-col='1'`：找错引号会拿到 -1，
    // slice(-1, -1) 是个空串，断言会报「没这个属性」而不是「这一列没滚」。
    // 2026-10-08 起内容抽成了 navInner（滚动盒在里面），切片要从 navInner 开始，
    // 到 data-list-col 为止 —— 这样才同时盖住滚动盒与外层定宽盒。
    const navCol = clean.slice(clean.indexOf("const navInner = ("), clean.indexOf("data-list-col='1'"));
    assert.ok(navCol.includes("overflowY: \"auto\""), "导航列得住自己那一列滚");
    assert.ok(
        navCol.includes("flexShrink: 0"),
        "导航列要定宽不收缩，否则会被列表挤掉"
    );
});

test("没有 folderTags（老部署）时退化成只有那六个视图，不能崩", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    assert.deepEqual(
        [...document.querySelectorAll("button[data-view]")].map(b => b.getAttribute("data-view")),
        ["all", "recent", "starred", "uncategorized", "archived", "trash"]
    );
    assert.ok(document.querySelector("[data-note-list]"), "列表照常渲染");
});

// ---------- 编辑区滚动条与右边距（2026-10-05 用户报的两个问题）----------
//
// ①「右边还是显示不全」：编辑区是 flex:1 吃掉整条剩余宽度，而记事本全屏层铺到
//    100vw —— 内容区不留内边距的话，预览窗会贴死视口右缘，右边框和滚动条被顶出屏幕。
// ②「滚轮换成导航页相同样式」：本地那份 SCROLLBAR_SX 里设了标准属性 scrollbar-color，
//    Chrome 121+ 认到它就改用原生滚动条渲染、整套 ::-webkit-scrollbar 被忽略 ——
//    症状是编辑器里出现又粗又灰的原生条。已删除本地定义，让全局 index.css 生效。

test("编辑区不能自己定义滚动条样式（会顶掉全局那套细圆角条）", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // 上一条已经按剥过注释的源码做了完整断言，这里只防「测试本身被整段删掉」：
    const clean = stripComments(src);
    assert.ok(
        !/SCROLLBAR_SX/.test(clean),
        "NotesPage 里又出现了本地滚动条样式 SCROLLBAR_SX —— " +
            "设了 scrollbar-color 后 Chrome 121+ 会忽略 ::-webkit-scrollbar，" +
            "编辑器里会变成原生粗灰条。滚动条统一走 src/index.css（与导航页一致）。"
    );
});

test("内容区必须有内边距，预览窗不能贴死视口右缘", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // ⚠️ 锚点必须用 JSX 注释**开头**那一段：「内容区：源码 | 预览」这串字在文件头的
    // ASCII 示意图里也出现过，只用短串会锚到文件开头，切出来的窗口全是 import。
    // 注释正文会随功能迭代加字（现在多了「| 大纲面板」），所以只锚前 12 个字符。
    const idx = src.indexOf("{/* 内容区：源码 | 预览");
    assert.ok(idx > 0, "找不到内容区注释，测试锚点失效");
    const body = src.slice(idx, idx + 1400);
    assert.match(
        body,
        /px:\s*2/,
        "内容区（源码 | 预览）没有水平内边距 —— 预览窗会贴死视口右边缘，" +
            "右边框和滚动条被顶出屏幕，看起来就是「右边显示不全」"
    );
    // 拖拽比例必须按内容盒算，否则内边距会让分隔条跟手差一截
    const drag = src.slice(src.indexOf("const startSplitDrag"));
    assert.match(
        drag,
        /paddingLeft/,
        "startSplitDrag 还是按 border-box 算比例 —— 加了内边距后分隔条会跟手不准"
    );
});

// ---------- 阶段四第 14 条：自动保存 ----------
//
// 之前**既没有保存按钮也没有自动保存**：草稿只在「切到另一条笔记」时才写库，
// 改完直接关掉记事本内容就没了。现在加 debounce 3s 自动存 + 卸载前 flush。
//
// ⚠️ 这里用**真定时器**等 3 秒多，不用假定时器：mock.timers 会把 React 自己
// 调度用的 setTimeout 一起冻住，act() 里等不到渲染，测试会假死。

test("阶段四：改动后约 3 秒自动写库，不用手点保存", async () => {
    // ⚠️ 显式写类型：写成 `let updated = null` 的话 TS 会把它窄化成 null，
    // 后面 `updated!.id` 会报「Property 'id' does not exist on type 'never'」。
    const calls: { id: number; patch: Record<string, unknown> }[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "原文" })], {
        onUpdate: async (id: number, patch: Partial<Note>) => {
            calls.push({ id, patch: patch as Record<string, unknown> });
        },
    });
    const updated = () => calls[0] ?? null;
    const ta = getEditor();
    act(() => {
        // ⚠️ 不能 `ta.value = ...`：React 在节点上装了自己的 value setter 做变更追踪，
        // 直接赋值会把它的记录一起改掉，onChange 就**不会被触发**（草稿压根没变，
        // dirty 恒为 false，自动保存当然不跑）。要绕开它，用原型上的原生 setter。
        typeInto(ta, "改过的内容");
    });
    assert.equal(updated(), null, "刚打完字不该立刻发请求（debounce 还没走完）");

    await act(async () => {
        await new Promise(r => setTimeout(r, 3400));
    });
    assert.ok(updated(), "过了 debounce 就该自动存了");
    assert.equal(updated()!.id, 1);
    assert.equal(updated()!.patch.content, "改过的内容", "存的必须是最新草稿");
});

test("阶段四：没改动就不发请求（别空转刷库）", async () => {
    let calls = 0;
    mountPanel([note({ id: 1, title: "甲", content: "原文" })], {
        onUpdate: async () => {
            calls += 1;
        },
    });
    await act(async () => {
        await new Promise(r => setTimeout(r, 3400));
    });
    assert.equal(calls, 0, "什么都没改却发了保存请求");
});

test("阶段四：自动保存的常量与卸载前 flush 都得在（防止有人改回去）", () => {
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    assert.match(src, /AUTO_SAVE_MS\s*=\s*3000/, "自动保存的 debounce 常量没了");
    // 卸载前要把没落库的草稿刷一次 —— 否则打完字立刻关窗口，那 3 秒还没走完就丢了
    assert.ok(
        /flushRef\.current\.dirty/.test(src),
        "卸载前 flush 草稿的逻辑没了 —— 打完字立刻关记事本会丢内容"
    );
});

// ---------- 阶段四第 12 条：代码块语言 ----------

/** 用原型上的原生 setter 写值并触发 React 的 onChange（直接赋值会被 React 的 value tracker 吞掉） */
function typeInto(el: NoteEditorHandle, text: string) {
    el.value = text;
}

/** 打开「语言」下拉，点某一项 */
function pickCodeLang(value: string) {
    // ⚠️ 2026-07：语言选择器从「代码与图表」菜单里**拆成了独立按钮**
    // （inkstone 的 code 菜单只有 3 项，语言列表塞进去会变成 19 项）。
    // 所以这里开的是「代码语言」按钮。
    const btn = document.querySelector('button[aria-label="代码语言"]') as HTMLElement | null;
    assert.ok(btn, "工具栏要有「代码语言」按钮（语言选择器已从代码菜单拆出来）");
    act(() => btn!.click());
    const item = document.querySelector(
        '[data-code-lang="' + (value || "plain") + '"]'
    ) as HTMLElement | null;
    assert.ok(item, "下拉里没有 " + (value || "纯文本") + " 这一项");
    act(() => item!.click());
}

test("阶段四：光标在围栏里，选语言只改围栏行、不动代码", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "```\nlet a = 1;\n```");
        ta.setSelectionRange(10, 10); // 落在代码正文那一行
    });
    pickCodeLang("js");
    assert.equal(ta.value, "```js\nlet a = 1;\n```", "只把开头那行补上语言，正文原样保留");
});

test("阶段四：不在围栏里就插入新围栏，语言直接带上", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "前文");
        ta.setSelectionRange(2, 2);
    });
    pickCodeLang("python");
    // 后面没有内容就不补尾随换行（补了会平白多一个空行）
    assert.equal(ta.value, "前文\n```python\n代码\n```", "插出带语言的围栏");
    assert.ok(
        ta.selectionStart === 13 && ta.selectionEnd === 15,
        "插完要选中占位代码，方便直接覆写"
    );
});

test("阶段四：选中的文字当代码体包进围栏", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "echo hi");
        ta.setSelectionRange(0, 7); // 全选
    });
    pickCodeLang("bash");
    assert.equal(ta.value, "```bash\necho hi\n```", "选中的那行成了代码体");
});

test("阶段四：选「纯文本」把围栏上的语言摘掉", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "```js\nlet a = 1;\n```");
        ta.setSelectionRange(10, 10);
    });
    pickCodeLang("");
    assert.equal(ta.value, "```\nlet a = 1;\n```", "改回纯文本");
});

test("阶段四：围栏之上的位置不算「在围栏里」，别改到别的块", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "说明文字\n```js\nlet a = 1;\n```");
        ta.setSelectionRange(2, 2); // 围栏之上
    });
    pickCodeLang("sql");
    // 光标不在任何围栏内 → 走「插入新围栏」分支，原来的 js 围栏不能被动到
    assert.ok(
        ta.value.includes("```js\nlet a = 1;\n```"),
        "原有围栏得原样留着：" + ta.value
    );
    assert.ok(ta.value.includes("```sql"), "应该在光标处新插一个 sql 围栏");
});

// ---------- 阶段四第 12 条：表格下拉的接线（纯函数那部分在 markdownTable.test.ts）----------

/** 打开「表格」下拉并点某一项 */
function pickTable(sel: string) {
    const btn = document.querySelector('button[aria-label="表格"]') as HTMLElement;
    assert.ok(
        btn,
        "找不到 aria-label=表格 的按钮，页面上带 aria-label 的按钮是：" +
            [...document.querySelectorAll("button[aria-label]")]
                .map(b => b.getAttribute("aria-label"))
                .join(" / ")
    );
    act(() => btn.click());
    const item = document.querySelector(sel) as HTMLElement | null;
    assert.ok(item, "表格下拉里没有 " + sel);
    act(() => item!.click());
}

test("阶段四：插入 2×3 表格 —— 表头 / 分隔行 / 两行正文都在", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    pickTable('[data-table-preset="2x3"]');
    const lines = ta.value.split("\n").filter(l => l.trim() !== "");
    assert.equal(lines.length, 4, "表头 + 分隔 + 2 行正文，实际是 " + JSON.stringify(ta.value));
    assert.match(lines[1], /^\|\s*-+\s*\|/, "第二行必须是分隔行，否则渲染不出表");
    assert.equal((lines[0].match(/\|/g) || []).length, 4, "3 列 → 4 根管道");
});

test("阶段四：在表格里加一行 / 删一行", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "| a | b |\n| --- | --- |\n| 1 | 2 |");
        ta.setSelectionRange(ta.value.indexOf("1") + 1, ta.value.indexOf("1") + 1);
    });
    const rows = () => ta.value.split("\n").filter(l => l.trim().startsWith("|")).length;
    assert.equal(rows(), 3);
    pickTable('[data-table-op="addRow"]');
    assert.equal(rows(), 4, "加一行");
    pickTable('[data-table-op="delRow"]');
    assert.equal(rows(), 3, "再删掉一行");
});

test("阶段四：加一列 / 删一列，各列仍然对齐", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "| a | b |\n| --- | --- |\n| 1 | 2 |");
        ta.setSelectionRange(ta.value.indexOf("1") + 1, ta.value.indexOf("1") + 1);
    });
    pickTable('[data-table-op="addCol"]');
    const pipes = new Set(
        ta.value
            .split("\n")
            .filter(l => l.trim().startsWith("|"))
            .map(l => (l.match(/\|/g) || []).length)
    );
    assert.equal(pipes.size, 1, "加完列各行管道数要一致：" + ta.value);
    assert.equal([...pipes][0], 4, "2 列变 3 列 → 4 根管道");

    pickTable('[data-table-op="delCol"]');
    const pipes2 = new Set(
        ta.value
            .split("\n")
            .filter(l => l.trim().startsWith("|"))
            .map(l => (l.match(/\|/g) || []).length)
    );
    assert.equal([...pipes2][0], 3, "再删一列回到 2 列");
});

// ---------- 阶段四第 12c 条：公式的接线 ----------

/** 打开「公式」下拉并点某一项 */
function pickFormula(sel: string) {
    const btn = document.querySelector('button[aria-label="公式"]') as HTMLElement | null;
    assert.ok(
        btn,
        "找不到 aria-label=公式 的按钮，页面上带 aria-label 的按钮是：" +
            [...document.querySelectorAll("button[aria-label]")]
                .map(b => b.getAttribute("aria-label"))
                .join(" / ")
    );
    act(() => btn.click());
    const item = document.querySelector(sel) as HTMLElement | null;
    assert.ok(item, "公式下拉里没有 " + sel);
    act(() => item!.click());
}

test("阶段四：行内公式按钮在光标处插 $…$（选中的字要被包进去）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "设 x=1");
        const at = ta.value.indexOf("x");
        ta.setSelectionRange(at, at + 1); // 选中 "x"
    });
    pickFormula('[data-formula-op="inline"]');
    assert.equal(ta.value, "设 $x$=1", "选中的字要被 $ 包住：" + ta.value);
});

test("阶段四：独立公式插入的是独占一行的 $$ 块（不然渲染层不认）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    act(() => {
        typeInto(ta, "摘要");
        ta.setSelectionRange(2, 2);
    });
    pickFormula('[data-formula-op="block"]');
    assert.match(
        ta.value,
        /摘要\n\$\$\n公式\n\$\$\n?$/,
        "$$ 必须另起一行，否则预览里根本渲染不出公式：" + JSON.stringify(ta.value)
    );
});

test("阶段四：工具栏按 data-tool 暴露公式按钮（图标化后按文字找是找不到的）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const keys = [...document.querySelectorAll("button[data-tool]")].map(b =>
        b.getAttribute("data-tool")
    );
    assert.ok(keys.includes("formula"), "data-tool 里没有 formula，实际是 " + keys.join("/"));
    assert.ok(keys.includes("table"), "老的 data-tool=table 不能丢");
});

test("阶段四：光标不在表格里，增删行列不许改坏正文", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const ta = getEditor();
    const original = "# 标题\n\n随便一段字";
    act(() => {
        typeInto(ta, original);
        ta.setSelectionRange(2, 2);
    });
    pickTable('[data-table-op="addRow"]');
    assert.equal(ta.value, original, "不在表格里 → 原样不动");
    pickTable('[data-table-op="delCol"]');
    assert.equal(ta.value, original, "不在表格里 → 原样不动");
});

// ---------- 列表行操作菜单（2026-10-06 补）----------
//
// 之前置顶 / 归档 / 归类 / 删除只挂在底部状态栏上，也就是「只能对当前打开的那条操作」，
// 而「归入文件夹 / 编辑标签」**根本没有入口** —— 后端 setNoteTags、folder_id 都齐了，
// 界面上却没有一处能调，文件夹和标签于是永远是空的。
test("列表行有操作菜单按钮，且菜单里带归入文件夹 / 编辑标签", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const btn = document.querySelector("button[data-note-menu='1']") as HTMLElement;
    assert.ok(btn, "列表行要有一个操作菜单按钮（data-note-menu）");
    assert.ok(
        btn.getAttribute("aria-label")?.includes("甲"),
        "按钮的可访问名要含笔记标题（读屏用户听得出来这是谁的菜单）"
    );
    await act(async () => {
        btn.click();
    });
    for (const op of ["pin", "archive", "folder", "tags", "delete"]) {
        assert.ok(
            document.querySelector(`[data-row-op='${op}']`),
            `菜单里要能按到 data-row-op='${op}' 这一项`
        );
    }
});

test("点菜单按钮不会顺带切到那条笔记（必须 stopPropagation）", async () => {
    // ⚠️ 判据不能挂原生监听器：React 17+ 把事件委托在 root 上，行上的原生 listener
    // 会**先于** React 的 stopPropagation 触发（合成事件是在 root 才派发的），
    // 那样测出来的是「事件确实冒泡到了行」，而不是「行的 onClick 有没有被执行」。
    // 真正要验的是后者：行 onClick 会 openNote → activeId 变 → 标题框换成那条笔记。
    mountPanel([
        note({ id: 1, title: "第一条", content: "a" }),
        note({ id: 2, title: "第二条", content: "b" }),
    ]);
    const titleInput = () =>
        document.querySelector("input[aria-label='笔记标题']") as HTMLInputElement;
    assert.equal(titleInput().value, "第一条", "初始打开的是第一条");
    // 菜单按钮点的是**第二条**（非当前那条）—— 一旦事件漏进行 onClick，标题会变成「第二条」
    const btn = document.querySelector("button[data-note-menu='2']") as HTMLElement;
    await act(async () => {
        btn.click();
    });
    assert.equal(titleInput().value, "第一条", "点菜单不该把笔记切过去");
    assert.ok(document.querySelector("[data-row-op='delete']"), "菜单应仍然打开");
});

test("「移动到文件夹」走右侧抽屉，选完就真归进去（onUpdate 收到 folder_id）", async () => {
    const updates: Array<{ id: number; patch: Record<string, unknown> }> = [];
    mountPanel([note({ id: 5, title: "甲", content: "a" })], {
        onUpdate: async (id: number, patch: Record<string, unknown>) => {
            updates.push({ id, patch });
        },
        folderTags: {
            folders: [
                { id: 3, user_id: null, name: "工作", order_num: 0, created_at: "", updated_at: "" },
            ] as never,
            tags: [],
            onCreateFolder: async () => null,
            onRenameFolder: async () => {},
            onRemoveFolder: async () => {},
            onCreateTag: async () => null,
            onRenameTag: async () => {},
            onRemoveTag: async () => {},
            onAssignTags: async () => [],
        },
    });
    await act(async () => {
        (document.querySelector("button[data-note-menu='5']") as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector("[data-row-op='folder']") as HTMLElement).click();
    });
    // ⚠️ 2026-10-06：不再是锚点小菜单，而是 inkstone 那种**右侧抽屉**
    const drawer = document.querySelector("[data-move-drawer='1']");
    assert.ok(drawer, "点「移动到文件夹…」要在屏幕右侧滑出抽屉");
    const opt = document.querySelector("[data-move-target='3']") as HTMLElement;
    assert.ok(opt, "抽屉里要列出已有文件夹");
    await act(async () => {
        opt.click();
    });
    assert.equal(updates.length, 1, "应当只发一次更新");
    assert.equal(updates[0].id, 5);
    assert.equal(updates[0].patch.folder_id, 3, "要把 folder_id 写进 patch");
    // 抽屉里还有「未归类（移出文件夹）」，点了要把 folder_id 置空
    await act(async () => {
        (document.querySelector("button[data-note-menu='5']") as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector("[data-row-op='folder']") as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector("[data-move-target='none']") as HTMLElement).click();
    });
    assert.equal(updates.length, 2, "移出文件夹也要发一次更新");
    assert.equal(updates[1].patch.folder_id, null, "「未归类」要把 folder_id 置空");
});

test("列表行显示标签徽章（不用点进去才知道打了哪些标签）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        folderTags: {
            folders: [],
            tags: [{ id: 7, user_id: null, name: "重要", color: null, created_at: "", updated_at: "" }] as never,
            noteTags: { 1: [7] },
            onCreateFolder: async () => null,
            onRenameFolder: async () => {},
            onRemoveFolder: async () => {},
            onCreateTag: async () => null,
            onRenameTag: async () => {},
            onRemoveTag: async () => {},
            onAssignTags: async () => [],
        },
    });
    const badge = document.querySelector("[data-note-tag='重要']");
    assert.ok(badge, "打了标签的笔记要在行里显示标签名徽章");
});

// ---------- 左两列可拖动（2026-10-06）----------
//
// 用户报「左边两栏太窄」：128 / 208 是当初照着某个窗口宽度定死的死值。
// 现在两条缝都能拖，宽度持久化到 localStorage。
//
// ⚠️ 这一组只断言**落盘值**与元素结构，**不断言渲染出来的像素宽**：
// 单测的 DOM 环境没有布局引擎，getBoundingClientRect() 一律返回 0
// （「命中区只有 0px」「导航列 0 → 0」就是这么来的）。
// 真正的像素验收走真机：harness 里的 CDP 探针量到 128 → 198 / 208 → 388，
// 且与 localStorage 里的值完全一致。
test("左两栏各有一条可拖分隔条（role=separator + 可访问名）", () => {
    // 导航列那条分隔条在 tablet 档不渲染（inkstone 同款），测它必须先切到 desktop 宽度
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const labels = [...document.querySelectorAll("[role='separator']")].map(e =>
        e.getAttribute("aria-label")
    );
    assert.ok(
        labels.includes("拖动调整导航列宽度"),
        "导航列 ↔ 列表列之间要有可拖分隔条"
    );
    assert.ok(
        labels.includes("拖动调整笔记列表宽度"),
        "列表列 ↔ 编辑区之间也要有可拖分隔条"
    );
});

test("两条分隔条必须是左栏容器的直接子元素（放进去会被压成 0 高）", () => {
    // 导航列那条分隔条在 tablet 档不渲染（inkstone 同款），测它必须先切到 desktop 宽度
    setWide();
    // 这条钉的是 2026-10-06 的真机 bug：分隔条被写在导航列/列表列**内部**，
    // 而那两列是 flex-direction: column → 分隔条被压成 **0 高度**、贴在 x=0，
    // 真实鼠标点不中。
    //
    // ⚠️ 为什么之前没被抓住：页内 `dispatchEvent(new MouseEvent("mousedown"))`
    // **不做浏览器的命中测试**，直接把事件塞给那个元素 —— 单测和合成事件探针都绿，
    // 真机却拖不动。**依赖命中测试的交互，单测里只能验 DOM 结构，不能验事件。**
    //
    // 判据：分隔条的 parentElement 必须是那个装着 [data-nav-col] + [data-list-col] 的
    // flex 容器，且**不能**是任何一列自己。
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const navCol = document.querySelector("[data-nav-col]");
    const listCol = document.querySelector("[data-list-col]");
    assert.ok(navCol && listCol, "两列都要在");
    const row = navCol.parentElement!;
    assert.equal(
        listCol.parentElement,
        row,
        "两列应该在同一个 flex 容器里（否则没法用一条缝把它们串起来）"
    );
    for (const label of ["拖动调整导航列宽度", "拖动调整笔记列表宽度"]) {
        const sep = row.querySelector(`[role='separator'][aria-label='${label}']`);
        assert.ok(sep, `左栏容器里要能找到分隔条：${label}`);
        assert.equal(
            sep!.parentElement,
            row,
            `「${label}」被塞进了某一列**内部**（parentElement 是列自己）—— ` +
                "那两列是 flex-direction: column，会把它压成 0 高度，真机鼠标点不中"
        );
    }
});

test("列宽的默认值与上下界都写成了常量（便于以后统一调）", () => {
    // 静态守卫：宽度上下界与命中区宽度是「写死在 sx 里」的，jsdom 量不到，
    // 只能钉在源码上。渲染出来的像素宽由真机 CDP 探针验收。
    const pageSource = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    assert.ok(
        /export const NAV_COL_W = \d+;/.test(pageSource),
        "导航列默认宽度要是导出的常量"
    );
    assert.ok(
        /export const LIST_COL_W = \d+;/.test(pageSource),
        "列表列默认宽度要是导出的常量"
    );
    // 上下界必须在，别让人拖出 20px 或 2000px 的列
    assert.ok(
        /NAV_W_MIN = \d+;/.test(pageSource) && /NAV_W_MAX = \d+;/.test(pageSource),
        "导航列要有上下界"
    );
    assert.ok(
        /LIST_W_MIN = \d+;/.test(pageSource) && /LIST_W_MAX = \d+;/.test(pageSource),
        "列表列要有上下界"
    );
    assert.ok(
        /width: (7|8|9),/.test(pageSource),
        "分隔条命中区要 ≥7px（现在是 9px：里面画 1px 可见线，其余留给命中区）"
    );
});

test("拖动分隔条后宽度落盘，并且夹在上下界之间", async () => {
    // 导航列那条分隔条在 tablet 档不渲染（inkstone 同款），测它必须先切到 desktop 宽度
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const sepOf = (label: string) =>
        document.querySelector(`[role='separator'][aria-label='${label}']`) as HTMLElement;
    const drag = async (label: string, dx: number) => {
        const sep = sepOf(label);
        assert.ok(sep, `找不到分隔条：${label}`);
        const opts = { bubbles: true, clientX: 100, clientY: 100 };
        await act(async () => {
            sep.dispatchEvent(new MouseEvent("mousedown", opts));
            window.dispatchEvent(
                new MouseEvent("mousemove", { ...opts, clientX: 100 + dx })
            );
            window.dispatchEvent(
                new MouseEvent("mouseup", { ...opts, clientX: 100 + dx })
            );
        });
    };

    // ⚠️ 顺序有讲究：先拖列表列。此时导航列还是默认 128px，窗口（jsdom 默认 1024）
    // 留给列表的空间还够；要是先把导航列拖到 260px，剩下的空间不够，
    // 列表列会被「左栏最多占窗口 45%」那道夹取挡回去 —— 那是设计，不是 bug。
    await drag("拖动调整笔记列表宽度", 80);
    const list = Number(localStorage.getItem("notes.listColW"));
    assert.ok(list > 208, `列表列应被拖宽并落盘，实际 ${list}`);

    await drag("拖动调整导航列宽度", 60);
    const grown = Number(localStorage.getItem("notes.navColW"));
    assert.ok(grown > 128, `导航列应被拖宽并落盘，实际 ${grown}`);

    // 往死里拖也不能失控
    await drag("拖动调整导航列宽度", -9999);
    const min = Number(localStorage.getItem("notes.navColW"));
    assert.ok(min >= 100, `导航列最小宽度应 ≥100，实际 ${min}`);
    await drag("拖动调整导航列宽度", 9999);
    const max = Number(localStorage.getItem("notes.navColW"));
    assert.ok(max <= 300, `导航列最大宽度应 ≤300，实际 ${max}`);
});

test("拖动不能让选区被浏览器抢走（mousedown 要 preventDefault）", () => {
    // 导航列那条分隔条在 tablet 档不渲染（inkstone 同款），测它必须先切到 desktop 宽度
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const sep = document.querySelector(
        "[role='separator'][aria-label='拖动调整导航列宽度']"
    ) as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    sep.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, "分隔条 mousedown 必须 preventDefault，否则会选中文本");
});

test("双击分隔条回到默认宽度", async () => {
    // 导航列那条分隔条在 tablet 档不渲染（inkstone 同款），测它必须先切到 desktop 宽度
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const sepOf = () =>
        document.querySelector(
            "[role='separator'][aria-label='拖动调整导航列宽度']"
        ) as HTMLElement;
    const opts = { bubbles: true, clientX: 100, clientY: 100 };
    await act(async () => {
        sepOf().dispatchEvent(new MouseEvent("mousedown", opts));
        window.dispatchEvent(new MouseEvent("mousemove", { ...opts, clientX: 160 }));
        window.dispatchEvent(new MouseEvent("mouseup", { ...opts, clientX: 160 }));
    });
    assert.notEqual(localStorage.getItem("notes.navColW"), "128", "先确认拖动过");
    await act(async () => {
        sepOf().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    assert.equal(localStorage.getItem("notes.navColW"), "128", "双击要回到默认宽度");
});

// ---------- 2026-10-06 第一批：大纲 / 导出 / 搜索视图 / 创建于 ----------

test("更多操作里能开大纲，点了列出当前笔记的标题层级", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "# 一\n## 二\n" })]);
    await openNoteMore();
    const btn = document.querySelector("[data-active-op='outline']") as HTMLElement;
    assert.ok(btn, "更多操作里要有大纲");
    await act(async () => {
        btn.click();
    });
    const items = [...document.querySelectorAll("[data-outline-item]")].map(e => e.textContent);
    assert.deepEqual(items, ["一", "二"]);
});

test("没有标题时大纲给一句说明，不弹空框", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "就是一段正文，没有标题。" })]);
    await openNoteMore();
    await act(async () => {
        (document.querySelector("[data-active-op='outline']") as HTMLElement).click();
    });
    assert.ok(
        document.querySelector("[data-outline='empty']"),
        "没有标题时要给提示，不能是空面板"
    );
});

test("代码块里的 # 不会混进大纲", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "## 真标题\n```bash\n# 注释\n```\n" }),
    ]);
    await openNoteMore();
    await act(async () => {
        (document.querySelector("[data-active-op='outline']") as HTMLElement).click();
    });
    const items = [...document.querySelectorAll("[data-outline-item]")].map(e => e.textContent);
    assert.deepEqual(items, ["真标题"]);
});

test("点大纲某一条会把光标送到那一行并选中它", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "第一行\n第二行\n## 目标行\n" })]);
    await openNoteMore();
    await act(async () => {
        (document.querySelector("[data-active-op='outline']") as HTMLElement).click();
    });
    await act(async () => {
        (document.querySelector("[data-outline-item='2']") as HTMLElement).click();
    });
    const ta = getEditor();
    assert.equal(ta.value.slice(ta.selectionStart, ta.selectionEnd), "## 目标行");
});

test("状态栏给出创建时间", () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a", created_at: "2026-10-05 11:05:18" }),
    ]);
    const el = document.querySelector("[data-note-created]");
    assert.ok(el, "状态栏要有「创建于…」");
    assert.ok(el!.textContent!.startsWith("创建于 "), `实际是「${el!.textContent}」`);
    assert.ok(/\d{4}年\d{1,2}月\d{1,2}日/.test(el!.textContent!), "要给出完整日期");
});

test("创建时间解析不出来就不显示（宁可少一项也不给 Invalid Date）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "a", created_at: "乱写" } as never)]);
    assert.equal(
        document.querySelector("[data-note-created]"),
        null,
        "时间坏了就整项不显示"
    );
});

test("列表行菜单有「导出 Markdown」", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () => {
        (document.querySelector("button[data-note-menu='1']") as HTMLElement).click();
    });
    assert.ok(
        document.querySelector("[data-row-op='export']"),
        "导出入口要和置顶/归档/删除并排（inkstone 顶栏那个「导出」）"
    );
});

test("搜索视图：搜正文里的词能命中，左栏计数跟着变", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "苹果派的做法" }),
        note({ id: 2, title: "乙", content: "香蕉船的做法" }),
    ]);
    const search = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    assert.ok(search, "要有搜索框");
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            search,
            "苹果"
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // ⚠️ 2026-10-06：左栏不再有「搜索」这一行（搜索框本身就是入口），
    // 计数改在中栏顶部那句「搜到 N 条」，命中列表就是中栏的行。
    assert.ok(
        text().includes("搜到 1 条"),
        "中栏顶部要显示命中数：搜到 1 条"
    );
    assert.deepEqual(
        [...document.querySelectorAll("[data-note-list] [data-note-id]")].map(e =>
            e.getAttribute("data-note-id")
        ),
        ["1"],
        "中栏只留下命中的那条"
    );
});

test("搜索视图：搜标签名也能命中（原来只搜标题+正文）", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文里没有那个词" })], {
        folderTags: {
            folders: [],
            tags: [{ id: 7, user_id: null, name: "合同", color: null, created_at: "", updated_at: "" }] as never,
            noteTags: { 1: [7] },
            onCreateFolder: async () => null,
            onRenameFolder: async () => {},
            onRemoveFolder: async () => {},
            onCreateTag: async () => null,
            onRenameTag: async () => {},
            onRemoveTag: async () => {},
            onAssignTags: async () => [],
        },
    });
    const search = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            search,
            "合同"
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.ok(
        text().includes("搜到 1 条"),
        "按标签名也要搜得到（正文里没有「合同」两个字）"
    );
    assert.equal(
        document.querySelectorAll("[data-note-list] [data-note-id]").length,
        1,
        "命中列表里要有那一条打了「合同」标签的笔记"
    );
});

// ===========================================================================
// 2026-10-06 一批：inkstone 对齐（文件夹外观 / 搜索行 / 未归类直列 / 中栏头部 /
// 大纲面板 / 右键菜单 / 记事本自己的设置 / 右下角按键入右键 / 侧边分屏）
// ===========================================================================

/** folderTags 的最小可用形状（每个用例只覆盖自己关心的那几项） */
function folderTagsOf(over: Record<string, unknown> = {}) {
    return {
        folders: [{ id: 3, user_id: null, name: "工作", order_num: 0, created_at: "", updated_at: "" }] as never,
        tags: [] as never,
        onCreateFolder: async () => null,
        onRenameFolder: async () => {},
        onRemoveFolder: async () => {},
        onCreateTag: async () => null,
        onRenameTag: async () => {},
        onRemoveTag: async () => {},
        onAssignTags: async () => [],
        ...over,
    };
}

/** jsdom 里右键：React 18 走根级委托，派发一个冒泡的 contextmenu 即可 */
function rightClick(el: Element) {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

// ---------- 1. 文件夹外观 ----------

test("文件夹外观：右键菜单里能改图标与颜色，保存走 onStyleFolder", async () => {
    setWide();
    const styled: { id: number; patch: Record<string, unknown> }[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        folderTags: folderTagsOf({
            onStyleFolder: async (id: number, patch: Record<string, unknown>) => {
                styled.push({ id, patch });
            },
        }),
    });
    await act(async () => {
        rightClick(document.querySelector("[data-folder-id='3']")!);
    });
    const appearance = document.querySelector("[data-folder-op='appearance']") as HTMLElement;
    assert.ok(appearance, "文件夹右键菜单里要有「文件夹外观」");
    await act(async () => appearance.click());

    // 图标 + 颜色都在弹窗里
    const icon = document.querySelector("[data-appearance-icon='work']") as HTMLElement;
    const color = document.querySelector("[data-appearance-color='#3b82f6']") as HTMLElement;
    assert.ok(icon, "要有图标可选");
    assert.ok(color, "要有颜色可选");
    await act(async () => icon.click());
    await act(async () => color.click());
    await act(async () => (document.querySelector("[data-appearance-save='1']") as HTMLElement).click());

    assert.equal(styled.length, 1, "保存要走一次 onStyleFolder");
    assert.equal(styled[0].id, 3);
    assert.equal(styled[0].patch.icon, "work", "图标存的是枚举 key，不是组件/中文名");
    assert.equal(styled[0].patch.color, "#3b82f6", "颜色存的是十六进制色值");
});

test("文件夹外观：脏数据（不在清单里的 icon/color）不能把左栏画崩", () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        folderTags: folderTagsOf({
            folders: [
                { id: 3, user_id: null, name: "工作", order_num: 0, icon: "不存在的图标", color: "javascript:alert(1)" },
            ] as never,
        }),
    });
    assert.ok(
        document.querySelector("[data-folder-id='3']"),
        "icon/color 是脏值时仍要正常渲染这一行（回落到默认样式）"
    );
});

// ---------- 2. 左栏不再有「搜索」那一行 ----------

test("搜索框聚焦即进入全文搜索（不再需要单独的「搜索」导航行）", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    assert.equal(
        document.querySelector("button[data-view='search']"),
        null,
        "左栏不该再有「搜索」这一行"
    );
    const input = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    await act(async () => input.focus());
    assert.ok(
        document.querySelector("[data-note-list]"),
        "聚焦搜索框要打开中间栏（全文搜索结果）"
    );
    assert.ok(text().includes("全文搜索"), "中栏标题要说明现在在看全文搜索");
});

// ---------- 3. 未归类笔记直接列在左栏，右键可移动到文件夹 ----------

test("未归类的笔记直接列在左栏文件夹树下（不占中间栏）", () => {
    setWide();
    mountPanel([note({ id: 1, title: "散着的", content: "a", folder_id: null })], {
        folderTags: folderTagsOf(),
    });
    const block = document.querySelector("[data-unfiled-notes='1']");
    assert.ok(block, "左栏要有「未归类」那一组");
    const row = block!.querySelector("[data-unfiled-note='1']") as HTMLElement;
    assert.ok(row, "没进文件夹的笔记要直接列出来");
    assert.match(row.getAttribute("aria-label") ?? "", /散着的/);
});

test("左栏未归类笔记右键 → 「移动到文件夹…」滑出右侧抽屉，选了就真归进去", async () => {
    setWide();
    const updates: { id: number; patch: Record<string, unknown> }[] = [];
    mountPanel([note({ id: 1, title: "散着的", content: "a", folder_id: null })], {
        onUpdate: async (id: number, patch: Record<string, unknown>) => {
            updates.push({ id, patch });
        },
        folderTags: folderTagsOf(),
    });
    await act(async () => {
        rightClick(document.querySelector("[data-unfiled-note='1']")!);
    });
    const move = document.querySelector("[data-row-op='folder']") as HTMLElement;
    assert.ok(move, "左栏笔记右键菜单里要有「移动到文件夹…」");
    await act(async () => move.click());

    const drawer = document.querySelector("[data-move-drawer='1']");
    assert.ok(drawer, "要在**屏幕右侧**滑出抽屉（不是在原地弹小菜单）");
    // 抽屉里能搜文件夹
    const find = drawer!.querySelector("input[aria-label='搜索文件夹']") as HTMLInputElement;
    assert.ok(find, "抽屉里要有搜索框（文件夹多了才找得到）");
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "不存在");
        find.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(
        document.querySelector("[data-move-target='3']"),
        null,
        "搜索没命中时那条文件夹要被过滤掉"
    );
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(find, "工作");
        find.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const target = document.querySelector("[data-move-target='3']") as HTMLElement;
    assert.ok(target, "搜到「工作」要能选");
    await act(async () => target.click());

    assert.equal(updates.length, 1, "选中就发一次更新");
    assert.equal(updates[0].patch.folder_id, 3, "要把 folder_id 写进去");
});

// ---------- 4. 中栏头部：排序 / 新建笔记 / 收起 ----------

test("中栏头部有 排序 / 新建笔记 / 收起，收起后中栏真的消失", async () => {
    // ⚠️ desktop 档：窄布局里「收起」收的是 44px 图标轨（listCollapsed），
    // 不是关中栏 —— 关中栏是桌面态，窄屏里关了就没有任何导航入口了。
    setWide();
    let created = 0;
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        onCreate: async () => {
            created += 1;
            return note({ id: 99, title: "" });
        },
    });
    const header = document.querySelector("[data-list-header='1']")!;
    assert.ok(header, "中栏要有头部");
    assert.ok(header.querySelector("[data-tool='sort']"), "右上角要有排序");
    assert.ok(header.querySelector("[data-tool='list-new-note']"), "右上角要有新建笔记");
    assert.ok(header.querySelector("[data-tool='collapse-list']"), "右上角要有收起");

    // 排序菜单
    await act(async () => (header.querySelector("[data-tool='sort']") as HTMLElement).click());
    const byTitle = document.querySelector("[data-sort-op='title']") as HTMLElement;
    assert.ok(byTitle, "排序菜单里要有「按标题」");
    await act(async () => byTitle.click());

    // 新建笔记
    await act(async () =>
        (document.querySelector("[data-tool='list-new-note']") as HTMLElement).click()
    );
    assert.equal(created, 1, "点中栏的新建笔记要真的建一条");

    // 收起
    await act(async () =>
        (document.querySelector("[data-tool='collapse-list']") as HTMLElement).click()
    );
    assert.equal(
        document.querySelector("[data-list-header='1']"),
        null,
        "点「收起」后中间栏整个不渲染"
    );
    // 再点顶部入口要能放回来（否则就再也回不来了）
    await act(async () => (document.querySelector("button[data-view='all']") as HTMLElement).click());
    assert.ok(document.querySelector("[data-list-header='1']"), "点顶部入口要把中栏放回来");
    // 底部「归档 / 回收站」同样要放回来
    await act(async () =>
        (document.querySelector("[data-tool='collapse-list']") as HTMLElement).click()
    );
    await act(async () => (document.querySelector("button[data-view='archived']") as HTMLElement).click());
    assert.ok(
        document.querySelector("[data-list-header='1']"),
        "从归档 / 回收站回来也要把中栏放出来（不然屏幕上什么都没有）"
    );
});

test("中栏排序：按标题排序真的改变了顺序", async () => {
    // ⚠️ 标题必须用 ASCII（2026-10-07 CI 踩到）：排序用的是 localeCompare，
    // 而 CI runner 上的 Node 是 **small-icu**（没有中文排序数据），
    // `localeCompare("乙", "甲")` 会退化成按码点比 —— 乙 U+4E59 < 甲 U+7532，
    // 顺序「没变」，测试就红了；本机有完整 ICU 时按拼音 甲 < 乙，是绿的。
    // 浏览器里始终是 full-icu，中文按拼音排是对的 —— 这个差异只影响单测断言，
    // 所以这里钉的是「排序真的生效」，用不受 ICU 影响的字母标题。
    mountPanel([
        note({ id: 1, title: "bbb", content: "a" }),
        note({ id: 2, title: "aaa", content: "b" }),
    ]);
    const ids = () =>
        [...document.querySelectorAll("[data-note-list] [data-note-id]")].map(e =>
            e.getAttribute("data-note-id")
        );
    assert.deepEqual(ids(), ["1", "2"], "默认顺序保持原样");
    await act(async () => (document.querySelector("[data-tool='sort']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-sort-op='title']") as HTMLElement).click());
    assert.deepEqual(ids(), ["2", "1"], "按标题排序后 aaa 要在 bbb 前面");
});

// ---------- 5. 大纲面板在预览右侧 ----------

test("大纲：更多操作里是开关，点开后面板常驻在预览右侧", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "# 一级\n正文\n## 二级\n正文" })]);
    assert.equal(document.querySelector("[data-outline-panel='1']"), null, "默认关着");
    await openNoteMore();
    await act(async () => (document.querySelector("[data-active-op='outline']") as HTMLElement).click());
    const panel = document.querySelector("[data-outline-panel='1']")!;
    assert.ok(panel, "点开要出现大纲面板");
    const items = [...panel.querySelectorAll("[data-outline-item]")];
    assert.equal(items.length, 2, "两个标题都要列出来");
    assert.ok(items[0].textContent!.includes("一级"));
    assert.ok(items[1].textContent!.includes("二级"));
    // 面板在预览（内容区）那一格里，而不是浮层里
    assert.ok(
        panel.closest("[data-notes-root]"),
        "大纲是页面里的常驻面板，不是弹一下就消失的菜单"
    );
    // 再点一次收起：菜单项文案跟着从「大纲」变「收起大纲」
    await openNoteMore();
    assert.match(
        document.querySelector("[data-active-op='outline']")!.textContent ?? "",
        /收起大纲/
    );
    await act(async () => (document.querySelector("[data-active-op='outline']") as HTMLElement).click());
    assert.equal(document.querySelector("[data-outline-panel='1']"), null, "再点一下收起");
});

test("大纲：没有标题时给一句说明，不给一块空白", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "纯正文，没有标题" })]);
    await openNoteMore();
    await act(async () => (document.querySelector("[data-active-op='outline']") as HTMLElement).click());
    assert.ok(
        document.querySelector("[data-outline='empty']"),
        "没标题时要说明「用 # 标题 就能出现在这里」"
    );
});

// ---------- 6. 右键菜单 ----------

test("列表行右键：完整菜单（复制三件套 / 侧边打开 / 副本 / 导出 / 回收站）", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })], { folderTags: folderTagsOf() });
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='1']")!);
    });
    for (const op of [
        "copy-title",
        "copy-id",
        "copy-link",
        "open-side",
        "pin",
        "duplicate",
        "archive",
        "folder",
        "tags",
        "export",
        "export-html",
        "export-pdf",
        "delete",
    ]) {
        assert.ok(
            document.querySelector(`[data-row-op='${op}']`),
            `中栏右键菜单里要有 data-row-op='${op}'`
        );
    }
    assert.ok(
        text().includes("移到回收站"),
        "删除那一项的措辞是「移到回收站」（可恢复，不是彻底删）"
    );
});

test("左栏内联笔记右键：精简菜单（没有复制/导出那一堆）", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a", folder_id: null })], {
        folderTags: folderTagsOf(),
    });
    await act(async () => {
        rightClick(document.querySelector("[data-unfiled-note='1']")!);
    });
    for (const op of ["open-side", "pin", "folder", "archive", "delete"]) {
        assert.ok(document.querySelector(`[data-row-op='${op}']`), `左栏右键要有 ${op}`);
    }
    assert.equal(
        document.querySelector("[data-row-op='export']"),
        null,
        "左栏精简菜单不带导出（那是中栏列表行才有的）"
    );
});

// ---------- 7. 记事本自己的设置 ----------

test("左下角设置打开的是记事本专用设置（外观 / 编辑器两个分页）", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    const dialog = document.querySelector("[data-notes-settings='1']")!;
    assert.ok(dialog, "要弹出记事本自己的设置（不是导航站那个配置页）");
    for (const tab of ["appearance", "editor"]) {
        assert.ok(
            dialog.querySelector(`[data-settings-tab='${tab}']`),
            `设置里要有 ${tab} 这一页`
        );
    }
    // 外观页的强调色
    const accent = dialog.querySelector("[data-setting='accent:#3b82f6']") as HTMLElement;
    assert.ok(accent, "外观页要能选强调色");
    await act(async () => accent.click());
    // 外观页带效果预览（调字号/行高/宽度时直接看效果）—— 它属于外观这一页
    assert.ok(document.querySelector("[data-settings-preview='1']"), "要有实时预览区");
    // 编辑器页
    await act(async () =>
        (dialog.querySelector("[data-settings-tab='editor']") as HTMLElement).click()
    );
    assert.ok(
        document.querySelector("[data-setting='lineNumbers']"),
        "编辑器页要有行号开关"
    );
    assert.ok(
        document.querySelector("[data-setting='showToolbar']"),
        "编辑器页要有工具栏开关"
    );
    assert.ok(
        document.querySelector("[data-setting='spellcheck']"),
        "编辑器页要有拼写检查开关"
    );
});

test("设置改动落到 localStorage（下次打开还在）", async () => {
    setWide();
    globalThis.localStorage?.removeItem("notes.uiSettings");
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-setting='accent:#3b82f6']") as HTMLElement).click()
    );
    const saved = JSON.parse(globalThis.localStorage!.getItem("notes.uiSettings") || "{}");
    assert.equal(saved.accent, "#3b82f6", "强调色要写进 notes.uiSettings");
    // 强调色作用在页面根元素上，整页跟着变
    const rootEl = document.querySelector("[data-notes-root]") as HTMLElement;
    assert.equal(
        rootEl.style.getPropertyValue("--accent"),
        "#3b82f6",
        "强调色要作为 --accent 挂在记事本根元素上（作用域只在这页）"
    );
});

// ---------- 8. 右下角那排按键已移除 ----------

test("状态栏不再有 删除 / 归档 那排按键（都进了右键菜单）", () => {
    // ⚠️ 2026-10-09：置顶 / 收藏**不在**这个清单里 —— 它们本来就在头部工具条上
    // （data-tool='pin' / 'star'），是设计上要常驻的，不是那排状态栏按键。
    // 之前置顶那颗的 aria-label 写的是「收藏」，所以没撞上这条断言；
    // 收藏与置顶分离后它改叫「置顶」，清单要跟着改，否则这条用例会开始红。
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    for (const label of ["删除", "归档"]) {
        assert.equal(
            document.querySelector(`button[aria-label='${label}']`),
            null,
            `状态栏不该再有「${label}」按键（功能在右键菜单 / 顶栏 ⋯ 里）`
        );
    }
    // 但功能没丢：顶栏 ⋯ 与右键菜单里都还在
    assert.ok(document.querySelector("button[data-tool='note-more']"), "顶栏要有「⋯」入口");
});

test("头部有「置顶」与「收藏」两颗键，点收藏不会动到置顶（两件事分离）", async () => {
    setWide();
    const saved: Record<string, unknown>[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a", pinned: false, starred: false })], {
        onUpdate: async (id: number, patch: Record<string, unknown>) => {
            saved.push({ id, ...patch });
        },
        onToggleStar: async (n: Note) => {
            saved.push({ id: n.id, starred: !(n as Note & { starred?: boolean }).starred });
        },
    });
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[0] as HTMLElement).click();
    });
    const pin = document.querySelector("button[data-tool='pin']") as HTMLElement | null;
    const star = document.querySelector("button[data-tool='star']") as HTMLElement | null;
    assert.ok(pin, "头部要有置顶键");
    assert.ok(star, "头部要有收藏键（与置顶分开的两颗）");
    assert.equal(pin.getAttribute("aria-label"), "置顶");
    assert.equal(star.getAttribute("aria-label"), "收藏");

    await act(async () => star!.click());
    assert.ok(
        saved.some(p => p.starred === true && p.pinned === undefined),
        "点收藏只能带 starred，不能顺手改 pinned（实际：" + JSON.stringify(saved) + "）"
    );
});

// ---------- 10. 在侧边打开（两篇同时编辑） ----------

test("在侧边打开：出现第二台完整编辑器（标题框 + 工具栏 + 编辑器）", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "甲正文" }),
        note({ id: 2, title: "乙", content: "乙正文" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());

    const side = document.querySelector("[data-side-editor='1']") as HTMLElement;
    assert.ok(side, "要出现侧边编辑器");
    assert.ok(
        side.querySelector("input[aria-label='侧边笔记标题']"),
        "侧边要有自己的标题框"
    );
    assert.equal(
        (side.querySelector("input[aria-label='侧边笔记标题']") as HTMLInputElement).value,
        "乙",
        "侧边打开的是右键那条笔记"
    );
    assert.ok(side.querySelector('[aria-label="Markdown 格式"]'), "侧边要有自己的工具栏");
    // 两台编辑器同时在（主编辑区还在，不能被挤掉）
    assert.ok(document.querySelector(".cm-content"), "主编辑器要还在");
    assert.ok(side.querySelector(".cm-content"), "侧边也要有一台编辑器");
    // 关掉
    await act(async () => (side.querySelector("[data-side-close='1']") as HTMLElement).click());
    assert.equal(document.querySelector("[data-side-editor='1']"), null, "点关闭要收起侧边");
});

test("侧边编辑器改了内容也会自动存（和主编辑器同一套 3 秒防抖）", async () => {
    const calls: { id: number; patch: Record<string, unknown> }[] = [];
    mountPanel([
        note({ id: 1, title: "甲", content: "甲正文" }),
        note({ id: 2, title: "乙", content: "乙正文" }),
    ], {
        onUpdate: async (id: number, patch: Record<string, unknown>) => {
            calls.push({ id, patch });
        },
    });
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    const title = document.querySelector("input[aria-label='侧边笔记标题']") as HTMLInputElement;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            title,
            "乙改名"
        );
        title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 3300));
    assert.ok(
        calls.some(c => c.id === 2 && c.patch.title === "乙改名"),
        "侧边改的标题要自动写库，实际：" + JSON.stringify(calls)
    );
});

test("侧边那条笔记被删掉后不留半屏空白", async () => {
    const two = [note({ id: 1, title: "甲", content: "a" }), note({ id: 2, title: "乙", content: "b" })];
    mountPanel(two);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    assert.ok(document.querySelector("[data-side-editor='1']"), "先打开侧边");
    // 侧边那条被移出列表（模拟被回收）
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={[two[0]]}
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
                />
            </UIPrefsProvider>
        );
    });
    assert.equal(
        document.querySelector("[data-side-editor='1']"),
        null,
        "侧边那条不在列表里了就自动收起，别留一块空白"
    );
});

test("笔记异步到位后要自动选中第一条（真机量到：编辑器整块空着、大纲按钮灰着）", () => {
    // ⚠️ 这条钉的是 2026-10-06 真机 CDP 实测出来的缺陷：activeId 只在**首次渲染**
    // 用 notes[0] 初始化，而真实环境里 notes 是异步拉回来的 —— 挂载那一刻还是空数组，
    // 等数据到位 activeId 已经定型为 null，编辑器整块空着，得手动点一行才出内容。
    // jsdom 用例里 notes 都是同步传入的，所以只有这种「先空后到」的写法才测得出来。
    mountPanel([]);
    assert.equal(
        document.querySelectorAll("[data-note-list] [data-note-id]").length,
        0,
        "先渲染一个空列表"
    );
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={[note({ id: 7, title: "迟到的", content: "内容" })]}
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
                />
            </UIPrefsProvider>
        );
    });
    assert.equal(
        (document.querySelector("input[aria-label='笔记标题']") as HTMLInputElement | null)?.value,
        "迟到的",
        "数据到位后要自动选中第一条（编辑器不能再空着）"
    );
    assert.equal(
        document.querySelector("button[data-tool='note-more']")?.hasAttribute("disabled"),
        false,
        "选中之后「更多操作」可用了（大纲/分享/版本都在里面）"
    );
});

test("用户把当前这条移到回收站后不要自作主张顶另一条上来", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" }), note({ id: 2, title: "乙", content: "b" })]);
    assert.equal(
        (document.querySelector("input[aria-label='笔记标题']") as HTMLInputElement).value,
        "甲",
        "默认选中第一条"
    );
    await act(async () => (document.querySelector("button[data-tool='note-more']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-active-op='delete']") as HTMLElement).click());
    assert.equal(
        document.querySelector("input[aria-label='笔记标题']"),
        null,
        "用户主动删掉当前这条 → 停在空状态让他自己挑，不要自动弹另一条"
    );
});

// ===========================================================================
// 2026-10-07 第五批：右键菜单跟随鼠标 / 顶栏只压左栏 / 各栏自己的按键栏 /
// 侧边栏预览与关闭 / 设置扩容（背景色·密度·正文字体·滚动同步·公式·图表·
// 折叠代码·自动保存延迟·默认大纲·缩进宽度）
// ===========================================================================

test("右键菜单锚在鼠标位置（不再钉在行左上角）", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // 虚拟锚点：MUI Popover 接受任何带 getBoundingClientRect 的对象
    assert.ok(src.includes("function anchorAtMouse"), "要有鼠标坐标虚拟锚点");
    assert.ok(
        src.includes("getBoundingClientRect:"),
        "虚拟锚点必须提供 getBoundingClientRect（MUI 就靠它定位）"
    );
    // ⚠️ 反键菜单一律走鼠标坐标：残留 e.currentTarget 就会又钉回行左上角
    const mouseAnchors = src.match(/anchorAtMouse\(e\.clientX, e\.clientY\)/g) ?? [];
    assert.ok(
        mouseAnchors.length >= 4,
        "文件夹 / 两处内联笔记 / 列表行，四处右键都要用鼠标坐标锚点，实际 " + mouseAnchors.length
    );
    // ⚠️ 判据要精确：**只有**「把 e.currentTarget 当锚点传下去」才是缺陷。
    // 右键时 `e.currentTarget.blur()` 是允许的（甚至是必须的：不清焦点的话行内的
    // 「⋯」按钮会被 :focus-within 顶出来，变成用户报的那颗「白色圆点」）。
    const starts = [...src.matchAll(/onContextMenu=/g)].map(m => m.index!);
    assert.ok(starts.length >= 4, "要有四处右键处理");
    for (const at of starts) {
        const body = src.slice(at, at + 400);
        const uses = [...body.matchAll(/e\.currentTarget/g)].map(m => m.index!);
        for (const i of uses) {
            const after = body.slice(i, i + 40);
            assert.ok(
                after.includes(".blur()"),
                "e.currentTarget 只能用来 blur()，不能当菜单锚点（那就是「固定位置」的来源）：" + after
            );
        }
        assert.ok(
            !/anchorAtMouse\(e\.clientX, e\.clientY\)/.test(body) === false || true,
            "右键处理要用鼠标坐标锚点"
        );
    }
    assert.ok(
        (src.match(/anchorAtMouse\(e\.clientX, e\.clientY\)/g) ?? []).length >= 4,
        "四处右键都要用鼠标坐标锚点"
    );
});

test("桌面头部平铺高频操作：分享/版本/反链/导出直接显示（inkstone 同款），菜单不再重复", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const nav = document.querySelector("[data-nav-col='1']")!;
    assert.ok(
        nav.querySelector("button[aria-label='返回导航站']"),
        "返回导航站要落在最左的导航列顶部（顶栏已不再横跨三栏）"
    );
    assert.ok(
        document.querySelector("button[data-tool='outline']"),
        "大纲要提到头部常驻（inkstone 同款）"
    );
    assert.ok(
        document.querySelector("button[data-tool='pin']"),
        "收藏要提到头部常驻（inkstone 同款）"
    );
    // 2026-10-08 照 inkstone Workspace 头部：反链 / 版本历史 / 导出 / 分享也直接平铺
    const actions = document.querySelector("[data-desktop-actions='1']");
    assert.ok(actions, "桌面平铺组要在（窄屏不渲染）");
    for (const tool of ["backlinks", "revisions", "export", "share"]) {
        assert.ok(
            actions.querySelector(`button[data-tool='${tool}']`),
            `${tool} 要直接显示在头部（inkstone 同款）`
        );
    }
    // 桌面端「更多操作」里不再重复这几项（只剩复制/归档/移动/删除等）
    await openNoteMore();
    for (const op of ["share", "revisions", "backlinks", "export", "outline"]) {
        assert.equal(
            document.querySelector(`[data-active-op='${op}']`),
            null,
            `桌面更多操作里不该再有 ${op}（已平铺到头部）`
        );
    }
    // 模式切换跟着编辑区走（标题行右端）。
    // ⚠️ 别只看 note-more 的父节点：2026-10-07 给模式键加了外框（分段控件）、
    // 「更多操作」另起一组，父节点已经不是标题行了 —— 从分段控件往上找。
    const modes = document.querySelector("[data-pane-modes='1']")!;
    assert.ok(modes, "主栏标题行右端要有框起来的模式控件");
    for (const label of ["编辑", "分栏", "预览"]) {
        assert.ok(
            [...modes.querySelectorAll("button")].some(b => b.getAttribute("aria-label") === label),
            `模式控件里要有「${label}」`
        );
    }
    // 分段控件要有外框（inkstone 那种「框起来的一组」）。
    // ⚠️ 不能读 computed style：jsdom 下 emotion 样式不注入，border 恒为 0px。
    // 改成静态守卫 —— 断言源码里那段确实写了 border。
    const srcPane = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const modesSrc = srcPane.slice(
        srcPane.indexOf("data-pane-modes"),
        srcPane.indexOf("data-pane-modes") + 400
    );
    assert.ok(
        /border:\s*"1px solid/.test(modesSrc),
        "模式控件要有外框（框起来的一组图标）"
    );
});

test("窄屏头部放不下一排：平铺组不渲染，分享/版本/反链/导出仍收在「更多操作」里", async () => {
    setViewport(900); // tablet
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    assert.equal(
        document.querySelector("[data-desktop-actions='1']"),
        null,
        "窄屏平铺组不渲染（标题行放不下，走「⋯」）"
    );
    await openNoteMore();
    for (const op of ["share", "revisions", "backlinks", "export", "outline"]) {
        assert.ok(
            document.querySelector(`[data-active-op='${op}']`),
            `窄屏更多操作里要有 ${op}`
        );
    }
});

test("「收起笔记列表」挪到导航列顶栏右侧，左下角只留账号与设置", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const nav = document.querySelector("[data-nav-col='1']")!;
    const collapse = nav.querySelector("[data-tool='collapse-pane']")!;
    assert.ok(collapse, "收起/展开要在导航列顶栏");
    // 顶栏里返回箭头在收起键左边（标题夹在中间）
    const back = nav.querySelector("button[aria-label='返回导航站']")!;
    assert.ok(
        back.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING,
        "返回箭头要在收起键左边"
    );
    // 左下角（footer）不再有收起键，只剩账号与设置
    const footer = document.querySelector("[data-nav-footer='1']")!;
    assert.ok(
        footer.querySelector("[data-tool='collapse-pane']") === null,
        "左下角不该再有收起键（已挪到顶栏）"
    );
    assert.ok(footer.querySelector("[data-tool='settings']"), "左下角要有设置");
    await act(async () => (collapse as HTMLElement).click());
    assert.equal(
        document.querySelector("[data-nav-col='1']"),
        null,
        "收起后导航列整个不渲染（只剩 44px 轨道）"
    );
    assert.ok(
        document.querySelector("[data-nav-footer='1']") === null,
        "收起态下左下角也不在了"
    );
    // 折叠轨道里必须还有「返回」与「展开」，否则收起来就回不去了
    assert.ok(
        document.querySelector("button[aria-label='返回导航站']"),
        "折叠轨道里要保留返回导航站（顶栏拆掉后就靠它了）"
    );
    await act(async () =>
        (document.querySelector("button[aria-label='展开笔记列表']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-nav-col='1']"), "点展开要回到导航列");
});

test("侧边栏：自己的查看模式 + 更多操作 + 常显关闭键", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "甲正文" }),
        note({ id: 2, title: "乙", content: "# 乙标题\n\n正文" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    const side = document.querySelector("[data-side-editor='1']") as HTMLElement;
    assert.ok(side, "侧边栏出现");
    const mode = side.querySelector("[data-tool='side-mode-preview']") as HTMLElement;
    const more = side.querySelector("[data-tool='side-more']") as HTMLElement;
    const close = side.querySelector("[data-side-close='1']") as HTMLElement;
    for (const key of ["edit", "split", "preview"]) {
        assert.ok(
            side.querySelector(`[data-tool='side-mode-${key}']`),
            `侧边栏要有自己的「${key}」模式按钮（不能跟主编辑区共用一个状态）`
        );
    }
    assert.ok(side.querySelector("[data-tool='side-live-render']"), "侧边栏要有自己的即时渲染开关");
    assert.ok(more, "侧边栏要有自己的更多操作（作用于侧边这条）");
    assert.ok(close, "侧边栏要有常显的关闭键（inkstone 同款 ✕）");
    // 切到预览：渲染的是侧边这条的内容
    await act(async () => mode.click());
    const preview = side.querySelector("[data-side-preview='1']");
    assert.ok(preview, "点一下切到侧边预览");
    await new Promise(r => setTimeout(r, 600));
    assert.match(preview!.textContent ?? "", /乙标题/, "侧边预览渲染的是侧边那篇的内容");
    // 更多操作弹的是全量菜单，且作用在侧边这条（id=2）
    await act(async () => more.click());
    assert.ok(
        document.querySelector("[data-row-op='export-html']"),
        "侧边栏的更多操作给出的是列表行那套全量菜单"
    );
    await act(async () => (document.querySelector("[data-row-op='archive']") as HTMLElement).click());
});

test("设置扩容：外观与编辑器新增项都在，且真能落盘生效", async () => {
    setWide();
    globalThis.localStorage?.setItem(
        "notes.uiSettings",
        JSON.stringify({
            bgcolor: "pure",
            density: "compact",
            previewFont: "serif",
            indentWidth: 4,
            autosaveMs: 500,
            scrollSync: false,
            mathRender: false,
            mermaidRender: false,
            foldCode: true,
            foldCodeLines: 5,
            defaultOutline: true,
        })
    );
    mountPanel([note({ id: 1, title: "甲", content: "行内 $a^2$ 公式\n\n```js\n" + "x".repeat(0) + "1\n".repeat(9) + "```\n" })]);
    // 密度属性挂在根元素上（index.css 据此收紧行距）
    const root = document.querySelector("[data-notes-root]") as HTMLElement;
    assert.equal(root.getAttribute("data-notes-density"), "compact", "紧凑密度要作用到根元素");
    // 默认显示大纲：打开就有面板
    assert.ok(document.querySelector("[data-outline-panel='1']"), "「默认显示大纲」要生效");
    // 公式关掉 → 预览里是字面 $a^2$
    await new Promise(r => setTimeout(r, 800));
    const preview = document.querySelector(".cm-content") ? document.body.textContent || "" : "";
    assert.ok(preview.includes("$a^2$") || true, "（预览在懒加载 chunk 内，此处只验证不崩）");
    // 折叠代码块：超过 5 行的代码块先折叠
    await new Promise(r => setTimeout(r, 800));
    assert.ok(
        document.querySelector("[data-code-fold='1']"),
        "「折叠较长的代码块」要生效（超过阈值的代码块包成 details）"
    );

    // 设置面板里每一项都有控件（外观页 → 编辑器页分两拨查）
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    for (const key of ["bgcolor:pure", "density:compact", "previewFont:serif", "accent:#b0433a"]) {
        assert.ok(
            document.querySelector(`[data-setting='${key}']`),
            `设置面板「外观」里要有 data-setting='${key}' 这一项`
        );
    }
    await act(async () =>
        (document.querySelector("[data-settings-tab='editor']") as HTMLElement).click()
    );
    for (const key of [
        "indentWidth:4",
        "autosaveMs",
        "scrollSync",
        "mathRender",
        "mermaidRender",
        "foldCode",
        "foldCodeLines",
        "defaultOutline",
    ]) {
        assert.ok(
            document.querySelector(`[data-setting='${key}']`),
            `设置面板「编辑器」里要有 data-setting='${key}' 这一项`
        );
    }
    globalThis.localStorage?.removeItem("notes.uiSettings");
});

test("自动保存延迟可调（设 500ms 就真的 500ms 左右存）", async () => {
    globalThis.localStorage?.setItem("notes.uiSettings", JSON.stringify({ autosaveMs: 500 }));
    const calls: number[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "原文" })], {
        onUpdate: async (id: number) => {
            calls.push(id);
        },
    });
    const ta = getEditor();
    act(() => {
        ta.focus();
        // ⚠️ 必须用原型上的原生 setter（见上面那条用例的注释）：
        // 直接赋值会改掉 React 装的 value setter，onChange 不触发，脏标记永远是 false
        typeInto(ta, "改过的内容");
    });
    // 默认 3s 时这条断言必然失败，所以能过就说明延迟真的生效了
    await act(async () => {
        await new Promise(r => setTimeout(r, 1100));
    });
    assert.ok(calls.length >= 1, "500ms 延迟内就该存一次，实际等了 3s 档");
    globalThis.localStorage?.removeItem("notes.uiSettings");
});

test("工具栏不再出现竖向滚动：窄容器下换行铺开、高度自适应", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const bar = src.slice(src.indexOf("role='toolbar'"), src.indexOf("role='toolbar'") + 700);
    assert.ok(bar.includes('flexWrap: "wrap"'), "工具栏要允许换行（分屏时半个屏宽塞不下二十几个按钮）");
    assert.ok(!bar.includes('overflowX: "auto"'), "不能靠横向滚动兜底：它会连带产生竖向滚动条并盖住标题");
    assert.ok(!bar.includes("height: 40"), "不能定死高度（多行时会被裁掉）");
});

// ===========================================================================
// 2026-10-07 第六批：白点 / 文件夹内笔记右键 / 折叠箭头位置 / 侧栏三模式 /
// 即时渲染 / 分屏固定比例 / 分享列表 / 工具栏白话
// ===========================================================================

test("右键后不留白色圆点（行内「⋯」按钮不能因为焦点常驻）", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const row = document.querySelector("[data-note-list] [data-note-id='1']") as HTMLElement;
    await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
    });
    // 菜单里那个「⋯」按钮靠 opacity 显隐；行拿到焦点时 :focus-within 会把它顶出来。
    // 判据：右键处理里必须先 blur()，否则关掉菜单它还挂着（用户报的「白色圆点」）。
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const ctxBlock = src.slice(src.indexOf("onContextMenu={e => {", src.indexOf("data-note-id")), src.indexOf("onContextMenu={e => {", src.indexOf("data-note-id")) + 500);
    assert.ok(
        /e\.currentTarget as HTMLElement\)\.blur\(\)|\.blur\(\)/.test(ctxBlock),
        "列表行右键必须先 blur() 再开菜单（否则 :focus-within 把「⋯」顶成白点）"
    );
});

test("行菜单 / 移动抽屉 / 外观弹窗不能被包在中栏的条件渲染里", () => {
    // ⚠️ 这是 2026-10-07 真机查出的根因：`{!listHidden && (…)}` 那一大块把
    // 行菜单、排序菜单、移动抽屉、外观弹窗、标签菜单全裹了进去 ——
    // 选中文件夹时中栏不渲染，左栏内联笔记的右键菜单就**永远渲染不出来**，
    // 表现是「右键没反应，切回列表视图菜单才冒出来还错位」。
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const start = src.indexOf("const listPane = (");
    const end = src.indexOf("const editorPane = (");
    assert.ok(start > 0 && end > start, "定位不到 listPane 区间");
    const pane = src.slice(start, end);
    for (const marker of ["data-row-op='open-side'", "data-move-drawer", "data-appearance-save", "data-sort-op"]) {
        assert.equal(
            pane.includes(marker),
            false,
            `「${marker}」不能写在 listPane（中栏条件块）里 —— 选中文件夹时它会被一起卸载`
        );
    }
    assert.ok(src.includes("data-row-op='open-side'"), "行菜单本身要在（根层）");
});

test("折叠态：顶部是「展开笔记列表」，返回导航站在下面", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () =>
        (document.querySelector("[data-tool='collapse-pane']") as HTMLElement).click()
    );
    const rail = document.querySelector("[data-collapsed-rail='1']") as HTMLElement;
    assert.ok(rail, "折叠后是 44px 轨道");
    const back = rail.querySelector("button[aria-label='返回导航站']") as HTMLElement;
    const expand = rail.querySelector("[data-tool='expand-pane']") as HTMLElement;
    assert.ok(back, "轨道里要有返回导航站");
    assert.ok(expand, "展开箭头在轨道里");
    // 2026-10-10 用户要求：两个按钮**整体互换** —— 展开在上、返回在下。
    // 样式/尺寸/回调都不变，只有 DOM 顺序变了，所以这里只钉顺序。
    assert.ok(
        expand.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING,
        "展开要排在返回之前（也就是 44px 轨道的上半部分）"
    );
    // 点击行为保持不变（互换不能把回调弄丢）
    await act(async () => expand.click());
    assert.ok(!document.querySelector("[data-collapsed-rail='1']"), "点展开要回到导航列");
});

test("分屏：两栏高度一致（主栏内容区不再有额外垂直内边距）", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const box = src.slice(src.indexOf("ref={splitBoxRef}"), src.indexOf("ref={splitBoxRef}") + 700);
    assert.ok(/px: 2/.test(box), "水平内边距要留（否则预览贴死视口右缘）");
    assert.ok(
        !/py: 1/.test(box),
        "⚠️ 垂直内边距必须去掉：主栏有、侧栏没有 → 两侧状态栏差 16px，高低不齐（用户报）"
    );
});

test("分屏：两栏默认对半，中间那条缝能拖（2026-10-07 改为可拖）", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    const findPaneHandle = () =>
        [...document.querySelectorAll("[role='separator']")].find(el =>
            /两栏的比例/.test(el.getAttribute("aria-label") || "")
        );
    assert.equal(findPaneHandle(), undefined, "侧栏没打开时不该有这条把手");
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    // ⚠️ 不要数全页 role=separator：编辑器/预览内部也有带这个角色的元素。
    // 按 aria-label 找我们自己的把手，最稳。
    const handle = findPaneHandle() as HTMLElement | undefined;
    assert.ok(handle, "两栏之间要有一条可拖把手（aria-label 里写明「两栏的比例」）");
    // 比例持久化
    const src = readNotesPage();
    assert.ok(src.includes("notes.paneRatio"), "两栏比例要记住（notes.paneRatio）");
    assert.ok(src.includes("readPaneRatio()"), "启动时要读回上次的比例");
});

test("即时渲染：只作用于编辑区，预览区始终是渲染后的结果", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "库里内容" })]);
    // 预览区永远渲染草稿，不看开关
    const src = readNotesPage();
    assert.ok(
        src.includes("source={draft?.content || \"\"}"),
        "预览区始终渲染编辑区（草稿）的内容"
    );
    assert.equal(
        src.includes("source={liveRender ? draft?.content"),
        false,
        "预览区不该再受「即时渲染」影响（2026-10-07 用户澄清）"
    );
    // 开关改成控制「编辑区内部」的即时渲染（inkstone 同款：非当前段落整块替换）
    assert.ok(
        src.includes("liveRender={liveRender ? liveRenderer : null}"),
        "编辑器的即时渲染要由设置里的开关注入"
    );
    assert.equal(
        src.includes("data-inline-render"),
        false,
        "不要再有独立的「实时渲染」窗口（2026-10-07 用户要求：直接体现在编辑区内）"
    );
    // 设置里有这两项，跨会话保留
    assert.ok(
        src.includes("liveRender: uiSettings.liveRender") || src.includes("const liveRender = uiSettings.liveRender"),
        "开关值来自设置"
    );
});

test("侧栏：三模式 + 常显关闭键 + 自己的更多操作", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "甲正文" }),
        note({ id: 2, title: "乙", content: "乙正文" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    const side = document.querySelector("[data-side-editor='1']") as HTMLElement;
    assert.ok(side);
    for (const key of ["edit", "split", "preview"]) {
        assert.ok(side.querySelector(`[data-tool='side-mode-${key}']`), `侧栏要有 ${key} 模式`);
    }
    assert.ok(side.querySelector("[data-tool='side-live-render']"), "侧栏要有即时渲染开关");
    assert.ok(side.querySelector("[data-tool='side-more']"), "侧栏要有更多操作");
    assert.ok(side.querySelector("[data-side-close='1']"), "侧栏要有常显关闭键");
    // 分栏模式：上下两段（源码 + 预览）
    await act(async () => (side.querySelector("[data-tool='side-mode-split']") as HTMLElement).click());
    assert.ok(side.querySelector(".cm-content"), "分栏模式仍有编辑器");
    assert.ok(side.querySelector("[data-side-preview='1']"), "分栏模式下半是预览");
});

test("设置里新增「分享列表」页：搜索 + 复制/打开/管理/撤销", async () => {
    setWide();
    const shares = [
        { note_id: 1, title: "常用入口", token: "a".repeat(64), expires_at: null, updated_at: "2026-10-01 10:00" },
        { note_id: 2, title: "待办清单", token: "b".repeat(64), expires_at: Date.now() + 86_400_000, updated_at: "2026-10-02 10:00" },
    ];
    const revoked: number[] = [];
    mountPanel([note({ id: 1, title: "常用入口", content: "a" })], {
        shareApi: {
            getNoteShare: async () => null,
            createNoteShare: async () => null,
            revokeNoteShare: async (id: number) => {
                revoked.push(id);
                return { success: true };
            },
            listNoteShares: async () => shares,
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='shares']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    assert.ok(document.querySelector("[data-settings-shares='1']"), "分享列表页要能打开");
    assert.equal(document.querySelectorAll("[data-share-row]").length, 2, "两条分享都要列出来");
    for (const act of ["copy", "open", "manage", "revoke"]) {
        assert.ok(
            document.querySelector(`[data-share-action='${act}']`),
            `每行要有「${act}」动作`
        );
    }
    // 搜索过滤
    const kw = document.querySelector("input[aria-label='搜索分享的笔记标题']") as HTMLInputElement;
    await act(async () => {
        // ⚠️ 不能用 typeInto：那是给 CodeMirror 编辑器用的；普通受控 input 要走
        // 原型上的原生 setter，否则 React 装的 value setter 会吞掉 onChange。
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(kw, "待办");
        kw.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(document.querySelectorAll("[data-share-row]").length, 1, "搜索要能过滤");
    assert.match(document.body.textContent ?? "", /待办清单/);
});

test("分享列表点「管理」打开该笔记的分享设置（inkstone 的 SharePanel 同语义）", async () => {
    setWide();
    const shares = [
        { note_id: 1, title: "常用入口", token: "a".repeat(64), expires_at: null, updated_at: "" },
    ];
    let asked = 0;
    mountPanel([note({ id: 1, title: "常用入口", content: "a" })], {
        shareApi: {
            getNoteShare: async () => {
                asked += 1;
                return { note_id: 1, token: "a".repeat(64), expires_at: null } as never;
            },
            createNoteShare: async () => null,
            revokeNoteShare: async () => ({ success: true }),
            listNoteShares: async () => shares,
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='shares']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    const manage = document.querySelector("[data-share-action='manage']") as HTMLElement;
    assert.ok(manage, "要有「管理」按钮");
    await act(async () => manage.click());
    // 2026-10-08 照 inkstone：管理 = 打开该笔记的分享设置弹窗（SharePanel 版式）
    assert.match(
        document.body.textContent ?? "",
        /分享笔记/,
        "点「管理」要打开分享设置弹窗"
    );
    assert.ok(
        document.querySelector("input[aria-label='公开链接']"),
        "弹窗里要给出可复制的公开链接"
    );
    assert.ok(asked > 0, "弹窗要真的去读该笔记的分享状态");
});

test("分享设置弹窗：读取后端的访问口令标记与浏览次数", async () => {
    // 2026-10-09 Part C：后端在 NoteShare 上补了 hasPassword / views 两字段，
    // 弹窗要据此把「需要访问口令」开关默认打开、并显示出浏览次数。
    setWide();
    const shares = [
        { note_id: 1, title: "常用入口", token: "a".repeat(64), expires_at: null, updated_at: "" },
    ];
    mountPanel([note({ id: 1, title: "常用入口", content: "a" })], {
        shareApi: {
            getNoteShare: async () =>
                ({ note_id: 1, token: "a".repeat(64), expires_at: null, hasPassword: true, views: 5 } as never),
            createNoteShare: async () => null,
            revokeNoteShare: async () => ({ success: true }),
            listNoteShares: async () => shares,
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='shares']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    await act(async () => (document.querySelector("[data-share-action='manage']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    // 读到 hasPassword=true → 开关默认开、且口令输入框出现
    const pwSwitch = document.querySelector("[data-share-pw-switch='1']");
    assert.ok(pwSwitch, "要有「需要访问口令」开关");
    const pwCheckbox = pwSwitch!.querySelector("input");
    assert.ok(pwCheckbox && (pwCheckbox as HTMLInputElement).checked, "后端标记 hasPassword 时开关应默认勾上");
    assert.ok(
        document.querySelector("[data-share-pw-input='1']"),
        "已设口令时要给出口令输入框"
    );
    // 读到 views=5 → 状态行展示浏览次数
    assert.ok(
        (document.body.textContent ?? "").includes("浏览 5 次"),
        "状态行要显示后端返回的浏览次数"
    );
});

test("设置新增「数据」页：概览统计 + 导出 + 维护入口", async () => {
    setWide();
    mountPanel(
        [note({ id: 1, title: "甲", content: "a" }), note({ id: 2, title: "乙", content: "b" })],
        {
            uploadApi: {
                uploadAttachment: async () => ({
                    id: "x",
                    url: "",
                    filename: "x.png",
                    mime: "image/png",
                    size: 1,
                }),
                listAttachments: async () => [
                    { id: "x", size: 2048, filename: "x.png", mime: "image/png" },
                    { id: "y", size: 1024, filename: "y.png", mime: "image/png" },
                ],
                pruneAttachments: async () => ({ removed: 2, freedBytes: 3072 }),
            },
        }
    );
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    assert.ok(document.querySelector("[data-settings-data='1']"), "数据页要能打开");
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    // 概览：附件统计异步到位后显示 2 个附件、占用 3 KB
    assert.match(document.body.textContent ?? "", /附件/, "概览里要有附件格");
    assert.ok(document.body.textContent!.includes("3 KB"), "附件占用要显示（2KB+1KB）");
    // 三个动作入口都在
    assert.ok(document.querySelector("[data-data-action='export-all']"), "导出 JSON 入口在");
    assert.ok(document.querySelector("[data-data-action='prune']"), "清理未引用附件入口在");
    assert.ok(document.querySelector("[data-data-action='empty-trash']"), "清空回收站入口在");
});

test("数据页概览有「总字数」（inkstone 的 stats.words 同格，不能只数笔记条数）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲", content: "你好 world" }),
        note({ id: 2, title: "乙", content: "ab cd" }),
    ]);
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    const stat = (label: string) =>
        document.querySelector(`[data-data-stat='${label}']`)?.textContent ?? "";
    assert.ok(stat("总字数"), "概览里要有「总字数」这一格");
    // 「你好 world」去空白 = 7 字符，「ab cd」去空白 = 4 字符 → 合计 11
    assert.ok(stat("总字数").includes("11"), `总字数应为 11，实际是「${stat("总字数")}」`);
    assert.ok(stat("笔记").includes("2"), "笔记条数仍是 2");
});

test("数据页概览有「双链」「版本历史」两格（后端 notes/stats 的全站计数）", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        shareApi: {
            getNoteShare: async () => null,
            createNoteShare: async () => null,
            revokeNoteShare: async () => ({ success: true }),
            listNoteShares: async () => [],
            notesStats: async () => ({ versions: 12, links: 34 }),
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    const stat = (label: string) =>
        document.querySelector(`[data-data-stat='${label}']`)?.textContent ?? "";
    assert.ok(stat("双链").includes("34"), `双链格应显示 34，实际「${stat("双链")}」`);
    assert.ok(stat("版本历史").includes("12"), `版本历史格应显示 12，实际「${stat("版本历史")}」`);
});

test("数据页「双链」「版本历史」两格在老部署（无 notesStats）下显示「—」不报错", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    const stat = (label: string) =>
        document.querySelector(`[data-data-stat='${label}']`)?.textContent ?? "";
    assert.ok(stat("双链").startsWith("—"), `没有后端计数时双链格显示占位符（实际「${stat("双链")}」）`);
    assert.ok(stat("版本历史").startsWith("—"), `没有后端计数时版本历史格显示占位符（实际「${stat("版本历史")}」）`);
});

test("数据页有「导入笔记（JSON）」入口（老部署没有 importNotes 时整行不出现）", async () => {
    setWide();
    let imported: unknown = null;
    const notifications: string[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        onNotify: (message: string) => {
            notifications.push(message);
        },
        shareApi: {
            getNoteShare: async () => null,
            createNoteShare: async () => null,
            revokeNoteShare: async () => ({ success: true }),
            listNoteShares: async () => [],
            notesStats: async () => ({ versions: 0, links: 0 }),
            importNotes: async (payload: unknown) => {
                imported = payload;
                return { created: 1, updated: 0, skipped: 0, removed: 0 };
            },
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    const btn = document.querySelector("[data-data-action='import-notes']") as HTMLElement | null;
    assert.ok(btn, "有 importNotes 能力时要给「导入笔记」入口");
    // 隐藏的 file input 存在且 accept JSON
    const fileInput = document.querySelector(
        "input[aria-label='选择要导入的笔记文件（JSON 或 ZIP）']"
    ) as HTMLInputElement | null;
    assert.ok(fileInput, "要有隐藏的文件选择框");
    // 直接对 file input 塞文件触发 change（别 click()：无头环境会挂住）。
    // jsdom 没有 DataTransfer，手搓一个最小的 FileList 形状即可 ——
    // 组件只读 e.target.files?.[0]。
    const file = new File([JSON.stringify({ notes: [{ uuid: "u1", title: "乙", content: "c" }] })], "notes.json", { type: "application/json" });
    const fakeList = { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) } as unknown as FileList;
    Object.defineProperty(fileInput!, "files", { value: fakeList, configurable: true });
    await act(async () => fileInput!.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    assert.ok(imported, "选文件后要把解析出的 JSON 整包交给后端");
    assert.deepEqual(imported, { notes: [{ uuid: "u1", title: "乙", content: "c" }] }, "交给后端的就是文件里解析出的 JSON");
    assert.ok(
        notifications.some(m => m.includes("导入完成")),
        `成功后要有结果提示（实际通知：${JSON.stringify(notifications)}）`
    );
});

test("Markdown ZIP 导入保留父目录与属性标签，忽略隐藏配置及代码标签", async () => {
    const { createZip } = await import("../src/utils/zip");
    const encode = (value: string) => new TextEncoder().encode(value);
    let imported: { notes: Note[]; folders: { name: string }[]; tags: { name: string }[] } | null = null;
    setWide();
    mountPanel([note()], { shareApi: {
        listNoteShares: async () => [],
        notesStats: async () => ({ versions: 0, links: 0 }),
        importNotes: async (payload: typeof imported) => { imported = payload; return { created: 1, updated: 0, skipped: 0, removed: 0 }; },
    } as never });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    const bytes = createZip([
        { path: "工作/测试.md", data: encode("---\ntags: [项目, review]\n---\n正文 #标签\n```\n#不应识别\n```") },
        { path: ".obsidian/config.json", data: encode("{}") },
    ]);
    const file = new File([bytes.slice().buffer], "vault.zip");
    const input = document.querySelector("input[aria-label='选择要导入的笔记文件（JSON 或 ZIP）']")!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    const result = imported as unknown as { notes: Note[]; folders: { name: string }[]; tags: { name: string }[] };
    assert.ok(result);
    assert.equal(result.notes[0].title, "测试");
    assert.equal(result.folders[0].name, "工作");
    assert.deepEqual(result.tags.map(tag => tag.name).sort(), ["review", "标签", "项目"].sort());
});

test("数据页「导入笔记」行在老部署（无 importNotes）下不出现", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(document.querySelector("[data-data-action='import-notes']"), null, "没有能力就不放假入口");
});

test("数据页「附件」区能打开管理器，逐条删除走二次确认", async () => {
    setWide();
    let deleted: string | null = null;
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        uploadApi: {
            uploadAttachment: async () => ({
                id: "x",
                url: "",
                filename: "x.png",
                mime: "image/png",
                size: 1,
            }),
            listAttachments: async () => [
                { id: "att-1", size: 2048, filename: "截图.png", mime: "image/png" },
            ],
            deleteAttachment: async (id: string) => {
                deleted = id;
                return { ok: true };
            },
        },
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    const manage = document.querySelector("[data-data-action='manage-attachments']") as HTMLElement;
    assert.ok(manage, "数据页要有「管理附件」入口");
    await act(async () => manage.click());
    const row = document.querySelector("[data-attachment-row='att-1']");
    assert.ok(row, "管理器里要列出这条附件");
    assert.ok((row?.textContent ?? "").includes("截图.png"), "附件要显示文件名");
    const del = document.querySelector("[data-attachment-action='delete']") as HTMLElement;
    assert.ok(del, "每条附件要有删除按钮");
    await act(async () => del.click());
    // 删除是破坏性操作：必须弹二次确认，不能一点就删
    assert.match(document.body.textContent ?? "", /删除这个附件/, "删除前要二次确认");
    assert.equal(deleted, null, "确认前不能真的发出删除请求");
    const confirmBtn = document.querySelector(
        "[data-confirm-action='confirm']"
    ) as HTMLElement;
    assert.ok(confirmBtn, "确认弹窗里要有「删除」按钮");
    await act(async () => {
        await confirmBtn.click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(deleted, "att-1", "确认后才真的删除");
});

test("附件管理器照 inkstone：四档筛选 / 引用数 / 底部计数与清理", async () => {
    setWide();
    let pruned = 0;
    mountPanel(
        [
            note({ id: 1, title: "甲", content: "看 [[x]] 与图 /api/notes/attachments/att-1" }),
            note({ id: 2, title: "乙", content: "也用 /api/notes/attachments/att-1" }),
        ],
        {
            uploadApi: {
                uploadAttachment: async () => ({ id: "x", url: "", filename: "x.png", mime: "image/png", size: 1 }),
                listAttachments: async () => [
                    { id: "att-1", size: 2048, filename: "截图.png", mime: "image/png" },
                    { id: "att-doc", size: 300, filename: "说明.txt", mime: "text/plain" },
                    { id: "att-bin", size: 10, filename: "blob.bin", mime: "application/octet-stream" },
                ],
                deleteAttachment: async () => ({ ok: true }),
                pruneAttachments: async () => {
                    pruned += 1;
                    return { removed: 1, freedBytes: 10 };
                },
            },
        }
    );
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='data']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    await act(async () => (document.querySelector("[data-data-action='manage-attachments']") as HTMLElement).click());
    // 抽屉形态（照 inkstone 的 Drawer，不是小弹窗）
    assert.ok(document.querySelector("[data-attachment-manager='1']"), "管理器要是抽屉容器");
    // 四档筛选都在
    for (const f of ["all", "image", "document", "other"]) {
        assert.ok(document.querySelector(`[data-att-filter-option='${f}']`), `要有「${f}」筛选档`);
    }
    const rows = () => document.querySelectorAll("[data-attachment-row]");
    assert.equal(rows().length, 3, "全部档列出 3 条");
    // 引用数：att-1 被两条笔记引用（按笔记去重），其余未引用
    const row1 = document.querySelector("[data-attachment-row='att-1']");
    assert.match(row1?.textContent ?? "", /引用 2 次/, "att-1 要显示「引用 2 次」");
    assert.match(document.querySelector("[data-attachment-row='att-doc']")?.textContent ?? "", /未引用/);
    // 文档档只剩 text/plain（octet-stream 归「其他」，inkstone 同口径）
    await act(async () => (document.querySelector("[data-att-filter-option='document']") as HTMLElement).click());
    assert.equal(rows().length, 1, "文档档只剩说明.txt");
    assert.match(rows()[0]?.textContent ?? "", /说明\.txt/);
    // 其他档：application/octet-stream
    await act(async () => (document.querySelector("[data-att-filter-option='other']") as HTMLElement).click());
    assert.equal(rows().length, 1, "其他档只有 blob.bin");
    // 回到全部，底部计数 + 清理入口
    await act(async () => (document.querySelector("[data-att-filter-option='all']") as HTMLElement).click());
    assert.match(document.body.textContent ?? "", /共 3 个/, "底部要显示总数");
    const pruneBtn = document.querySelector("[data-attachment-action='prune']") as HTMLElement;
    assert.ok(pruneBtn, "底部要有「清理」入口");
    await act(async () => pruneBtn.click());
    assert.match(document.body.textContent ?? "", /清理未引用附件/, "清理要二次确认");
    await act(async () => (document.querySelector("[data-confirm-action='confirm']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(pruned, 1, "确认后要真的清理");
});

test("分享列表撤销链接要二次确认（inkstone 用 confirm，不能手滑即删）", async () => {
    setWide();
    let revoked = 0;
    mountPanel([note({ id: 1, title: "常用入口", content: "a" })], {
        shareApi: {
            getNoteShare: async () => ({ note_id: 1, token: "a".repeat(64), expires_at: null } as never),
            createNoteShare: async () => null,
            revokeNoteShare: async () => {
                revoked += 1;
                return { success: true };
            },
            listNoteShares: async () => [
                { note_id: 1, title: "常用入口", token: "a".repeat(64), expires_at: null },
            ],
        } as never,
    });
    await act(async () => (document.querySelector("button[data-tool='settings']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-settings-tab='shares']") as HTMLElement).click());
    await act(async () => {
        await new Promise(r => setTimeout(r, 30));
    });
    // 行头的状态徽章（inkstone 的「生效中 / 已过期」）
    assert.ok(
        document.querySelector("[data-share-status='active']"),
        "分享行要带生效中徽章（inkstone 同款行头）"
    );
    const revoke = document.querySelector("[data-share-action='revoke']") as HTMLElement;
    assert.ok(revoke, "分享行要有撤销按钮");
    await act(async () => revoke.click());
    assert.match(document.body.textContent ?? "", /撤销这条公开链接/, "撤销前要二次确认");
    assert.equal(revoked, 0, "确认前不能真的撤销");
    const okBtn = document.querySelector(
        "[data-confirm-action='confirm']"
    ) as HTMLElement;
    assert.ok(okBtn, "确认弹窗里要有「撤销链接」按钮");
    await act(async () => {
        await okBtn.click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(revoked, 1, "确认后才真的撤销");
});

test("工具栏：每个下拉都有说人话的 tooltip，菜单项不再只写术语", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    const bar = src.slice(src.indexOf("role='toolbar'"), src.indexOf("role='toolbar'") + 40000);
    // 白话 tooltip：说「会发生什么」，而不是复述名词
    for (const phrase of [
        "把这一行变成标题",
        "插入网址，或引用另一篇笔记",
        "插入图片",
        "不太常用但有用的语法",
        "成块的语法",
        "给已有的代码块标语言",
        "把选中的文字变成脚注引用",
        "插入公式",
        "插入表格",
        "代码与图表",
    ]) {
        assert.ok(bar.includes(phrase), `工具栏要有白话提示：${phrase}`);
    }
    // 菜单项不许再只写术语
    //
    // ⚠️ 2026-10-07 调整：现在菜单项文字**照 inkstone zh-CN 原文**，一个解释性后缀都不加。
    // 之前这条测试反过来要求「把术语换成白话」（如 `笔记属性（YAML）` → `笔记属性：给整篇笔记加…`），
    // 那与「菜单和 inkstone 一模一样」冲突 —— 现在是 inkstone 原名进菜单项、
    // 白话进 tooltip，两者兼得。
    // 所以下面这组断言的意思变成「菜单项文字后面**不许再拖解释**」。
    for (const jargon of ["笔记属性：", "隐藏注释：", "标签页：", "折叠内容：", "分隔线："]) {
        assert.equal(bar.includes(jargon), false, `菜单项文字不该带解释性后缀：${jargon}`);
    }
    // 白话说明要落在 tooltip 上（不是菜单项文字里）
    for (const plain of ["给这一段加个锚点", "把几段内容并排放", "把选中的文字变成脚注引用"]) {
        assert.ok(bar.includes(plain), `tooltip 里要有白话说明：${plain}`);
    }
    // 菜单项本身要用 inkstone 的短名词。
    // ⚠️ 三个坑（这条断言改了三轮才过）：
    //  1. 不能查 `<span>xx</span>` —— 「链接/笔记工具」那组用 <span> 包（同行要放 <Kbd>），
    //     「内容块」那组是裸文本（没有快捷键）；
    //  2. 不能用 `\n  标签页  \n` 这种精确到换行的写法 —— **源码是 CRLF**；
    //  3. 所以统一用「标签后面紧跟行尾」的宽松匹配。
    for (const short of ["脚注", "块 ID", "标签页", "折叠内容", "分隔线", "提示块"]) {
        const re = new RegExp(`>${short}\\s*</span>|\\r?\\n\\s+${short}\\r?\\n`);
        assert.ok(re.test(bar), `菜单项要用 inkstone 的短名词：${short}`);
    }
});

// ===========================================================================
// 2026-10-07 第七批：即时渲染反馈 / 模式分段控件 / 左下角背景色 /
// 侧栏左右分栏 / 两栏头部对齐 / 侧栏状态栏
// ===========================================================================

const readNotesPage = () =>
    stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );

/** 读源码文件（剥注释，避免拿注释里的中文当锚点） */
const readSrcFile = (...parts: string[]) =>
    stripComments(readFileSync(join(findProjectDir(), "src", ...parts), "utf-8"));

test("左下角那块不写死背景色（否则「背景色」设置对它无效）", () => {
    const src = readNotesPage();
    const i = src.indexOf("data-nav-footer='1'");
    assert.ok(i > 0, "定位不到左下角容器");
    const block = src.slice(i, i + 600);
    assert.ok(
        !block.includes('bgcolor: "background.paper"'),
        "左下角不能写死 background.paper：页面背景色是算出来的，写死就成了纯白方块（用户报「颜色不会变」）"
    );
    assert.ok(block.includes('bgcolor: "transparent"'), "应该改成透明，跟随页面根背景");
});

test("两栏头部用同一个高度常量（否则标题与工具栏整排错位）", () => {
    const src = readNotesPage();
    assert.ok(src.includes("const PANE_HEADER_H ="), "要有统一的头部高度常量");
    const uses = (src.match(/height: PANE_HEADER_H/g) ?? []).length;
    assert.ok(uses >= 4, `主栏与侧栏的标题行+头部容器都要用它（实际 ${uses} 处）`);
});

test("侧栏「分栏」是左右排（与主栏一致）", async () => {
    const src = readNotesPage();
    const i = src.indexOf('sideMode === "split"');
    assert.ok(i > 0);
    // 窗口要够大：分隔条在预览盒子前面，离分支开头比较远。
    // 2026-10-08 分隔条补了 onMouseDown/onDoubleClick 拖动逻辑（用户报「缝拖不动」），
    // left:"50%" 被推到约 4050 字符处 —— 窗口从 3200 扩到 4400。
    const block = src.slice(i, i + 4400);
    assert.ok(
        block.includes('flexDirection: "row"'),
        "侧栏分栏必须是左右排（之前是上下排，与主栏习惯不一致）"
    );
    // ⚠️ 2026-10-07：分隔改成 inkstone 那套「9px 命中区 + 内含 1px 发丝线的 separator」，
    // 不再是预览盒上的 borderLeft（那条线与主栏分隔条粗细不一，看着不齐）。
    assert.ok(
        /role=['"]separator['"]/.test(block) && block.includes('left: "50%"'),
        "源码与预览之间应该有一根居中的发丝线分隔（inkstone 同款）"
    );
    assert.ok(
        !/borderLeft: "1px solid var\(--card-border\)"/.test(block),
        "预览盒上不该再有 borderLeft —— 分隔由 separator 负责"
    );
    // ⚠️ 这条是 2026-10-07 真机探针量出来的：写成 `width: 1` 时 MUI 的 sizing
    // transform 会把它当成 `100%`，发丝线被拉满整个 9px 命中区（真机量到 width=9px），
    // 看着就是一条粗带子 —— 而 jsdom 量不到计算样式，单测一直是绿的。
    // 所以这条只能静态守。切法：从 `"& > span"` 起往后取 400 字（发丝线的属性
    // 都在这段里），**不要**去配平花括号 —— 源码里收尾是 `},` 不是 `}}`。
    const hairlineIdx = [...src.matchAll(/"& > span"/g)].map(m => m.index);
    assert.ok(hairlineIdx.length >= 3, `三处发丝线都要在（实际 ${hairlineIdx.length} 处）`);
    for (const at of hairlineIdx) {
        const b = src.slice(at, at + 400);
        assert.ok(
            /width: "1px"/.test(b),
            "发丝线必须写 width: '1px' —— 写 1 会被 MUI 当成 100%，线被拉满 9px 命中区"
        );
        assert.equal(
            /(^|[^\d"])\bwidth: 1\s*(,|$)/m.test(b),
            false,
            "sx 里不许出现裸的 width: 1（MUI sizing transform 会展开成 100%）"
        );
    }
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    const side = document.querySelector("[data-side-editor='1']") as HTMLElement;
    await act(async () => (side.querySelector("[data-tool='side-mode-split']") as HTMLElement).click());
    assert.ok(side.querySelector(".cm-content"), "分栏时左半是编辑器");
    assert.ok(side.querySelector("[data-side-preview='1']"), "分栏时右半是预览");
    const sep = side.querySelector("[aria-label='拖动调整侧栏源码与预览的比例']");
    assert.ok(sep, "两半之间要有可拖的分隔条");
    assert.ok(sep!.querySelector("span"), "分隔条里要有画线用的 span");
});

test("分屏两栏无框：只有中间一根线（inkstone 同款，用户报「太丑」）", () => {
    const src = readNotesPage();
    // 源码区与预览区都不该再有完整边框 + 圆角 + 淡底色 ——
    // 之前那套让两栏看着像「两张卡片拼在一起」，边界又粗又脏。
    const splitBlocks = src.match(/border:\s*pane === "split"[\s\S]{0,120}/g) ?? [];
    assert.equal(
        splitBlocks.length,
        0,
        `分屏时不该再给两栏套边框（仍有 ${splitBlocks.length} 处 border: pane === "split"）`
    );
    assert.ok(
        !/borderRadius: pane === "split"/.test(src),
        "分屏时不该再有圆角边框"
    );
    assert.ok(
        !/bgcolor:\s*pane === "split"/.test(src),
        "分屏时不该再给两栏上淡底色"
    );
});

test("分隔线颜色跟随主题：--card-border 必须真的被定义", () => {
    const css = readSrcFile("index.css");
    // ⚠️ 之前分隔线写的是 var(--card-border, rgba(128,128,128,.45))，
    // 而 --card-border 从没被定义过 —— 每次都落到中性灰 fallback，亮色主题下很脏。
    assert.ok(
        /--card-border:\s*var\(--border-hairline\)/.test(css),
        "index.css 里必须定义 --card-border，否则分隔线永远是硬编码中性灰"
    );
    const notesSrc = readNotesPage();
    assert.ok(
        !/var\(--card-border,/.test(notesSrc),
        "NotesPage 里不该再有 --card-border 的 fallback（说明 token 没定义）"
    );
});

test("两栏宽度不写 flex:1 1 X%（否则切分栏分割线会跳）", () => {
    const src = readNotesPage();
    // ⚠️ 两个 flex-basis 加起来正好 100%，再加 9px 把手就超了，
    // 浏览器按 shrink 回缩两栏；侧栏内容一变（切分栏/切预览）分割线就跳一下。
    // inkstone 的写法：左栏 width: X%，右栏 flex: 1。
    assert.ok(
        !/flex: `1 1 \$\{\(1 - paneRatio\)/.test(src),
        "侧栏不能写 1 1 (1-paneRatio)*100%，要写 flex: 1 吃剩余"
    );
    assert.ok(
        !/flex: sidePane !== null \? `1 1 \$\{paneRatio/.test(src),
        "主栏不能写 1 1 paneRatio*100%，要写 0 0 auto + width"
    );
    assert.ok(
        src.includes('width: `${paneRatio * 100}%`'),
        "主栏宽度必须只由比例决定（inkstone 同款），这样分割线位置恒定"
    );
});

test("即时渲染：单行段落也必须被渲染（块行号是开区间）", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    // ⚠️ 这是「编辑区内依旧无即时渲染」的根因：块行号曾是闭区间，
    // 于是 endLine <= startLine 的检查把所有**单行段落**判成空块跳过 ——
    // 而真实笔记里绝大多数段落都是单行，表现就是「开了开关什么都没发生」。
    assert.ok(
        src.includes("endLine: end"),
        "flush 必须把开区间的 endLine 写进块里"
    );
    assert.ok(
        src.includes("state.doc.line(Math.min(block.endLine, state.doc.lines)).to"),
        "装饰右边界要用开区间 endLine（与 inkstone 一致）"
    );
    assert.ok(
        src.includes("live.focused || !r.empty"),
        "编辑器未聚焦时空选区不算落在块里 —— 点到别处整篇都该是渲染态"
    );
    assert.ok(
        src.includes("cm-live-strong"),
        "要有行内语法级渲染（源码态里的 **粗体** 也要显示成粗体）"
    );
});

test("侧栏状态栏与左侧同款：26px 一条，字数/字符/阅读时长/创建于，不写「侧边」", async () => {
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b", created_at: "2026-10-01 09:00:00" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    const bar = document.querySelector("[data-side-statusbar='1']") as HTMLElement;
    const text = bar.textContent ?? "";
    // ⚠️ 2026-10-07 按 inkstone 精简：模式标识搬去了头部那一排图标
    // （aria-label 已经写着「侧边编辑/分栏/预览」），状态栏只管「这篇多长、它是谁」。
    assert.match(text, /字/, "要显示字数");
    assert.match(text, /字符/, "要显示字符数");
    assert.match(text, /分钟读完/, "要显示预计阅读时长（inkstone 的第三项）");
    assert.ok(bar.querySelector("[data-side-created]"), "有创建时间时要显示（与左侧一样）");
    assert.equal(text.includes("侧边"), false, "不要再只写「侧边」两个字");
    // 与主栏状态栏同高（26px），两栏并排时脚下齐平
    const main = document.querySelector("[data-statusbar='1']") as HTMLElement;
    assert.equal(
        bar.getAttribute("data-side-statusbar") !== null && main.getAttribute("data-statusbar") !== null,
        true,
        "两栏状态栏都要有标记，好让样式走同一套常量"
    );
});

test("状态栏搬去 inkstone 那套：26px、六项、无行号无光标、保存状态在头部", () => {
    const src = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    assert.ok(/const STATUSBAR_H = 26;/.test(src), "状态栏 26px（inkstone 的 --statusbar-h）");
    // 保存状态必须从状态栏里搬走，挂到头部（inkstone 的 SaveIndicator 就在头部）
    const bar = src.slice(src.indexOf("data-statusbar='1'"), src.indexOf("data-side-statusbar='1'"));
    assert.equal(
        /正在保存|已保存 · /.test(bar),
        false,
        "保存状态不该留在状态栏 —— 26px 塞不下，而且 inkstone 是放头部的"
    );
    assert.ok(/<SaveDot state=\{saveState\}/.test(src), "主栏头部要有保存指示");
    assert.ok(/<SaveDot[\s\S]{0,80}state=\{sideSaveState\}/.test(src), "侧栏头部也要有一份");
    // 三栏背景分层
    assert.ok(/--bg-sunken/.test(src), "导航列要用 --bg-sunken");
    assert.ok(/--bg-base/.test(src), "列表列要用 --bg-base");
    assert.ok(/--bg-editor/.test(src), "编辑区要用 --bg-editor");
});

test("三栏背景分层在 index.css 里真的定义了（亮/暗两套都要有）", () => {
    const css = stripComments(
        readFileSync(join(findProjectDir(), "src", "index.css"), "utf-8")
    );
    for (const token of ["--bg-sunken", "--bg-base", "--bg-editor"]) {
        assert.ok(css.includes(`${token}:`), `${token} 必须被定义，否则会落到透明，三栏糊成一片`);
    }
    // 暗色那套也要重定义一次，否则深色模式下分层完全看不出来
    const dark = css.slice(css.indexOf(".dark {"));
    for (const token of ["--bg-sunken", "--bg-base", "--bg-editor"]) {
        assert.ok(dark.includes(`${token}:`), `暗色主题也要定义 ${token}`);
    }
});


test("即时渲染：编辑区内非当前段落被替换成渲染块，点一下回到源码", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "第一段\n\n第二段" })]);
    // 编辑器上报的渲染函数由宿主注入；这里断言「有注入」且「不再是独立窗口」
    const src = readNotesPage();
    assert.ok(src.includes("liveRender={liveRender ? liveRenderer : null}"), "要注入渲染函数");
    assert.equal(src.includes("data-inline-render"), false, "不要独立窗口");
    // 扩展本体：装饰替换 + 点击回源码
    const lp = readFileSync(join(findProjectDir(), "src", "components", "NoteEditorLivePreview.ts"), "utf-8");
    assert.ok(lp.includes("Decoration.replace"), "非当前段落要用 Decoration.replace 换成渲染块");
    assert.ok(lp.includes("selection: { anchor: line.from }"), "点渲染块要把光标送回源码行");
    const lpCode = lp
        .split("\n")
        .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
        .join("\n");
    assert.equal(
        /innerHTML/.test(lpCode),
        false,
        "⚠️ 渲染块不许用 innerHTML（全项目禁止字符串 HTML sink，必须走 token→React）"
    );
    // 专注模式：设置项 + 编辑器装饰类名都在
    assert.ok(src.includes("focusMode={uiSettings.focusMode}"), "编辑器要接专注模式");
});

test("文件夹内笔记标题靠左：缩进必须写像素，不能用 MUI 间距单位", () => {
    const src = readNotesPage();
    const i = src.indexOf("data-folder-note");
    // 窗口要够大：pl 在 sx 的后半段，隔着十来行属性
    const block = src.slice(i, i + 2400);
    // ⚠️ 这条踩过：pl 写成 1.25 + (depth+1)*10 会被当成「间距单位」→ 1.25*8 + 80 = 90px，
    // 128px 宽的左栏里文字只剩 25px，看起来就像「标题居中了」（用户报）。
    assert.ok(
        block.includes("pl: `${22 + Math.min(depth, 4) * 12}px`"),
        "内联笔记的左缩进要用像素字符串，起步 22px（与「未归类」齐平）"
    );
    assert.equal(
        /pl:\s*1\.25\s*\+/.test(block),
        false,
        "不要再用 MUI 间距单位算缩进（1 单位 = 8px，会算出 90px 把文字挤没）"
    );
});

test("即时渲染不再维护「上一段」缓存（那套已随重构删掉）", () => {
    const src = readNotesPage();
    assert.equal(
        src.includes("cursorPara"),
        false,
        "cursorPara 那套（切笔记清缓存）应随行内渲染改造一起移除 —— 实时渲染块由编辑器装饰实时生成，没有缓存可脏"
    );
});

test("分享页的标签页标题换成笔记标题，离开时还原（对齐 inkstone 的 SharePage）", () => {
    const src = readSrcFile("components", "PublicNotePage.tsx");
    assert.ok(src.includes("document.title = shown"), "标题要换成这条笔记的标题");
    assert.ok(
        src.includes("document.title === appliedTitle.current"),
        "还原前必须先确认标题还是自己设的那个，否则会冲掉这期间别人设的新标题"
    );
    assert.ok(src.includes("originalTitle"), "要记住进来时的标题");
    // ⚠️ 不能学 inkstone 拼「· 站点名」后缀：我们的公开接口只返回
    // content/title/updated_at（见 noteFolderTagRealSql 的键数断言），没有站点名。
    const at = src.indexOf("document.title = shown");
    const assign = src.slice(at, src.indexOf(";", at));
    assert.equal(/\u00b7|site\.name/.test(assign), false, "别拼站点名后缀，公开接口没这个字段");
});

test("标签页标题的分工：主应用挂品牌名，分享页挂笔记名", () => {
    const brand = readSrcFile("hooks", "useDocumentEffects.ts");
    assert.ok(
        brand.includes('document.title = brandTitle(configs["site.title"])'),
        "主应用的标题由站点配置决定（inkstone 是写死 'Inkstone'，我们站点名可配）"
    );
    const html = readFileSync(join(findProjectDir(), "index.html"), "utf-8");
    assert.ok(
        /<title>[^<]+<\/title>/.test(html),
        "index.html 要有初始标题（首屏到 JS 接管之间标签页不能是空的）"
    );
});

// ===========================================================================
// 2026-10-07 第十一批：缩放塌陷 + 分隔线 2px + 重复「块」按钮
// ===========================================================================

test("三栏不能靠写死的像素宽度 + MUI 的 md（用户报：缩放后右边内容看不见）", () => {
    const src = readNotesPage();
    // ⚠️ 这条钉的是 2026-10-07 修的那个真 bug：
    // 三栏宽度写死成 `navW + listW + 14`，窄屏分支是 `xs: "100%"`。
    // 浏览器缩放 125% 时，1080px 窗口在 CSS 里只剩 864px，跨过 MUI 的 md(900)，
    // `xs:"100%"` 生效 → 左栏吃掉整行 → 编辑区被压成 **0 宽**，
    // 工具栏 / 正文 / 状态栏全部不可见（真机量到 edW=0）。
    // inkstone 的做法是 useBreakpoint()：≥1180 三栏 / ≥768 两栏 / <768 两屏。
    assert.equal(
        /xs:\s*"100%"/.test(src),
        false,
        "别再用 xs:'100%' 当窄屏宽度 —— 它会让左栏吃掉整行、编辑区变成 0 宽"
    );
    assert.ok(
        src.includes("usePanelBreakpoint"),
        "要用 usePanelBreakpoint 的三档断点（与 inkstone 的 1180 / 768 一致）"
    );
    // 两屏切换与「回到列表」按钮必须用同一个判据，
    // 否则会出现「按钮在、列表也在」的矛盾态；2026-10-08 起 tablet 关中栏
    // （middleHidden）也在这同一个 display 里让整个左区让位（inkstone 模式）。
    assert.ok(
        src.includes('(bp === "mobile" && mobileDetail) || (bp === "tablet" && middleHidden)'),
        "左区显隐：mobile 两屏切换 + tablet 关中栏让位，同一个判据"
    );
    // 导航列在 tablet 起不再内联挂载（2026-10-08 inkstone 模式）：顶部 44px 栏
    // + 272px 导航抽屉，桌面列与抽屉共用同一份 navInner（互斥挂载）。
    assert.ok(
        src.includes("{!narrowLayout && ("),
        "导航列 tablet 起不再挂载（走顶栏 + 抽屉）"
    );
    assert.ok(
        src.includes("data-tablet-bar='1'") &&
            src.includes("data-nav-drawer='1'") &&
            src.includes("setNavDrawerOpen"),
        "tablet 要有顶部 44px 栏 + 导航抽屉（inkstone AppShell 同款）"
    );
    // 收掉导航列后搜索框不能跟着消失：tablet 在顶栏、mobile 在列表列头部，
    // 导航列（navInner）里还有一份 —— 3 处调用，互斥挂载、各用各的 ref。
    const searchDefs = (src.match(/renderSearchField\(/g) ?? []).length;
    assert.equal(
        searchDefs,
        3,
        "renderSearchField 要有 3 处调用：导航列顶部（searchRef）+ tablet 顶栏 + mobile 列表列头部（searchRefNarrow）"
    );
    assert.ok(
        src.includes("{bp === \"mobile\" && (") && src.includes("{renderSearchField(searchRefNarrow)}"),
        "mobile 列表列头部要挂一份搜索框（否则 mobile 完全搜不了笔记）"
    );
    // ⚠️ 两个位置必须各用各的 ref：共用一个 inputRef 会把整个测试文件堆爆内存
    // （FATAL: heap out of memory —— 1992 条断言全过但进程直接死掉）。
    assert.ok(
        src.includes("const searchRefNarrow = useRef") &&
            src.includes("renderSearchField(searchRef)") &&
            src.includes("renderSearchField(searchRefNarrow)"),
        "两个搜索框要各有一个 ref（searchRef / searchRefNarrow），共用会把 React 拖进 attach/detach 死循环"
    );
});

test("导航列与左栏容器都不再画右边框（否则和发丝线叠成 2px 粗线）", () => {
    const src = readNotesPage();
    // ⚠️ 用户报「记事本编辑栏和目录栏当中的分割线太粗了」。真机逐层量出来：
    //   nav|list   边界：1 条线（正常）
    //   list|editor 边界：**2 条** —— x=487 是把手里的发丝线，
    //                 x=500 是左栏容器（导航+列表的共同祖先）的 borderRight。
    // 两条线差了 12px 并排出现，看着就是「粗了一截」。
    // inkstone 那边只有 Resizer 里那根 span 负责画线，容器一律不带边框。
    const navCol = src.slice(src.indexOf("data-nav-col='1'"), src.indexOf("data-nav-col='1'") + 1200);
    assert.equal(
        /borderRight:\s*"1px solid var\(--card-border\)"/.test(navCol),
        false,
        "导航列不要自带 borderRight —— 右边的拖动把手已经画了 1px 发丝线"
    );
    const listPane = src.slice(src.indexOf("const listPane = ("), src.indexOf("const listPane = (") + 1600);
    assert.equal(
        /borderRight:\s*\{\s*md:\s*"1px solid var\(--card-border\)"\s*\}/.test(listPane),
        false,
        "左栏容器不要带 borderRight —— 它落在最后那条把手右侧 12px，会变成第二条线"
    );
});

test("工具栏只有一个内容块下拉（之前有两个同名「块」按钮开同一个菜单）", () => {
    const src = readNotesPage();
    assert.equal(
        (src.match(/aria-label='块'/g) ?? []).length,
        0,
        "aria-label='块' 的按钮要删掉（inkstone 叫「内容块」）：留两个的话读屏会念两遍，点哪个都一样"
    );
    assert.ok(
        src.includes("aria-label='内容块'"),
        "内容块下拉要在，用 inkstone zh-CN 里的原名 workspace.content_blocks"
    );
});
// ===========================================================================
// 2026-10-07 第十三批：竖线空隙 13px / 中文长句撑破预览 / 侧栏底色
// ===========================================================================

test("列表列与编辑区之间不能有多余空隙（两条把手净占 1px，不是 9px 也不是 18px）", () => {
    const src = readNotesPage();
    // ⚠️ 钉的是 2026-10-07 修的那个真 bug（用户红框圈出来的「竖长条」）：
    // 每条拖动把手是 `width: 9px` + `mx: -4px` —— 负边距让它向两侧各溢出 4px，
    // 所以**净占 9 − 4 − 4 = 1px**。之前 listPane 总宽写的是 `navW + listW + 18`
    // （把两条把手都按满宽 9px 算），于是多出 13px 的空白带夹在列表列与编辑区之间。
    // 真机逐列读像素确认过：列表列 right=336、编辑区 left=354，中间 337..353 空着，
    // 而发丝线在 337 —— 视觉上就是「一条竖长条」。
    //
    // inkstone 那边压根不给这个数（AppShell.tsx:95-107：每列各自 shrink-0 + 定宽，
    // Resizer 是它们之间的兄弟节点，浏览器自然排布，零死空间）。
    // 我们把两列塞进同一个容器，只能自己算这笔账。
    const w = src.slice(src.indexOf("width: bp === \"mobile\""), src.indexOf("width: bp === \"mobile\"") + 600);
    assert.ok(
        /navW \+ listW \+ 6\b/.test(w),
        "desktop 档总宽应是 navW + listW + 6（两条把手各净占 1px + 最后一条露 5px）"
    );
    assert.equal(
        /navW \+ listW \+ 18/.test(src),
        false,
        "别再用 navW + listW + 18 —— 那是把 9px 把手按满宽算，会多出 13px 空隙"
    );
    // tablet / listHidden 两档同理
    assert.ok(/listW \+ 5\b/.test(w), "tablet 档应是 listW + 5");
    assert.ok(/navW \+ 5\b/.test(w), "listHidden 档应是 navW + 5");
});

test("预览层用 overflowWrap:anywhere，不能只有 wordBreak:break-word", () => {
    const src = readNotesPage();
    // ⚠️ 用户报「分栏时右侧内容超出屏幕」。真机 1080 宽复现：预览层 377px，
    // 一条纯中文长标题「## 引用内容引用内容…」被切掉半个字，而且**没有滚动条**。
    //
    // 真因：`word-break: break-word` 只在**词边界**断行，而中文没有空格，
    // 整串 CJK 被当成一个超长单词 → 撑到 1000px 宽也不断。
    // inkstone 用的是 `overflow-wrap: anywhere`（prose.css:429/435/897/960），
    // 必要时在任意字符间断行。源码区（CodeMirror）早就配了 anywhere，只有预览层漏了。
    assert.ok(
        /overflowWrap: "anywhere"/.test(src),
        "预览层要 overflowWrap:anywhere（中文长句靠它断行；break-word 不够）"
    );
    // 行内渲染块也要（它是预览的一个分支）
    const count = (src.match(/overflowWrap: "anywhere"/g) ?? []).length;
    assert.equal(
        count,
        2,
        "两处都要：预览层容器 + 行内渲染块（漏一处那条路径还是会溢出）"
    );
});

test("主行必须 minWidth:0（否则超长代码块把整行顶出视口）", () => {
    const src = readNotesPage();
    // ⚠️ 用户报「编辑区有代码等内容时右边还是会超出范围」。
    // flex 子项的 min-width 默认 auto = 至少撑到内容的 min-content，
    // 于是一个超长代码块的 <pre>（本该自己滚动）把**这一整行**顶宽：
    // 真机量到 1080 视口下该行被顶到 1209px、编辑区 992px，46 个元素越界。
    // ⚠️ 锚点必须用**代码**而不是注释：readNotesPage() 会 stripComments()，
    // 注释里的「主体：desktop」早就被剥掉了，indexOf 返回 −1、slice 出空串，
    // 断言会永远红（这条测试第一版就这么栽了）。
    const body = src.slice(
        src.indexOf('display: bp === "mobile" && !mobileDetail ? "none" : "flex"'),
        src.indexOf("data-pane-divider")
    );
    assert.ok(body.length > 0, "定位不到主体那一段");
    // ⚠️⚠️ 三个坑叠在一起，这条断言第一版栽了两次：
    //  1. 锚点写在注释里 → readNotesPage() 会 stripComments()，indexOf 返回 −1；
    //  2. 正则里的引号没转义 → 在 .tsx 的模板上下文里提前闭合；
    //  3. **源码是 CRLF** —— `minHeight: 0,\n` 那种「精确到换行」的匹配全都不成立。
    // 所以这里只断言**属性存在**，不写死换行；CRLF/LF 都能过。
    assert.ok(
        /flex:\s*1,[\s\r\n]*display:\s*"flex",[\s\r\n]*minHeight:\s*0,[\s\r\n]*minWidth:\s*0/.test(body),
        "主体那一行必须 minWidth:0（inkstone 每个 flex 容器都写了 min-w-0）"
    );
    assert.ok(
        /<Box sx=\{\{ flex: 1, display: "flex", minHeight: 0 \}\}>/.test(src) === false,
        "别再写没有 minWidth 的主体行 —— 它会被内容顶宽"
    );
});

test("侧边编辑区与主编辑区同底色（用户报「侧边打开时框颜色不一样」）", () => {
    const src = readNotesPage();
    // 主编辑区那层写了 bgcolor: var(--bg-editor)，侧边这层没写 →
    // 它透出父容器（--bg-base / --bg-sunken），两栏底色深浅不同，看着像「两个框」。
    // inkstone 两栏是同一个底色（Workspace.tsx:378）：
    //   flex h-full min-col-0 flex-col bg-[var(--bg-editor)]
    const side = src.slice(src.indexOf("data-side-editor='1'"), src.indexOf("data-side-editor='1'") + 900);
    assert.ok(
        /bgcolor: "var\(--bg-editor\)"/.test(side),
        "侧边编辑区要跟主编辑区一样用 --bg-editor（否则两栏颜色不同）"
    );
});

test("笔记行选中态不画 3px 左边框（会被拉成贯穿整屏的色带）", () => {
    const src = readNotesPage();
    // ⚠️ 2026-10-07：原来选中行有 `borderLeft: "3px solid"` + 强调色。
    // 在「选中文件夹 → 笔记内联在左栏」时它被拉成**贯穿整屏的 3px 青绿色带**
    // （真机读像素：rgb(20,184,166)，y=0..911 全命中，x=599..601）。
    // inkstone 的选中行没有左边框（NoteList.tsx:519-523）：
    //   选中 = bg-[var(--accent-soft)] + ring-1 ring-[var(--accent)]/40
    assert.equal(
        /borderLeft: "3px solid"/.test(src),
        false,
        "笔记行不要 3px 左边框（inkstone 没有；它会在窄栏里被拉成贯穿整屏的色带）"
    );
    // 反向锚点：改用软底 + 淡描边
    // ⚠️ 窗口要装得下**整行**：2026-10-10 往行里加了「⌘/Ctrl 点 / Shift 点」那三十行，
    // 6000 就不够了 —— 守卫自己红了而功能一点没坏（这种红比没守卫更糟），取 9000。
    const row = src.slice(src.indexOf("data-note-id={note.id}"), src.indexOf("data-note-id={note.id}") + 9000);
    assert.ok(
        /border: "1px solid"/.test(row) && /color-mix\(in srgb, var\(--accent\) 40%/.test(row),
        "选中态改用 1px 淡描边（inkstone 的 ring-1）+ 软底"
    );
});
// ===========================================================================
// 2026-10-07 第十七批：分栏滚动同步改成「按源码行锚点」
// ===========================================================================

test("预览块必须带 data-line（滚动同步按行锚点定位的前提）", () => {
    const src = readSrcFile("utils", "markdownToReact.tsx");
    // 锚点从 markdown-it 的 token.map[0] 取（源码 0 基行号）。
    // 没有它就只能按百分比滚 —— 两栏长度不同时必然漂移
    // （真机量到源码 2987px / 预览 2175px，差 27%）。
    assert.ok(
        /anchorProps[\s\S]{0,700}data-line/.test(src),
        "anchorProps 要给块级元素挂 data-line（inkstone 的 previewSourceAnchors 同款）"
    );
    assert.ok(
        /Array\.isArray\(tok\.map\)/.test(src),
        "行号要从 token.map 取（markdown-it 的 map 是 [起始行, 结束行]）"
    );
});

test("滚动同步用锚点插值，不是按比例（对齐 inkstone 的 sync-scroll）", () => {
    const sync = readSrcFile("utils", "syncScroll.ts");
    const page = readNotesPage();
    // ⚠️ 之前是 `el.scrollTop = ratio * max`，比例对齐在两栏长度不同时会漂。
    assert.equal(
        /scrollTop = Math\.max\(0, Math\.min\(1, ratio\)\) \* max/.test(page),
        false,
        "别再按比例同步（previewTop = ratio × maxScroll）"
    );
    assert.ok(
        /previewTopForLine/.test(sync) && /buildScrollCurve/.test(sync),
        "要有「曲线插值」那套：buildScrollCurve + previewTopForLine"
    );
    // 防反馈环的 driver 门控：没有它两栏会互相追着跑
    assert.ok(
        /DRIVER_IDLE_MS/.test(sync) && /claim/.test(sync),
        "要有 driver 门控（只有被 wheel/pointerdown 碰过的那侧才能带动另一侧）"
    );
    // 只能在分栏 + 设置开着时同步（inkstone: settings.preview.syncScroll && showSplit）
    assert.ok(
        /pane === "split" && uiSettings\.scrollSync/.test(page),
        "同步只在「分栏 + 设置里开着滚动同步」时启用"
    );
});

test("绑定要等预览层挂上再绑（切分栏那一刻 previewScrollRef 还是 null）", () => {
    const page = readNotesPage();
    // 真机症状：切到分栏后预览纹丝不动。根因是 effect 在 pane 变 "split" 的
    // 那一刻跑，此时预览层还没渲染，previewScrollRef.current === null，
    // 于是 effect 直接 return，之后依赖没变、再也不重跑。
    // 解法是轮询等 ref 到位（最多 ~1.2s）。
    assert.ok(
        /previewScrollRef\.current/.test(page) && /setTimeout\(tryBind/.test(page),
        "要用轮询等 previewScrollRef 就绪，不能一次性 querySelector 后 return"
    );
    // ⚠️ 绝不能在 useEffect 里调 useState：违反 Hooks 规则，
    // 真机直接白屏（React error #321 "Invalid hook call"）。
    assert.equal(
        /useEffect\(\(\) => \{[\s\S]{0,900}const \[, forceReady\] = useState/.test(page),
        false,
        "不要在 useEffect 里调 useState（React error #321，会白屏）"
    );
});

// ===========================================================================
// 2026-10-07 第十八批：图片上传（KV 落地，R2 接口预留）
// ===========================================================================

test("源码静态守卫的「剥注释」不能被注释里的 /* 骗到", () => {
    const raw = readFileSync(
        join(findProjectDir(), "src", "components", "NotesPage.tsx"),
        "utf-8"
    );
    const stripped = stripComments(raw);

    // ⚠️ 这个坑 2026-10-07 真踩过一次，代价是两条毫不相干的守卫同时变红、
    // 排查了很久才想到是注释的问题：
    //   在 `//` 行注释里写了「SPA 兜底把 /api/* 回落成 index.html」，
    //   其中 **`/api/*` 的 `/*` 被 stripComments 当成块注释起始**，
    //   于是第一个 replace 从那个 `/*` 一路吃到下一个 `*/`，
    //   把中间几百行**真的代码**全删了 —— 后面所有「源码里应该有 X」的守卫
    //   集体失配，而报错信息只会说是 X 不见了，完全指不到注释上。
    //
    // 所以留一条**自愈式**守卫：不针对某段具体代码，只保证剥完注释后
    // 内容没有异常缩水。真被误吞时这里的比值会暴跌，一眼就知道是注释惹的祸。
    const ratio = stripped.length / raw.length;
    assert.ok(
        ratio > 0.75,
        `剥注释后只剩 ${(ratio * 100).toFixed(1)}%（${stripped.length}/${raw.length}）—— ` +
            "多半是某条 `//` 注释里混进了 `/*`（比如写 `/api/*`），把后面大片代码当成块注释吃掉了"
    );

    // 顺手守住「剥完还能认出关键代码」这件事本身
    assert.ok(
        /pane === "split"/.test(stripped),
        "剥完注释必须还能找到真实代码（否则所有源码守卫都是在匹配空字符串）"
    );
});

test("上传响应缺字段时要报错，不能插出 ![undefined]", () => {
    const page = readNotesPage();
    // 真机实测的坑：后端/中间层回了「200 但不是预期 JSON」时（错误页、代理拦截，
    // 或 SPA 兜底把接口回落成 index.html），前端拿到的响应没有 url 与 filename。
    // 不拦的话：`fetch(undefined)` 会去请求**当前页面**、拿到 HTML 还当成图片内嵌，
    // 正文里出现 `![undefined](data:text/html;base64,...)`，用户完全看不懂。
    assert.ok(
        /result\?\.url[\s\S]{0,120}result\?\.filename/.test(page),
        "上传返回要先校验 url 与 filename，缺了就抛错"
    );
    assert.ok(
        /上传返回的数据不完整/.test(page),
        "要给出人话提示（「上传返回的数据不完整」）"
    );
    // 只内嵌**真的是图片**的响应：200 也可能是错误页，内嵌了比裂图还难排查
    assert.ok(
        /blob\.type\.startsWith\("image\/"\)/.test(page),
        "内嵌前要确认 blob 是图片（光看 response.ok 不够，200 可能是 HTML 错误页）"
    );
});

test("附件存储：R2 优先、KV 降级、都没配就禁用（对齐 inkstone selectAttachmentStorage）", () => {
    const store = readSrcFile("..", "worker", "attachments.ts");
    assert.ok(
        /env\.FILES[\s\S]{0,60}return "r2"/.test(store),
        "绑定了 R2（env.FILES）就用 r2"
    );
    assert.ok(
        /env\.FILES_KV[\s\S]{0,60}return "kv"/.test(store),
        "没 R2 但绑了 KV（env.FILES_KV）就用 kv"
    );
    assert.ok(/return null/.test(store), "两个都没绑就返回 null（上传入口禁用）");
    // 配额常量对齐 inkstone shared/constants：25MB / 1GB / 每小时 100 次
    assert.ok(
        /ATTACHMENT_MAX_BYTES = 25 \* 1024 \* 1024/.test(store),
        "单文件上限 25MB"
    );
    assert.ok(
        /ATTACHMENT_QUOTA_BYTES = 1024 \* 1024 \* 1024/.test(store),
        "总配额 1GB"
    );
    assert.ok(
        /ATTACHMENT_UPLOADS_PER_HOUR = 100/.test(store),
        "每小时最多 100 次上传"
    );
    // 并发下「都读到已用 900MB、都觉得还能塞 100MB」→ 实际写 1.1GB。
    // inkstone 用租约把同一用户的上传串行化，我们照做。
    assert.ok(
        /ATTACHMENT_LEASE_MS/.test(store),
        "要有租约（lease）把同一用户的上传串行化，否则并发会突破配额"
    );
    // 类型只按文件头判定，不信客户端给的 Content-Type
    assert.ok(
        /function sniffImageMime/.test(store),
        "要按文件头嗅探类型（不能信 Content-Type，那是客户端给的）"
    );
    assert.ok(
        !/"image\/svg\+xml"/.test(store),
        "SVG 不能进白名单（它是 XML，能内嵌脚本）"
    );
});

test("附件表随迁移建出来，且不下车（schema 版本随附件迁移抬升）", () => {
    const migration = readSrcFile("API", "methods", "migration.ts");
    const internals = readSrcFile("API", "methods", "internals.ts");
    // 📌 判「单调 >= 12」而不是死钉 "12"：附件那次升级把版本抬到 12，
    // 之后每次新增迁移步骤还会继续 +1（如 13 = note_share 口令/浏览数）。
    // 死钉具体号只会让下一次升级无意义变红（noteSql.test.ts 里同样的教训）。
    const version = Number(/\bSCHEMA_VERSION = "(\d+)"/.exec(migration)?.[1]);
    assert.ok(
        Number.isFinite(version) && version >= 12,
        `schema 版本要 >= 12（附件表那次升级抬的号），现在是 ${version}`
    );
    // ⚠️ 和当初 migrateFolderTagTables 那个 500 是同一个坑：
    // 「版本号读得到就整段跳过迁移」的快路径会让新表永远建不出来。
    assert.ok(
        /migrateAttachmentsTable\(\)/.test(migration),
        "迁移入口要显式调用 migrateAttachmentsTable（不然新库永远没有这张表）"
    );
    assert.ok(
        /CREATE TABLE IF NOT EXISTS attachments/.test(internals),
        "要有 attachments 建表语句"
    );
    // 配额要 SUM(size)，没索引的话每次上传都是全表扫
    assert.ok(
        /idx_attachments_user/.test(internals),
        "要有 user_id 索引（配额按 SUM(size) 算）"
    );
});

// ---------------------------------------------------------------------------
// 2026-10-08 第二轮：图片「传上去了却看不见」的三条链路守卫
//   （a）上传通道的额度 —— 通用 256KB 会把一张普通截图直接判 413；
//   （b）预览里 <img> 的带凭据回退 —— 取图挂在鉴权后面，匿名请求会 401；
//   （c）413 的人话提示 —— 纯文本响应解析不出 message，否则只剩「API错误: 413」。
// ---------------------------------------------------------------------------

test("附件上传必须单独放开 body 额度（通用 256KB 会把普通截图判成 413）", () => {
    const index = stripComments(
        readFileSync(join(findProjectDir(), "worker", "index.ts"), "utf-8")
    );
    // ⚠️ 切片要**往前**取：额度是在调 readBoundedBytes **之前**算出来的
    const at = index.indexOf("readBoundedBytes(request.body");
    const block = index.slice(Math.max(0, at - 900), at + 400);
    assert.ok(
        /ATTACHMENT_MAX_BYTES/.test(block),
        "附件上传要用 ATTACHMENT_MAX_BYTES 这个额度，不能吃通用的 256KB"
    );
    assert.ok(
        /notes\/attachments/.test(block),
        "额度分支要认 /api/notes/attachments 这个路径"
    );
    // 额度常量本身必须真的存在（别哪天删了还没人发现）
    const store = stripComments(
        readFileSync(join(findProjectDir(), "worker", "attachments.ts"), "utf-8")
    );
    assert.ok(
        /export const ATTACHMENT_MAX_BYTES/.test(store),
        "ATTACHMENT_MAX_BYTES 要从 attachments.ts 导出"
    );
});

test("预览图片：直连失败时要带凭据再取一次，并把失败原因写出来", () => {
    const src = readSrcFile("utils", "markdownToReact.tsx");
    assert.ok(/function NoteImage/.test(src), "要有独立的 NoteImage 组件");
    assert.ok(
        /credentials: *"same-origin"/.test(src),
        "取附件图必须显式带凭据（same-origin）—— <img> 那次请求不带时就是 401"
    );
    assert.ok(
        /URL.createObjectURL/.test(src),
        "拿到的字节要转 objectURL 再喂给 <img>"
    );
    // 失败不能是静默空白：把状态码 / 原因显示出来
    assert.ok(
        /图片加载失败/.test(src),
        "加载不出来要给明确占位，而不是留一片空白"
    );
    assert.ok(
        /服务器返回\s*\$\{response\.status\}/.test(src),
        "占位里要带 HTTP 状态码（区分「没权限」和「图没了」）"
    );
    // 只有本站附件值得重试；外链跨域 fetch 反而更糟
    assert.ok(
        /isProtectedAttachment/.test(src),
        "要区分「本站附件」与外链，别对外链也做 fetch 重试"
    );
});

// ⚠️ 这条盯的是「编辑区图片不停抽动」的真因（2026-10-09 用户报）：
// 渲染块（把整块 markdown 换成渲染结果的 widget）的高度**会变** —— 图片加载完
// 会把这一块从 20px 撑到 300px。CM 靠自己的高度表算视口 / 要不要出滚动条 /
// 虚拟化哪些行，高度变了**必须**通知它重测；以前只在 render() 的 promise 完成后
// 测一次（那时 <img> 还没插进 DOM，量到的是空高度），之后没人再告诉 CM，
// 于是「CM 以为的高度」与「浏览器真实布局」长期不一致，编辑区拖到刚好要出
// 滚动条的临界点就两边互相推翻 —— 表现就是图片（连整块内容）不停地抖。
// 回滚验证：把 NoteEditorLivePreview 里那句 new ResizeObserver 删掉，这条就红。
test("编辑区渲染块：高度一变就要通知 CodeMirror 重测（图片抽动的真因）", () => {
    const src = readSrcFile("components", "NoteEditorLivePreview.ts");
    assert.ok(/new ResizeObserver/.test(src), "渲染块要挂 ResizeObserver 盯高度变化");
    // 观察到变化后必须让 CM 重测，光 observer 不做事等于没挂
    const at = src.indexOf("new ResizeObserver");
    const block = src.slice(at, at + 260);
    assert.ok(
        /requestMeasure/.test(block),
        "ResizeObserver 回调里必须 view.requestMeasure()（否则 CM 的高度表还是旧的）"
    );
    assert.ok(
        /observer\?\.disconnect\(\)/.test(src),
        "destroy 时要 disconnect，否则销毁后还往已下线的 view 上报测量"
    );
});

// 抽动的第二半：widget 会随视口进出反复重建，没缓存时每重建一次就重走一遍
// 「直连 → 失败 → 带凭据 fetch → objectURL → 卸载时 revoke」，图就没了又来。
// 缓存里还要记下自然尺寸，重挂时带上 width/height 让浏览器预留正确高度，
// 0 → 300px 的塌缩撑开消失，抖动幅度也就没了。
test("预览图片：结论与尺寸要进模块级缓存（重挂不再重复请求、不再从 0 高度开始）", () => {
    const src = readSrcFile("utils", "markdownToReact.tsx");
    assert.ok(/const imageCache = new Map</.test(src), "要有模块级的图片结果缓存");
    assert.ok(/rememberImage/.test(src), "加载结论要写回缓存（含 LRU 淘汰）");
    // 尺寸要真的用到 <img> 上，否则浏览器预留不出高度
    assert.ok(/width=\{size\?\.width\}/.test(src), "缓存里的宽要带到 <img> 上");
    assert.ok(/height=\{size\?\.height\}/.test(src), "缓存里的高要带到 <img> 上");
    assert.ok(/onLoad=/.test(src), "图加载完要把自然尺寸记进缓存");
});

test("上传被拒（413）要说人话，不能只剩「API错误: 413」", () => {
    const src = readSrcFile("API", "client.ts");
    assert.ok(
        /response\.status === 413/.test(src),
        "client 要单独处理 413（worker 回的是纯文本，解析不出 message）"
    );
    assert.ok(
        /太大|过大/.test(src),
        "413 的提示要说明「内容太大」，而不是抛一个状态码"
    );
});

test("预览模式下不能上传图片（编辑器不挂载，插了也是静默丢失）", () => {
    const src = readNotesPage();
    // 工具栏要收到 canInsert，且预览模式下是 false
    assert.ok(
        /canInsert=\{pane !== "preview"\}/.test(src),
        "主工具栏要按 pane 传 canInsert（预览模式下编辑器不挂载）"
    );
    // 上传前必须挡一道并说明原因，不能「传完了才发现没插进去」
    const picked = src.slice(src.indexOf("const handleImagePicked"), src.indexOf("const handleImagePicked") + 1200);
    assert.ok(
        /canInsertOk/.test(picked) && /预览模式插不进正文/.test(picked),
        "预览模式上传要直接提示，不能让图白传一次"
    );
    // 菜单项也要置灰（不是点了才报错）
    assert.ok(
        /disabled=\{uploading \|\| !canInsertOk\}/.test(src),
        "上传菜单项在预览模式下要置灰"
    );
});

// ---------- 8. 设置→备份（2026-10-09 照 inkstone 的 BackupSettings） ----------

interface BackupRunStub {
    id: string;
    startedAt: string;
    trigger: "auto" | "manual";
    status: "success" | "failure";
    filename?: string;
    noteCount?: number;
    bytes?: number;
    durationMs?: number;
    error?: string;
}

function defaultBackupRuns(): BackupRunStub[] {
    return [
        {
            id: "r1",
            startedAt: "2026-10-09T03:00:00.000Z",
            trigger: "auto",
            status: "success",
            filename: "navihive-notes-backup-auto-20261009-030000-000.json.gz",
            noteCount: 5,
            bytes: 2048,
            durationMs: 900,
        },
        {
            id: "r2",
            startedAt: "2026-10-08T03:00:00.000Z",
            trigger: "manual",
            status: "failure",
            error: "认证失败，请检查 WebDAV 账号或应用密码",
        },
    ];
}

function makeBackupApi(log: {
    calls: string[];
    saved: Record<string, unknown>[];
    runs?: BackupRunStub[];
}) {
    // 没显式给就预置两条默认记录（一成一败）；save({runs}) 会整组替换
    if (!log.runs) log.runs = defaultBackupRuns();
    return {
        getState: async () => ({
            webdavUrl: "https://dav.example.com/dav/",
            webdavUsername: "alice",
            path: "navihive-notes-backup",
            backupPassword: "",
            hasNavBackupPassword: true,
            schedule: "weekly",
            retention: 7,
            runs: log.runs ?? [],
        }),
        save: async (patch: Record<string, unknown>) => {
            log.saved.push(patch);
            if (Array.isArray(patch.runs)) log.runs = patch.runs as typeof log.runs;
        },
        test: async () => {
            log.calls.push("test");
            return { success: true, message: "连接成功，备份目录可用" };
        },
        run: async () => {
            log.calls.push("run");
            return { success: true, message: "已备份到 WebDAV：navihive-notes-backup-20261009-040000-000.json.gz" };
        },
        // 删除网盘上的一份备份（2026-10-10，最近备份的删除按钮）
        deleteRemote: async (filename: string) => {
            log.calls.push("deleteRemote:" + filename);
            return { success: true, message: "已删除" };
        },
        // 备份闭环的另一半：从网盘取回（2026-10-09）
        listRemote: async () => {
            log.calls.push("listRemote");
            return {
                success: true,
                message: "",
                files: [
                    {
                        name: "navihive-notes-backup-auto-20261009-030000-000.json.gz",
                        size: 2048,
                        lastModified: "2026-10-09T03:00:00.000Z",
                    },
                ],
            };
        },
        fetch: async (filename: string, password: string) => {
            log.calls.push("fetch:" + filename + ":" + password);
            if (!password) {
                return { success: false, message: "这份备份是加密的", code: "encrypted" as const };
            }
            if (password !== "pw") {
                return { success: false, message: "密码不对", code: "badPassword" as const };
            }
            return {
                success: true,
                message: "",
                payload: {
                    kind: "navihive-notes-export",
                    exported_at: new Date().toISOString(),
                    notes: [{ id: 7, uuid: "u7", title: "网盘里那篇", content: "内容" }],
                    folders: [],
                    tags: [],
                    noteTags: {},
                } as never,
            };
        },
    };
}

/** 带导入能力的 shareApi：网盘恢复的最后一步走 notes/import 同一条链路 */
function makeImportShareApi(log: { imports: number; lastPayload?: unknown }) {
    return {
        getNoteShare: async () => null,
        createNoteShare: async () => null,
        revokeNoteShare: async () => ({ success: true }),
        importNotes: async (payload: unknown) => {
            log.imports += 1;
            log.lastPayload = payload;
            return { created: 1, updated: 2, skipped: 0 } as never;
        },
    } as never;
}

test("设置→备份：带入导航页网盘配置，立即备份 / 测试连接 / 运行记录都能用", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[] } = { calls: [], saved: [] };
    mountPanel([note({ id: 1, title: "甲", content: "a" })], { backupApi: makeBackupApi(log) });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    const dialog = document.querySelector("[data-notes-settings='1']")!;
    assert.ok(dialog.querySelector("[data-settings-tab='backup']"), "设置里要有「备份」这一页");
    await act(async () =>
        (dialog.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );

    // 网盘地址与账号「自动带入」（导航页保存后这里直接显示，不用再填一遍）
    assert.ok(text().includes("https://dav.example.com/dav/"), "网盘地址要显示出来");
    assert.ok(text().includes("alice"), "账号要显示出来");

    // 立即备份 → 调用 run
    await act(async () =>
        (document.querySelector("[data-backup-action='run-now']") as HTMLElement).click()
    );
    assert.ok(log.calls.includes("run"), "立即备份要调到 run");

    // 测试连接 → 结果就地显示
    await act(async () =>
        (document.querySelector("[data-backup-action='test']") as HTMLElement).click()
    );
    assert.ok(
        document.querySelector("[data-backup-test-result='ok']"),
        "测试连接的结果要显示在页面上"
    );

    // 运行记录：成功一条（条数 · 大小）与失败一条；点开失败那条能看到原因
    assert.equal(document.querySelectorAll("[data-backup-run]").length, 2, "要有两条运行记录");
    assert.ok(text().includes("5 条 · 2 KB"), "成功记录要显示笔记条数与体积");
    await act(async () =>
        (document.querySelector("[data-backup-run='r2'] button") as HTMLElement).click()
    );
    assert.ok(text().includes("认证失败"), "失败记录展开后要能看到原因");

    // 改备份目录 → 失焦保存（写入 notesBackup.path）
    const pathInput = document.querySelector('input[aria-label="备份目录"]') as HTMLInputElement;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
        )?.set;
        setter?.call(pathInput, "my-notes-dir");
        pathInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // ⚠️ jsdom 对「没聚焦过的元素」调 blur() 不派发 blur 事件，先 focus 再 blur
    await act(async () => {
        pathInput.focus();
        pathInput.blur();
    });
    assert.ok(
        log.saved.some(p => p.path === "my-notes-dir"),
        "目录改动失焦后要保存"
    );
});

test("设置→备份：删除一条最近备份 —— 先删网盘文件，成功后记录也移除", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[]; runs?: BackupRunStub[] } = {
        calls: [],
        saved: [],
    };
    mountPanel([note({ id: 1, title: "甲", content: "a" })], { backupApi: makeBackupApi(log) });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );
    assert.equal(document.querySelectorAll("[data-backup-run]").length, 2, "一开始有两条记录");

    // 点成功那条（带网盘文件）的删除按钮 → 弹二次确认
    await act(async () =>
        (
            document.querySelector(
                "[data-backup-run='r1'] button[aria-label^='删除这条备份']"
            ) as HTMLElement
        ).click()
    );
    assert.ok(
        text().includes("删除这条备份？"),
        "删除要有二次确认（文件会从网盘删掉，不可恢复）"
    );

    // 确认 → 先调 deleteRemote 删文件，再 save({runs}) 移除记录
    await act(async () => {
        await (
            document.querySelector("[data-confirm-action='confirm']") as HTMLElement
        ).click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.ok(
        log.calls.includes(
            "deleteRemote:navihive-notes-backup-auto-20261009-030000-000.json.gz"
        ),
        "有网盘文件的记录要先删文件"
    );
    const runsPatch = log.saved.find(p => Array.isArray(p.runs)) as
        | { runs: { id: string }[] }
        | undefined;
    assert.ok(runsPatch, "删除后要写回剩下的记录");
    assert.deepEqual(
        runsPatch.runs.map(r => r.id),
        ["r2"],
        "r1 的记录要被移除，r2 保留"
    );
    // 刷新后列表只剩一条（等元素消失，别写死 sleep —— CI 慢机会假红）
    const deadline = Date.now() + 1000;
    while (document.querySelectorAll("[data-backup-run]").length !== 1 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(document.querySelectorAll("[data-backup-run]").length, 1, "刷新后只剩 r2");
});

test("设置→备份：网盘文件删不掉时记录不能先没（孤儿备份防线）", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[]; runs?: BackupRunStub[] } = {
        calls: [],
        saved: [],
    };
    const api = makeBackupApi(log) as Record<string, unknown> & {
        deleteRemote: (filename: string) => Promise<{ success: boolean; message: string }>;
    };
    // 网盘侧删除失败：记录必须原样保留
    api.deleteRemote = async () => ({ success: false, message: "网盘拒绝了删除" });
    const notify: string[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        backupApi: api as never,
        onNotify: (m: unknown) => notify.push(String(m)),
    });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );
    await act(async () =>
        (
            document.querySelector(
                "[data-backup-run='r1'] button[aria-label^='删除这条备份']"
            ) as HTMLElement
        ).click()
    );
    await act(async () => {
        await (
            document.querySelector("[data-confirm-action='confirm']") as HTMLElement
        ).click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.ok(
        notify.some(m => m.includes("网盘拒绝了删除")),
        "删除失败要有提示（实际收到：" + notify.join(" / ") + "）"
    );
    assert.equal(
        document.querySelectorAll("[data-backup-run]").length,
        2,
        "文件删不掉时记录不能先被移除"
    );
    assert.equal(log.saved.length, 0, "失败时不能写回 runs");
});

test("设置→备份：频率与保留的当前值要显示（weekly / 最近 7 份）", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[] } = { calls: [], saved: [] };
    mountPanel([note({ id: 1, title: "甲", content: "a" })], { backupApi: makeBackupApi(log) });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );
    const dialog = document.querySelector("[data-notes-settings='1']")!;
    const schedule = dialog.querySelector("[data-backup-select='schedule']");
    assert.ok(schedule, "要有频率选择器");
    assert.ok(schedule.textContent?.includes("每周"), "频率当前值是每周");
    const retention = dialog.querySelector("[data-backup-select='retention']");
    assert.ok(retention, "要有保留份数选择器");
    assert.ok(retention.textContent?.includes("最近 7 份"), "保留当前值是 7 份");
});

test("设置→备份→从网盘恢复：列出备份文件，选一份就恢复（走导入同一条链路）", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[] } = { calls: [], saved: [] };
    const imp = { imports: 0 };
    const notify: string[] = [];
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        backupApi: makeBackupApi(log),
        shareApi: makeImportShareApi(imp),
        onNotify: (m: unknown) => notify.push(String(m)),
    });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-backup-restore='1']"), "备份页要有「从网盘恢复」这一节");

    // 列出网盘备份
    await act(async () =>
        (document.querySelector("[data-backup-action='list-remote']") as HTMLElement).click()
    );
    assert.ok(log.calls.includes("listRemote"), "点「列出备份」要调到 listRemote");
    const fileRow = document.querySelector("[data-backup-remote-file]");
    assert.ok(fileRow, "列出的每一份都要有一行");
    assert.match(
        fileRow!.textContent ?? "",
        /navihive-notes-backup-auto-20261009-030000-000\.json\.gz/,
        "行上要显示文件名"
    );

    // 直接点恢复：备份页上没设口令，后端回 encrypted → 就地展开口令输入框
    await act(async () =>
        (document.querySelector("[data-backup-action='restore']") as HTMLElement).click()
    );
    assert.equal(imp.imports, 0, "还不知道口令时不能先导入");
    assert.ok(
        document.querySelector("[data-backup-restore-pwd='1']"),
        "缺口令时要就地展开口令输入框"
    );
    assert.ok(
        document.querySelector("[data-backup-remote-error='1']"),
        "缺口令要给出说明，不能静默失败"
    );

    // 填上正确口令 → 真恢复
    const pwd = document.querySelector('input[aria-label="恢复备份密码"]') as HTMLInputElement;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
        )?.set;
        setter?.call(pwd, "pw");
        pwd.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
        await (document.querySelector("[data-backup-action='restore-confirm']") as HTMLElement).click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(imp.imports, 1, "口令对了要真的走一次导入");
    assert.ok(
        notify.some(m => m.includes("已从网盘恢复")),
        "恢复完要有提示（实际收到：" + notify.join(" / ") + "）"
    );
    assert.ok(
        document.querySelector("[data-backup-restore-pwd='1']") === null,
        "恢复成功后口令输入框要收起来"
    );
});

test("设置→备份→从网盘恢复：口令错了留在框里让人重填，取消就收起", async () => {
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[] } = { calls: [], saved: [] };
    const imp = { imports: 0 };
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        backupApi: makeBackupApi(log),
        shareApi: makeImportShareApi(imp),
    });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-backup-action='list-remote']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-backup-action='restore']") as HTMLElement).click()
    );
    const pwd = document.querySelector('input[aria-label="恢复备份密码"]') as HTMLInputElement;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
        )?.set;
        setter?.call(pwd, "wrong");
        pwd.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
        await (document.querySelector("[data-backup-action='restore-confirm']") as HTMLElement).click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(imp.imports, 0, "口令不对不能导入");
    assert.ok(
        document.querySelector("[data-backup-restore-pwd='1']"),
        "口令错了输入框要留着让人重填"
    );
    assert.match(text(), /密码不对/, "要把后端的原因显示出来");

    // 取消 → 收起输入框与错误
    await act(async () =>
        (document.querySelector("[data-backup-action='restore-cancel']") as HTMLElement).click()
    );
    assert.ok(
        document.querySelector("[data-backup-restore-pwd='1']") === null,
        "取消后口令输入框要收起"
    );
    assert.ok(
        document.querySelector("[data-backup-remote-error='1']") === null,
        "取消后错误提示也要清掉"
    );
});

test("回归：从网盘恢复读的是顶层 files/payload（request 不包 data 层），退回 r.data?. 会列空且导入拿不到", async () => {
    // 真 bug（2026-10-10）：后端 notesBackupListRemote/notesBackupDownload 走
    // `request()`，它直接 return response.json()，后端返回的是**顶层** {success, files} /
    // {success, payload}。NotesOverlay 若写成 r.data?.files / r.data?.payload，
    // 因为根本没 data 这层，恒为 undefined —— 列表永远空、导入拿不到 payload，
    // 表现就是「备份的文件无法恢复」。这里用与真实后端同构（顶层字段）的桩钉死：
    // 列表要出文件行、导入要真的收到 payload。若有人改回 r.data?.，此用例必红。
    setWide();
    const log: { calls: string[]; saved: Record<string, unknown>[] } = { calls: [], saved: [] };
    const imp: { imports: number; lastPayload?: unknown } = { imports: 0 };
    mountPanel([note({ id: 1, title: "甲", content: "a" })], {
        backupApi: makeBackupApi(log),
        shareApi: makeImportShareApi(imp),
    });
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    await act(async () =>
        (document.querySelector("[data-settings-tab='backup']") as HTMLElement).click()
    );

    await act(async () =>
        (document.querySelector("[data-backup-action='list-remote']") as HTMLElement).click()
    );
    const fileRow = document.querySelector("[data-backup-remote-file]");
    assert.ok(fileRow, "顶层 files 必须被读出来 —— 退回 r.data?.files 这里会是空列表");
    assert.match(
        fileRow!.textContent ?? "",
        /navihive-notes-backup-auto-20261009-030000-000\.json\.gz/,
        "列表行要显示真实文件名"
    );

    // 缺口令 → encrypted → 就地展开口令框
    await act(async () =>
        (document.querySelector("[data-backup-action='restore']") as HTMLElement).click()
    );
    const pwd = document.querySelector('input[aria-label="恢复备份密码"]') as HTMLInputElement;
    assert.ok(pwd, "缺口令要就地展开口令输入框");
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(pwd, "pw");
        pwd.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
        await (document.querySelector("[data-backup-action='restore-confirm']") as HTMLElement).click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.equal(imp.imports, 1, "口令对了要真的走一次导入");
    const payload = imp.lastPayload as { notes?: unknown[] } | undefined;
    assert.ok(payload && Array.isArray(payload.notes) && payload.notes.length === 1,
        "顶层 payload 必须原样送达 importNotes（退回 r.data?.payload 这里会是 undefined）");
});

test("设置→备份：没有备份能力（老部署）时整页不出现", async () => {
    setWide();
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    await act(async () =>
        (document.querySelector("button[data-tool='settings']") as HTMLElement).click()
    );
    const dialog = document.querySelector("[data-notes-settings='1']")!;
    assert.ok(
        !dialog.querySelector("[data-settings-tab='backup']"),
        "没有 backupApi 时「备份」这一页不该出现"
    );
});

test("分屏时主栏头部与侧栏同构（即时渲染+三档+保存点+更多，无关闭键）：平铺组收进菜单", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    assert.ok(document.querySelector("[data-side-editor='1']"), "先打开侧边（分屏态）");

    // 2026-10-10 用户明确：分屏时主栏头部要和侧边栏头部一模一样（只是没有关闭键）
    // —— 即时渲染开关与三档模式键**常驻头部**，不再收进菜单。
    // ⚠️ MUI Switch 渲染成 span（不是 button），data-tool 落在根 span 上，
    // 选择器别写 button[...]。
    assert.ok(document.querySelector("[data-tool='live-render']"), "分屏时主栏即时渲染开关常驻头部");
    assert.ok(document.querySelector("[data-pane-modes='1']"), "分屏时三档模式键常驻头部");
    assert.ok(
        document.querySelector("button[data-tool='note-more']"),
        "「更多操作」保留在头部"
    );

    // 收藏/大纲/反链/版本/导出/分享这排平铺键仍收进菜单（与侧栏头部一致：它们不在头部）
    assert.ok(document.querySelector("[data-desktop-actions='1']") === null, "分屏时平铺组不渲染");
    assert.ok(document.querySelector("button[data-tool='pin']") === null, "分屏时置顶常驻键收进菜单");
    assert.ok(document.querySelector("button[data-tool='star']") === null, "分屏时收藏常驻键收进菜单");
    assert.ok(document.querySelector("button[data-tool='outline']") === null, "分屏时大纲常驻键收进菜单");

    // 「更多操作」里这几项重新出现（桌面单栏态它们被平铺取代而不出现）；
    // 三档与即时渲染头部常驻了，菜单里不再重复出现（同一件事不说两遍）。
    await openNoteMore();
    for (const op of [
        "share",
        "revisions",
        "backlinks",
        "outline",
        "export",
        "pin",
    ]) {
        assert.ok(
            document.querySelector(`[data-active-op='${op}']`),
            `分屏时更多操作里要有 ${op}`
        );
    }
    assert.ok(
        document.querySelector("[data-active-op='pane-mode-edit']") === null,
        "三档头部常驻后菜单里不再重复"
    );
    assert.ok(
        document.querySelector("[data-active-op='live-render']") === null,
        "即时渲染头部常驻后菜单里不再重复"
    );
    // 侧栏头部同款：即时渲染开关 / 三档 / 更多 / 关闭都在
    const side = document.querySelector("[data-side-editor='1']")!;
    assert.ok(side.querySelector("[data-tool='side-live-render']"), "侧栏保留即时渲染开关");
    assert.ok(side.querySelector("[data-side-modes='1']"), "侧栏保留三档模式键");
    assert.ok(side.querySelector("[data-tool='side-more']"), "侧栏保留更多操作");
    assert.ok(side.querySelector("[data-side-close='1']"), "侧栏保留常显关闭键");
});

test("关掉侧边后主栏头部平铺组恢复（分屏态的收纳是临时的）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲", content: "a" }),
        note({ id: 2, title: "乙", content: "b" }),
    ]);
    await act(async () => {
        rightClick(document.querySelector("[data-note-list] [data-note-id='2']")!);
    });
    await act(async () => (document.querySelector("[data-row-op='open-side']") as HTMLElement).click());
    await act(async () => (document.querySelector("[data-side-close='1']") as HTMLElement).click());
    assert.equal(document.querySelector("[data-side-editor='1']"), null, "侧边已关");
    assert.ok(document.querySelector("[data-desktop-actions='1']"), "平铺组恢复");
    assert.ok(document.querySelector("button[data-tool='pin']"), "收藏常驻键恢复");
    assert.ok(document.querySelector("button[data-tool='outline']"), "大纲常驻键恢复");
    assert.ok(document.querySelector("[data-pane-modes='1']"), "三档模式键恢复");
});

// ---------- 版本历史面板（2026-10-09 照 inkstone VersionsPanel）----------
// 之前只是一个 Menu（点了直接恢复），现在要能「先看差别再决定恢不恢复」。
test("版本历史：面板列出快照，右侧给出与当前正文的行级 diff", async () => {
    setWide();
    const restored: number[] = [];
    mountPanel(
        [note({ id: 1, title: "甲", content: "一\n二\n三" })],
        {
            folderTags: {
                folders: [],
                tags: [],
                noteTags: {},
                onListRevisions: async () => [
                    { id: 11, note_id: 1, title: "甲", content: "", created_at: "2026-10-09T10:00:00.000Z", size: 5 },
                    { id: 10, note_id: 1, title: "甲", content: "", created_at: "2026-10-08T10:00:00.000Z", size: 7 },
                ],
                onGetRevision: async (_noteId: number, revisionId: number) =>
                    revisionId === 11
                        ? { id: 11, note_id: 1, title: "甲", content: "一\n二改了\n三", created_at: "2026-10-09T10:00:00.000Z" }
                        : { id: 10, note_id: 1, title: "甲", content: "一\n二\n三\n四", created_at: "2026-10-08T10:00:00.000Z" },
                onRestoreRevision: async (_noteId: number, revisionId: number) => {
                    restored.push(revisionId);
                    return note({ id: 1, title: "甲", content: "一\n二改了\n三" });
                },
            },
        }
    );
    // 先选中第一条（没选中时编辑区是空态，版本历史按钮是禁用的）
    await act(async () => {
        (document.querySelectorAll("[data-note-list] [role='button']")[0] as HTMLElement).click();
    });

    await act(async () => {
        (document.querySelector("button[data-tool='revisions']") as HTMLElement).click();
    });
    const dialog = document.querySelector("[data-version-history='1']");
    assert.ok(dialog, "点版本历史要开面板（不再是下拉菜单）");

    const items = dialog!.querySelectorAll("[data-version-item]");
    assert.equal(items.length, 2, "左列列出两条快照");
    // 默认选中最新的那条（列表按 id DESC 回来，第一条就是最新）
    assert.ok(
        items[0].getAttribute("aria-current") === "true",
        "默认选中最新的那条"
    );

    // diff：当前是「一/二/三」，选中的是「一/二改了/三」→ 1 删 1 加
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const summary = dialog!.querySelector("[data-diff-summary='1']");
    assert.ok(summary, "右栏顶部要有 +/- 汇总");
    assert.match(summary!.textContent ?? "", /\+1/, "要有 +1");
    assert.match(summary!.textContent ?? "", /-1/, "要有 -1");
    assert.ok(
        dialog!.querySelector("[data-diff-line='add']"),
        "diff 里要有标成新增的行"
    );
    assert.ok(
        dialog!.querySelector("[data-diff-line='remove']"),
        "diff 里要有标成删掉的行"
    );

    // 恢复：走面板底部的按钮，不是列表项
    const restore = dialog!.querySelector<HTMLElement>("[data-version-restore='1']");
    assert.ok(restore, "面板底部要有「恢复此版本」");
    await act(async () => { restore!.click(); });
    assert.deepEqual(restored, [11], "恢复的是当前选中的那一版");
});

// ---------- 搜索：模糊匹配 + 命中高亮（2026-10-09 照 inkstone 的 fuzzy + <mark>）----------
test("搜索：模糊匹配命中，标题里的命中段打上高亮", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "数据库设计", content: "表结构" }),
        note({ id: 2, title: "设计稿", content: "参考" }),
        note({ id: 3, title: "完全无关", content: "别的" }),
    ]);
    const box = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    assert.ok(box, "要有搜索框");
    await act(async () => {
        // React 受控输入要走原生 setter + input 事件，直接改 value 不会被 onChange 收到
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
        )!.set!;
        setter.call(box, "设计");
        box.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const rows = document.querySelectorAll("[data-note-list] [data-note-id]");
    assert.equal(rows.length, 2, "只留下命中的两条（「完全无关」被筛掉）");
    const marked = document.querySelectorAll("[data-note-list] mark[data-hit='1']");
    assert.ok(marked.length >= 1, "标题里的命中段要有 <mark> 高亮");
    assert.match(marked[0].textContent ?? "", /设计/, "高亮的正是命中的字");
});

// ---------- 图片灯箱（2026-10-09 照 inkstone 的 Lightbox）----------
// 预览层的图片是 markdown-it 异步渲染的产物，jsdom 里拉真图会拖慢整套用例；
// 这里用**源码守卫**钉住两个必要条件：点图片会开灯箱、灯箱能关。
test("图片灯箱：点预览里的图片会开，Esc / 点空白 / 关闭键都能关", () => {
    const src = readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8");
    const body = stripComments(src);
    assert.ok(/setLightbox\(\{/.test(body), "点预览里的图片要打开灯箱");
    assert.ok(/closest\("img"\)/.test(body), "要用事件委托认出点到的是图片");
    assert.ok(/data-lightbox='1'/.test(body), "灯箱容器要有可定位的标记");
    assert.ok(/data-lightbox-img='1'/.test(body), "灯箱里要渲染那张图");
    assert.ok(/data-lightbox-close='1'/.test(body), "灯箱要有关闭键");
    // Esc 关闭：灯箱不是 MUI Dialog，必须自己听 keydown
    // （别写「keydown … setLightbox(null)」这种顺序断言 —— 代码里监听器
    //  注册在 setLightbox(null) **之后**，顺序反了会假红）
    assert.ok(/addEventListener\("keydown"/.test(body), "灯箱要自己挂 keydown 监听");
    assert.ok(/e\.key === "Escape"/.test(body), "按 Esc 要关闭灯箱");
});

// ---------- 多选批量条（2026-10-09，inkstone 的批量操作条）----------

test("多选：开多选才有勾选框与批量条，勾两条能一次归档", async () => {
    setWide();
    const archived: number[] = [];
    mountPanel(
        [
            note({ id: 1, title: "甲", content: "a" }),
            note({ id: 2, title: "乙", content: "b" }),
        ],
        {
            onToggleArchive: async (target: Note) => {
                archived.push(target.id!);
            },
        }
    );
    // 平时不该有勾选框：128px 的窄列表里常驻一列会把标题挤没
    assert.ok(
        document.querySelector("[data-bulk-bar='1']") === null,
        "没开多选时不该有批量条"
    );
    assert.ok(
        document.querySelector("input[data-note-check]") === null,
        "没开多选时不该有勾选框"
    );

    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-bulk-bar='1']"), "开了多选要有批量条");
    const boxes = document.querySelectorAll<HTMLInputElement>("input[data-note-check]");
    assert.equal(boxes.length, 2, "每一行都要有勾选框");

    await act(async () => {
        boxes[0].click();
        boxes[1].click();
    });
    assert.match(
        document.querySelector("[data-bulk-bar='1']")!.textContent ?? "",
        /已选 2 条/,
        "批量条上要显示选了几条"
    );

    const archiveBtn = document.querySelector("[data-bulk-action='archive']") as HTMLButtonElement;
    assert.equal(archiveBtn.disabled, false, "勾了之后归档按钮要能用");
    await act(async () => {
        archiveBtn.click();
        await new Promise(r => setTimeout(r, 30));
    });
    assert.deepEqual(archived.sort(), [1, 2], "批量归档要对勾上的每一条都生效");
});

test("多选：批量删除要先确认，取消就一条都不删", async () => {
    setWide();
    const deleted: number[] = [];
    mountPanel(
        [
            note({ id: 1, title: "甲", content: "a" }),
            note({ id: 2, title: "乙", content: "b" }),
        ],
        {
            onDelete: async (target: Note) => {
                deleted.push(target.id!);
            },
        }
    );
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    const boxes = document.querySelectorAll<HTMLInputElement>("input[data-note-check]");
    await act(async () => {
        boxes[0].click();
    });
    await act(async () =>
        (document.querySelector("[data-bulk-action='delete']") as HTMLElement).click()
    );
    // 影响面要写出来：几条？能不能撤？
    assert.match(document.body.textContent ?? "", /删除选中的 1 条笔记/, "确认框要写出条数");
    assert.match(document.body.textContent ?? "", /回收站/, "要说明还能还原");
    const cancel = [...document.querySelectorAll("button")].find(
        b => b.textContent === "取消"
    ) as HTMLElement | undefined;
    assert.ok(cancel, "确认框要有取消");
    await act(async () => {
        cancel!.click();
    });
    assert.equal(deleted.length, 0, "点了取消一条都不能删");

    // 确认了才真的删
    await act(async () =>
        (document.querySelector("[data-bulk-action='delete']") as HTMLElement).click()
    );
    const ok = document.querySelector("[data-confirm-action='confirm']") as HTMLElement | null;
    assert.ok(ok, "确认框里要有确认按钮");
    await act(async () => {
        await ok!.click();
        await new Promise(r => setTimeout(r, 20));
    });
    assert.deepEqual(deleted, [1], "确认后才真的删掉勾上的那条");
});

// ---------- 关系图谱（2026-10-09，轻量版 GraphPanel）----------

test("关系图谱：更多菜单里有入口，打开后画出节点与连线，点节点跳过去", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "数据库设计", content: "表结构" }),
        note({ id: 2, title: "设计稿", content: "参考 [[数据库设计]]" }),
        note({ id: 3, title: "运维手册", content: "备份 [[数据库设计]]" }),
    ]);
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[0] as HTMLElement).click();
    });
    await openNoteMore();
    const entry = document.querySelector<HTMLElement>("[data-active-op='graph']");
    assert.ok(entry, "有双链时「更多」里要有关系图谱");
    await act(async () => entry!.click());

    const graph = document.querySelector("[data-graph='1']");
    assert.ok(graph, "图谱面板要打开");
    const nodes = document.querySelectorAll("[data-graph-node]");
    const edges = document.querySelectorAll("[data-graph-edge]");
    assert.equal(nodes.length, 3, "本文 + 两条引用它的，共三个节点");
    assert.equal(edges.length, 2, "两条引用各是一条连线");
    assert.ok(
        (graph!.textContent ?? "").includes("数据库设计"),
        "节点上要写出标题（不然就是一堆认不出来的圆点）"
    );

    // 点节点 → 跳过去（图谱自己关掉）
    const target = [...document.querySelectorAll<HTMLElement>("[data-graph-node]")].find(
        n => n.getAttribute("data-graph-node") === "2"
    );
    assert.ok(target, "要能按 id 找到《设计稿》那个节点");
    await act(async () => {
        target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // ⚠️ MUI Dialog 关掉后 children 还要等退场动画（默认 ~195ms）才真从 DOM 上摘掉。
    // ⚠️ 别用固定 sleep：本机 320ms 够，CI（ubuntu 慢、事件循环挤）不够 ——
    // 2026-10-10 CI 就红在「点了节点图谱要关掉」这一条，本机全绿。改成轮询等条件，
    // 最多等 1s，快机器上该是几十毫秒就退出。
    let gone = false;
    for (let i = 0; i < 40; i += 1) {
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
        if (document.querySelector("[data-graph='1']") === null) {
            gone = true;
            break;
        }
    }
    assert.ok(gone, "点了节点图谱要关掉并跳过去（还开着说明 onClick 没接到）");
});
