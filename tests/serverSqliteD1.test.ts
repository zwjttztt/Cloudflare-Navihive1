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

test("batch 里的 SELECT 也要有 results（首页 bootstrap 的形状，错法只有「空首页」）", async () => {
    // 事故原型（2026-10-14 晚，自托管上线后）：data.ts 的 queryBootstrap 把
    // 「分组 + 站点 + 配置」三条 SELECT 放进一个 batch，直接读每个结果的 .results。
    // 早期版本只对 RETURNING 走 all()，SELECT 走了 run() —— run() 不回行，
    // 于是首页永远 0 分组 0 站点，而单独 GET /api/groups（单条 all()）却有数据。
    // 没有任何报错，表现只有一个空首页，所以必须钉在这里。
    const { db, cleanup } = tempDb();
    try {
        await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
        await db.prepare("INSERT INTO t (name) VALUES (?)").bind("豆包").run();
        await db.prepare("INSERT INTO t (name) VALUES (?)").bind("掘金").run();

        // SELECT 混在写语句之间，且带绑定参数（scope 过滤就是这种形状）
        const out = await db.batch<{ id: number; name: string }>([
            db.prepare("SELECT id, name FROM t WHERE name = ?").bind("豆包"),
            db.prepare("UPDATE t SET name = ? WHERE id = 2").bind("掘金改名"),
            db.prepare("SELECT id, name FROM t ORDER BY id"),
        ]);
        assert.equal(out.length, 3);
        assert.deepEqual(out[0]!.results, [{ id: 1, name: "豆包" }], "batch 里的 SELECT 丢了行");
        assert.deepEqual(out[2]!.results, [{ id: 1, name: "豆包" }, { id: 2, name: "掘金改名" }]);
        // 写语句那条的 meta 不受影响
        assert.equal(metaOf(out[1]!).changes, 1);
    } finally {
        cleanup();
    }
});

test("batch 里的 CTE（WITH ... SELECT）同样要有 results", async () => {
    const { db, cleanup } = tempDb();
    try {
        await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
        await db.prepare("INSERT INTO t (v) VALUES (?)").bind("x").run();
        const out = await db.batch<{ id: number }>([
            db.prepare("WITH c AS (SELECT id FROM t) SELECT id FROM c"),
        ]);
        assert.deepEqual(out[0]!.results, [{ id: 1 }], "WITH 开头的查询被当成写语句了");
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

// ---------------------------------------------------------------------------
// 严格模式（2026-10-30，P1 第 7 项）
// ---------------------------------------------------------------------------
//
// 本机 SQLite 的绑定变量上限是 32766、也没有语句数上限，而 D1 是 **100 个参数 /
// 100 KB 语句**。于是 `IN (?×500)` 这种写法在本机跑得飞起、到线上必炸。
// 这一组用例钉的是「违反 D1 限制时适配器必须抛错」—— 让缺陷在本机就暴露，
// 而不是等上线。默认关（靠 NAVIHIVE_STRICT_D1=1 打开），所以现有套件不受影响。
function withStrict<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
    const before = process.env.NAVIHIVE_STRICT_D1;
    if (on) process.env.NAVIHIVE_STRICT_D1 = "1";
    else delete process.env.NAVIHIVE_STRICT_D1;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (before === undefined) delete process.env.NAVIHIVE_STRICT_D1;
            else process.env.NAVIHIVE_STRICT_D1 = before;
        });
}

/** 一条带 N 个 `?` 的 SQL + N 个绑定值：专用来顶参数上限 */
function sqlWithParams(count: number): { sql: string; args: number[] } {
    return {
        sql: `SELECT 1 WHERE 1 IN (${Array(count).fill("?").join(", ")})`,
        args: Array.from({ length: count }, (_, i) => i),
    };
}

test("严格模式默认关：101 个绑定参数照样执行（现有套件不受影响）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const { sql, args } = sqlWithParams(101);
        const r = await withStrict(false, () => db.prepare(sql).bind(...args).all());
        assert.equal(r.success, true, "默认不查：SQLite 上限 32766，本来也跑得过去");
    } finally {
        cleanup();
    }
});

test("严格模式开：超过 100 个绑定参数直接抛错，且报错里能看出是哪种 SQL", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const { sql, args } = sqlWithParams(101);
        await assert.rejects(
            () => withStrict(true, () => db.prepare(sql).bind(...args).all()),
            (error: unknown) => {
                assert.ok(error instanceof Error, "要抛 Error");
                assert.match(error.message, /101 个参数/);
                assert.match(error.message, /100/);
                // 报错里要能一眼认出调用形态：`?×101` 折叠后仍在消息里
                assert.match(error.message, /\?×101/);
                return true;
            }
        );
    } finally {
        cleanup();
    }
});

test("严格模式开：正好 100 个参数是允许的（边界不能差一个）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const { sql, args } = sqlWithParams(100);
        const r = await withStrict(true, () => db.prepare(sql).bind(...args).all());
        assert.equal(r.success, true);
    } finally {
        cleanup();
    }
});

test("严格模式开：D1 不支持的命名参数（:name）被拦下", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        await assert.rejects(
            () =>
                withStrict(true, () =>
                    db.prepare("SELECT id FROM t WHERE v = :name").bind("x").all()
                ),
            /:name|命名参数|只支持/
        );
        // 字符串字面量里的 :name 不该被当成参数（避免误报）
        const ok = await withStrict(true, () =>
            db.prepare("INSERT INTO t (v) VALUES (?)").bind("a:b @c $d").run()
        );
        assert.equal(ok.success, true);
    } finally {
        cleanup();
    }
});

test("严格模式开：returning 落在字符串字面量里要拦下（正则会被它骗到）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        await assert.rejects(
            () =>
                withStrict(true, () =>
                    db.prepare("INSERT INTO t (v) VALUES ('returning 的字面量')").run()
                ),
            /returning|字面量/
        );
    } finally {
        cleanup();
    }
});

test("严格模式开：exec() 里写 RETURNING 要拦下（那个行永远拿不到）", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        await assert.rejects(
            () => withStrict(true, () => db.exec("DELETE FROM t RETURNING id")),
            /RETURNING|exec/
        );
    } finally {
        cleanup();
    }
});

test("严格模式开：一个 batch 超过保守上限（1000 条）要拦下", async () => {
    const { db, cleanup } = tempDb();
    try {
        await seed(db);
        const many = Array.from({ length: 1001 }, () =>
            db.prepare("INSERT INTO t (v) VALUES (?)").bind("x")
        );
        await assert.rejects(() => withStrict(true, () => db.batch(many)), /1001 条语句/);
        // 1000 条正好在限内：真的执行完
        const ok = await withStrict(true, () =>
            db.batch(Array.from({ length: 1000 }, () => db.prepare("INSERT INTO t (v) VALUES (?)").bind("y")))
        );
        assert.equal(ok.length, 1000);
    } finally {
        cleanup();
    }
});
