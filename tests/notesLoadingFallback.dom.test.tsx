// tests/notesLoadingFallback.dom.test.tsx
// 记事本骨架的「超时出口」：慢链路上 import() 永远 pending 时，用户不能只能干等。
//
// 这条守的是 v37.1.0 之后实测到的现象：/assets/note-editor-*.js（564KB）20 秒 0 字节，
// React.lazy 的 promise 既不 resolve 也不 reject，ChunkBoundary 的 getDerivedStateFromError
// 接不到任何东西，Suspense fallback 就永久停在 6 条灰条上。
//
// 出口与 ChunkBoundary 的错误面板同语义：清 Cache Storage → location.reload()，
// 而不是重挂子树（lazy 的 rejected/pending promise 缓存在组件对象上，重挂只会再等一次）。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesLoadingFallback from "../src/components/NotesLoadingFallback";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalLocation: Location | undefined;

function cleanup(): void {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
    if (originalLocation) {
        (globalThis as { location?: unknown }).location = originalLocation;
        originalLocation = undefined;
    }
    delete (globalThis as { caches?: unknown }).caches;
}

afterEach(cleanup);

function mount(node: React.ReactElement): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(node);
    });
}

/** jsdom 的 Location.reload 非 configurable，整体换掉 globalThis.location 才能计数 */
function stubReload(): number[] {
    const calls: number[] = [];
    const real = globalThis.location;
    originalLocation = real;
    (globalThis as { location?: unknown }).location = {
        href: real.href,
        search: real.search,
        pathname: real.pathname,
        reload: () => void calls.push(Date.now()),
    };
    return calls;
}

const byText = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent || "").trim() === text
    );

const skeletonLabel = (): string | null =>
    document.querySelector('[role="status"]')?.getAttribute("aria-label") ?? null;

test("未超时时就是骨架，不显示任何超时出口", async t => {
    t.after(cleanup);
    mount(<NotesLoadingFallback timeoutMs={200} />);
    assert.equal(skeletonLabel(), "记事本加载中");
    assert.equal(byText("刷新页面"), undefined, "正常加载期不该提前冒出刷新按钮");

    await act(async () => {
        await new Promise(r => setTimeout(r, 20));
    });
    assert.ok(
        !(document.body.textContent ?? "").includes("加载时间过长"),
        "还没到超时点，不能误报"
    );
});

test("骨架超时后给「加载时间过长」+「刷新页面」，点下去真的清缓存刷新", async t => {
    t.after(cleanup);
    const reloads = stubReload();
    const deleted: string[] = [];
    (globalThis as { caches?: unknown }).caches = {
        keys: async () => ["navihive-shell-v1", "navihive-stale-v0"],
        delete: async (key: string) => {
            if (key === "navihive-stale-v0") throw new Error("删不掉");
            deleted.push(key);
            return true;
        },
    };

    mount(<NotesLoadingFallback timeoutMs={20} />);
    await act(async () => {
        await new Promise(r => setTimeout(r, 60));
    });

    const text = document.body.textContent ?? "";
    assert.ok(text.includes("加载时间过长"), `超时后要给出口，实际：${text}`);
    assert.equal(skeletonLabel(), "记事本加载时间过长", "无障碍标签也要跟着变");
    const btn = byText("刷新页面");
    assert.ok(btn, "超时面板必须有「刷新页面」按钮");

    await act(async () => {
        btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.deepEqual(deleted, ["navihive-shell-v1"], "该清的缓存要清掉");
    assert.equal(
        reloads.length,
        1,
        "一条缓存删失败也必须照样刷新 —— 超时出口要真的能救回来，不能只改 state"
    );
});

test("Cache Storage 不可用时照样刷新，不把用户留在骨架上", async t => {
    t.after(cleanup);
    const reloads = stubReload();
    // caches 打不开（隐私模式 / 配额异常）：删掉全局替身，走兜底分支
    delete (globalThis as { caches?: unknown }).caches;

    mount(<NotesLoadingFallback timeoutMs={20} />);
    await act(async () => {
        await new Promise(r => setTimeout(r, 60));
    });
    await act(async () => {
        byText("刷新页面")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(reloads.length, 1, "没有 Cache Storage 也要刷新");
});
