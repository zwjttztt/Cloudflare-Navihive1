// tests/noteStarRevRealSql.test.ts
//
// 「收藏 / 置顶分离」与「乐观并发 rev」在**真实 SQLite** 里跑一遍。
//
// 两件事都必须真跑 SQL：
//   · 补列（starred/rev）在老库上只有 ALTER 才有 —— CREATE TABLE IF NOT EXISTS 不补列，
//     而「版本号对得上就跳过迁移」的快路径会把补列也一起跳过（note_share.views
//     那个 500 就是这么来的）。FakeD1 不执行 SQL，这里必须连真库才测得出来。
//   · 并发守卫是 `UPDATE ... WHERE id=? AND rev=?` 的 changes 判定 ——
//     只有真引擎才会真的返回「0 行受影响」，替身永远返回 success。

import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { isNoteConflict } from "../src/utils/noteConflict";

async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

test("真实 SQLite：迁移后 notes 有 starred 与 rev 两列（新库）", async () => {
    const { db } = await fresh();
    const cols = (
        await db.prepare("SELECT name FROM pragma_table_info('notes')").all<{ name: string }>()
    ).results.map(c => c.name);
    assert.ok(cols.includes("starred"), "notes 要有 starred 列");
    assert.ok(cols.includes("rev"), "notes 要有 rev 列");
});

test("真实 SQLite：已部署老库（版本号已存 12）也必须补出 starred/rev 两列", async () => {
    // 与 note_share.views 同一个坑的回归钉子：补列代码写了但 SCHEMA_VERSION 忘了 +1
    // → 快路径整段跳过 → 线上「保存笔记 500 / 收藏没反应」，本地全新迁移却全绿。
    resetMigrationCacheForTests();
    const db = makeRealD1();
    await db.exec(`
        CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, uuid TEXT,
            title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0, order_num INTEGER NOT NULL DEFAULT 0,
            site_id INTEGER, archived INTEGER NOT NULL DEFAULT 0, folder_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO configs (key, value) VALUES ('schema.version', '12');
        INSERT INTO notes (id, title, content) VALUES (1, '老笔记', '老正文');
    `);
    const api = makeRealApi(db);
    await api.migrate();

    const cols = (
        await db.prepare("SELECT name FROM pragma_table_info('notes')").all<{ name: string }>()
    ).results.map(c => c.name);
    assert.ok(cols.includes("starred"), "老库升级后必须补出 starred 列");
    assert.ok(cols.includes("rev"), "老库升级后必须补出 rev 列");

    // ⚠️ 老行的 rev 必须是 1 而不是 NULL：NULL 上 `rev = ?` 永远不成立，
    // 并发守卫会变成「这条笔记怎么都保存不了」。
    const row = await db.prepare("SELECT rev FROM notes WHERE id = 1").first<{ rev: unknown }>();
    assert.equal(row?.rev, 1, "老行的 rev 必须回填成 1（NULL 会让并发守卫永远挡住保存）");

    // 补完列后保存要真的能跑通（线上症状就是这条 UPDATE 500 / 静默无效）
    const saved = await api.updateNote(1, { content: "新正文" });
    assert.ok(saved, "老库补列后保存要能成功");
    assert.equal(saved?.content, "新正文");
});

test("真实 SQLite：每次保存 rev +1（客户端拿到的是新版本）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "a" });
    assert.equal(note.rev, 1, "新建的笔记 rev 从 1 起算");
    const second = await api.updateNote(note.id!, { content: "b" });
    assert.equal(second?.rev, 2, "保存一次 rev 要 +1");
    const third = await api.updateNote(note.id!, { content: "c" });
    assert.equal(third?.rev, 3, "再保存一次再 +1");
});

test("真实 SQLite：带过期 rev 保存 → 抛冲突，且冲突里带着库里当前那版", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "我这版" });
    // 模拟「另一个设备先保存了」
    const elsewhere = await api.updateNote(note.id!, { content: "别人那版" });
    assert.equal(elsewhere?.rev, 2);

    let caught: unknown = null;
    try {
        // 这台设备手里的还是 rev=1
        await api.updateNote(note.id!, { content: "我这版 b", rev: 1 });
    } catch (error) {
        caught = error;
    }
    assert.ok(isNoteConflict(caught), "过期 rev 必须抛冲突（不是静默覆盖）");
    const conflict = caught as { note?: { content?: string; rev?: number } };
    assert.equal(conflict.note?.content, "别人那版", "冲突里要带上库里当前的内容，前端才能显示");
    assert.equal(conflict.note?.rev, 2);

    // 冲突不能把库里的东西改掉
    const after = await api.getNote(note.id!);
    assert.equal(after?.content, "别人那版", "冲突时不能写入任何东西");
});

test("真实 SQLite：带上当前 rev 就正常保存（并发生效但不挡正常路径）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "a" });
    const saved = await api.updateNote(note.id!, { content: "b", rev: note.rev });
    assert.equal(saved?.content, "b", "rev 对得上必须正常保存");
    assert.equal(saved?.rev, 2);
});

test("真实 SQLite：不传 rev 就是老行为（无条件覆盖）—— 老客户端不受影响", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "a" });
    await api.updateNote(note.id!, { content: "别人那版" });
    // 老前端不知道 rev 这回事：照旧保存成功
    const saved = await api.updateNote(note.id!, { content: "我这版" });
    assert.equal(saved?.content, "我这版", "不传 rev 时必须照旧覆盖（老客户端不能突然保存不了）");
});

test("真实 SQLite：收藏与置顶互不影响（置顶管排序、收藏管筛选）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "a" });
    // 只收藏：置顶不能被顺手改掉
    const starred = await api.updateNote(note.id!, { starred: true });
    // ⚠️ SQLite 里布尔存的是 0/1，读回来是数字不是 true —— 断言一律先 Boolean()
    assert.equal(Boolean(starred?.starred), true, "收藏要写进去");
    assert.equal(Boolean(starred?.pinned), false, "收藏不该把置顶也打开");

    // 只置顶：收藏不能被动
    const pinned = await api.updateNote(note.id!, { pinned: true });
    assert.equal(Boolean(pinned?.pinned), true);
    assert.equal(Boolean(pinned?.starred), true, "置顶不该把收藏清掉");

    // 取消收藏不影响置顶
    const off = await api.updateNote(note.id!, { starred: false });
    assert.equal(Boolean(off?.starred), false);
    assert.equal(Boolean(off?.pinned), true, "取消收藏不该把置顶也关掉");
});

test("真实 SQLite：删了再还原，收藏还在（还原按白名单逐列写，漏一列就丢）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "甲", content: "a" });
    await api.updateNote(note.id!, { starred: true, pinned: true });
    const res = await api.deleteNote(note.id!);
    assert.ok(res.recycleId, "删除要进回收站");
    assert.equal(await api.restoreRecycleItem(res.recycleId!), true);

    const back = (await api.listNotes()).find(n => n.uuid === note.uuid);
    assert.ok(back, "还原后要找得到这条笔记");
    assert.equal(Boolean(back?.starred), true, "还原后收藏要还在");
    assert.equal(Boolean(back?.pinned), true, "还原后置顶也要还在");
});
