// tests/iconBatch.test.ts
// 批量取图标这条链路（src/utils/iconBatch.ts）。
//
// 守的是两件容易悄悄坏掉的事：
// 1. **key 必须对齐**：批量接口按**原始地址**回图标，卡片按**代理地址**读缓存。
//    两边对不上，批量取回来的那份卡片永远命中不了 —— 请求数一个没少，流量还翻倍。
// 2. **卡片要等这一批**：只是「后台预热」不够，卡片自己那次请求会先发出去，
//    同一批图标被下两遍。所以这里测「在途时卡片能等到」。
//
// 失败一律退化成老行为（卡片照常自己请求），这条也要钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    putIconBlob,
    proxied,
    readIconObjectUrl,
    releaseIconObjectUrl,
    setIconObjectUrlFactoryForTest,
    unproxied,
} from "../src/utils/iconCache";
import {
    awaitWarmup,
    pendingWarmup,
    queueIconWarmup,
    resetIconBatchForTest,
    warmIcons,
} from "../src/utils/iconBatch";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** objectURL 的创建换成计数器：node 里没有真的 Blob URL */
function installObjectUrlSpy(): { created: string[] } {
    const created: string[] = [];
    let seq = 0;
    setIconObjectUrlFactoryForTest(() => {
        const url = `blob:test/${++seq}`;
        created.push(url);
        return url;
    });
    return { created };
}

/**
 * 打桩：/api/icons 返回固定结果，data: URL 按真实语义转成 blob
 * （批量接口回的就是 data URL，前端那一步 fetch(dataUrl) 必须真的能拿到字节）。
 */
function stubFetch(handler: (url: string) => Response | null) {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("data:")) {
            const [head, b64] = url.split(",");
            const type = head.slice("data:".length).split(";")[0];
            const bytes = Buffer.from(b64, "base64");
            return new Response(bytes, { status: 200, headers: { "content-type": type } });
        }
        return handler(url) ?? new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

const PNG_1PX =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("代理地址与原始地址能互相换算（key 对齐的前提）", () => {
    const raw = "https://cdn.example/favicon.ico";
    const proxy = proxied(raw);
    assert.match(proxy, /^\/api\/icon\?u=/, "跨域地址要走代理");
    assert.equal(unproxied(proxy), raw, "代理地址必须能还原成原始地址");
    // 用户填的相对路径不需要代理，unproxied 返回 null（不该进批量请求）
    assert.equal(unproxied("/icons/custom.png"), null);
    assert.equal(unproxied(""), null);
});

test("批量取回来的图标，卡片按代理地址能读到（key 对齐）", async () => {
    resetIconBatchForTest();
    installObjectUrlSpy();
    const raw = "https://cdn.example/favicon.ico";
    const proxy = proxied(raw);
    const stub = stubFetch(url =>
        url.startsWith("/api/icons")
            ? Response.json({ icons: { [raw]: PNG_1PX }, failed: {} })
            : null
    );
    try {
        await warmIcons([proxy]);
        const cached = await readIconObjectUrl(proxy);
        assert.ok(cached, "批量取回来之后，卡片读代理地址应当命中");
        releaseIconObjectUrl(proxy);
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("只需要代理的才进批量请求（同源地址不浪费一个名额）", async () => {
    resetIconBatchForTest();
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? Response.json({ icons: {}, failed: {} }) : null
    );
    try {
        // 传的是**卡片实际会用的地址**（iconCandidates 的结果）：
        // 相对路径不走代理 → 不进批量；跨域地址已被 proxied → 进批量
        await warmIcons(["/icons/local.png", proxied("https://x.example/a.png")]);
        const batch = stub.calls.filter(u => u.startsWith("/api/icons"));
        assert.equal(batch.length, 1, "一次批量就够");
        assert.match(batch[0], /u=https%3A%2F%2Fx\.example%2Fa\.png/, "只带需要代理的那条");
        assert.ok(!batch[0].includes("local.png"), "同源地址不该塞进批量请求");
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("一批超过 30 条会拆成多次请求（与服务端 MAX_BATCH 对齐）", async () => {
    resetIconBatchForTest();
    const urls = Array.from({ length: 65 }, (_, i) => proxied(`https://x.example/${i}.png`));
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? Response.json({ icons: {}, failed: {} }) : null
    );
    try {
        await warmIcons(urls);
        const batch = stub.calls.filter(u => u.startsWith("/api/icons"));
        assert.equal(batch.length, 3, "65 条应当拆成 30 + 30 + 5 三次");
        for (const call of batch) {
            const count = new URLSearchParams(call.split("?")[1]).getAll("u").length;
            assert.ok(count <= 30, `单次不能超过 30 条，这次是 ${count} 条`);
        }
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("卡片在批量进行中时能等到（不是在途就立刻返回）", async () => {
    resetIconBatchForTest();
    installObjectUrlSpy();
    const raw = "https://slow.example/favicon.ico";
    const proxy = proxied(raw);
    // 默认给个空函数：写成 `| null` 的话 TS 会把调用点收窄成 never（赋值在回调里，
    // 控制流分析认为它到不了那儿），测试就编不过。
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const stub = stubFetch(url => {
        if (!url.startsWith("/api/icons")) return null;
        return null; // 占位，真正的响应在下面用 gate 控制
    });
    // 换成「先卡住再返回」的 fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("data:")) {
            const [head, b64] = url.split(",");
            const type = head.slice("data:".length).split(";")[0];
            return new Response(Buffer.from(b64, "base64"), {
                status: 200,
                headers: { "content-type": type },
            });
        }
        await gate;
        return Response.json({ icons: { [raw]: PNG_1PX }, failed: {} });
    }) as typeof fetch;

    try {
        assert.equal(pendingWarmup(proxy), null, "还没开始就不该有在途");
        const batchDone = warmIcons([proxy]);
        // warmIcons 内部是先注册在途再发请求，等一个微任务让注册生效
        await Promise.resolve();
        assert.ok(pendingWarmup(proxy), "批量在途时，卡片应当能拿到这个 promise");
        release();
        await batchDone;
        await awaitWarmup(proxy); // 已经结束：立刻返回，不卡住
        const cached = await readIconObjectUrl(proxy);
        assert.ok(cached, "批量完成后卡片应当命中缓存");
        releaseIconObjectUrl(proxy);
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("批量请求失败：不抛异常，卡片拿不到缓存也不受影响", async () => {
    resetIconBatchForTest();
    const proxy = proxied("https://down.example/favicon.ico");
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? new Response("boom", { status: 500 }) : null
    );
    try {
        // 不该抛：批量只是加速手段，挂了要退化成卡片各自请求
        await warmIcons([proxy]);
        await awaitWarmup(proxy);
        const cached = await readIconObjectUrl(proxy);
        assert.equal(cached, null, "没取到就是没缓存，卡片继续走自己的路");
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("解 data URL 不能走 fetch —— 站点 CSP 的 connect-src 不含 data:", async () => {
    // 这是 2026-10-13 实测出来的真 bug：批量接口 200、图标一张没进缓存，
    // 而失败是**静默**的（控制台一条 Failed to fetch），外面看只像「批量没生效」，
    // 卡片照常各发各的，请求数一点没少。
    resetIconBatchForTest();
    installObjectUrlSpy();
    const raw = "https://cdn.example/csp.ico";
    const proxy = proxied(raw);
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        // 模拟 CSP 拦截：data: 不在 connect-src 白名单里
        if (url.startsWith("data:")) throw new TypeError("Failed to fetch");
        if (url.startsWith("/api/icons")) return Response.json({ icons: { [raw]: PNG_1PX }, failed: {} });
        return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
        await warmIcons([proxy]);
        const cached = await readIconObjectUrl(proxy);
        assert.ok(cached, "就算 fetch(data:) 被 CSP 拒掉，批量取回来的图标也要进缓存");
        releaseIconObjectUrl(proxy);
    } finally {
        globalThis.fetch = original;
        resetIconBatchForTest();
    }
});

test("静态守卫：iconBatch 里不许出现 fetch(dataUrl)", () => {
    const src = readFileSync(resolve(findProjectDir(), "src", "utils", "iconBatch.ts"), "utf8");
    assert.ok(
        !/fetch\(\s*dataUrl/.test(src),
        "data URL 必须用 atob 解 —— fetch(data:) 会被本站 CSP 的 connect-src 拦掉"
    );
    assert.ok(/atob\(/.test(src), "应当直接用 atob 解 base64");
});

test("渲染期登记：调用完**立刻**就能查到在途（卡片首帧据此把 src 留空）", async () => {
    resetIconBatchForTest();
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? Response.json({ icons: {}, failed: {} }) : null
    );
    try {
        const proxy = proxied("https://x.example/frame.png");
        queueIconWarmup([proxy]);
        // ⚠️ 不能 await：卡片在**渲染期**同步查的就是这一刻。
        // 等到微任务才生效的话，<img> 的 src 已经定下来、请求已经发出去了。
        assert.ok(pendingWarmup(proxy), "登记必须在渲染期同步生效");
        assert.equal(
            stub.calls.filter(u => u.startsWith("/api/icons")).length,
            0,
            "登记阶段不发请求，等这一帧攒齐再发"
        );
        await new Promise(r => setTimeout(r, 20));
        assert.equal(pendingWarmup(proxy), null, "批次结束后要摘掉在途，卡片才会放行");
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("同一帧里每张卡片各登记一次，只发**一个**批量请求", async () => {
    resetIconBatchForTest();
    const urls = [1, 2, 3, 4, 5].map(i => proxied(`https://x.example/${i}.png`));
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? Response.json({ icons: {}, failed: {} }) : null
    );
    try {
        for (const u of urls) queueIconWarmup([u]); // 模拟 5 张卡片各自登记
        queueIconWarmup(urls); // App 那一次登记的也是这些地址，应全部跳过
        await new Promise(r => setTimeout(r, 20));
        const batch = stub.calls.filter(u => u.startsWith("/api/icons"));
        assert.equal(batch.length, 1, "一帧内所有候选合成一个请求");
        assert.equal(
            new URLSearchParams(batch[0].split("?")[1]).getAll("u").length,
            5,
            "5 条候选都在这一批里"
        );
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("批量失败也要摘掉在途 —— 否则 src 一直留空、图标永远不出来", async () => {
    resetIconBatchForTest();
    const proxy = proxied("https://boom.example/f.ico");
    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? new Response("boom", { status: 500 }) : null
    );
    try {
        queueIconWarmup([proxy]);
        assert.ok(pendingWarmup(proxy), "登记后在途");
        await awaitWarmup(proxy);
        assert.equal(pendingWarmup(proxy), null, "失败也要放行：卡片照常自己发请求");
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});

test("已经缓存过的图标不会被覆盖（objectURL 有引用数，换掉会让卡片卡住）", async () => {
    resetIconBatchForTest();
    const spy = installObjectUrlSpy();
    const raw = "https://cdn.example/second.ico";
    const proxy = proxied(raw);
    // 先手动存一份，占住 key
    const first = new Response(Buffer.from("first"), {
        status: 200,
        headers: { "content-type": "image/png" },
    });
    await putIconBlob(proxy, await first.blob());
    assert.equal(spy.created.length, 1);

    const stub = stubFetch(url =>
        url.startsWith("/api/icons") ? Response.json({ icons: { [raw]: PNG_1PX }, failed: {} }) : null
    );
    try {
        await warmIcons([proxy]);
        assert.equal(spy.created.length, 1, "已有的一份不该被批量结果换掉");
    } finally {
        stub.restore();
        resetIconBatchForTest();
    }
});
