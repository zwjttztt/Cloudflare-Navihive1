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

// ---------------------------------------------------------------------------
// ④ 整行点选：多选态下点行的任意位置都切换勾选，而不是只有小 checkbox 能选。
// 根因在行自己的 onClick/onKeyDown —— 以前多选态仍无条件 openNote/switchTo，
// 所以点标题、摘要、空白处全都没反应，只有左上方框有效。
// ---------------------------------------------------------------------------

/** 列表里的行（按渲染顺序），每行带 data-note-id */
function rows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-note-list] [data-note-id]")];
}

/** React 的 onClick 收合成事件，修饰键得自己 dispatch MouseEvent 才带得上 */
function clickRow(el: HTMLElement, init: MouseEventInit = {}) {
    el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, view: window, ...init })
    );
}

function bulkBar(): string {
    return document.querySelector("[data-bulk-bar='1']")!.textContent ?? "";
}

function isChecked(id: number): boolean {
    return document.querySelector<HTMLInputElement>(`input[data-note-check='${id}']`)!.checked;
}

function checkedIds(): number[] {
    return [...document.querySelectorAll<HTMLInputElement>("input[data-note-check]")]
        .filter(i => i.checked)
        .map(i => Number(i.getAttribute("data-note-check")))
        .sort((a, b) => a - b);
}

async function enterMultiSelect() {
    await act(async () =>
        (document.querySelector("button[data-tool='multiselect']") as HTMLElement).click()
    );
    assert.ok(document.querySelector("[data-bulk-bar='1']"), "前置：多选已开");
}

test("多选态：点整行任意位置都切换勾选，再点一次取消（标题也算）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    await enterMultiSelect();
    assert.match(bulkBar(), /已选 0 条/, "前置：还没勾");
    const row1 = () => document.querySelector<HTMLElement>("[data-note-list] [data-note-id='1']")!;

    // ① 点行自身的空白处（既不是 checkbox，也不是 ⋯ 菜单按钮）
    await act(async () => { row1().click(); });
    assert.equal(isChecked(1), true, "点行要勾上这一条");
    assert.match(bulkBar(), /已选 1 条/);
    // ② 再点一次取消
    await act(async () => { row1().click(); });
    assert.equal(isChecked(1), false, "再点一次要取消");
    assert.match(bulkBar(), /已选 0 条/);
    // ③ 点标题所在的那个 flex 子容器（行内非 checkbox / 非菜单按钮的区域）同样能选
    const titleArea = row1().firstElementChild as HTMLElement | null;
    assert.ok(titleArea, "行里要有标题/摘要子区域");
    await act(async () => { titleArea!.click(); });
    assert.equal(isChecked(1), true, "点行内子区域也要勾上");
    assert.match(bulkBar(), /已选 1 条/);
});

test("多选态：点 checkbox 只切换一次（行 onClick 不会二次 toggle）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    await enterMultiSelect();
    const box = () => document.querySelector<HTMLInputElement>("input[data-note-check='1']")!;
    // 若 checkbox 的 stopPropagation 丢了，冒泡到行会再 toggle 一次 → 两次抵消成 0
    await act(async () => { box().click(); });
    assert.equal(box().checked, true, "点 checkbox 要勾上");
    assert.equal(isChecked(1), true);
    assert.match(bulkBar(), /已选 1 条/, "只能是 1 条，双 toggle 会抵消成 0");
    await act(async () => { box().click(); });
    assert.equal(box().checked, false, "再点一次取消");
    assert.match(bulkBar(), /已选 0 条/);
});

test("多选态：点行内 ⋯ 菜单按钮不改变勾选（stopPropagation 必须保留）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    await enterMultiSelect();
    await act(async () => {
        document.querySelector<HTMLInputElement>("input[data-note-check='1']")!.click();
    });
    assert.match(bulkBar(), /已选 1 条/, "前置：先勾一条当基准");

    const menu = document.querySelector<HTMLElement>("button[data-note-menu='2']")!;
    await act(async () => { menu.click(); });
    assert.ok(document.querySelector("[data-row-op='delete']"), "菜单要打开");
    assert.match(bulkBar(), /已选 1 条/, "点菜单不能顺带改勾选");
    assert.equal(isChecked(2), false, "第二条不该被勾上");
});

test("非多选态：点整行仍打开笔记，不进多选（不回归）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    const title = () => document.querySelector<HTMLInputElement>("input[aria-label='笔记标题']")!;
    assert.equal(title().value, "甲", "前置：初始打开第一条");
    assert.equal(document.querySelector("[data-bulk-bar='1']"), null, "前置：没进多选");

    await act(async () => {
        (document.querySelector("[data-note-list] [data-note-id='2']") as HTMLElement).click();
    });
    assert.equal(title().value, "乙", "点整行要打开/切换过去");
    assert.equal(document.querySelector("input[data-note-check]"), null, "普通点不该进多选");
});

test("多选态：Ctrl/Cmd+点仍切单条、Shift+点仍从锚点连选（不回归）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
        note({ id: 3, title: "丙" }),
        note({ id: 4, title: "丁" }),
    ]);
    // ⌘/Ctrl+点：进入多选且只切这一条，不能双 toggle
    await act(async () => { clickRow(rows()[1], { ctrlKey: true, metaKey: true }); });
    assert.ok(document.querySelector("[data-bulk-bar='1']"), "Ctrl+点要进多选");
    assert.deepEqual(checkedIds(), [2], "Ctrl+点只该勾这一条");
    // 多选态下再 Ctrl+点同一条 = 取消（验 B：分支语义不变、没有双切换）
    await act(async () => { clickRow(rows()[1], { ctrlKey: true }); });
    assert.deepEqual(checkedIds(), [], "再 Ctrl+点要取消");
    // 普通点建立锚点（多选态下现在变成「切一条 + 设锚点」）
    await act(async () => { clickRow(rows()[1]); });
    assert.deepEqual(checkedIds(), [2], "普通点在多选态切一条并当锚点");
    // Shift+点第 4 条 → 2、3、4（两端都算）
    await act(async () => { clickRow(rows()[3], { shiftKey: true }); });
    assert.deepEqual(checkedIds(), [2, 3, 4], "Shift 从锚点连选到这一条");
});

test("多选态：键盘 Enter / Space 切勾选而不打开笔记（e.preventDefault 保持）", async () => {
    setWide();
    mountPanel([
        note({ id: 1, title: "甲" }),
        note({ id: 2, title: "乙" }),
    ]);
    const title = () => document.querySelector<HTMLInputElement>("input[aria-label='笔记标题']")!;
    await enterMultiSelect();
    const row2 = () => document.querySelector<HTMLElement>("[data-note-list] [data-note-id='2']")!;
    const press = (key: string) => {
        const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        row2().dispatchEvent(ev);
        return ev;
    };

    let ev!: KeyboardEvent;
    await act(async () => { ev = press("Enter"); });
    assert.ok(ev.defaultPrevented, "e.preventDefault 要保持");
    assert.equal(isChecked(2), true, "Enter 要勾上第二条");
    assert.equal(isChecked(1), false, "不该动到别的条");
    assert.match(bulkBar(), /已选 1 条/);
    assert.equal(title().value, "甲", "键盘不该打开/切换笔记");

    await act(async () => { press(" "); });
    assert.equal(isChecked(2), false, "Space 再切一次取消");
    assert.match(bulkBar(), /已选 0 条/);
    assert.equal(title().value, "甲", "Space 也不该打开笔记");
});
