// tests/noteWriteQueue.dom.test.tsx
// 同一条笔记的**连续写入**不能自己把自己判成「别处被修改过」。
//
// 起因（用户实测）：连点两下「置顶」就弹冲突框。真因是两笔写入都拿同一个旧 rev 发出去 ——
// 第一笔把服务端 rev +1，第二笔带着旧 rev 命中 `AND rev = 旧值` 一条都改不到 → 409。
// 那个框本意是防**别的设备/标签页**抢写，结果我们自己按两下就把它叫出来了。
//
// 为什么必须真环境（真 hook + 真 promise 时序）：这条 bug 的全部信息都在时序里 ——
// 「第二笔开始时第一笔还在飞」。用假的 api 同步返回结果，或者两笔之间多 await 一次，
// 都会让顺序自然正确，写成「怎么测都过」的假绿。所以这里用一个**可手动放行的闸门**
// 把第一笔钉在飞行中，再触发第二下点击。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotes } from "../src/hooks/useNotes";
import { NoteConflictError } from "../src/utils/noteConflict";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
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

interface Harness {
    hook: () => ReturnType<typeof useNotes>;
    /** 服务端收到的每一个 rev（按到达顺序） */
    revsSent: number[];
    /** 弹了几次「这条笔记在别处被改过了」 */
    conflicts: number;
    /** 服务端当前那一版 */
    server: Note;
    /** 放行第一笔在飞的请求 */
    release: () => void;
    /** 模拟「别的设备刚改过」：把服务端 rev 直接推高 */
    bumpServer: (by: number) => void;
}

/**
 * 起一个带闸门的服务端替身：第一笔 updateNote 会一直挂着，直到调用 release()。
 * 服务端语义照抄真后端 —— 带 rev 且对不上就抛 NoteConflictError。
 */
async function mountQueue(over: Partial<Note> = {}, holdFirstUpdate = true): Promise<Harness> {
    const server: Note = {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        rev: 5,
        order_num: 0,
        site_id: null,
        ...over,
    } as Note;
    const revsSent: number[] = [];
    let conflicts = 0;
    let holdFirst = holdFirstUpdate;
    // ⚠️ 不放行就永远挂着：闸门只给「要把第一笔钉在飞行中」的用例用，
    // 不用闸门的用例必须 hold=false，否则 await 会一直不返回（测试跑到超时被 abort）
    let release = () => {};
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });

    const api = {
        listNotes: async () => [{ ...server }],
        updateNote: async (_id: number, patch: Partial<Note>) => {
            revsSent.push(patch.rev as number);
            // 真后端：带 rev 且库里对不上 → 409（一条都改不到）
            if (typeof patch.rev === "number" && patch.rev !== server.rev) {
                throw new NoteConflictError("这条笔记在别处被改过了", { ...server });
            }
            if (holdFirst) {
                holdFirst = false;
                await gate;
            }
            Object.assign(server, patch, { rev: (server.rev ?? 0) + 1 });
            return { ...server };
        },
    };

    const seen: ReturnType<typeof useNotes>[] = [];
    // ⚠️ 这三个回调必须**定义在 Probe 外面**：写进 JSX 里的话每次渲染都是新函数，
    // 而 useNotes 的 reload 依赖 onError、effect 又依赖 reload —— 身份一变就重跑
    // reload → setNotes → 再渲染 → 又变…… 无限循环（实测跑到 4GB 堆直接 OOM）。
    const onError = () => {};
    const onNotify = () => {};
    const onNoteConflict = async () => {
        conflicts++;
    };
    function Probe() {
        const value = useNotes({
            api: api as never,
            onError,
            onNotify,
            onNoteConflict,
        });
        seen.push(value);
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
    await act(async () => {
        await Promise.resolve();
    });

    return {
        hook: () => seen.at(-1)!,
        revsSent,
        get conflicts() {
            return conflicts;
        },
        server,
        release,
        bumpServer: (by: number) => {
            server.rev = (server.rev ?? 0) + by;
        },
    } as Harness;
}

test("多标签通知：按账号分频道，仅提示不替换草稿，成功保存才广播", async () => {
    const original = globalThis.BroadcastChannel;
    const channels: MockChannel[] = [];
    class MockChannel {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        sent: unknown[] = [];
        closed = false;
        constructor(readonly name: string) { channels.push(this); }
        postMessage(value: unknown) { this.sent.push(value); }
        close() { this.closed = true; }
    }
    globalThis.BroadcastChannel = MockChannel as unknown as typeof BroadcastChannel;
    localStorage.setItem("navihive:activeAccount", "77");
    try {
        const h = await mountQueue({}, false);
        assert.equal(channels[0].name, "navihive-notes-changed:77");
        const before = h.hook().notes[0].content;
        act(() => channels[0].onmessage?.({ data: { type: "changed" } }));
        assert.equal(h.hook().externalChange, true);
        assert.equal(h.hook().notes[0].content, before);
        await act(async () => { await h.hook().updateNote(1, { title: "changed" }); });
        assert.deepEqual(channels[0].sent, [{ type: "changed" }]);
        act(() => root?.unmount());
        root = null;
        assert.equal(channels[0].closed, true);
    } finally {
        globalThis.BroadcastChannel = original;
        localStorage.removeItem("navihive:activeAccount");
    }
});

test("连点两下置顶：第二笔带的是第一笔返回的新 rev，不该弹冲突框", async () => {
    const h = await mountQueue();
    const note = h.hook().notes[0];

    let first!: Promise<void>;
    let second!: Promise<void>;
    // 第一下：发出去，故意不 await（请求还在飞）
    act(() => {
        first = h.hook().togglePin(note);
    });
    // 让 React 把这次乐观更新刷进状态（用户在真实点击之间也隔了这么久）
    await act(async () => {
        await Promise.resolve();
    });
    // 第二下：此时第一笔还没回来
    act(() => {
        second = h.hook().togglePin(h.hook().notes[0]);
    });

    h.release();
    await act(async () => {
        await Promise.all([first, second]);
    });

    assert.deepEqual(h.revsSent, [5, 6], "两笔写入必须带 5 和 6，不能两笔都带 5");
    assert.equal(h.conflicts, 0, "自己连点两下不该报「别处被修改过」");
    // 点两下 = 置顶又取消，净效果回到未置顶
    assert.equal(h.server.pinned, false, "服务端最终应是未置顶");
    assert.equal(h.hook().notes[0].pinned, false);
    assert.equal(typeof h.hook().notes[0].rev, "number", "rev 要被回填成服务端最新的");
});

test("连点两下的第二下按**最新状态**取反（不能按旧快照算成同一个值）", async () => {
    const h = await mountQueue();
    act(() => {
        void h.hook().toggleStar(h.hook().notes[0]);
    });
    await act(async () => {
        await Promise.resolve();
    });
    act(() => {
        void h.hook().toggleStar(h.hook().notes[0]);
    });
    h.release();
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(h.server.starred, false, "点两下收藏 → 收藏又取消，最终未收藏");
});

test("真有别的设备抢写时，守卫仍然要弹框（不能为了不误报就把守卫关掉）", async () => {
    const h = await mountQueue({}, false);
    // 模拟：这个页面加载之后，别的设备把这条笔记存了一版
    h.bumpServer(3);
    await act(async () => {
        await h.hook().updateNote(1, { title: "我这里的改动" });
    });
    assert.ok(h.conflicts >= 1, "rev 对不上时必须仍然弹冲突框");
    assert.equal(h.server.title, "标题", "没让用户确认前，服务端的版本不能被覆盖");
});
