// tests/linkSweep.test.ts
// 死链巡检的账号隔离。
//
// 这条巡检过去是一把梭：以「无账号」身份读出**所有人**的站点，探完写回全站共享的
// 一份 `link.health` —— 库里唯一一处跨账号混合的数据。现在改成逐个账号各探各的。
//
// 回环地址由 SSRF 策略阻断后属于未知，不写失效证据，也不会真的联网。
// 明确 HTTP 结果的隔离用例用 mock fetch，避免空快照相等导致错误推断共享数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLinkSweep } from "../worker/cron";
import { HEALTH_KEY, type LinkHealthSnapshot } from "../worker/cronLogic";

/** 只实现巡检真正用到的读写字；快照按「当前账号 + 键」分开存，模拟 user_configs */
function makeApi(
    users: { id: number; status?: string }[],
    sitesByUser: Record<number, string[]>
) {
    const store = new Map<string, string>();
    const seenAs: (number | null)[] = [];
    const switches: (number | null)[] = [];
    const writes: { uid: number | null; key: string }[] = [];
    let current: number | null = null;

    return {
        seenAs,
        switches,
        writes,
        store,
        api: {
            async listUsers() {
                return users.map(u => ({
                    id: u.id,
                    username: `u${u.id}`,
                    role: "user",
                    status: u.status ?? "active",
                }));
            },
            setCurrentUser(uid: number | null) {
                switches.push(uid);
                current = uid;
            },
            async getSites() {
                seenAs.push(current);
                const urls =
                    current === null
                        ? Object.values(sitesByUser).flat()
                        : (sitesByUser[current] ?? []);
                return urls.map((url, i) => ({ id: i + 1, url, name: "" }));
            },
            async getConfig(key: string) {
                return store.get(`${current}:${key}`) ?? null;
            },
            async setConfig(key: string, value: string) {
                writes.push({ uid: current, key });
                store.set(`${current}:${key}`, value);
                return true;
            },
        },
    };
}

test("死链巡检按账号逐个进行：每个人只探到自己的站点", async () => {
    const { api, seenAs } = makeApi(
        [{ id: 1 }, { id: 2 }],
        {
            1: ["http://localhost:9/a", "http://localhost:9/b"],
            2: ["http://localhost:9/c"],
        }
    );

    await runLinkSweep(api as never);

    assert.deepEqual(seenAs, [1, 2], "应当分别以账号 1、账号 2 的身份各巡检一轮");
});

test("SSRF 未知结果各写空快照，不以内容相同推断共享数据", async () => {
    const { api, store, switches, writes } = makeApi(
        [{ id: 1 }, { id: 2 }],
        {
            1: ["http://localhost:9/a"],
            2: ["http://localhost:9/c"],
        }
    );

    await runLinkSweep(api as never);

    const a = JSON.parse(store.get(`1:${HEALTH_KEY}`) as string) as LinkHealthSnapshot;
    const b = JSON.parse(store.get(`2:${HEALTH_KEY}`) as string) as LinkHealthSnapshot;
    const empty = { v: 1, dead: {}, probe: {}, white: [] };
    assert.deepEqual(a, empty, "账号 1 的未知探测不产生成功或失效证据");
    assert.deepEqual(b, empty, "账号 2 的未知探测不产生成功或失效证据");
    assert.deepEqual(writes.filter(w => w.key === HEALTH_KEY).map(w => w.uid), [1, 2]);
    assert.deepEqual(switches, [1, null, 2, null], "每账号执行后恢复无账号上下文");
    assert.equal(store.has(`null:${HEALTH_KEY}`), false, "不再写全站共享的那份快照");
});

test("明确 HTTP 404 和 200 的证据只写各自账号，不泄漏到对方快照", async () => {
    const missing = "https://account-a.example/missing";
    const healthy = "https://account-b.example/healthy";
    const { api, store, seenAs, switches, writes } = makeApi(
        [{ id: 1 }, { id: 2 }],
        { 1: [missing], 2: [healthy] }
    );
    const previousFetch = globalThis.fetch;
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: init?.method ?? "GET" });
        assert.ok(url === missing || url === healthy, "不应请求其他账号之外的 URL");
        return new Response(null, { status: url === missing ? 404 : 200 });
    };
    try {
        await runLinkSweep(api as never);

        const a = JSON.parse(store.get(`1:${HEALTH_KEY}`) as string) as LinkHealthSnapshot;
        const b = JSON.parse(store.get(`2:${HEALTH_KEY}`) as string) as LinkHealthSnapshot;
        assert.deepEqual(Object.keys(a.dead), [missing]);
        assert.deepEqual(a.probe, {});
        assert.deepEqual(Object.keys(b.probe), [healthy]);
        assert.deepEqual(b.dead, {});
        assert.equal(a.dead[healthy], undefined);
        assert.equal(a.probe[healthy], undefined);
        assert.equal(b.dead[missing], undefined);
        assert.equal(b.probe[missing], undefined);
        assert.deepEqual(seenAs, [1, 2]);
        assert.deepEqual(calls, [{ url: missing, method: "HEAD" }, { url: healthy, method: "HEAD" }]);
        assert.deepEqual(writes.filter(w => w.key === HEALTH_KEY).map(w => w.uid), [1, 2]);
        assert.equal(store.has(`null:${HEALTH_KEY}`), false);
        assert.deepEqual(switches, [1, null, 2, null]);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("已停用的账号跳过巡检：人进不来看不到结果", async () => {
    const { api, seenAs } = makeApi(
        [{ id: 1 }, { id: 2, status: "disabled" }],
        { 1: ["http://localhost:9/a"], 2: ["http://localhost:9/c"] }
    );

    await runLinkSweep(api as never);

    assert.deepEqual(seenAs, [1], "停用账号不该被巡检");
});

test("没有 users 数据时退回「不带账号巡检一次」的旧行为", async () => {
    const { api, seenAs } = makeApi([], { 1: ["http://localhost:9/a"] });

    await runLinkSweep(api as never);

    assert.deepEqual(seenAs, [null]);
});

test("注入的假实现没有 listUsers 时也不炸（不污染既有用例）", async () => {
    // 只有 SchedulerDB 三件套、没有多账号方法：走单账号分支
    const store = new Map<string, string>();
    const api = {
        async getSites() {
            return [{ id: 1, url: "http://localhost:9/a", name: "" }];
        },
        async getConfig(key: string) {
            return store.get(key) ?? null;
        },
        async setConfig(key: string, value: string) {
            store.set(key, value);
            return true;
        },
    };

    await runLinkSweep(api as never);
    assert.ok(store.has(HEALTH_KEY), "旧行为下仍会写出一份快照");
});
