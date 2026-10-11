// tests/usePrefSync.dom.test.tsx
// 本机偏好「上传」那一半的四条硬规矩。
//
// 为什么补它：这个 hook 全是**失败也不出声**的逻辑 ——
// 上传失败一律静默（同步是锦上添花，不能干扰正常使用）。规矩写反了不会报错：
//   - 内容没变也每次都写库 → 打开同步开关的瞬间刚合并回来又原样推一遍，白白多两次请求；
//   - 访问统计在 setConfig **失败**时也记基线 → 这几次访问永远补不回服务端，热度悄悄少一块；
//   - 开关关着还在推 → 用户明确关掉的同步在后台继续跑。
// 这些都是「数据慢慢变得不对」而不是「页面报错」，只有这里能钉住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useRef, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePrefSync, type PrefSyncOptions } from "../src/hooks/usePrefSync";
import { emitPrefsChange } from "../src/context/uiPrefsStore";
import { markLinkAlive } from "../src/utils/linkHealth";
import {
    LINK_HEALTH_CONFIG,
    PREF_COLLAPSED_CONFIG,
    PREF_STARRED_CONFIG,
    PREF_TAGS_CONFIG,
    PREF_VISITS_CONFIG,
} from "../src/appDefaults";

// ---------------- 假 api ----------------
type Call = { key: string; value: string };

function makeApi(behavior?: (key: string) => Promise<void>) {
    const calls: Call[] = [];
    return {
        calls,
        api: {
            setConfig: (key: string, value: string) => {
                calls.push({ key, value });
                return (behavior ? behavior(key) : Promise.resolve()).then(() => true);
            },
        },
    };
}

// ---------------- 防抖：把 setTimeout 换成手动触发 ----------------
// 真实防抖是 1500ms（SYNC_DEBOUNCE_MS），用例里真等 1.5 秒既慢又脆。
// 换成「先记下、手动放行」，顺便能验证「防抖确实生效」（不放行就一个都不该发出去）。
let scheduled: Array<() => void> = [];
const realSetTimeout = window.setTimeout;
const realClearTimeout = window.clearTimeout;

function installTimers() {
    scheduled = [];
    (window as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void) => {
        scheduled.push(fn);
        return 0;
    };
    (window as unknown as { clearTimeout: unknown }).clearTimeout = () => {};
}

function restoreTimers() {
    (window as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (window as unknown as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
}

async function flushTimers() {
    const fns = scheduled;
    scheduled = [];
    for (const fn of fns) fn();
    await act(async () => {
        await Promise.resolve();
    });
}

// ---------------- 挂载 ----------------
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let lastPrefPushRef: MutableRefObject<string> = { current: "" };
let lastHealthPushRef: MutableRefObject<string> = { current: "" };

function render(opts: {
    api: Pick<PrefSyncOptions["api"], "setConfig">;
    prefSync?: boolean;
    linkHealthSync?: boolean;
    starred?: number[];
    tags?: Record<string, string[]>;
    visits?: Record<string, { count: number; last: number }>;
    collapsedIds?: string[];
    onVisitsSynced?: () => void;
}) {
    function Harness() {
        lastPrefPushRef = useRef("");
        lastHealthPushRef = useRef("");
        usePrefSync({
            api: opts.api,
            lastHealthPushRef,
            lastPrefPushRef,
            linkHealthSync: opts.linkHealthSync ?? false,
            prefSync: opts.prefSync ?? false,
            starred: opts.starred ?? [],
            tags: opts.tags ?? {},
            visits: opts.visits ?? {},
            onVisitsSynced: opts.onVisitsSynced ?? (() => {}),
            collapsedIds: opts.collapsedIds ?? [],
        });
        return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 换个 props 重新挂一整套（先卸载旧的：留着两份会各推一遍，读数就不准了） */
function remount(opts: Parameters<typeof render>[0]) {
    cleanup();
    render(opts);
}

const keysOf = (calls: Call[]) => calls.map(c => c.key);
/** 某一个配置项被写了几次（四路各自独立，断言要只看自己那一路） */
const countOf = (calls: Call[], key: string) => calls.filter(c => c.key === key).length;

test("同步开关关着：一次都不写库（用户关掉的东西不该在后台继续跑）", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi();
    render({ api, prefSync: false, linkHealthSync: false, visits: { a: { count: 1, last: 1 } } });
    await flushTimers();
    await act(async () => {
        emitPrefsChange();
        await Promise.resolve();
    });
    await flushTimers();
    assert.deepEqual(calls, []);
});

test("防抖：连着改十次星标，只合并成一次请求", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi();
    render({ api, prefSync: true, starred: [1], tags: {} });

    for (let i = 0; i < 10; i++) {
        await act(async () => {
            emitPrefsChange();
            await Promise.resolve();
        });
    }
    assert.equal(
        countOf(calls, PREF_STARRED_CONFIG),
        0,
        "防抖窗口内一个都不该发出去"
    );
    await flushTimers();
    // 十次改动只合并成一次：星标与标签各写一次
    assert.equal(countOf(calls, PREF_STARRED_CONFIG), 1, "十次改动应只写一次星标");
    assert.equal(countOf(calls, PREF_TAGS_CONFIG), 1);
});

test("内容没变就不写库：刚从服务端合并回来的那一轮不该立刻再推一次", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi();
    const starred = [7, 8];
    render({ api, prefSync: true, starred, tags: {} });
    // 模拟「刚合并回来」：缓存里已经是这份内容
    lastPrefPushRef.current = JSON.stringify({ starred, tags: {} });

    await act(async () => {
        emitPrefsChange();
        await Promise.resolve();
    });
    await flushTimers();
    assert.equal(countOf(calls, PREF_STARRED_CONFIG), 0, "内容完全一致时不该再写库");
});

test("访问统计：写库成功才记基线，失败时不能记（记了这几次访问就永远补不回去）", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    let synced = 0;
    const { api, calls } = makeApi(key =>
        key === PREF_VISITS_CONFIG
            ? Promise.reject(new Error("网络不通"))
            : Promise.resolve()
    );
    render({
        api,
        prefSync: true,
        visits: { "https://a.example": { count: 3, last: 100 } },
        onVisitsSynced: () => {
            synced += 1;
        },
    });
    await flushTimers();
    assert.equal(countOf(calls, PREF_VISITS_CONFIG), 1, "访问统计这一路要真的发出去");
    assert.equal(synced, 0, "写库失败时不该记基线——记了这几条访问就再也不会重发");

    // 换成能写成功的 api：这一轮才该记基线
    const ok = makeApi();
    remount({
        api: ok.api,
        prefSync: true,
        visits: { "https://a.example": { count: 3, last: 100 } },
        onVisitsSynced: () => {
            synced += 1;
        },
    });
    await flushTimers();
    assert.equal(countOf(ok.calls, PREF_VISITS_CONFIG), 1);
    assert.equal(synced, 1, "成功后才记基线");
});

test("上传失败要静默：不能把同步的网络问题抛给用户", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi(() => Promise.reject(new Error("500")));
    // 只要这里不抛异常就是对的（hook 内部 .catch(() => {})）
    render({
        api,
        prefSync: true,
        visits: { a: { count: 1, last: 1 } },
        collapsedIds: ["g1"],
    });
    await act(async () => {
        emitPrefsChange();
        await Promise.resolve();
    });
    await flushTimers();
    assert.ok(calls.length >= 1, "至少一次上传真的尝试过（失败路径被走到，不是静默跳过）");
    assert.equal(calls.filter(c => c.value === "").length, 0, "失败后不应把本机偏好清空（宁可留着下次再传）");
});

test("分组折叠：按开关上传，且内容不变不重复写", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi();
    render({ api, prefSync: true, collapsedIds: ["g1", "g2"] });
    await flushTimers();
    const collapsed = calls.filter(c => c.key === PREF_COLLAPSED_CONFIG);
    assert.equal(collapsed.length, 1, "折叠态应上传一次");
    assert.deepEqual(JSON.parse(collapsed[0]!.value), ["g1", "g2"]);

    // 换一组折叠：应当再推一次
    remount({ api, prefSync: true, collapsedIds: ["g1"] });
    await flushTimers();
    assert.equal(countOf(calls, PREF_COLLAPSED_CONFIG), 2, "折叠内容变了应再推一次");
    assert.deepEqual(
        JSON.parse(calls.filter(c => c.key === PREF_COLLAPSED_CONFIG).at(-1)!.value),
        ["g1"]
    );
});

test("失效检测：开关开了才推，且走它自己的配置项", async t => {
    t.after(() => {
        restoreTimers();
        cleanup();
    });
    installTimers();
    const { api, calls } = makeApi();
    render({ api, linkHealthSync: true });
    await act(async () => {
        markLinkAlive("https://a.example");
        await Promise.resolve();
    });
    await flushTimers();
    assert.ok(
        keysOf(calls).includes(LINK_HEALTH_CONFIG),
        `失效检测结果应写到 ${LINK_HEALTH_CONFIG}，实际 ${JSON.stringify(keysOf(calls))}`
    );
});
