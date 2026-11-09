// tests/lazyWarm.test.ts
// v37.3.0 笔记懒块字节预热：pure 单测。
//
// 这里刻意用 **value import**（不是 import type）：script/coverage.mjs 第 1 层要求
// src/utils 层文件触及率 100%，只有值导入才会让 esbuild 把 lazyWarm.ts 计入 metafile；
// 第 2 层 src/utils 行/函数覆盖地板 90，所以下面每个导出函数都真调用、真断言，不是空 import。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pickWarmUrls, shouldSkipWarm, startLazyWarm } from "../src/utils/lazyWarm";

// ---- 全局替身：startLazyWarm 会读 globalThis 上的 window/navigator/fetch ----
// startLazyWarm 带模块级幂等标志，替身必须在 afterEach 还原，绝不污染其它用例。
const GLOBAL_KEYS = ["window", "navigator", "document", "fetch", "requestIdleCallback"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const k of GLOBAL_KEYS) saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));

function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

afterEach(() => {
    for (const k of GLOBAL_KEYS) {
        const desc = saved.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete (globalThis as unknown as Record<string, unknown>)[k];
    }
});

/** 把若干轮微任务 + 一次定时器都排干净，让 idle 回调里的 async 链走完 */
async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
        await new Promise<void>(r => setTimeout(r, 0));
    }
}

/** 对照 dist/client/precache-manifest.json 的真实笔记相关 lazy 条目 */
const NOTE_URLS = [
    "/assets/Notes-CVg5x3z9.js",
    "/assets/NotesOverlay-sMq1F-7T.js",
    "/assets/NotesLoadingFallback-DycN8DMJ.js",
    "/assets/PublicNotePage-dmiwlDPa.js",
    "/assets/SiteNoteDialog-CluuSUvc.js",
    "/assets/katex-CoonBF1E.js",
    "/assets/markdown-DKEETBHE.js",
    "/assets/markdownToReact-BWeZdRfh.js",
    "/assets/note-editor-BUK3vTEr.js",
];

/** 明确排除的沙箱 / 图表块 */
const DENY_URLS = [
    "/assets/mermaidSandbox-CX2J_vyI.js",
    "/assets/elk-IJKZMXRS-B1KoEkEf.js",
    "/assets/mermaid-parser.core-B4AoK-PE.js",
];

test("pickWarmUrls：只留笔记白名单、去重、排除沙箱/图表、丢弃非法 URL", () => {
    const input = [
        ...NOTE_URLS,
        NOTE_URLS[0], // 重复项应被去重
        ...DENY_URLS,
        "https://evil.com/assets/Notes-abcdef12.js", // 外域
        "/api/notes-abcdef12.js", // /api/
        "/assets/Notes-abc.js", // 无 8 位 hash
        42, // 非字符串
    ] as unknown as string[];
    assert.deepEqual(pickWarmUrls(input), NOTE_URLS, "顺序保留、去重、9 条笔记块全中");
});

test("pickWarmUrls：白名单条目逐条命中，明确排除的三类一条都不进", () => {
    assert.deepEqual(pickWarmUrls(NOTE_URLS), NOTE_URLS);
    assert.deepEqual(pickWarmUrls(DENY_URLS), [], "mermaidSandbox/elk/mermaid-parser.core 必须被排除");
    assert.deepEqual(
        pickWarmUrls([...DENY_URLS, NOTE_URLS[0]]),
        [NOTE_URLS[0]],
        "排除项混在笔记项里也只留笔记项"
    );
});

test("pickWarmUrls：非法 URL（外域、/api/、无 hash、坏扩展名、query、非字符串）全被丢", () => {
    const illegal = [
        "https://cdn.example.com/assets/Notes-abcdef12.js", // 外域
        "//evil.com/assets/Notes-abcdef12.js", // 协议相对
        "/api/notes-abcdef12.js", // /api/
        "/assets/Notes-abc.js", // hash 不足 8 位
        "/assets/Notes-abcdef12.txt", // 扩展名不在 js/css
        "/assets/Notes-abcdef12.js?x=1", // 带 query
        "Notes-abcdef12.js", // 缺 /assets/ 前缀
        "/assets/Notes-abcdef12.css", // 这条合法（白名单允许 css），不该被这条断言覆盖
    ];
    // 上面最后一条是合法 css，单独验它确实能进
    assert.deepEqual(pickWarmUrls(illegal.slice(0, 7) as string[]), []);
    assert.deepEqual(pickWarmUrls(["/assets/Notes-abcdef12.css"]), ["/assets/Notes-abcdef12.css"]);

    const withNonStrings = [1, null, undefined, {}, true, "/assets/Notes-CVg5x3z9.js"] as unknown as string[];
    assert.deepEqual(
        pickWarmUrls(withNonStrings),
        ["/assets/Notes-CVg5x3z9.js"],
        "非字符串项静默丢弃，合法项照留"
    );
});

test("pickWarmUrls：去重后最多 24 条、空数组返回空数组", () => {
    assert.deepEqual(
        pickWarmUrls(["/assets/Notes-CVg5x3z9.js", "/assets/Notes-CVg5x3z9.js"]),
        ["/assets/Notes-CVg5x3z9.js"],
        "同一 URL 只留一条"
    );
    const many: string[] = [];
    for (let i = 0; i < 30; i++) many.push(`/assets/Notes-${String(i).padStart(8, "0")}.js`);
    const capped = pickWarmUrls(many);
    assert.equal(capped.length, 24, "最多取 24 条");
    assert.equal(new Set(capped).size, 24, "截断后仍是去重后的 24 条");
    assert.deepEqual(pickWarmUrls([]), []);
    assert.deepEqual(pickWarmUrls("not-an-array" as unknown as string[]), [], "非数组输入也安全返回空");
});

test("pickWarmUrls：合法但不属于笔记白名单的普通懒块也不预热", () => {
    const others = [
        "/assets/SiteCard-abcdef12.js",
        "/assets/ConfigPanel-abcdef12.js",
        "/assets/vendor-Dq_V4i-z.js",
    ];
    assert.deepEqual(pickWarmUrls(others), [], "普通懒块不该为笔记预热");
    assert.deepEqual(
        pickWarmUrls([...others, ...NOTE_URLS]),
        NOTE_URLS,
        "混入普通懒块时只留笔记块"
    );
});

test("shouldSkipWarm：守卫矩阵（离线 / 省流量 / 慢网）", () => {
    assert.equal(shouldSkipWarm(), false, "无参数视为不跳过");
    assert.equal(shouldSkipWarm({}), false);
    assert.equal(shouldSkipWarm({ onLine: true }), false);
    assert.equal(shouldSkipWarm({ onLine: false }), true);
    assert.equal(shouldSkipWarm({ saveData: false }), false);
    assert.equal(shouldSkipWarm({ saveData: true }), true);
    assert.equal(shouldSkipWarm({ effectiveType: "4g" }), false);
    assert.equal(shouldSkipWarm({ effectiveType: "3g" }), false);
    assert.equal(shouldSkipWarm({ effectiveType: "2g" }), true);
    assert.equal(shouldSkipWarm({ effectiveType: "slow-2g" }), true);
    assert.equal(shouldSkipWarm({ onLine: true, saveData: false, effectiveType: "4g" }), false);
    assert.equal(shouldSkipWarm({ onLine: false, saveData: false, effectiveType: "4g" }), true);
    assert.equal(shouldSkipWarm({ onLine: true, saveData: true, effectiveType: "4g" }), true);
    assert.equal(shouldSkipWarm({ onLine: true, saveData: false, effectiveType: "slow-2g" }), true);
});

test("startLazyWarm：幂等 + 守卫命中不发消息 + 空闲回调端到端发 warm-lazy", async () => {
    let idleCb: (() => void) | null = null;
    let idleRegistrations = 0;
    const fetchCalls: string[] = [];
    const postMessages: unknown[] = [];

    const manifest = {
        version: "test",
        lazy: [
            "/assets/Notes-CVg5x3z9.js",
            "/assets/note-editor-BUK3vTEr.js",
            "/assets/mermaidSandbox-CX2J_vyI.js", // 应被 pickWarmUrls 排除
            "https://evil.com/assets/x-abcdef12.js", // 外域，应被排除
        ],
    };

    // 可控替身：window / navigator / document / fetch 全部挂到 globalThis 上
    const nav = {
        onLine: true,
        connection: { saveData: false, effectiveType: "4g" },
        serviceWorker: {
            ready: Promise.resolve({
                active: { postMessage: (m: unknown) => postMessages.push(m) },
            }),
        },
    };
    setGlobal("window", {
        requestIdleCallback: (cb: () => void) => {
            idleRegistrations++;
            idleCb = cb;
            return 1;
        },
    });
    setGlobal("navigator", nav);
    setGlobal("document", {});
    setGlobal("fetch", async (url: string) => {
        fetchCalls.push(url);
        return { json: async () => manifest };
    });

    // ① 幂等：模块级标志，连续调用只登记一个 idle 回调
    startLazyWarm();
    startLazyWarm();
    startLazyWarm();
    assert.equal(idleRegistrations, 1, "重复调用只调度一次");
    assert.ok(idleCb, "必须真的登记了一个 idle 回调");
    const fire = idleCb as () => void;

    // ② 守卫命中：saveData=true 时触发 idle 回调 → 不读 manifest、不发消息。
    //    这里手动触发「同一个」被登记的 idle 回调（requestIdleCallback 在真实浏览器里
    //    只触发一次；为了在一条用例里同时钉住守卫与成功两条路径，改由用例控制触发时机）。
    nav.connection.saveData = true;
    fire();
    await flush();
    assert.equal(postMessages.length, 0, "守卫命中时不发 warm-lazy 消息");
    assert.equal(fetchCalls.length, 0, "守卫命中时连 manifest 都不该读");

    // ③ 端到端成功：恢复 guard-pass，再触发同一 idle 回调
    nav.connection.saveData = false;
    fire();
    await flush();
    assert.equal(fetchCalls.length, 1, "应读取一次 precache-manifest.json");
    assert.equal(fetchCalls[0], "/precache-manifest.json", "默认缓存策略读 manifest（无 init 选项）");
    assert.equal(postMessages.length, 1, "应发一条 warm-lazy 消息");
    const msg = postMessages[0] as { type: string; urls: string[]; version: unknown };
    assert.equal(msg.type, "warm-lazy");
    assert.equal(msg.version, "test");
    assert.deepEqual(
        msg.urls,
        ["/assets/Notes-CVg5x3z9.js", "/assets/note-editor-BUK3vTEr.js"],
        "urls 形状正确：只含笔记白名单条目，排除沙箱与外域"
    );
});
