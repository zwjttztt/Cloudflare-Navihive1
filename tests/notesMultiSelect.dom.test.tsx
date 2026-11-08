// tests/notesMultiSelect.dom.test.tsx
// 需求 3「中间栏开启多选后点 X 收起列表没取消多选」的行为回归用例。
//
// 幽灵多选的根因是「组件没卸载、state 会一直留着」：列表被藏起来 / 折叠 /
// 退出多选按钮，三条路径都得调 exitMultiSelect()，且它必须一次把
// multiSelect / checked / bulkDeleteOpen 三个状态收干净。
//
// 分三层钉住：
//   ① useNotesRowActions 直接渲染：exitMultiSelect() 一次清三个状态（直接读 state）；
//   ② 与 useNotesPageModel 同形的集中式 effect：listHidden / listCollapsed 变真
//      就退出多选（直接读 state，覆盖「X 收起 / 折叠」背后的隐藏路径）；
//   ③ 整页 NotesPage 真 DOM：点按钮、看批量条 / 勾选框 / 确认框，证明入口真的接上了。
//
// 环境：runner 只给 *.dom.test.tsx 挂 jsdom（script/unit-tests.mjs 的 DOM_SUFFIX），
// 这个文件名必须带 .dom.，否则会被静默跳过。
// ⚠️ 刻意不碰 NotesNavPanel 的视图切换（另一个 worker 正在补那里的
// exitMultiSelect）：用例里的按钮全在 NotesListPane / ConfirmDialog 上。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import NotesPage from "../src/components/NotesPage";
import { useNotesRowActions } from "../src/components/notes/useNotesRowActions";
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
    setViewport(1024);
});

function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", {
        value: width, configurable: true, writable: true,
    });
}
/** desktop 档（≥1180）：三栏都渲染，中栏头部的多选 / 收起按钮才在 */
function setWide() { setViewport(1440); }

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

// ---------------------------------------------------------------------------
// ① / ②：hook 级，直接读 state
// ---------------------------------------------------------------------------

function mountRowActions(): ReturnType<typeof useNotesRowActions>[] {
    const seen: ReturnType<typeof useNotesRowActions>[] = [];
    function Probe() {
        seen.push(useNotesRowActions());
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Probe />); });
    assert.ok(seen.length > 0, "Probe 至少该渲染过一次");
    return seen;
}

test("exitMultiSelect：一次把 multiSelect / checked / bulkDeleteOpen 全收干净", async () => {
    const seen = mountRowActions();
    await act(async () => {
        seen.at(-1)!.setMultiSelect(true);
        seen.at(-1)!.setChecked(new Set([1, 2, 3]));
        seen.at(-1)!.setBulkDeleteOpen(true);
    });
    assert.equal(seen.at(-1)!.multiSelect, true, "前置：多选已开");
    assert.equal(seen.at(-1)!.checked.size, 3, "前置：已勾三条");
    assert.equal(seen.at(-1)!.bulkDeleteOpen, true, "前置：确认框已开");

    await act(async () => { seen.at(-1)!.exitMultiSelect(); });
    assert.equal(seen.at(-1)!.multiSelect, false, "multiSelect 要关掉");
    assert.equal(seen.at(-1)!.checked.size, 0, "checked 要清空");
    assert.equal(seen.at(-1)!.bulkDeleteOpen, false, "bulkDeleteOpen 要关掉");
});

interface EffectHarness {
    seen: ReturnType<typeof useNotesRowActions>[];
    setHidden: (v: boolean) => void;
    setCollapsed: (v: boolean) => void;
}

/**
 * 用真实的 useNotesRowActions 状态 + 与 useNotesPageModel.tsx 里那条集中式
 * effect 同形的 useEffect。这样「listHidden / listCollapsed 变真」能直接读到
 * 三个 state 的结果，而不是靠 DOM 猜。真实那条 effect 的存在由
 * tests/bulkOps.test.ts 的静态守卫钉住。
 */
function mountEffectHarness(): EffectHarness {
    const seen: ReturnType<typeof useNotesRowActions>[] = [];
    let setHidden!: (v: boolean) => void;
    let setCollapsed!: (v: boolean) => void;
    function Probe() {
        const [listHidden, setListHidden] = useState(false);
        const [listCollapsed, setListCollapsed] = useState(false);
        const row = useNotesRowActions();
        const { exitMultiSelect } = row;
        setHidden = setListHidden;
        setCollapsed = setListCollapsed;
        useEffect(() => {
            if (listHidden || listCollapsed) exitMultiSelect();
        }, [listHidden, listCollapsed, exitMultiSelect]);
        seen.push(row);
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Probe />); });
    assert.ok(seen.length > 0, "Probe 至少该渲染过一次");
    return { seen, setHidden, setCollapsed };
}

function seedMultiSelect(seen: ReturnType<typeof useNotesRowActions>[]) {
    // 把三个状态都置成「多选进行中」，下一行 flip 隐藏标志才测得出差别
    return act(async () => {
        seen.at(-1)!.setMultiSelect(true);
        seen.at(-1)!.setChecked(new Set([1, 2]));
        seen.at(-1)!.setBulkDeleteOpen(true);
        await Promise.resolve();
    });
}

test("listHidden 变 true：集中式 effect 退出多选（三个状态全清）", async () => {
    const h = mountEffectHarness();
    await seedMultiSelect(h.seen);
    assert.equal(h.seen.at(-1)!.multiSelect, true, "前置：多选开着");
    assert.equal(h.seen.at(-1)!.checked.size, 2, "前置：已勾两条");
    assert.equal(h.seen.at(-1)!.bulkDeleteOpen, true, "前置：确认框开着");

    await act(async () => {
        h.setHidden(true);
        await Promise.resolve();
    });
    assert.equal(h.seen.at(-1)!.multiSelect, false, "listHidden 为真要退出多选");
    assert.equal(h.seen.at(-1)!.checked.size, 0, "勾选要清空");
    assert.equal(h.seen.at(-1)!.bulkDeleteOpen, false, "确认框要关掉");
});

test("listCollapsed 变 true：集中式 effect 退出多选（三个状态全清）", async () => {
    const h = mountEffectHarness();
    await seedMultiSelect(h.seen);
    assert.equal(h.seen.at(-1)!.multiSelect, true, "前置：多选开着");

    await act(async () => {
        h.setCollapsed(true);
        await Promise.resolve();
    });
    assert.equal(h.seen.at(-1)!.multiSelect, false, "listCollapsed 为真要退出多选");
    assert.equal(h.seen.at(-1)!.checked.size, 0, "勾选要清空");
    assert.equal(h.seen.at(-1)!.bulkDeleteOpen, false, "确认框要关掉");
});

// ---------------------------------------------------------------------------
// ③：整页 NotesPage 真 DOM（照抄 notes.dom.test.tsx 的 mountPanel）
// ---------------------------------------------------------------------------

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

/** MUI Dialog 关闭有退场过渡，内容不会在 open 变 false 的同一帧卸载 */
async function settleDialog() {
    await act(async () => { await new Promise(r => setTimeout(r, 350)); });
}

test("再点多选按钮切出：multiSelect / checked / bulkDeleteOpen 三个状态全清", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
        note({ id: 3, title: "丙" }),
    ]);
    // 开多选 + 勾两条
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-bulk-bar='1']"), "前置：开了多选要有批量条");
    const boxes = document.querySelectorAll<HTMLInputElement>("input[data-note-check]");
    assert.equal(boxes.length, 3);
    await act(async () => { boxes[0].click(); boxes[1].click(); });
    assert.match(
        document.querySelector("[data-bulk-bar='1']")!.textContent ?? "",
        /已选 2 条/,
        "前置：勾选生效"
    );
    // 打开批量删除确认框，把 bulkDeleteOpen 也置成 true
    await act(async () =>
        (document.querySelector("[data-bulk-action='delete']") as HTMLElement).click()
    );
    assert.match(document.body.textContent ?? "", /删除选中的 2 条笔记/, "前置：确认框已开");
    assert.ok(document.querySelector("[data-confirm-action='confirm']"), "前置：确认框里有确认键");
    assert.equal(
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).getAttribute("aria-label"),
        "退出多选"
    );

    // 再点一次多选按钮（切出）——这条路径直接调 exitMultiSelect()
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    await settleDialog();
    // multiSelect === false
    assert.equal(document.querySelector("[data-bulk-bar='1']"), null, "批量条要消失（multiSelect 关掉）");
    assert.equal(document.querySelector("input[data-note-check]"), null, "勾选框要收起");
    assert.equal(
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).getAttribute("aria-label"),
        "多选", "按钮要回到未开态"
    );
    // bulkDeleteOpen === false
    assert.equal(document.querySelector("[data-confirm-action='confirm']"), null, "确认框要关掉");
    assert.ok(!/删除选中的/.test(document.body.textContent ?? ""), "确认框文案不该还在");
    // checked.size === 0：重新进一次多选，一个勾都不该还在
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    assert.match(
        document.querySelector("[data-bulk-bar='1']")!.textContent ?? "",
        /已选 0 条/,
        "不能有残留勾选"
    );
    const again = [...document.querySelectorAll<HTMLInputElement>("input[data-note-check]")];
    assert.ok(again.length > 0 && again.every(b => !b.checked), "复选框一个都不该是勾上的");
});

test("X 收起列表：中栏真的隐藏、批量删除确认框随之关闭", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    const boxes = document.querySelectorAll<HTMLInputElement>("input[data-note-check]");
    await act(async () => { boxes[0].click(); });
    assert.match(
        document.querySelector("[data-bulk-bar='1']")!.textContent ?? "",
        /已选 1 条/,
        "前置：已勾一条"
    );
    await act(async () =>
        (document.querySelector("[data-bulk-action='delete']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-confirm-action='confirm']"), "前置：确认框已开");

    // 点 X 收起：setMiddleHidden(true) -> listHidden 变真，按钮直接调 exitMultiSelect
    // 外加那条集中式 effect。NotesConfirmLayer 是常驻 portal（不在列表列里），
    // 所以「确认框消失」只能是 bulkDeleteOpen 被置 false，而不是列表列被摘掉。
    await act(async () =>
        (document.querySelector("button[data-tool='collapse-list']") as HTMLElement).click()
    );
    await settleDialog();
    assert.equal(
        document.querySelector("[data-list-header='1']"),
        null,
        "中栏头部整个不渲染（列表被藏起来，幽灵多选的前提条件）"
    );
    assert.equal(
        document.querySelector("[data-confirm-action='confirm']"),
        null,
        "bulkDeleteOpen 要关掉（确认框消失）"
    );
    assert.ok(!/删除选中的/.test(document.body.textContent ?? ""), "确认框文案不该还在");
});
