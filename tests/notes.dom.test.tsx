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
import { useNotes } from "../src/hooks/useNotes";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/http";

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
                    {...handlers}
                />
            </UIPrefsProvider>
        );
    });
}

const text = () => document.body.textContent || "";

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

async function mountHook(api: Record<string, unknown>, onError = () => {}) {
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
