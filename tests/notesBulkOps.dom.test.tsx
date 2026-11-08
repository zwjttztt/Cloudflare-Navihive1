// tests/notesBulkOps.dom.test.tsx
// 需求 2「笔记多选删除慢、卡片一条条消失」的行为回归用例。
//
// 这一组刻意不读源码文本、也不「确认函数存在」，而是把 useNotes /
// useNotesBulkOps 用 createRoot 真渲染一遍，塞一份假 API，然后数：
// 请求次数、渲染中间态、并发在飞峰值 —— 都是写歪了立刻会变的**可观测行为**。
//
// 环境说明：runner 只给 *.dom.test.tsx 挂 jsdom（见 script/unit-tests.mjs 的
// DOM_SUFFIX）；*.test.ts / *.test.tsx 都不带 DOM，渲染不了 react-dom。所以这个
// 文件名必须带 .dom.，否则会被 runner 静默跳过 —— 一个不跑的守卫等于没有。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import { useNotes, clearNotesSwrCache } from "../src/hooks/useNotes";
import { useNotesBulkOps } from "../src/components/notes/useNotesBulkOps";
import type { Note } from "../src/API/http";
import type { NoteBatchDeleteResult } from "../src/API/types";

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
    // useNotes 有模块级 SWR 缓存，不请的话下一个用例会拿到上一份列表
    clearNotesSwrCache();
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

// ---------------------------------------------------------------------------
// useNotes.deleteNotes：数据层的批量删除
// ---------------------------------------------------------------------------

interface NotesHarness {
    seen: ReturnType<typeof useNotes>[];
    errors: string[];
    notices: Array<{ message: string; level?: string }>;
}

/** 照抄 notes.dom.test.tsx 的 mountHook：Probe 每次渲染把 hook 返回值收进 seen */
async function mountNotes(api: Record<string, unknown>): Promise<NotesHarness> {
    const seen: ReturnType<typeof useNotes>[] = [];
    const errors: string[] = [];
    const notices: Array<{ message: string; level?: string }> = [];
    // ⚠️ 这两个回调必须是稳定的：useNotes 的 reload() 把 onError 列进了依赖，
    // 而首屏那个 effect 又依赖 reload。写成内联箭头会每次渲染换身份 →
    // effect 反复重跑 → listNotes 被反复调用，观测窗口里混进一堆无关渲染。
    const onError = (message: string) => { errors.push(message); };
    const onNotify = (message: string, level?: string) => { notices.push({ message, level }); };
    function Probe() {
        const state = useNotes({
            api: api as never,
            onError,
            onNotify,
        });
        seen.push(state);
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
    // 首屏那次 listNotes 是异步的：不等的话 notes 还是初始空数组，
    // 「回滚到删除前」「按 before 复原」这些断言就成了空→空，等于什么都没测
    await act(async () => { await Promise.resolve(); });
    assert.ok(seen.length > 0, "Probe 至少该渲染过一次");
    return { seen, errors, notices };
}

test("deleteNotes：只发一次批量请求、只做一次乐观 setNotes、单删一次都不发", async () => {
    const all = [
        note({ id: 1 }), note({ id: 2 }), note({ id: 3 }),
        note({ id: 4, title: "留下" }),
    ];
    const batchArgs: number[][] = [];
    const singleArgs: number[] = [];
    const { seen, notices } = await mountNotes({
        listNotes: async () => all,
        deleteNotes: async (ids: number[]): Promise<NoteBatchDeleteResult> => {
            batchArgs.push(ids);
            return { items: ids.map(id => ({ id })), failed: [] };
        },
        deleteNote: async (id: number) => {
            singleArgs.push(id);
            return { success: true };
        },
    });
    const state = seen.at(-1)!;
    assert.deepEqual(state.notes.map(n => n.id), [1, 2, 3, 4], "首拉后列表要有四条");

    const targets = [note({ id: 1 }), note({ id: 2 }), note({ id: 3 })];
    const mark = seen.length;
    let result!: { deleted: number[]; failed: number[] };
    await act(async () => { result = await state.deleteNotes(targets); });

    // 一次批量，不是 N 次单删
    assert.equal(batchArgs.length, 1, "api.deleteNotes 只能调一次");
    assert.deepEqual(batchArgs[0], [1, 2, 3], "一次把整批 id 交出去");
    assert.deepEqual(singleArgs, [], "有批量端点时不该再逐条 deleteNote");
    // 结果契约 + 列表只剩没勾的那条
    assert.deepEqual(result.deleted, [1, 2, 3]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(seen.at(-1)!.notes.map(n => n.id), [4], "只有没勾的那条留下");
    // 一次回执，条数等于成功数
    assert.equal(notices.length, 1, "整批只发一次 notify");
    assert.match(notices[0].message, /已删除 3 条/, "回执条数等于成功数");

    // 只做一次乐观 setNotes：窗口内 notes 引用只变一次，
    // 且绝不能出现「只删掉一两条」的中间渲染（那就是卡片一条条消失）
    const beforeNotes = seen[mark - 1].notes;
    let changes = 0;
    let prev = beforeNotes;
    for (const s of seen.slice(mark)) {
        if (s.notes !== prev) { changes++; prev = s.notes; }
    }
    assert.equal(changes, 1, "整批删除只该有一次乐观 setNotes（卡片不能一条条消失）");
    const partial = seen.slice(mark).filter(s => {
        const left = s.notes.filter(n => [1, 2, 3].includes(n.id!)).length;
        return left > 0 && left < 3;
    });
    assert.equal(partial.length, 0, "不该出现只删了一部分的中间态");
});

test("deleteNotes：部分失败时按 before 快照把没删掉的放回列表", async () => {
    const all = [
        note({ id: 1 }), note({ id: 2 }),
        note({ id: 3, title: "原文·三", content: "服务端没删掉的正文" }),
        note({ id: 4, title: "留下" }),
    ];
    const { seen, notices } = await mountNotes({
        listNotes: async () => all,
        deleteNotes: async (): Promise<NoteBatchDeleteResult> => ({
            items: [{ id: 1 }, { id: 2 }],
            failed: [3],
        }),
    });
    const beforeNote3 = seen.at(-1)!.notes.find(n => n.id === 3)!;

    // 刻意传一份「被改动过」的 target：复原必须来自 before 快照，而不是入参
    const targets = [
        note({ id: 1 }), note({ id: 2 }),
        note({ id: 3, title: "被篡改的标题", content: "不该被写回" }),
    ];
    let result!: { deleted: number[]; failed: number[] };
    await act(async () => { result = await seen.at(-1)!.deleteNotes(targets); });

    const finalList = seen.at(-1)!.notes;
    assert.deepEqual(
        finalList.map(n => n.id!).sort((a, b) => a - b),
        [3, 4],
        "没删掉的 3 要放回、删掉的 1/2 不能回来"
    );
    const restored = finalList.find(n => n.id === 3)!;
    assert.equal(restored.title, "原文·三", "复原的是删除前的原文，不是入参里被改过的那份");
    assert.equal(restored, beforeNote3, "复原项与 before 快照里的对象同一个引用（按 before 复原）");
    assert.deepEqual(result.deleted, [1, 2]);
    assert.deepEqual(result.failed, [3]);
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /已删除 2 条/, "回执按成功数算");
});

test("deleteNotes：老部署没有批量端点时退化成 N 次 deleteNote", async () => {
    const all = [note({ id: 1 }), note({ id: 2 }), note({ id: 3 }), note({ id: 4 })];
    const singleArgs: number[] = [];
    const { seen } = await mountNotes({
        listNotes: async () => all,
        // 故意不提供 deleteNotes
        deleteNote: async (id: number) => {
            singleArgs.push(id);
            return { success: true };
        },
    });
    let result!: { deleted: number[]; failed: number[] };
    await act(async () => {
        result = await seen.at(-1)!.deleteNotes([
            note({ id: 1 }), note({ id: 2 }), note({ id: 3 }),
        ]);
    });
    assert.equal(singleArgs.length, 3, "三条各发一次单删（合计 N 次）");
    assert.deepEqual([...singleArgs].sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual(result.deleted, [1, 2, 3]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(seen.at(-1)!.notes.map(n => n.id), [4]);
});

test("deleteNotes：降级路径里某条单删失败也要按 before 复原", async () => {
    const all = [
        note({ id: 1 }),
        note({ id: 2, title: "单删失败的原文" }),
        note({ id: 3 }),
    ];
    const { seen } = await mountNotes({
        listNotes: async () => all,
        deleteNote: async (id: number) => {
            if (id === 2) throw new Error("网络断了");
            return { success: true };
        },
    });
    await act(async () => {
        await seen.at(-1)!.deleteNotes([
            note({ id: 1 }), note({ id: 2 }), note({ id: 3 }),
        ]);
    });
    assert.deepEqual(
        seen.at(-1)!.notes.map(n => n.id ?? 0).sort((a, b) => a - b),
        [2],
        "删失败的 2 要放回、删成的 1/3 不能回来"
    );
    assert.equal(
        seen.at(-1)!.notes.find(n => n.id === 2)!.title,
        "单删失败的原文",
        "复原的是删除前那份"
    );
});

test("deleteNotes：请求抛异常时整体回滚到 before 并触发 onError", async () => {
    const all = [
        note({ id: 1, title: "甲" }), note({ id: 2, title: "乙" }), note({ id: 3, title: "丙" }),
    ];
    const { seen, errors, notices } = await mountNotes({
        listNotes: async () => all,
        deleteNotes: async (): Promise<NoteBatchDeleteResult> => {
            throw new Error("网络断了");
        },
    });
    const before = seen.at(-1)!.notes;
    let result!: { deleted: number[]; failed: number[] };
    await act(async () => {
        result = await seen.at(-1)!.deleteNotes([note({ id: 1 }), note({ id: 2 })]);
    });
    assert.equal(seen.at(-1)!.notes, before, "整体回滚：列表要回到 before 那份快照（同一引用）");
    assert.deepEqual(seen.at(-1)!.notes.map(n => n.id), [1, 2, 3]);
    assert.ok(errors.some(e => e.includes("批量删除笔记失败")), "要触发 onError");
    assert.equal(notices.length, 0, "失败路径不该发成功回执");
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.failed, [1, 2]);
});

// ---------------------------------------------------------------------------
// useNotesBulkOps：勾选层的批量删除 / 批量归档
//
// 这个 hook 是「受控」的：checked / bulkBusy / bulkDeleteOpen 的状态都在父级。
// 所以这里用一份**普通可变对象**当父级状态，把 setChecked / setBulkDeleteOpen /
// onNotify 全接成探针 —— hook 的契约就是「按什么参数调这些回调」，直接看探针
// 比绕一圈渲染真实父组件更清楚，也不会有无谓的重渲染混进观测窗口。
// ---------------------------------------------------------------------------

interface BulkOpsHarness {
    ops: () => ReturnType<typeof useNotesBulkOps>;
    checked: () => Set<number>;
    bulkDeleteOpen: () => boolean;
    notifyCalls: Array<{ message: string; kind?: "success" | "error" | "info" }>;
    setCheckedCalls: Set<number>[];
}

function mountBulkOps(opts: {
    notes: Note[];
    initialChecked: number[];
    onToggleArchive?: (n: Note) => void | Promise<void>;
    onDelete?: (n: Note) => void | Promise<void>;
    onDeleteMany?: (notes: Note[]) => Promise<{ failed: number[] }>;
}): BulkOpsHarness {
    const state = {
        checked: new Set<number>(opts.initialChecked),
        bulkBusy: false,
        bulkDeleteOpen: true, // 模拟「确认弹窗正开着」
    };
    const notifyCalls: Array<{ message: string; kind?: "success" | "error" | "info" }> = [];
    const setCheckedCalls: Set<number>[] = [];
    let captured: ReturnType<typeof useNotesBulkOps> | null = null;

    function Probe() {
        const ops = useNotesBulkOps({
            filtered: opts.notes,
            checked: state.checked,
            onToggleArchive: opts.onToggleArchive ?? (() => {}),
            onDelete: opts.onDelete ?? (() => {}),
            onDeleteMany: opts.onDeleteMany,
            onNotify: (message, kind) => notifyCalls.push({ message, kind }),
            setChecked: v => {
                const next = typeof v === "function" ? v(state.checked) : v;
                setCheckedCalls.push(new Set(next));
                state.checked = next;
            },
            setBulkDeleteOpen: v => { state.bulkDeleteOpen = v; },
            bulkBusy: state.bulkBusy,
            setBulkBusy: v => { state.bulkBusy = v; },
        });
        captured = ops;
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<Probe />); });
    assert.ok(captured, "Probe 至少该渲染过一次");
    return {
        ops: () => captured!,
        checked: () => state.checked,
        bulkDeleteOpen: () => state.bulkDeleteOpen,
        notifyCalls,
        setCheckedCalls,
    };
}

test("bulkDelete：走 onDeleteMany 一次调用，failed 留 checked、成功项移除，通知条数等于成功数", async () => {
    const notes = [note({ id: 1 }), note({ id: 2 }), note({ id: 3 })];
    const manyCalls: number[][] = [];
    const singleCalls: number[] = [];
    const h = mountBulkOps({
        notes,
        initialChecked: [1, 2, 3],
        onDeleteMany: async (ns) => {
            manyCalls.push(ns.map(n => n.id!));
            return { failed: [3] }; // 3 没删掉
        },
        onDelete: async (n) => { singleCalls.push(n.id!); },
    });
    await act(async () => { await h.ops().bulkDelete(); });

    assert.equal(manyCalls.length, 1, "onDeleteMany 只能调一次");
    assert.deepEqual(manyCalls[0], [1, 2, 3], "一次把整批勾中的笔记交出去");
    assert.deepEqual(singleCalls, [], "有批量回调时不该逐条 onDelete（证明优先走批量）");
    assert.deepEqual([...h.checked()].sort((a, b) => a - b), [3], "没删掉的 3 留在 checked，成功的 1/2 移出");
    assert.equal(h.setCheckedCalls.length, 1, "只在结尾写一次 checked");
    assert.deepEqual([...h.setCheckedCalls[0]].sort((a, b) => a - b), [3]);
    assert.equal(h.bulkDeleteOpen(), false, "确认框要关掉");
    assert.equal(h.notifyCalls.length, 1, "只发一次回执");
    assert.match(h.notifyCalls[0].message, /已删除 2 条/, "回执条数等于成功数（3 勾 - 1 失败）");
});

test("bulkDelete：没有 onDeleteMany 时才退回逐条 onDelete（证明优先级）", async () => {
    const notes = [note({ id: 1 }), note({ id: 2 })];
    const singleCalls: number[] = [];
    const h = mountBulkOps({
        notes,
        initialChecked: [1, 2],
        onDelete: async (n) => { singleCalls.push(n.id!); },
    });
    await act(async () => { await h.ops().bulkDelete(); });
    assert.equal(singleCalls.length, 2, "降级路径逐条 onDelete");
    assert.deepEqual([...singleCalls].sort((a, b) => a - b), [1, 2]);
    assert.deepEqual([...h.checked()], [], "全删成时勾选清空");
    assert.match(h.notifyCalls[0].message, /已删除 2 条/);
});

test("bulkArchive：并发而非串行 —— 峰值 in-flight > 1 且 ≤ 6", async () => {
    const notes = Array.from({ length: 8 }, (_, i) => note({ id: i + 1, archived: false }));
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const h = mountBulkOps({
        notes,
        initialChecked: notes.map(n => n.id!),
        // 延迟到微任务再 resolve 的假 update：串行的 for...await 会在继续下一条
        // 之前就把它 resolve 掉（同一时刻永远只有 1 条在飞）；并发窗口才会把多条
        // 叠起来。峰值就是「到底开没开并发」的可观测量。
        onToggleArchive: () => {
            calls++;
            inFlight++;
            peak = Math.max(peak, inFlight);
            return Promise.resolve().then(() => { inFlight--; });
        },
    });
    // 这一路不触发任何 React setState（父级状态是普通对象），直接 await 即可
    await h.ops().bulkArchive();

    assert.equal(calls, 8, "八条都要走 onToggleArchive");
    assert.ok(peak > 1, `批量归档是并发的，峰值 in-flight 应 > 1（实测 ${peak}）`);
    assert.ok(peak <= 6, `并发上限是 6，峰值不该超过 6（实测 ${peak}）`);
    assert.deepEqual([...h.checked()], [], "归档完清空勾选");
    assert.match(h.notifyCalls.at(-1)!.message, /已归档 8 条/);
});
