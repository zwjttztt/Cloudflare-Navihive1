// tests/chunkBoundary.dom.test.tsx
// 懒加载块出错时那个「出口」按钮：它必须**真的能救回来**。
//
// 这条守的是一个「点了必然失败」的 bug（2026-10-29 修）：
//   ChunkBoundary 原来的 retry 只做 `setState({error:null, attempt+1})`，靠
//   `<Suspense key={attempt}>` 重挂子树。而 `React.lazy` 把 `import()` 的 promise
//   **缓存在组件对象上**：promise 一旦 reject 就永久停在那个状态，再次渲染只会把
//   同一个错误原样再抛一次，**永远不会重新发请求**。所以用户点一次、看到一模一样的
//   错误、再点一次，还是那个错误 —— 那个按钮从来没救过任何人。
//
// 现在的动作是「清 Cache Storage → location.reload()」，与 public/boot-guard.js 一致。
// 这里钉住的是「点下去真的会去 reload」，而不是「state 变了」。
//
// ⚠️ jsdom 里 location.reload 是真实存在的函数，但只会打印
//    "Not implemented: navigation"，所以必须先 stub 掉再断言调用次数。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ChunkBoundary from "../src/components/ChunkBoundary";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalLocation: Location | undefined;

/** 一个「渲染就抛」的组件，用来模拟 lazy chunk 取不到时的行为 */
function Explode(): never {
    throw Object.assign(new Error("Failed to fetch dynamically imported module: /assets/x.js"), {
        name: "ChunkLoadError",
    });
}

function cleanup() {
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

function mount(node: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(node);
    });
}

/**
 * 把 location.reload 换成计数桩。
 *
 * ⚠️ 不能 `Object.defineProperty(window.location, "reload", ...)`：jsdom 里
 * Location.reload 是**非 configurable** 的，重定义会直接抛
 * "Cannot redefine property: reload"。而组件里写的是裸的 `location.reload()`
 * —— 在 bundle 里它解析到 globalThis.location（runner 的 banner 把 jsdom 的
 * location 以可写值属性挂了上去），所以整个换掉 globalThis.location 即可。
 */
function stubReload() {
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

test("块取不到时显示错误面板，按钮写的是「刷新页面」", t => {
    t.after(cleanup);
    // React 会把被错误边界接住的异常打到 console.error；这里静音，免得刷屏掩盖真失败
    const originalError = console.error;
    console.error = () => { };
    try {
        mount(
            <ChunkBoundary>
                <Explode />
            </ChunkBoundary>
        );
    } finally {
        console.error = originalError;
    }

    const text = document.body.textContent ?? "";
    assert.ok(text.includes("这个功能没能加载出来"), `要给出解释，实际：${text}`);
    assert.ok(byText("刷新页面"), "按钮文案必须是「刷新页面」—— 它做的就是这个");
    assert.equal(byText("重试"), undefined, "不能再留一个叫「重试」的按钮（点了不会重新取代码）");
});

test("点那个按钮真的会 reload（清完缓存后），而不是只改 state", async t => {
    t.after(cleanup);
    const reloads = stubReload();

    const originalError = console.error;
    console.error = () => { };
    try {
        mount(
            <ChunkBoundary>
                <Explode />
            </ChunkBoundary>
        );
    } finally {
        console.error = originalError;
    }

    const btn = byText("刷新页面");
    assert.ok(btn, "错误面板上应有「刷新页面」");
    await act(async () => {
        btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        // clearCachesAndReload 里 caches 不存在（jsdom），会直接走到 reload
        await Promise.resolve();
        await Promise.resolve();
    });

    assert.equal(reloads.length, 1, "点一下必须真的刷新页面 —— 不然它救不回任何东西");
});

test("Cache Storage 存在时：先清掉再 reload（旧外壳是这类失败最常见的原因）", async t => {
    t.after(cleanup);
    const reloads = stubReload();
    const deleted: string[] = [];
    // 造一个最小可用的 caches 替身：两条缓存，其中一条删除会失败
    (globalThis as { caches?: unknown }).caches = {
        keys: async () => ["navihive-shell-v1", "navihive-stale-v0"],
        delete: async (key: string) => {
            if (key === "navihive-stale-v0") throw new Error("删不掉");
            deleted.push(key);
            return true;
        },
    };

    const originalError = console.error;
    console.error = () => { };
    try {
        mount(
            <ChunkBoundary>
                <Explode />
            </ChunkBoundary>
        );
    } finally {
        console.error = originalError;
    }

    await act(async () => {
        byText("刷新页面")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise(r => setTimeout(r, 10));
    });

    assert.deepEqual(deleted, ["navihive-shell-v1"], "该清的缓存要清掉");
    assert.equal(
        reloads.length,
        1,
        "一条缓存删失败也必须照样刷新 —— 不能因为清理出错把用户卡在错误面板上"
    );
});
