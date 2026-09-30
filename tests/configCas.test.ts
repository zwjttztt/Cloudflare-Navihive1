// tests/configCas.test.ts
//
// `compareAndSetConfig` 是这次把限速计数从「读-改-写」改成「条件更新」的地基：
// 它必须真的做到「只有当前值还是我读到的那份时才写」，否则上层重试多少次都没用。
// 这里用一个最小 D1 替身，忠实回报 `rows_written`（D1 的 `success` 在 UPDATE 一行
// 都没匹配上时也是 true，看它会得出完全相反的结论）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";
import { WEBDAV_PASSWORD_KEY } from "../src/API/configKeys";

/** 只实现 CAS 用到的三条语句，其余一律报错（免得假 D1 悄悄吞掉 SQL 变化） */
function makeDb(initial?: Record<string, string>) {
    const rows = new Map<string, string>(Object.entries(initial || {}));
    const asked: string[] = [];
    const db = {
        rows,
        asked,
        prepare(sql: string) {
            let args: unknown[] = [];
            const stmt = {
                bind: (...values: unknown[]) => {
                    args = values;
                    return stmt;
                },
                run: async () => {
                    asked.push(sql);
                    const compact = sql.replace(/\s+/g, " ").trim();
                    if (compact.startsWith("UPDATE configs SET")) {
                        const [next, key, expected] = args as [string, string, string];
                        if (rows.get(key) !== expected) {
                            return { success: true, meta: { rows_written: 0 } };
                        }
                        rows.set(key, next);
                        return { success: true, meta: { rows_written: 1 } };
                    }
                    if (compact.startsWith("INSERT INTO configs")) {
                        const [key, next] = args as [string, string];
                        // ON CONFLICT DO NOTHING：已经有这条就一行都写不进去
                        if (rows.has(key)) return { success: true, meta: { rows_written: 0 } };
                        rows.set(key, next);
                        return { success: true, meta: { rows_written: 1 } };
                    }
                    throw new Error(`假 D1 不支持这条 SQL: ${compact.slice(0, 60)}`);
                },
                first: async <T>() => {
                    const compact = sql.replace(/\s+/g, " ").trim();
                    if (compact.startsWith("SELECT value FROM configs")) {
                        const key = args[0] as string;
                        if (!rows.has(key)) return null as T;
                        return { value: rows.get(key) } as unknown as T;
                    }
                    throw new Error(`假 D1 不支持这条 SQL: ${compact.slice(0, 60)}`);
                },
            };
            return stmt;
        },
    };
    return db;
}

function makeApi(initial?: Record<string, string>) {
    const db = makeDb(initial);
    return { db, api: new NavigationAPI({ DB: db } as never) };
}

test("值没被人动过：更新生效并返回 true", async () => {
    const { db, api } = makeApi({ "auth.loginGuard": '{"v":1}' });
    const ok = await api.compareAndSetConfig("auth.loginGuard", '{"v":1}', '{"v":2}');

    assert.equal(ok, true);
    assert.equal(db.rows.get("auth.loginGuard"), '{"v":2}');
});

test("值已被别的请求改过：返回 false，且绝不覆盖别人的写入", async () => {
    const db = makeDb({ "auth.loginGuard": '{"v":1}' });
    const api = new NavigationAPI({ DB: db } as never);

    // 我读到的是 {"v":1}，但在这之前别人已经把值改成了 {"v":9}
    db.rows.set("auth.loginGuard", '{"v":9}');
    const ok = await api.compareAndSetConfig("auth.loginGuard", '{"v":1}', '{"v":2}');

    assert.equal(ok, false, "底层值变了就必须告知调用方重算");
    assert.equal(db.rows.get("auth.loginGuard"), '{"v":9}', "别人先写的值不能被覆盖");
});

test("rows_written 才是判据：UPDATE 一行没匹配上时 success 依然是 true，这里必须判失败", async () => {
    const { db, api } = makeApi({ "auth.writeGuard": "old" });
    const ok = await api.compareAndSetConfig("auth.writeGuard", "stale-read", "new");

    assert.equal(ok, false);
    // 假 D1 这一路的 success 故意返回 true —— 只盯 success 的话这条测试会红
    assert.ok(db.asked.some(s => s.includes("UPDATE configs SET")));
});

test("预期「还没有这条」时抢第一次写入；别人抢先插进去就返回 false", async () => {
    const db = makeDb();
    const api = new NavigationAPI({ DB: db } as never);

    assert.equal(await api.compareAndSetConfig("auth.initGuard", null, '{"v":1}'), true);
    // 第二次仍认为自己是在「第一次写入」——并发场景下必有的一方
    assert.equal(await api.compareAndSetConfig("auth.initGuard", null, '{"v":2}'), false);
    assert.equal(db.rows.get("auth.initGuard"), '{"v":1}', "先到者的值不能被后来的插队覆盖");
});

test("加密键（webdav.password）不支持 CAS：密文带随机 IV，同一明文两次加密都不同", async () => {
    const { api } = makeApi();
    const ok = await api.compareAndSetConfig(WEBDAV_PASSWORD_KEY, "", "hunter2");

    assert.equal(ok, false, "没法比对密文就明确拒绝，别让调用方误以为写成功了");
});

test("读到的原始串可以直接用来 CAS（限速场景的真实用法）", async () => {
    const { api } = makeApi({ "auth.loginGuard": '{"version":2,"buckets":{}}' });
    const raw = await api.getConfig("auth.loginGuard");
    const ok = await api.compareAndSetConfig(
        "auth.loginGuard",
        raw,
        '{"version":2,"buckets":{"1.2.3.4":{"count":1}}}'
    );

    assert.equal(ok, true);
    assert.equal(
        await api.getConfig("auth.loginGuard"),
        '{"version":2,"buckets":{"1.2.3.4":{"count":1}}}'
    );
});
