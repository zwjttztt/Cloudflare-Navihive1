// tests/noteTemplatePicker.dom.test.tsx
// B3 笔记模板（2026-10-22）的交互部分：点「新建笔记」→ 弹模板选择 →
// 选一份建库。纯函数那半边在 noteTemplates.test.ts。
//
// ⚠️ 断言只比**布尔与字符串**：node:assert 失败时要 util.inspect(actual)，
// 把 DOM 元素拖进错误消息会把进程堆炸掉（2026-10-22 实测踩过）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import NotesPage from "../src/components/NotesPage";
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
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
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

const has = (sel: string) => Boolean(document.querySelector(sel));

function mountPanel(notes: Note[], onCreate: (draft?: Partial<Note>) => Promise<Note | null>) {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={notes}
                    onCreate={onCreate}
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

test("点「新建笔记」先弹模板选择，不直接建", async () => {
    let created = 0;
    mountPanel([note({ id: 1 })], async draft => {
        created += 1;
        return note({ id: 99, ...draft });
    });
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='list-new-note']")!.click();
    });
    assert.equal(created, 0, "点开菜单这一步不该建笔记（先让人选）");
    assert.equal(has("[data-template='blank']"), true, "菜单要有「空白笔记」");
    assert.equal(has("[data-template='daily']"), true, "菜单要有「日报」");
    assert.equal(has("[data-template='meeting']"), true, "菜单要有「会议记录」");
    assert.equal(has("[data-template='reading']"), true, "菜单要有「读书笔记」");
});

test("选「日报」：建出来的笔记带日期标题和四节骨架", async () => {
    const seen: Array<Partial<Note>> = [];
    mountPanel([note({ id: 1 })], async draft => {
        seen.push(draft ?? {});
        return note({ id: 99, ...draft });
    });
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='list-new-note']")!.click();
    });
    await act(async () => {
        document.querySelector<HTMLElement>("[data-template='daily']")!.click();
    });
    assert.equal(seen.length, 1, "选完就建，且只建一次");
    const draft = seen[0];
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    assert.equal(draft.title, `${iso} 日报`, "标题带今天日期");
    assert.ok((draft.content ?? "").includes("## 今日完成"), "正文要带日报骨架");
    // 选完菜单要收起（流程走完的信号；「新笔记成为当前那一条」依赖上层把
    // 新笔记并回 notes，那是 App 层的事，组件测里不断言）
    assert.equal(has("[data-template='daily']"), false, "选完菜单要关掉");
});

test("选「空白笔记」：还是原来的行为（空标题空正文）", async () => {
    const seen: Array<Partial<Note>> = [];
    mountPanel([note({ id: 1 })], async draft => {
        seen.push(draft ?? {});
        return note({ id: 99, ...draft });
    });
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='list-new-note']")!.click();
    });
    await act(async () => {
        document.querySelector<HTMLElement>("[data-template='blank']")!.click();
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title ?? "", "", "空白笔记不预设标题");
    assert.equal(seen[0].content ?? "", "", "空白笔记不带骨架");
});

test("菜单开着时点别处：不会误建笔记", async () => {
    let created = 0;
    mountPanel([note({ id: 1 })], async draft => {
        created += 1;
        return note({ id: 99, ...draft });
    });
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='list-new-note']")!.click();
    });
    assert.equal(has("[data-template='daily']"), true, "前置：菜单开着");
    await act(async () => {
        document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // 只断言「不误建」。菜单关不关是 MUI 的事（v9 的 ClickAway / Esc 在
    // jsdom 里都不可靠，断言它会做成偶发红）—— 这里要守的是**产品行为**：
    // 用户改主意不该付出「多一篇空白笔记」的代价。
    assert.equal(created, 0, "点别处不该建笔记");
});
