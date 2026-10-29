// tests/bootGuard.test.ts
// 首屏兜底（public/boot-guard.js）的行为守卫。
//
// 为什么值得单测：这段脚本只在「主 bundle 根本没跑起来」时才有机会执行 —— 那是
// 所有常规测试都覆盖不到的现场（React 都没挂载）。它的两个失败方向都很糟：
//   · 该救没救 → 用户永久停在死骨架（2026-10-29 线上就是这样）；
//   · 救过头   → 服务器真挂了时无限刷新，用户连报错都看不到。
// 所以这里用 vm 把它放进假 DOM 里跑，逐条钉住「什么时候刷、什么时候不刷」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
// 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const GUARD_SRC = readProjectFile("public/boot-guard.js");

type Harness = {
    /** 触发 15 秒那个判定（脚本里唯一的 setTimeout(…, 15000)） */
    fireTimeout: () => Promise<void>;
    reloads: number;
    deletedCaches: string[];
    unregistered: number;
    retryFlag: () => string | null;
};

type HarnessOptions = {
    /** true = 骨架还在（React 没挂载） */
    skeletonAlive: boolean;
    /** 已经救过一次（sessionStorage 里有记号） */
    alreadyRetried?: boolean;
    /** sessionStorage 直接抛异常（隐私模式） */
    storageThrows?: boolean;
    /** 地址栏里带 boot-retry=1（storage 不可用时的兜底判据） */
    urlRetried?: boolean;
    /** caches.keys() 抛异常 */
    cachesThrows?: boolean;
    /** 没有 Service Worker API */
    noServiceWorker?: boolean;
};

/** 把 boot-guard.js 丢进假环境跑一遍，返回观测句柄 */
function runGuard(options: HarnessOptions): Harness {
    const timers: { fn: () => void; ms: number }[] = [];
    const store = new Map<string, string>();
    let reloads = 0;
    const deletedCaches: string[] = [];
    let unregistered = 0;

    if (options.alreadyRetried) store.set("navihive:boot-guard", "1");

    const sessionStorage = {
        getItem(key: string): string | null {
            if (options.storageThrows) throw new Error("storage disabled");
            return store.has(key) ? (store.get(key) as string) : null;
        },
        setItem(key: string, value: string): void {
            if (options.storageThrows) throw new Error("storage disabled");
            store.set(key, value);
        },
        removeItem(key: string): void {
            if (options.storageThrows) throw new Error("storage disabled");
            store.delete(key);
        },
    };

    const caches = {
        keys(): Promise<string[]> {
            if (options.cachesThrows) throw new Error("caches broken");
            return Promise.resolve(["navihive-v1", "navihive-v2"]);
        },
        delete(key: string): Promise<boolean> {
            deletedCaches.push(key);
            return Promise.resolve(true);
        },
    };

    const sandbox = {
        document: {
            getElementById(id: string) {
                return options.skeletonAlive && id === "boot-skeleton" ? { id } : null;
            },
        },
        location: {
            search: options.urlRetried ? "?boot-retry=1" : "",
            reload() {
                reloads += 1;
            },
        },
        navigator: options.noServiceWorker
            ? {}
            : {
                  serviceWorker: {
                      getRegistrations() {
                          return Promise.resolve([
                              {
                                  unregister() {
                                      unregistered += 1;
                                      return Promise.resolve(true);
                                  },
                              },
                          ]);
                      },
                  },
              },
        window: { caches },
        sessionStorage,
        setTimeout(fn: () => void, ms: number) {
            timers.push({ fn, ms });
            return timers.length;
        },
        Promise,
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(GUARD_SRC, sandbox, { filename: "public/boot-guard.js" });

    return {
        async fireTimeout() {
            const timer = timers.find(t => t.ms >= 10000);
            assert.ok(timer, "脚本应当注册一个约 15 秒的判定定时器");
            timer.fn();
            // 放行 Promise 链（清缓存 → 注销 → reload）
            for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
        },
        get reloads() {
            return reloads;
        },
        deletedCaches,
        get unregistered() {
            return unregistered;
        },
        retryFlag: () => (store.has("navihive:boot-guard") ? "1" : null),
    } as Harness;
}

test("骨架还在且没救过：清缓存 + 注销 SW + 只刷新一次", async () => {
    const h = runGuard({ skeletonAlive: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 1);
    assert.deepEqual(h.deletedCaches, ["navihive-v1", "navihive-v2"]);
    assert.equal(h.unregistered, 1);
    assert.equal(h.retryFlag(), "1", "救过一次要留记号");
});

test("同一会话已经救过：不再刷新（避免服务器真挂时无限循环）", async () => {
    const h = runGuard({ skeletonAlive: true, alreadyRetried: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 0);
    assert.deepEqual(h.deletedCaches, []);
});

test("URL 带 boot-retry=1 也算救过：storage 不可用时仍然不会循环", async () => {
    const h = runGuard({ skeletonAlive: true, storageThrows: true, urlRetried: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 0);
});

test("已经挂载成功（骨架被移除）：不动缓存、不刷新，并清掉记号", async () => {
    const h = runGuard({ skeletonAlive: false, alreadyRetried: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 0);
    assert.deepEqual(h.deletedCaches, []);
    assert.equal(h.retryFlag(), null, "挂载成功后要能再次启用自救");
});

test("清缓存本身抛异常：仍然会刷新（不能让用户卡在清理步骤上）", async () => {
    const h = runGuard({ skeletonAlive: true, cachesThrows: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 1);
    assert.equal(h.unregistered, 1, "缓存坏掉也要接着注销 SW");
});

test("环境里没有 Service Worker：只清缓存 + 刷新，不报错", async () => {
    const h = runGuard({ skeletonAlive: true, noServiceWorker: true });
    await h.fireTimeout();
    assert.equal(h.reloads, 1);
    assert.equal(h.unregistered, 0);
});

test("index.html 以外部脚本方式引入 boot-guard（内联会被 CSP 拦掉）", () => {
    const html = readProjectFile("index.html");
    const tag = /<script[^>]*src="\/boot-guard\.js"[^>]*>/u.exec(html);
    assert.ok(tag, "index.html 必须引入 /boot-guard.js");
    assert.match(tag[0], /defer/u, "要 defer：等 HTML 解析完再挂定时器");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]{0,200}boot-guard/u.test(html), "不能改成内联脚本");
});

test("CSP 仍然禁止内联脚本（boot-guard 保持外链的前提）", () => {
    const headers = readProjectFile("public/_headers");
    const csp = /Content-Security-Policy:\s*([^\n]+)/u.exec(headers)?.[1] ?? "";
    assert.match(csp, /script-src 'self'/u);
    assert.ok(!/script-src[^;]*'unsafe-inline'/u.test(csp), "script-src 一旦放开 unsafe-inline，外链这个约束就没人守了");
});
