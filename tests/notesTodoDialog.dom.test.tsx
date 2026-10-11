// tests/notesTodoDialog.dom.test.tsx
//
// 全库待办面板（阶段②）：分组渲染、勾选回调参数、跳转与过滤。
// 回写本身走父级 onUpdate（rev/自动保存/广播链路有各自的用例），这里钉面板行为。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesTodoDialog from "../src/components/NotesTodoDialog";
import type { Note } from "../src/API/types";

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

function mount(notes: Note[], handlers: { onToggle?: (id: number, line: number, c: boolean) => void; onOpenNote?: (id: number) => void }) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <NotesTodoDialog
                open
                notes={notes}
                onClose={() => {}}
                onToggle={(id, line, c) => handlers.onToggle?.(id, line, c)}
                onOpenNote={id => handlers.onOpenNote?.(id)}
            />
        );
    });
}

const makeNotes = (): Note[] =>
    [
        { id: 1, title: "购物", content: "- [ ] 牛奶\n- [x] 面包" },
        { id: 2, title: "工作", content: "- [ ] 写周报" },
    ] as unknown as Note[];

test("待办面板：按笔记分组、默认只看未完成、角标计数", () => {
    mount(makeNotes(), {});
    const groups = [...document.querySelectorAll("[data-todo-note]")];
    assert.equal(groups.length, 2, "两条笔记各一组（默认不含已完成，购物组只剩牛奶）");
    assert.match(groups[0].textContent || "", /购物/);
    const items = [...document.querySelectorAll("[data-todo-item]")];
    assert.equal(items.length, 2, "未完成两条（牛奶/写周报），已完成的面包默认不出现");
    assert.match(document.querySelector("[data-notes-todo]")!.textContent || "", /未完成 2 · 已完成 1/);
});

test("待办面板：勾选回调带 noteId/行号/目标状态", () => {
    const calls: Array<[number, number, boolean]> = [];
    mount(makeNotes(), { onToggle: (id, line, c) => calls.push([id, line, c]) });
    const checkbox = document.querySelector<HTMLInputElement>('[data-todo-item] input[type="checkbox"]')!;
    assert.ok(checkbox);
    // MUI Checkbox 的 onChange 由 click 驱动（change 事件不带 React 合成所需的状态翻转）
    act(() => {
        checkbox.click();
    });
    assert.deepEqual(calls, [[1, 0, true]], "牛奶在笔记1的第0行，勾选目标状态为 true");
});

test("待办面板：点标题跳原文并关面板；「显示已完成」展开全部", () => {
    const opened: number[] = [];
    mount(makeNotes(), { onOpenNote: id => opened.push(id) });
    const titleBtn = document.querySelector<HTMLElement>("[data-todo-note] button")!;
    act(() => {
        titleBtn.click();
    });
    assert.deepEqual(opened, [1]);

    act(() => {
        document.querySelector<HTMLElement>('[data-todo-toggle-done="1"]')!.click();
    });
    assert.equal(document.querySelectorAll("[data-todo-item]").length, 3, "切换后已完成也出现");
    // 勾选着的已完成为 true
    const done = document.querySelectorAll('[data-todo-item] input[type="checkbox"]')[1] as HTMLInputElement;
    assert.equal(done.checked, true, "面包保持已完成状态");
});
