// tests/useNotesSyncFilter.dom.test.tsx
// 笔记跨设备轮询的「外部变更」判定（2026-10-18）。
//
// 修的问题：本设备自己保存也会推 notes.updated_at，下一轮轮询照样命中
// `updated_at >= since` 的窗口 —— 不区分的话，自己刚保存的笔记会被当成
// 「其他设备改的」，表现为：
//   - 每次编辑后弹一条「其他设备的笔记更新已同步到列表」（其实是你自己改的）；
//   - 打开那篇笔记再弹「当前打开的笔记在其他设备被修改：保存时会提示冲突」。
//
// 判据：reload 前快照 revById（本设备已知的最新 rev，保存成功时回填的就是
// 服务端新 rev），reload 后 seedRevs 铺的服务端 rev 与快照**相等** = 本设备
// 已同步的写入；rev 真的变了的才算外部变更。
//
// 驱动方式：每轮轮询在 notesChanges 处挂闸（deferred gate），测试手动放行 ——
// 「先过一轮轮询 → 再执行保存动作 → 再过下一轮」这类时序完全确定，
// 不靠 sleep 猜（sleep 版实测会把用例顺序撞乱）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotes, clearNotesSwrCache, type NotesApiLike } from "../src/hooks/useNotes";
import { setActiveAccount, clearActiveAccount } from "../src/utils/accountScope";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import { clearNotesSyncState } from "../src/utils/notesSync";
import type { Note, NotesChangesResult } from "../src/API/types";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeNote(id: number, rev: number): Note {
    return {
        id,
        uuid: `u${id}`,
        title: `笔记${id}`,
        content: `内容${id}`,
        pinned: false,
        rev,
        order_num: 0,
        site_id: null,
    } as Note;
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
    clearNotesSwrCache();
    clearActiveAccount();
    // 游标 / prefs 按账号存 localStorage，跨用例必须清
    clearNotesSyncState();
    globalThis.localStorage?.clear();
});

interface MountOpts {
    /** 服务端当前列表（reload 每次都拉最新；测试里改外部变量模拟外部变更） */
    list: () => Note[];
    /** notesChanges 第 n 轮的变更脚本；出完兜底「无变更」 */
    changes: Array<Partial<NotesChangesResult>>;
}

async function mountNotes(opts: MountOpts) {
    const notifies: string[] = [];
    const errors: string[] = [];
    const seen: ReturnType<typeof useNotes>[] = [];
    let listCalls = 0;
    let changesCalls = 0;
    const sinceSeen: Array<string | undefined> = [];
    const onError = (m: string) => errors.push(m);
    const onNotify = (m: string) => notifies.push(m);
    let release: (() => void) | null = null;
    // ⚠️ api 必须定义在 Probe 外（写在 JSX 里每次渲染都是新对象 → reload 重跑
    // → setNotes → 再渲染 → 无限循环 OOM，见 noteWriteQueue.dom.test.tsx）
    const api = {
        listNotes: () => {
            listCalls += 1;
            return Promise.resolve(opts.list());
        },
        notesChanges: async (since?: string) => {
            sinceSeen.push(since);
            const script = opts.changes[changesCalls] ?? { notesChanged: 0, changedNoteIds: [] };
            changesCalls += 1;
            // 挂闸：等测试放行再返回 —— 放行前测试可以插入动作（保存）或做断言
            await new Promise<void>(r => {
                release = r;
            });
            return {
                success: true,
                now: `2026-01-01 00:00:${String(changesCalls).padStart(2, "0")}`,
                folders: [],
                tags: [],
                noteTags: {},
                notesChanged: 0,
                changedNoteIds: [],
                ...script,
            } as NotesChangesResult;
        },
        updateNote: async (_id: number, patch: Partial<Note>) => {
            const baseRev = typeof patch.rev === "number" ? patch.rev : 1;
            return { ...makeNote(_id, baseRev + 1), ...patch, rev: baseRev + 1 } as Note;
        },
    } as unknown as NotesApiLike;
    function Probe() {
        seen.push(
            useNotes({
                api,
                onError,
                onNotify,
                // 测试注入：首轮 5ms、轮询间隔 5ms —— 生产路径走 prefs，别传这两个
                firstDelayMs: 5,
                pollIntervalMs: 5,
            })
        );
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
    // mount 的 reload 是异步的：等它落地，别让它跟第一轮轮询抢时序
    await act(async () => {
        await sleep(10);
    });

    /** 等第 n 轮轮询挂到闸上，然后放行并等这轮处理完（含 reload 的 setState） */
    async function step(n: number) {
        const deadline = Date.now() + 2000;
        while (changesCalls < n || release === null) {
            if (Date.now() > deadline) throw new Error(`轮询没到第 ${n} 轮（当前 ${changesCalls}）`);
            await sleep(1);
        }
        const r = release;
        release = null;
        await act(async () => {
            r?.();
            await sleep(5);
        });
    }

    return {
        notifies,
        errors,
        sinceSeen,
        get listCalls() {
            return listCalls;
        },
        get changesCalls() {
            return changesCalls;
        },
        last: () => seen[seen.length - 1],
        step,
    };
}

test("首轮轮询（游标为空）只建基线，不报变更", async () => {
    setActiveAccount(1);
    const h = await mountNotes({
        list: () => [makeNote(5, 1)],
        // 有未消费的变更也照旧静默：游标为空 = 第一次用，只初始化
        changes: [{ notesChanged: 1, changedNoteIds: [5] }],
    });
    await h.step(1);
    assert.equal(
        h.notifies.filter(m => m.includes("其他设备的笔记更新已同步")).length,
        0,
        "首轮不应报「已同步」",
    );
    assert.deepEqual(h.last().lastSyncChangedIds, [], "首轮不产生 changed ids");
    assert.equal(h.sinceSeen[0], undefined, "首轮不携带游标");
});

test("本设备自己保存的笔记不再被当成「其他设备改的」", async () => {
    setActiveAccount(1);
    let serverRev = 1;
    const h = await mountNotes({
        list: () => [makeNote(5, serverRev)],
        changes: [
            { notesChanged: 0, changedNoteIds: [] }, // 首轮：建基线
            // 第二轮：changedNoteIds 含 5 —— 实际是本设备自己保存推的 updated_at
            { notesChanged: 1, changedNoteIds: [5] },
        ],
    });
    await h.step(1); // 首轮：建基线
    // 模拟本设备保存：服务端回 rev=2 并被 revById 记下
    const saved = await h.last().updateNote(5, { title: "本机改的" });
    assert.equal(saved, true, "保存应成功");
    serverRev = 2; // 服务端列表同步推进
    await h.step(2); // 第二轮：变更窗口命中 5
    const syncNotifies = h.notifies.filter(m => m.includes("其他设备的笔记更新已同步"));
    assert.deepEqual(syncNotifies, [], "自己的保存不应弹「其他设备已同步」");
    assert.deepEqual(
        h.last().lastSyncChangedIds,
        [],
        "自己的保存不应留下 changed ids（否则打开笔记就弹「在其他设备被修改」）",
    );
});

test("真正的外部变更仍会提示，且只含外部改的那几条", async () => {
    setActiveAccount(1);
    // mount 时服务端只有 5；6 是**之后**才被其它设备改出来的
    let serverList = [makeNote(5, 1)];
    const h = await mountNotes({
        list: () => serverList,
        changes: [
            { notesChanged: 0, changedNoteIds: [] },
            { notesChanged: 1, changedNoteIds: [6] }, // 第二轮：6 被外部改了
        ],
    });
    await h.step(1); // 首轮建基线（此时 revById 只有 5）
    serverList = [makeNote(5, 1), makeNote(6, 9)]; // 外部设备写入了新笔记 6
    await h.step(2);
    assert.equal(
        h.notifies.filter(m => m.includes("其他设备的笔记更新已同步")).length,
        1,
        "外部变更应弹一次「已同步」",
    );
    assert.deepEqual(h.last().lastSyncChangedIds, [6], "changed ids 只含外部改的笔记");
});

test("游标随轮询推进：第二轮起携带上一轮的 now", async () => {
    setActiveAccount(1);
    const h = await mountNotes({
        list: () => [makeNote(5, 1)],
        changes: [{ notesChanged: 0, changedNoteIds: [] }],
    });
    await h.step(1);
    await h.step(2);
    assert.equal(h.sinceSeen[0], undefined, "首轮无游标");
    assert.equal(h.sinceSeen[1], "2026-01-01 00:00:01", "第二轮携带首轮返回的游标");
});

test("外部删除也要广播提示：changedNoteIds 为空但列表少了笔记", async () => {
    // ⚠️ 后端 notesChanged = updated + 墓碑；changedNoteIds 只回「改过的」。
    // 别的设备删了笔记时它为空 —— 这里不能被「rev 没变」的过滤吞掉，
    // 否则其它标签页收不到 changed 广播、用户也看不到「已同步」。
    setActiveAccount(1);
    let serverList = [makeNote(5, 1), makeNote(6, 1)];
    const h = await mountNotes({
        list: () => serverList,
        changes: [
            { notesChanged: 0, changedNoteIds: [] },
            { notesChanged: 1, changedNoteIds: [] }, // 纯删除：只有墓碑计数
        ],
    });
    await h.step(1);
    serverList = [makeNote(5, 1)]; // 外部设备删了笔记 6
    await h.step(2);
    assert.equal(
        h.notifies.filter(m => m.includes("其他设备的笔记更新已同步")).length,
        1,
        "外部删除应弹「已同步」",
    );
    assert.deepEqual(
        h.last().lastSyncChangedIds,
        [],
        "删除不产生 changed ids（那篇已经不在了，没有「打开它弹冲突提示」的意义）",
    );
});
