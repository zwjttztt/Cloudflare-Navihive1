// tests/serverSlowQuery.test.ts
// 慢查询打点（2026-10-22，质量评估 C5）的行为钉子。
//
// 钉的是三件会「静默失效」的事：
//   1. 摘要把字面量抹成 ? —— 否则同一条语句每次参数不同都被当成新语句，
//      限流与聚合全废，而且**用户数据会进日志**（慢查询日志是要留存的）。
//   2. 阈值与开关 —— 打点在每条 SQL 的热路径上，关掉时必须真的不计时；
//      阈值调高后普通查询不该再进缓冲。
//   3. 限流与环形缓冲 —— 批量导入时一条语句慢几百次，不能刷屏；
//      但也不能只留前 50 条之后就什么都不记（排障要看最近的）。
//
// ⚠️ 断言只比字符串与数字：node:assert 失败时会 util.inspect(actual)，
//    把 DOM 元素 / 大对象塞进失败路径会把进程堆炸掉（2026-10-21 踩过）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeSqliteD1 } from "../server/sqlite-d1";
import {
    recordSlowQuery,
    resetSlowQueries,
    slowQuerySnapshot,
    slowQuerySummary,
    sqlDigest,
} from "../server/slowQuery";

test("SQL 摘要：字符串/数字字面量一律抹成 ?（同一条语句认得出是同一条）", () => {
    const a = sqlDigest("SELECT * FROM notes WHERE id = 'abc' AND n = 12");
    const b = sqlDigest("SELECT * FROM notes WHERE id = 'zzz' AND n = 999");
    assert.equal(a, b, "参数不同的同一条语句，摘要必须一致");
    assert.match(a, /\?/, "字面量要被替换掉");
    assert.equal(a.includes("abc"), false, "字面量不许留在摘要里（会带出用户数据）");
});

test("SQL 摘要：折叠空白 + 超长截断", () => {
    const d = sqlDigest("SELECT   *\n  FROM    notes\n WHERE x = 1");
    assert.equal(d.includes("\n"), false, "多行 SQL 要折成一行，否则日志一行变五行");
    const long = sqlDigest(`SELECT ${"x,".repeat(200)} 1`);
    assert.ok(long.length <= 160, `超长要截断（实际 ${long.length}）`);
    assert.ok(long.endsWith("…"), "截断要留个标记，别让人以为是完整语句");
});

test("打点进环形缓冲，且带语句类型/行数/参数个数", () => {
    resetSlowQueries();
    recordSlowQuery({ sql: "SELECT * FROM notes WHERE user_id = 1", ms: 80, rows: 3, params: 1 });
    const snap = slowQuerySnapshot();
    assert.equal(snap.length, 1, "慢查询要进缓冲");
    assert.equal(snap[0].kind, "select", "要能认出语句类型");
    assert.equal(snap[0].rows, 3);
    assert.equal(snap[0].params, 1);
});

test("限流：同一条语句记累计次数，缓冲只留最近 50 条", () => {
    resetSlowQueries();
    for (let i = 0; i < 120; i++) {
        recordSlowQuery({ sql: "SELECT * FROM notes WHERE id = " + i, ms: 90, rows: 1 });
    }
    const snap = slowQuerySnapshot(50);
    assert.equal(snap.length, 50, "环形缓冲只留最近 50 条，不能无限涨（进程是长跑的）");
    // 摘要把数字抹成 ?，120 次都是同一条 —— hits 应该累计到 120
    assert.equal(snap[snap.length - 1].hits, 120, "同一摘要要累计次数");
});

test("汇总视图：按摘要聚合，最慢的排在最前", () => {
    resetSlowQueries();
    recordSlowQuery({ sql: "SELECT fast FROM t", ms: 60, rows: 1 });
    recordSlowQuery({ sql: "SELECT slow FROM t", ms: 900, rows: 1 });
    const sum = slowQuerySummary(10);
    assert.equal(sum[0].sql.includes("slow"), true, "最慢的排第一");
    assert.ok(sum[0].maxMs >= 900);
});

test("适配器真的接上了打点：查询走完会进缓冲（不是只测了个孤立的 record 函数）", async () => {
    // ⚠️ 阈值调成一个极小正数：这样「每条语句都算慢」是**确定的**，
    //    不用靠「造一张大表让它真的跑 50ms」那种跟机器快慢绑定的断言
    //    （CI 的 small-icu ubuntu 上跑得比本机快，那种用例会偶发红）。
    const saved = process.env.NAVIHIVE_SLOW_QUERY_MS;
    process.env.NAVIHIVE_SLOW_QUERY_MS = "0.0001";
    try {
        resetSlowQueries();
        const dir = mkdtempSync(path.join(tmpdir(), "nh-slow2-"));
        try {
            const db = makeSqliteD1(path.join(dir, "t.db"));
            try {
                await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
                await db.prepare("INSERT INTO t (v) VALUES ('hello')").run();
                await db.prepare("SELECT v FROM t WHERE id = ?").bind(1).all();
                await db.prepare("SELECT v FROM t WHERE id = ?").bind(1).first();
            } finally {
                db.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        const kinds = slowQuerySnapshot().map(e => e.kind);
        assert.ok(kinds.includes("select"), `SELECT 要被记到（实际 ${kinds.join(",")}）`);
        assert.ok(kinds.includes("insert"), "INSERT 也要被记到 —— 打点挂在全库唯一出口上");
        // 反例：断言摘要里没有绑定值（'hello' 是这条语句唯一的字面量）
        const leaked = slowQuerySnapshot().some(e => e.sql.includes("hello"));
        assert.equal(leaked, false, "摘要里不许出现字面量（会带出用户数据）");
    } finally {
        if (saved === undefined) delete process.env.NAVIHIVE_SLOW_QUERY_MS;
        else process.env.NAVIHIVE_SLOW_QUERY_MS = saved;
    }
});

test("阈值 ≤ 0 = 关闭打点（运维关掉时不该再有开销与噪音）", () => {
    const saved = process.env.NAVIHIVE_SLOW_QUERY_MS;
    process.env.NAVIHIVE_SLOW_QUERY_MS = "0";
    try {
        resetSlowQueries();
        recordSlowQuery({ sql: "SELECT 1", ms: 9999, rows: 1 });
        assert.equal(slowQuerySnapshot().length, 0, "关掉之后不该再进缓冲");
    } finally {
        if (saved === undefined) delete process.env.NAVIHIVE_SLOW_QUERY_MS;
        else process.env.NAVIHIVE_SLOW_QUERY_MS = saved;
    }
});
