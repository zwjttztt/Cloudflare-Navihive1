// tests/migrationCacheRealSql.test.ts
//
// 「迁移只跑一次」这件事，用**真 SQLite + 计数**钉住。
//
// 为什么值得一条用例：迁移挂在实例上时，每个请求都要跑一遍建表 / 读版本的 DDL
// —— 那正是接口变慢的主因之一（见 src/API/methods/internals.ts 里 migrationState 的注释）。
// 改成模块级缓存之后，第二次起连一条 SQL 都不该发。这个行为一旦被谁改回去，
// 页面上只会表现为「接口又慢了」，看不出是谁、也看不出是哪一步。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

/** 数这个 api 一共往 D1 发了多少条语句（prepare 的次数） */
function countingDb() {
    const db = makeRealD1();
    let prepares = 0;
    const wrapped = new Proxy(db, {
        get(target, prop) {
            if (prop === "prepare") {
                return (...args: unknown[]) => {
                    prepares++;
                    return (target as unknown as Record<string, (...a: unknown[]) => unknown>).prepare(
                        ...args
                    );
                };
            }
            return Reflect.get(target, prop);
        },
    });
    return { db: wrapped, count: () => prepares };
}

test("真实 SQLite：第二次 migrate 一条 SQL 都不发（迁移缓存是模块级的）", async () => {
    resetMigrationCacheForTests();
    const { db, count } = countingDb();
    const api = makeRealApi(db);

    await api.migrate();
    const afterFirst = count();
    assert.ok(afterFirst > 0, "第一次必须真的建表");

    // 关键点：重新 new 一个 api（模拟下一个请求）—— 实例变了，缓存不该跟着丢
    const api2 = makeRealApi(db);
    await api2.migrate();
    assert.equal(count(), afterFirst, "换实例（下一个请求）不该再跑一遍迁移");

    await api2.migrate();
    assert.equal(count(), afterFirst, "同一个实例调两次也不该再跑");
});

test("真实 SQLite：迁移之后的业务查询照常工作（缓存不是把库锁住了）", async () => {
    resetMigrationCacheForTests();
    const { db, count } = countingDb();
    const api = makeRealApi(db);
    await api.migrate();

    const before = count();
    const created = await api.createNote({ title: "缓存之后还能写", content: "正文" });
    assert.ok(count() > before, "业务操作该发 SQL 还是得发");

    const list = await api.listNotes();
    assert.ok(list.some(n => n.id === created.id), "写完要能读回来");
});
