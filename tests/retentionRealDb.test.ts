// tests/retentionRealDb.test.ts
//
// 保留策略（D-16 幂等键 / D-20 审计日志）在**真 SQLite**上的行为钉桩。
//
// 为什么不能只靠 FakeD1：这两个清理函数的正确性全在**SQL 语义**里 ——
//   - idempotency_keys.expires_at 是**毫秒整数**，判据是 expires_at <= now；
//   - audit_log.created_at 是 TIMESTAMP **文本**（UTC），判据是 datetime('now','-N days')。
// FakeD1 不执行 SQL，只按前缀匹配，「比较的是文本还是整数」「UTC 还是本地时间」
// 这类差异在它身上永远是绿的。而这两条一旦写错，表现是「日志表/幂等表悄悄涨到几百万行」，
// 线上没有任何一处会报错 —— 只能靠真库把行为钉死。
//
// 第二个目的：给 cleanupExpiredRows 的 idempotency 字段上锁（D-16 的接线）。
// purgeExpiredIdempotency 一直存在且一直有单测，缺的只是「定时任务真的调它」。
// 只测函数本身会漏掉这条，所以最后一条用例断言的是**聚合入口**的返回值。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";

/**
 * 一套全新的内存库 + 已迁移的 api。
 *
 * ⚠️ 每条用例都必须调：迁移缓存在**模块作用域**（生产上每个 isolate 只跑一次），
 * 不清的话第二条用例拿到的是一个空库、一张表都没有，报的错会离题很远。
 */
async function freshApi() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

/** 往幂等键表塞一行；expires_at 用毫秒整数（与线上写入方一致） */
async function insertIdempotencyRow(
    db: ReturnType<typeof makeRealD1>,
    opId: string,
    expiresAt: number
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO idempotency_keys
                (scope, op_id, user_id, state, status, body, created_at, expires_at)
             VALUES (?, ?, NULL, 'done', 200, NULL, ?, ?)`
        )
        .bind("test-scope", opId, Date.now(), expiresAt)
        .run();
}

/** 当前幂等键表里的 op_id 集合（断言「谁还在」比数行数更能说明问题） */
async function idempotencyOpIds(db: ReturnType<typeof makeRealD1>): Promise<string[]> {
    const result = await db
        .prepare("SELECT op_id FROM idempotency_keys ORDER BY op_id")
        .all<{ op_id: string }>();
    return result.results.map(row => row.op_id);
}

const HOUR_MS = 60 * 60 * 1000;

test("purgeExpiredIdempotency()：只删 expires_at 已到点的，未到点的留着", async () => {
    const { db, api } = await freshApi();
    const now = Date.now();
    await insertIdempotencyRow(db, "expired", now - HOUR_MS);
    await insertIdempotencyRow(db, "alive", now + HOUR_MS);

    const removed = await api.purgeExpiredIdempotency();

    assert.equal(removed, 1, "只该删掉那条已到点的");
    assert.deepEqual(await idempotencyOpIds(db), ["alive"], "未到点的幂等键必须还在");
});

test("purgeExpiredIdempotency(7)：入参是毫秒时间戳，不是天数（传天数会一条都不删）", async () => {
    // ⚠️ 这条是**反证**，它保护的是一个真实踩过的坑：
    // purgeExpiredAudit(days) 与 purgeExpiredIdempotency(now) 长得一样但语义相反。
    // 谁把 cleanupExpiredRows 里的调用改成 purgeExpiredIdempotency(days)，
    // 判据就变成 `expires_at <= 7` —— 一个永远为假的比较，清理静默失效、表继续涨，
    // 而所有「正常调用」的用例照样绿。传 7 毫秒应当什么都删不掉。
    const { db, api } = await freshApi();
    const now = Date.now();
    await insertIdempotencyRow(db, "expired", now - HOUR_MS);
    await insertIdempotencyRow(db, "alive", now + HOUR_MS);

    const removed = await api.purgeExpiredIdempotency(7);

    assert.equal(removed, 0, "7 毫秒之前没有任何行 —— 传天数会把清理变成空操作");
    assert.deepEqual(
        await idempotencyOpIds(db),
        ["alive", "expired"],
        "两条都必须还在：这条用例钉的就是「毫秒不是天数」"
    );
});

test("purgeExpiredAudit(7)：created_at 是 TIMESTAMP 文本，按 UTC 相对时间比较", async () => {
    const { db, api } = await freshApi();
    // 时间用 SQL 侧的 datetime('now', ...) 生成，与判据同源 —— 在 JS 里算好再拼字符串
    // 会把「时区差 8 小时」这类问题一起写进用例，验出来的东西就不一样了。
    await db
        .prepare("INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now','-8 days'))")
        .bind("too-old")
        .run();
    await db
        .prepare("INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now','-1 day'))")
        .bind("recent")
        .run();

    const removed = await api.purgeExpiredAudit(7);

    assert.equal(removed, 1, "只有 8 天前那条超过 7 天保留期");
    const result = await db
        .prepare("SELECT action FROM audit_log ORDER BY action")
        .all<{ action: string }>();
    assert.deepEqual(
        result.results.map(row => row.action),
        ["recent"],
        "1 天前的审计日志必须保留（保留期内）"
    );
});

test("cleanupExpiredRows()：idempotency 计数真的接上了（D-16 不是只写了函数没人调）", async () => {
    const { db, api } = await freshApi();
    const now = Date.now();
    await insertIdempotencyRow(db, "expired-1", now - HOUR_MS);
    await insertIdempotencyRow(db, "expired-2", now - 2 * HOUR_MS);
    await insertIdempotencyRow(db, "alive", now + HOUR_MS);

    const counts = await api.cleanupExpiredRows();

    assert.equal(typeof counts.idempotency, "number", "聚合结果里必须有幂等键这一项");
    assert.equal(counts.idempotency, 2, "两条到点的都该被这个入口清掉");
    assert.deepEqual(await idempotencyOpIds(db), ["alive"]);
});
