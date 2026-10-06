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
    const btn = document.querySelector<HTMLElement>('[data-tool="backlinks"]');
    assert.ok(btn, "顶栏要有反向链接按钮");
    // 打开《数据库设计》（第一条）才有被引用
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[0] as HTMLElement).click();
    });
    const target = document.querySelector<HTMLElement>('[data-tool="backlinks"]')!;
    assert.match(target.getAttribute("aria-label") ?? "", /反向链接 1 条/);
    await act(async () => { target.click(); });
    assert.ok(document.querySelector("[data-backlinks='incoming-label']"));
    const item = document.querySelector<HTMLElement>("[data-backlink-source='2']");
    assert.ok(item, "应列出引用了它的《设计稿》");
    await act(async () => { item!.click(); });
    // 跳过去之后当前笔记变成《设计稿》，它自己没有反向链接
    const after = document.querySelector<HTMLElement>('[data-tool="backlinks"]')!;
    assert.match(after.getAttribute("aria-label") ?? "", /反向链接 0 条/);
});

test("双链渲染成可点元素，点一下跳到目标笔记", async () => {
    mountPanel([
        note({ id: 1, title: "目标笔记", content: "内容" }),
        note({ id: 2, title: "来源笔记", content: "见 [[目标笔记]]" }),
    ]);
    await act(async () => {
        (document.querySelectorAll('[data-note-list] [role="button"]')[1] as HTMLElement).click();
    });
    const link = document.querySelector<HTMLElement>("[data-wiki-link]");
    assert.ok(link, "正文里的 [[目标笔记]] 要渲染成链接");
    assert.equal(link!.textContent, "目标笔记");
    await act(async () => { link!.click(); });
    // 跳到《目标笔记》：反向链接按钮显示 1 条
    assert.match(
        document.querySelector<HTMLElement>('[data-tool="backlinks"]')!.getAttribute("aria-label") ?? "",
        /反向链接 1 条/
    );
});

test("链接与引用：选中文字换成脚注引用，原文进文末定义；再点一次全撤", () => {
    mountPanel([note({ content: "第一段第二段" })]);
    const editor = getEditor();
    act(() => editor.setSelectionRange(3, 6)); // 选中「第二段」
    act(() => (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click());
    // 选区被引用替换，原文搬到文末
    assert.equal(editor.value, "第一段[^1]\n\n[^1]: 第二段");
    // 再点一次：引用和定义都要没，且不留孤儿定义
    act(() => (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click());
    // ⚠️ 用局部变量再断言：上面那行 assert.equal 会把 editor.value 收窄成字面量类型，
    // 后面再 `.includes()` 就变成 never 上的调用（tsc 报错）。
    const afterUndo: string = editor.value;
    assert.equal(afterUndo, "第一段第二段");
    assert.ok(!afterUndo.includes("[^"), "不该留下没有引用的孤儿定义");
});

test("链接与引用：连插两条编号不重复（都写 [^1] 的话第二条定义会被忽略）", () => {
    mountPanel([note({ content: "甲乙丙" })]);
    const editor = getEditor();
    act(() => editor.setSelectionRange(0, 1));
    act(() => (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click());
    // 插完是 "[^1]乙丙\n\n[^1]: 甲"（索引 4 = 乙、5 = 丙），选中「丙」再插第二条
    act(() => editor.setSelectionRange(5, 6));
    act(() => (document.querySelector('[data-tool="footnote-ref"]') as HTMLElement).click());
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

test("工具栏补齐 inkstone 式下拉：链接 / 图片 / 插入 / 块", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const bar = document.querySelector('[aria-label="Markdown 格式"]') as HTMLElement;
    assert.ok(bar, "要有格式工具栏");
    // 这四个是 inkstone 式「文字/图标按钮 + 下拉」入口，区别于原来的散落图标
    for (const label of ["链接", "图片", "插入", "块"]) {
        assert.ok(
            bar.querySelector(`button[aria-label="${label}"]`),
            `工具栏要有 ${label} 下拉按钮`
        );
    }
    // 点开「链接」下拉，里面四种插入项都要在（覆盖双链 / 嵌入 / 块引用）
    const linkBtn = bar.querySelector('button[aria-label="链接"]') as HTMLElement;
    act(() => linkBtn.click());
    for (const op of ["external", "wikilink", "embed", "blockref"]) {
        assert.ok(
            document.querySelector(`[data-link-op="${op}"]`),
            `链接下拉要有 ${op} 这一项`
        );
    }
    // 点「笔记嵌入」要往编辑器插入 ![[笔记标题]]（和粗体走同一条 insertBlock 路径）
    const ta = getEditor();
    act(() => (document.querySelector('[data-link-op="embed"]') as HTMLElement).click());
    assert.ok(ta.value.includes("![[笔记标题]]"), "点嵌入要插入 ![[笔记标题]]，实际：" + ta.value);
    // 「插入」下拉：块 ID / 属性 / 隐藏注释 / 标签
    const insertBtn = bar.querySelector('button[aria-label="插入"]') as HTMLElement;
    act(() => insertBtn.click());
    for (const op of ["blockid", "frontmatter", "hidden", "tag"]) {
        assert.ok(document.querySelector(`[data-insert-op="${op}"]`), `插入下拉要有 ${op}`);
    }
    // 「块」下拉：折叠 / 标签页 / 分隔线
    const blockBtn = bar.querySelector('button[aria-label="块"]') as HTMLElement;
    act(() => blockBtn.click());
    for (const op of ["fold", "tabs", "divider"]) {
        assert.ok(document.querySelector(`[data-block-op="${op}"]`), `块下拉要有 ${op}`);
    }
});

test("新建笔记按钮挪到左栏文件夹标题右侧（顶栏那个移除）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const newBtns = [...document.querySelectorAll('button[aria-label="新建笔记"]')];
    assert.equal(newBtns.length, 1, "顶栏新建笔记已移除，只剩左栏文件夹处一个");
    assert.ok(
        newBtns[0].closest('[data-nav-col="1"]'),
        "新建笔记按钮应在左栏导航列（文件夹标题右侧），和新建文件夹并排"
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

test("左栏导航「收藏」只看置顶的那几条", () => {
    mountPanel([
        note({ id: 1, title: "置顶的", content: "a", pinned: true }),
        note({ id: 2, title: "普通的", content: "b", pinned: false }),
    ]);
    const list = () =>
        document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(list().includes("置顶的") && list().includes("普通的"), "默认全部");

    const starred = [...document.querySelectorAll("button[data-view]")].find(
        b => b.getAttribute("data-view") === "starred"
    ) as HTMLElement | null;
    assert.ok(starred, "要有收藏视图按钮");
    act(() => starred!.click());

    assert.ok(list().includes("置顶的"), "收藏里要有置顶的");
    assert.ok(!list().includes("普通的"), "收藏里不该出现没置顶的");
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
    const headBlock = src.slice(src.indexOf("标题层级"), src.indexOf("</Button>", src.indexOf("标题层级")));
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

test("阶段二：列表按月份分组，月份标题挂在条目上面", () => {
    mountPanel([
        note({ id: 1, title: "早的", content: "a", updated_at: "2026-09-03T10:00:00Z" }),
        note({ id: 2, title: "晚的", content: "b", updated_at: "2026-10-05T10:00:00Z" }),
    ]);
    const headers = [...document.querySelectorAll("[data-month]")].map(h => h.textContent);
    assert.deepEqual(headers, ["2026 年 10 月", "2026 年 9 月"], "月份从新到旧");
    const list = document.querySelector("[data-note-list]")!;
    assert.ok(list.textContent!.includes("晚的") && list.textContent!.includes("早的"));
    // 分组顺序：新的月份那组整体排在前面（「晚的」必须出现在「早的」之前）
    assert.ok(
        list.innerHTML.indexOf("晚的") < list.innerHTML.indexOf("早的"),
        "新的月份分组要在列表里排在前面"
    );
});

test("阶段二：顶栏能收起 / 展开左栏", () => {
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

test("阶段二：搜索框右侧挂 ⌘K 提示", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const input = document.querySelector("input[aria-label='搜索笔记']") as HTMLInputElement;
    assert.ok(input.parentElement!.textContent!.includes("⌘K"), "要有 ⌘K 角标");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    assert.equal(document.activeElement, input, "Ctrl+K 要聚焦搜索框");
});

// ---------- 阶段三：回收站 / 归档 / 未归类 ----------

test("左栏视图齐全（搜索/全部/最近/收藏/未归类/归档/回收站）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const views = [...document.querySelectorAll("button[data-view]")].map(b =>
        b.getAttribute("data-view")
    );
    // 顺序按 inkstone 那套（所有 / 最近编辑 / 收藏 / 未归类 / … / 归档 / 回收站）：
    // 「未归类」紧跟收藏、「归档」收在末尾，是刻意的，不是随手排的。
    // ⚠️ 「搜索」是 2026-10-06 加的（inkstone 左栏第一项就是它），
    // 它把「原来只有列表上方一个输入框」升级成独立视图，还多搜标签名。
    assert.deepEqual(views, [
        "search",
        "all",
        "recent",
        "starred",
        "uncategorized",
        "archived",
        "trash",
    ]);
});

test("阶段三：回收站视图列出被删的笔记，并给还原 / 彻底删除两个动作", () => {
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

test("顶栏：折叠按钮不能挨着「返回导航站」（两个无文字箭头靠太近会误按）", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    const src = readFileSync(
        resolve(findProjectDir(), "src/components/NotesPage.tsx"),
        "utf-8"
    );
    // 源码里两者的距离：返回键之后应当先出现标题 Typography，折叠按钮在它右边
    const backAt = src.indexOf("aria-label='返回导航站'");
    const foldAt = src.indexOf("收起笔记列表", backAt);
    const titleAt = src.indexOf("记事本", backAt);
    assert.ok(backAt > 0 && foldAt > backAt, "折叠按钮要在返回键之后");
    assert.ok(
        titleAt > backAt && titleAt < foldAt,
        "折叠按钮要挪到标题右边那一组，不能紧贴返回键"
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
        source.indexOf("主体：移动端"),
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
        /width: listCollapsed \? 44 : \{ xs: "100%", md: navW \+ listW \+ 14 \}/.test(source),
        "listPane 展开时宽度应是「导航列 + 列表列 + 两条分隔条」之和（2026-10-06 改成可拖动）"
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
        source.indexOf("主体：移动端"),
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
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    assert.ok(source.includes("MarkdownToolbar"), "要有格式工具栏");
    assert.ok(
        /onMouseDown=\{e => e\.preventDefault\(\)\}/.test(source),
        "工具栏按钮必须 onMouseDown + preventDefault —— 默认行为会让 textarea 失焦、" +
            "selectionStart 变成 0，插入的位置全跑到开头"
    );
    assert.ok(
        source.includes("setSelectionRange"),
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

test("插入内容以 textarea 的 DOM 值为准，不能读 draft", () => {
    // 静态守卫：上面那条行为用例只覆盖连点，读错来源换个场景又会漏回去。
    const clean = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "components", "NotesPage.tsx"),
            "utf-8"
        )
    );
    const fn = clean.slice(
        clean.indexOf("const insertAtCursor"),
        clean.indexOf("const charCount")
    );
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
    const listText = () => document.querySelector("[data-note-list]")!.textContent || "";
    assert.ok(listText().includes("甲") && listText().includes("乙"), "默认全部都该在");

    const folderBtn = [...document.querySelectorAll("button[data-folder-id]")].find(
        b => b.getAttribute("data-folder-id") === "7"
    ) as HTMLElement | null;
    assert.ok(folderBtn, "导航列里要有「收集箱」这一项");
    act(() => folderBtn!.click());

    assert.ok(listText().includes("甲"), "选中收集箱后，它里面的要还在");
    assert.ok(!listText().includes("乙"), "别文件夹的笔记要被筛掉");
});

test("导航列要自己滚（整块一起滚会把搜索框顶出视野）", () => {
    // 静态守卫：jsdom 里 MUI 的 sx 编译成 hash 类名，量不到 overflow-y，
    // 只能把结论钉在源码上（和「左栏容器不能带 flex:1」同一套路）。
    const clean = stripComments(
        readFileSync(join(findProjectDir(), "src", "components", "NotesPage.tsx"), "utf-8")
    );
    // ⚠️ 源码里写的是单引号 `data-nav-col='1'`：找错引号会拿到 -1，
    // slice(-1, -1) 是个空串，断言会报「没这个属性」而不是「这一列没滚」。
    const navCol = clean.slice(clean.indexOf("data-nav-col='1'"), clean.indexOf("data-list-col='1'"));
    assert.ok(navCol.includes("overflowY: \"auto\""), "导航列得住自己那一列滚");
    assert.ok(
        navCol.includes("flexShrink: 0"),
        "导航列要定宽不收缩，否则会被列表挤掉"
    );
});

test("没有 folderTags（老部署）时退化成只有那七个视图，不能崩", () => {
    mountPanel([note({ id: 1, title: "甲", content: "" })]);
    assert.deepEqual(
        [...document.querySelectorAll("button[data-view]")].map(b => b.getAttribute("data-view")),
        ["search", "all", "recent", "starred", "uncategorized", "archived", "trash"]
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
    // ⚠️ 锚点必须用 JSX 注释全文：「内容区：源码 | 预览」这串字在文件头的
    // ASCII 示意图里也出现过，只用短串会锚到文件开头，切出来的窗口全是 import。
    const idx = src.indexOf("{/* 内容区：源码 | 预览 */}");
    assert.ok(idx > 0, "找不到内容区注释，测试锚点失效");
    const body = src.slice(idx, idx + 900);
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
    const btn = document.querySelector('button[aria-label="代码块语言"]') as HTMLElement;
    act(() => btn.click());
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

test("「归入文件夹」能把笔记真的归进去（onUpdate 收到 folder_id）", async () => {
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
    const opt = document.querySelector("[data-folder-pick='3']") as HTMLElement;
    assert.ok(opt, "二级菜单要列出已有文件夹");
    await act(async () => {
        opt.click();
    });
    assert.equal(updates.length, 1, "应当只发一次更新");
    assert.equal(updates[0].id, 5);
    assert.equal(updates[0].patch.folder_id, 3, "要把 folder_id 写进 patch");
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
        /width: 7,/.test(pageSource),
        "分隔条命中区要 ≥7px —— 2px 的细线在笔记本触控板上根本点不中"
    );
});

test("拖动分隔条后宽度落盘，并且夹在上下界之间", async () => {
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
    mountPanel([note({ id: 1, title: "甲", content: "a" })]);
    const sep = document.querySelector(
        "[role='separator'][aria-label='拖动调整导航列宽度']"
    ) as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    sep.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, "分隔条 mousedown 必须 preventDefault，否则会选中文本");
});

test("双击分隔条回到默认宽度", async () => {
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

test("工具栏有大纲按钮，点了列出当前笔记的标题层级", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "# 一\n## 二\n" })]);
    const btn = document.querySelector("button[data-tool='outline']") as HTMLElement;
    assert.ok(btn, "工具栏要有大纲按钮");
    await act(async () => {
        btn.click();
    });
    const items = [...document.querySelectorAll("[data-outline-item]")].map(e => e.textContent);
    assert.deepEqual(items, ["一", "二"]);
});

test("没有标题时大纲给一句说明，不弹空框", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "就是一段正文，没有标题。" })]);
    await act(async () => {
        (document.querySelector("button[data-tool='outline']") as HTMLElement).click();
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
    await act(async () => {
        (document.querySelector("button[data-tool='outline']") as HTMLElement).click();
    });
    const items = [...document.querySelectorAll("[data-outline-item]")].map(e => e.textContent);
    assert.deepEqual(items, ["真标题"]);
});

test("点大纲某一条会把光标送到那一行并选中它", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "第一行\n第二行\n## 目标行\n" })]);
    await act(async () => {
        (document.querySelector("button[data-tool='outline']") as HTMLElement).click();
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
    // 左栏「搜索」那一项的计数 = 命中数
    const searchRow = document.querySelector("button[data-view='search']")!;
    assert.ok(searchRow.textContent!.includes("1"), `搜索计数应为 1，实际「${searchRow.textContent}」`);
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
    const searchRow = document.querySelector("button[data-view='search']")!;
    assert.ok(
        searchRow.textContent!.includes("1"),
        `按标签名也要搜得到，实际「${searchRow.textContent}」`
    );
});
