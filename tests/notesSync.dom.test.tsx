// tests/notesSync.dom.test.tsx
//
// 阶段 5（2026-10-11）：跨设备变更轮询的客户端语义（真 hook + 假时钟）。
//
// 服务端语义已在 noteChangesRealSql.test.ts 里用真库钉死；这里钉客户端的三条铁律：
//   1. 首次轮询只建立游标基线，**绝不触发刷新**（否则每次打开记事本都白刷一次）；
//   2. 有变更时走既有 reload() 整表重拉 + 广播 + 提示，编辑器草稿永不自动覆盖；
//   3. 偏好关掉（或 api 没有 notesChanges）就不发请求 —— 老部署零成本。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNotes } from "../src/hooks/useNotes";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { Note } from "../src/API/types";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const PREFS_KEY = "notes.sync.prefs:u77";
const CURSOR_KEY = "notes.sync.cursor:u77";

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
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(CURSOR_KEY);
    localStorage.removeItem("navihive:activeAccount");
});

interface SyncHarness {
    hook: () => ReturnType<typeof useNotes>;
    /** notesChanges 收到的每一个 since（按调用顺序） */
    sincStent: (string | undefined)[];
    /** reload 实际触发了几次（listNotes 调用数） */
    listCalls: () => number;
    notifications: string[];
    sent: unknown[];
    /** 服务端下一次轮询要报的变更数 */
    setChanged: (n: number) => void;
}

function mountSync(opts: { prefs?: Record<string, unknown>; withNotesChanges?: boolean } = {}) {
    const note: Note = {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        rev: 5,
        order_num: 0,
        site_id: null,
    } as Note;
    let listCalls = 0;
    let changed = 0;
    const sincStent: (string | undefined)[] = [];
    const notifications: string[] = [];
    const sent: unknown[] = [];

    const api: Record<string, unknown> = {
        listNotes: async () => {
            listCalls += 1;
            return [{ ...note }];
        },
        updateNote: async () => note,
    };
    if (opts.withNotesChanges !== false) {
        api.notesChanges = async (since?: string) => {
            sincStent.push(since);
            return {
                success: true,
                now: `2030-01-01 00:00:${String(10 + sincStent.length).padStart(2, "0")}`,
                notesChanged: changed,
                folders: [],
                tags: [],
                noteTags: {},
            };
        };
    }

    localStorage.setItem("navihive:activeAccount", "77");
    localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ enabled: true, intervalSec: 30, ...(opts.prefs ?? {}) })
    );

    const seen: ReturnType<typeof useNotes>[] = [];
    const onError = () => {};
    const onNotify = (message: string) => {
        notifications.push(message);
    };
    function Probe() {
        seen.push(useNotes({ api: api as never, onError, onNotify }));
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
    act(() => {
        void Promise.resolve();
    });

    // 把 hook 内部广播用的频道截下来（与 noteWriteQueue.dom 同一套桩法）
    return {
        hook: () => seen.at(-1)!,
        sincStent,
        listCalls: () => listCalls,
        notifications,
        sent,
        setChanged: (n: number) => {
            changed = n;
        },
        // sent 由测试内通过 MockChannel 实例断言（见下方用例）
    } as SyncHarness & { sent: unknown[] };
}

const channels: { name: string; sent: unknown[]; onmessage: ((e: { data: unknown }) => void) | null }[] = [];

test("跨设备轮询：首查建立基线不刷新，有变更才重拉+广播；关掉偏好不发请求", async (t) => {
    const original = globalThis.BroadcastChannel;
    class MockChannel {
        onmessage: ((e: { data: unknown }) => void) | null = null;
        sent: unknown[] = [];
        constructor(readonly name: string) {
            channels.push(this);
        }
        postMessage(v: unknown) {
            this.sent.push(v);
        }
        close() {}
    }
    globalThis.BroadcastChannel = MockChannel as unknown as typeof BroadcastChannel;
    t.mock.timers.enable({ apis: ["setTimeout"] });

    try {
        const h = mountSync();
        const channel = channels.at(-1)!;

        // 首查（挂载后 5s 的第一次 tick）：since 为空 → 只建基线，不 reload、不广播
        t.mock.timers.tick(6_000);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        assert.deepEqual(h.sincStent, [undefined], "首次轮询不带 since");
        assert.equal(h.listCalls(), 1, "首查不触发整表重拉");
        assert.equal(
            channel.sent.some(m => (m as { type?: string }).type === "changed"),
            false,
            "首查不广播变更（心跳消息不算）"
        );
        assert.equal(localStorage.getItem(CURSOR_KEY)?.startsWith("2030-01-01"), true, "游标已落盘");

        // 服务端报了变更：下一轮必须 reload + 广播 + 提示
        h.setChanged(1);
        const before = h.listCalls();
        t.mock.timers.tick(31_000);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        // ⚠️ 第二轮的 since 必须是第一轮回的 now（:11，桩按调用序生成）——
        // 游标在第二轮结束时会推进到 ：12，所以不能拿「当前游标」当期望值
        assert.equal(h.sincStent.at(-1), "2030-01-01 00:00:11", "下一轮带上一轮返回的游标");
        assert.ok(h.listCalls() > before, "有变更必须走既有 reload()");
        assert.equal(
            channel.sent.filter(m => (m as { type?: string }).type === "changed").length,
            1,
            "重拉后广播一次给其它标签页"
        );
        assert.ok(
            h.notifications.some(m => m.includes("其他设备")),
            "要给用户一句「谁改的」级别的提示"
        );
        // 编辑器草稿保护：reload 是列表级操作，本地 notes 状态被服务端列表覆盖，但没有「替换草稿」路径

        // 关掉偏好：不再发请求
        localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled: false, intervalSec: 30 }));
        const sincCount = h.sincStent.length;
        t.mock.timers.tick(31_000);
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(h.sincStent.length, sincCount, "关掉偏好后不再轮询");
    } finally {
        t.mock.timers.reset();
        globalThis.BroadcastChannel = original;
        channels.length = 0;
    }
});

test("跨设备轮询：api 没有 notesChanges（老部署）时整个机制空转", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
        const h = mountSync({ withNotesChanges: false });
        t.mock.timers.tick(60_000);
        await act(async () => {
            await Promise.resolve();
        });
        assert.equal(h.listCalls(), 1, "只有首屏那一次 reload，轮询根本没启动");
    } finally {
        t.mock.timers.reset();
    }
});
