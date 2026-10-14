// tests/serverSqliteD1.test.ts
//
// 自托管适配器 server/sqlite-d1.ts 的行为钉子。
// 这里钉的不是「SQLite 会不会执行 SQL」（那是 tests/helpers/realSqliteD1.ts 的活），
// 而是**适配器与 D1 的行为差**——每条都对应一个真实的线上事故形状：
//   - batch 不是真事务 → 「删站点 + 写回收站 + 写审计」半提交，数据半删
//   - run() 丢 RETURNING 的行 → 改笔记读到 undefined（notes.ts:934 直接读 results）
//   - 外键没开 → 线上拦得住的脏数据本地拦不住，两边行为分叉
//   - bind(undefined) 抛错 → 可选字段整条 500
//
// 几条关键行为是探针脚本（2026-10-14）量出来之后才敢写成断言的，写在这里防回归：
//   - 事务内失败后 COMMIT **仍会提交之前的语句** ⇒ 显式 ROLLBACK 是必须的，不是摆设
//   - node:sqlite 的 all() 跑普通 INSERT 回 [] 且不抛 ⇒ RETURNING 正则被字符串字面量
//     骗到时（"insert ... values ('returning')"）不会炸，meta 也不能拿行数顶替
//   - 关闭后的库再 prepare 抛 "database is not open"

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeSqliteD1, type SqliteD1 } from "../server/sqlite-d1";
import type { D1Result } from "../src/API/schema";

/** D1Result.meta 在契约里是 unknown（仓库里读它的地方都靠断言，见 src/API/methods/ai.ts:134） */
interface RunMeta {
    changes: number;
    rows_written: number;
    last_row_id: number;
}
function metaOf(result: D1Result<unknown>): RunMeta {
    return result.meta as RunMeta;
}

function tempDb(): { db: SqliteD1; dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "nh-d1-"));
    const db = makeSqliteD1(path.join(dir, "test.db"));
    return {
        db,
        dir,
        cleanup: () => {
            try {
                db.close();
            } catch {
                // 已经关过（close() 用例）就算了
            }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** 一张有 NOT NULL 约束的写表 + 一对父子表（外键） */
async function seed(db: SqliteD1): Promise<void> {
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))");
}

test("batch 是真事务：中途抛错，前面已执行的语句一起回滚", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        let error: unknown;
        try {
            await db.batch([
                db.prepare("INSERT INTO t (v) VALUES (?)").bind("first"),
                db.prepare("INSERT INTO t (v) VALUES (?)").bind(null), // 违反 NOT NULL
            ]);
        } catch (caught) {
            error = caught;
        }
        assert.ok(error, "批次里第二条违反约束时 batch 必须抛错");
        assert.match(String(error), /NOT NULL/i);

        const rows = await db.prepare("SELECT id FROM t").all<{ id: number }>();
        assert.equal(rows.results!.length, 0, "失败批次里的第一条也被回滚掉了（半提交就是数据半删）");
    } finally {
        cleanup();
    }
});

test("显式回滚不波及上一个已成功提交的 batch（txDepth 正确复位）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const ok = await db.batch([db.prepare("INSERT INTO t (v) VALUES (?)").bind("keep")]);
        assert.equal(metaOf(ok[0]!).changes, 1);

        await assert.rejects(
            db.batch([
                db.prepare("INSERT INTO t (v) VALUES (?)").bind("second"),
                db.prepare("INSERT INTO t (v) VALUES (?)").bind(null),
            ]),
            /NOT NULL/i
        );

        const rows = await db.prepare("SELECT v FROM t ORDER BY id").all<{ v: string }>();
        assert.deepEqual(rows.results, [{ v: "keep" }], "回滚只该滚掉失败的那一批");
    } finally {
        cleanup();
    }
});

test("batch 里 UPDATE ... RETURNING 的行不丢（notes.ts 改笔记换标签的形状）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, tag TEXT)");
        await db.prepare("INSERT INTO notes (title, tag) VALUES (?, ?)").bind("旧标题", "a").run();

        const out = await db.batch<{ id: number; title: string }>([
            db.prepare("UPDATE notes SET title = ? WHERE id = ? RETURNING id, title").bind("新标题", 1),
            db.prepare("UPDATE notes SET tag = ? WHERE id = ?").bind("b", 1),
        ]);
        assert.equal(out.length, 2);
        // notes.ts:934 的写法：batch 第一个结果直接读 .results 拿更新后的行
        assert.deepEqual(out[0]!.results, [{ id: 1, title: "新标题" }]);
        assert.equal(metaOf(out[0]!).changes, 1);
        // 不带 RETURNING 的那条：行是空的，meta 照给
        assert.deepEqual(out[1]!.results, []);
        assert.equal(metaOf(out[1]!).changes, 1);
    } finally {
        cleanup();
    }
});

test("run() 的 meta 三字段：changes / rows_written / last_row_id", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const inserted = await db.prepare("INSERT INTO t (v) VALUES (?)").bind("x").run();
        assert.equal(metaOf(inserted).changes, 1);
        assert.equal(metaOf(inserted).rows_written, 1);
        assert.equal(metaOf(inserted).last_row_id, 1);
        assert.deepEqual(inserted.results, []);

        const updated = await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("y", 1).run();
        assert.equal(metaOf(updated).changes, 1);
        assert.equal(metaOf(updated).last_row_id, 1, "UPDATE 不该动 last_row_id");

        const missed = await db.prepare("UPDATE t SET v = ? WHERE id = ?").bind("z", 999).run();
        assert.equal(metaOf(missed).changes, 0, "0 命中也要如实报 0");
    } finally {
        cleanup();
    }
});

test("bind(undefined) 按 NULL 收，不抛错（D1 语义，可选字段全靠它）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await db.exec("CREATE TABLE n (id INTEGER PRIMARY KEY, v TEXT)");
        await db.prepare("INSERT INTO n (id, v) VALUES (?, ?)").bind(1, undefined).run();
        const row = await db.prepare("SELECT v FROM n WHERE id = 1").first<{ v: string | null }>();
        assert.equal(row?.v, null);
        assert.equal(await db.prepare("SELECT id FROM n WHERE v IS NULL").first("id"), 1);
    } finally {
        cleanup();
    }
});

test("外键默认开启：违反约束当场被拦（与 D1 的 foreign_keys=on 对齐）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        await db.prepare("INSERT INTO p (id) VALUES (1)").run();
        await assert.rejects(
            db.prepare("INSERT INTO c (id, pid) VALUES (1, 99)").run(),
            /FOREIGN KEY constraint failed/i,
            "不开外键的话，这种脏数据本地静默收下、线上才报错"
        );
    } finally {
        cleanup();
    }
});

test("batch 内外键校验推到 COMMIT：先插子行再插父行也成立（D1 batch 语义）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const out = await db.batch([
            db.prepare("INSERT INTO c (id, pid) VALUES (1, 1)"), // 父行还在后头
            db.prepare("INSERT INTO p (id) VALUES (1)"),
        ]);
        assert.equal(out.length, 2);
        assert.equal(metaOf(out[0]!).changes, 1);
        assert.equal(metaOf(out[1]!).changes, 1);
    } finally {
        cleanup();
    }
});

test("无 RETURNING 的写语句走 all() 回空数组，不抛错（与 D1 一致）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const r = await db.prepare("DELETE FROM t WHERE id = 999").all<unknown>();
        assert.deepEqual(r.results, []);
        assert.equal(r.success, true);
    } finally {
        cleanup();
    }
});

test("exec() 回 D1 的 {count,duration} 形状，多条语句一次执行", async () => {
    const { db, cleanup } = tempDb();
    try {
        const r = await db.exec("CREATE TABLE e1 (a); CREATE TABLE e2 (b); INSERT INTO e1 VALUES (1); SELECT 1");
        assert.equal(r.success, true);
        assert.equal(typeof r.count, "number");
        assert.ok(r.duration >= 0);
        const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
        assert.deepEqual(tables.results!.map(row => row.name), ["e1", "e2"]);
    } finally {
        cleanup();
    }
});

test("first(列名) 回该列的值，first() 回整行，查不到回 null", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        await db.prepare("INSERT INTO t (id, v) VALUES (1, 'x')").run();
        assert.equal(await db.prepare("SELECT id, v FROM t").first("v"), "x");
        assert.equal(await db.prepare("SELECT id, v FROM t").first("不存在的列"), null);
        assert.equal(await db.prepare("SELECT id, v FROM t WHERE id = 42").first(), null);
        const row = await db.prepare("SELECT id, v FROM t").first<{ id: number; v: string }>();
        assert.deepEqual(row, { id: 1, v: "x" });
    } finally {
        cleanup();
    }
});

test("字符串字面量里的 returning 不骗过 dispatch：meta.changes 仍准确", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        // 正则 /\breturning\b/i 会命中这个字符串字面量 → 走 all() 分支。
        // 探针量的行为：all() 跑普通 INSERT 回 [] 且不抛，changes() 仍是 1。
        const r = await db.prepare("INSERT INTO t (v) VALUES (?)").bind("returning 之后").run();
        assert.deepEqual(r.results, []);
        assert.equal(metaOf(r).changes, 1, "changes 不能拿 results.length 顶替");
        assert.equal(metaOf(r).rows_written, 1);
    } finally {
        cleanup();
    }
});

test("close() 之后不能再 prepare（进程退出前靠它 checkpoint WAL）", () => {
    const { db, cleanup } = tempDb();
    db.close();
    assert.throws(() => db.prepare("SELECT 1"), /not open/i);
    cleanup();
});
