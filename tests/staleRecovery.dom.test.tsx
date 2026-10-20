// tests/staleRecovery.dom.test.tsx
// 「页面停在旧版 / 旧资源取不到」的自救逻辑（src/utils/staleRecovery.ts）。
//
// 为什么值得单测：这套代码是**站点升级后不白屏的唯一保障**，而它的特点是
// 「只在版本漂移时才跑、平时完全不出现」—— 属于最容易被无声改坏的那类。
// 项目里同类教训：v2.0.0 的登录设备去重当时没写单测，回归时一点声音都没有。
// 2026-10-20 之前它住在 main.tsx 里，import 即执行副作用，单测根本够不着，
// 于是被列进「9 个从未被用例引入的源文件」之首；现在抽成独立模块，四条路径全测。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recoverFromStaleAssets, resetRecoveryLatch } from "../src/utils/staleRecovery";

const KEY = "navihive:build-recover";

let deletedCaches: string[] = [];
let unregistered = 0;

/** 装桩。⚠️ caches 必须装在 **window** 上：jsdom 下 window 与 globalThis 不是同一个对象 */
function installStubs() {
    resetRecoveryLatch();
    deletedCaches = [];
    unregistered = 0;
    const cachesStub = {
        keys: async () => ["navihive-precache", "navihive-runtime", "someone-elses"],
        delete: async (k: string) => {
            deletedCaches.push(k);
            return true;
        },
    };
    // ⚠️ 两处都要装：浏览器里 window === globalThis（同一个对象），jsdom 里不是。
    // 被测代码读的是裸 `caches`（全局），只装 window 的话它看到 undefined，
    // 表现是「逻辑没跑但也不报错」，断言语无伦次地空着。
    Object.defineProperty(window, "caches", { configurable: true, value: cachesStub });
    Object.defineProperty(globalThis, "caches", { configurable: true, value: cachesStub });
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
            getRegistrations: async () => [{ unregister: async () => { unregistered += 1; return true; } }],
        },
    });
    try {
        sessionStorage.clear();
    } catch {
        /* 忽略 */
    }
}

afterEach(() => {
    installStubs();
});

test("触发时：只清本站缓存 + 注销 SW + 记一次性令牌", async () => {
    installStubs();
    const fired = await recoverFromStaleAssets({ reason: "版本落后", key: KEY });
    assert.equal(fired, true, "要告诉调用方「我刷了」");
    assert.deepEqual(deletedCaches.sort(), ["navihive-precache", "navihive-runtime"], "只清本站缓存，别动别人的");
    assert.equal(unregistered, 1, "要注销 SW，否则重载回来的还是旧外壳");
    assert.ok(sessionStorage.getItem(KEY), "重载要记令牌，否则弱网下无限刷新");
});

test("同一文件里第二次调用被闩挡住（两条路径同时发现问题只刷一次）", async () => {
    installStubs();
    assert.equal(await recoverFromStaleAssets({ reason: "a", key: KEY }), true);
    const before = deletedCaches.length;
    assert.equal(await recoverFromStaleAssets({ reason: "b", key: KEY }), false, "已在重载，不能再刷");
    assert.equal(deletedCaches.length, before, "第二次不该再清一次缓存");
});

test("令牌已存在：不重复刷（刷新后仍是旧版的死循环防护）", async () => {
    installStubs();
    sessionStorage.setItem(KEY, String(Date.now()));
    const fired = await recoverFromStaleAssets({ reason: "版本落后", key: KEY });
    assert.equal(fired, false);
    assert.deepEqual(deletedCaches, [], "记过令牌就不要再动缓存");
});

test("真离线：什么都不做（断网时清缓存会把还能用的离线页面换成错误页）", async () => {
    installStubs();
    const fired = await recoverFromStaleAssets({ reason: "chunk 404", key: KEY, online: false });
    assert.equal(fired, false);
    assert.deepEqual(deletedCaches, []);
    assert.equal(sessionStorage.getItem(KEY), null, "离线时连令牌都不该写");
});

test("拿不到在线状态：按在线处理（宁可多刷一次，也别让故障一直挂着）", async () => {
    installStubs();
    const fired = await recoverFromStaleAssets({ reason: "chunk 404", key: KEY });
    assert.equal(fired, true, "online 为 undefined 时要试一次");
});

test("清缓存抛错也照样走到重载（拿到新 HTML 就能自己恢复）", async () => {
    installStubs();
    Object.defineProperty(window, "caches", {
        configurable: true,
        value: {
            keys: async () => {
                throw new Error("Cache API 炸了");
            },
            delete: async () => false,
        },
    });
    const fired = await recoverFromStaleAssets({ reason: "chunk 404", key: KEY });
    assert.equal(fired, true, "清理失败不能拦住自救");
    assert.ok(sessionStorage.getItem(KEY), "令牌照记");
});
