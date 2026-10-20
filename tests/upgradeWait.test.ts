// tests/upgradeWait.test.ts
// 网页一键升级的「跟进」逻辑（src/utils/upgradeWait.ts）。
//
// 2026-10-20 用户报「点击更新长时间无反应，刷新后还是原来版本」。
// 服务端那边是 restart 不换镜像（另有守卫）；前端这边的问题是点完只挂一句
// 「升级中」，成了不吭声、败了也不说。这里钉住三个出口都要有结论：
//   upgraded / failed（带原因）/ timeout —— 绝不死循环、绝不假装成功。
import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadWithFreshCache, waitForUpgrade } from "../src/utils/upgradeWait";

interface Call {
    url: string;
}

const realFetch = globalThis.fetch;

/** 造一个按 URL 应答的 fetch 桩，并记录调用顺序 */
function stubFetch(handler: (url: string, callIndex: number) => unknown) {
    const calls: Call[] = [];
    const impl = (async (url: string) => {
        const index = calls.length;
        calls.push({ url: String(url) });
        const out = handler(String(url), index);
        if (out instanceof Error) throw out;
        return out;
    }) as unknown as (url: string, init?: RequestInit) => Promise<Response>;
    return { impl, calls };
}

const json = (body: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

/** 不真的等：sleep 直接返回，now 由用例自己推进 */
function fakeClock(stepMs = 1000) {
    let t = 0;
    return {
        sleep: async () => {
            t += stepMs;
        },
        now: () => t,
        advance: (ms: number) => {
            t += ms;
        },
    };
}

test("waitForUpgrade：清单版本变了 → upgraded", async () => {
    const clock = fakeClock();
    const { impl } = stubFetch(url =>
        url.includes("precache-manifest")
            ? json({ version: "1750000000001" })
            : json({ ok: true, phase: "recreating" }),
    );
    const result = await waitForUpgrade({
        localVersion: "1750000000000",
        fetchImpl: impl,
        sleep: clock.sleep,
        now: clock.now,
    });
    assert.deepEqual(result, { kind: "upgraded" });
});

test("waitForUpgrade：服务端报 failed → 带原因返回，不再干等", async () => {
    const clock = fakeClock();
    const { impl, calls } = stubFetch(url =>
        url.includes("precache-manifest")
            ? json({ version: "1750000000000" })
            : json({ ok: true, phase: "failed", error: "重建容器失败（退出码 21）：找不到 compose 文件" }),
    );
    const result = await waitForUpgrade({
        localVersion: "1750000000000",
        fetchImpl: impl,
        sleep: clock.sleep,
        now: clock.now,
    });
    assert.equal(result.kind, "failed");
    assert.match((result as { message: string }).message, /退出码 21/);
    // 第一跳就该出结论（容器重启期间的 502 还没消化完也照样先问 phase）
    assert.ok(calls.length <= 2, "报失败后不该继续轮询");
});

test("waitForUpgrade：容器重启期间接口全炸也不崩，恢复后照样判出 upgraded", async () => {
    const clock = fakeClock();
    // 前两跳：接口连不上（容器正在换）；之后：新版本
    const { impl } = stubFetch((url, i) => {
        if (i === 0 || i === 1) return new Error("ECONNREFUSED");
        return url.includes("precache-manifest")
            ? json({ version: "1750000000009" })
            : json({ ok: true, phase: "idle" });
    });
    const result = await waitForUpgrade({
        localVersion: "1750000000000",
        fetchImpl: impl,
        sleep: clock.sleep,
        now: clock.now,
    });
    assert.deepEqual(result, { kind: "upgraded" });
});

test("waitForUpgrade：版本一直不变 → timeout（绝不假装成功）", async () => {
    const clock = fakeClock();
    const { impl } = stubFetch(url =>
        url.includes("precache-manifest") ? json({ version: "1750000000000" }) : json({ ok: true, phase: "idle" }),
    );
    const result = await waitForUpgrade({
        localVersion: "1750000000000",
        timeoutMs: 3000,
        intervalMs: 1000,
        fetchImpl: impl,
        sleep: clock.sleep,
        now: clock.now,
    });
    assert.deepEqual(result, { kind: "timeout" });
});

test("reloadWithFreshCache：清本站缓存 + 注销 SW 后重载（否则 SW 喂回旧外壳）", async () => {
    const deleted: string[] = [];
    const unregistered: string[] = [];
    let reloaded = 0;
    const g = globalThis as unknown as {
        caches?: { keys: () => Promise<string[]>; delete: (k: string) => Promise<boolean> };
        navigator?: unknown;
    };
    const hadCaches = "caches" in g;
    const hadNavigator = "navigator" in g;
    const oldCaches = g.caches;
    const oldNavigator = g.navigator;

    g.caches = {
        keys: async () => ["navihive-precache", "navihive-runtime", "other-app"],
        delete: async (k: string) => {
            deleted.push(k);
            return true;
        },
    };
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            serviceWorker: {
                getRegistrations: async () => [
                    { unregister: async () => void unregistered.push("a") },
                ],
            },
        },
    });
    try {
        await reloadWithFreshCache(() => {
            reloaded += 1;
        });
    } finally {
        if (hadCaches) g.caches = oldCaches;
        else Reflect.deleteProperty(globalThis, "caches");
        if (hadNavigator) {
            Object.defineProperty(globalThis, "navigator", { configurable: true, value: oldNavigator });
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
        globalThis.fetch = realFetch;
    }

    assert.deepEqual(deleted.sort(), ["navihive-precache", "navihive-runtime"], "只清本站缓存，别动别人的");
    assert.deepEqual(unregistered, ["a"], "要注销 SW");
    assert.equal(reloaded, 1, "最后必须真的重载一次");
});

test("reloadWithFreshCache：缓存/SW 都不可用（隐私模式）也要重载", async () => {
    let reloaded = 0;
    await reloadWithFreshCache(() => {
        reloaded += 1;
    });
    assert.equal(reloaded, 1);
});
