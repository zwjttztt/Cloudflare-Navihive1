// tests/linkSweep.test.ts
// 死链巡检的账号隔离。
//
// 这条巡检过去是一把梭：以「无账号」身份读出**所有人**的站点，探完写回全站共享的
// 一份 `link.health` —— 库里唯一一处跨账号混合的数据。现在改成逐个账号各探各的。
//
// 站点 URL 统一用回环地址：SSRF 黑名单会直接判为死链，**不会真的发出请求**，
// 所以这个测试是纯内存的、不碰网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import { runLinkSweep } from "../worker/cron";
import { HEALTH_KEY } from "../worker/cronLogic";

/** 只实现巡检真正用到的读写字；快照按「当前账号 + 键」分开存，模拟 user_configs */
function makeApi(
    users: { id: number; status?: string }[],
    sitesByUser: Record<number, string[]>
) {
    const store = new Map<string, string>();
    const seenAs: (number | null)[] = [];
    let current: number | null = null;

    return {
        seenAs,
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

test("死链巡检的快照各写各的：A 的链接不会出现在 B 的快照里", async () => {
    const { api, store } = makeApi(
        [{ id: 1 }, { id: 2 }],
        {
            1: ["http://localhost:9/a"],
            2: ["http://localhost:9/c"],
        }
    );

    await runLinkSweep(api as never);

    const a = JSON.parse(store.get(`1:${HEALTH_KEY}`) as string) as { entries?: unknown[] };
    const b = JSON.parse(store.get(`2:${HEALTH_KEY}`) as string) as { entries?: unknown[] };
    assert.ok(a, "账号 1 应当有自己的快照");
    assert.ok(b, "账号 2 应当有自己的快照");
    assert.notDeepEqual(a, b, "两份快照不该是同一份共享数据");
    assert.equal(store.has(`null:${HEALTH_KEY}`), false, "不再写全站共享的那份快照");
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
