// tests/noteLinkCount.test.ts
// 真实 SQLite 上验证 `notes.link_count` 这一列的口径（2026-10-24，P1-2）。
//
// 背景：数据页的「双链」一格要的是**当前账号的全站总数**，而前端只持有截断后的列表
// （`?fields=list`），本地算不了。老实现是「SELECT content FROM notes 全表拉回 JS
// 逐条正则」—— 打开一次数据页就把全部正文从 D1 搬进 Worker。
// 现在改成「写入时算好、读取时 SUM 一列」。
//
// 这条数的正确性完全取决于**三条写入路径都维护它**（createNote / updateNote / 导入），
// 漏一处就会慢慢累出偏差，而这种偏差没人会主动去查。所以这里逐条钉住。

import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { SCHEMA_VERSION_KEY } from "../src/API/methods/migration";

const SAMPLE = "见 [[甲]] 与 [[乙]]，还有嵌入 ![[丙]]，重复一次 [[甲]]。";

/** 正文里真正的双链数（`![[…]]` 不算）：甲、乙、甲 = 3 */
const SAMPLE_EXPECTED = 3;

test("新建笔记：link_count 在写入时就算好（不是靠后续统计补）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const created = await api.createNote({ title: "t", content: SAMPLE });
    const row = await db
        .prepare("SELECT link_count FROM notes WHERE id = ?")
        .bind(created.id)
        .first<{ link_count: number }>();
    assert.equal(row?.link_count, SAMPLE_EXPECTED);
});

test("改正文：link_count 跟着重算", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const created = await api.createNote({ title: "t", content: SAMPLE });
    await api.updateNote(created.id!, { content: "只有 [[一个]]" });
    let row = await db
        .prepare("SELECT link_count FROM notes WHERE id = ?")
        .bind(created.id)
        .first<{ link_count: number }>();
    assert.equal(row?.link_count, 1, "改完正文后必须重算，否则数字永远停在旧值");

    await api.updateNote(created.id!, { content: "一个都没有" });
    row = await db
        .prepare("SELECT link_count FROM notes WHERE id = ?")
        .bind(created.id)
        .first<{ link_count: number }>();
    assert.equal(row?.link_count, 0, "从有到无也要能归零");
});

test("只改标题 / 置顶：不动 link_count（不该为无关字段重算）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const created = await api.createNote({ title: "t", content: SAMPLE });
    await api.updateNote(created.id!, { title: "改个名", pinned: true });
    const row = await db
        .prepare("SELECT link_count FROM notes WHERE id = ?")
        .bind(created.id)
        .first<{ link_count: number }>();
    assert.equal(row?.link_count, SAMPLE_EXPECTED);
});

test("notesStats.links = 各行 link_count 之和（不是现扫正文）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    await api.createNote({ title: "a", content: SAMPLE }); // 3
    await api.createNote({ title: "b", content: "[[x]]" }); // 1
    await api.createNote({ title: "c", content: "没有" }); // 0

    const stats = await api.notesStats();
    assert.equal(stats.links, SAMPLE_EXPECTED + 1);
});

test("导入（新增 / 覆盖）：两条路径都要维护 link_count", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    // 先有本地一条
    const local = await api.createNote({ title: "本地", content: "无" });
    // 导入的「覆盖」分支判据是 `Date.parse(导入.updated_at) > Date.parse(本地.updated_at)`，
    // 不带 updated_at 会被当成「不比本地新」而跳过 —— 所以这里给一个未来时间
    const future = new Date(Date.now() + 60_000).toISOString();

    await api.importNotesData({
        kind: "navihive-notes-backup",
        exportedAt: new Date().toISOString(),
        notes: [
            // 新增（uuid 本地没有）
            { uuid: "uuid-new-1", title: "新增", content: SAMPLE },
            // 覆盖（uuid 撞上本地那条，且 updated_at 更新）
            { uuid: local.uuid!, title: "覆盖", content: "[[p]] [[q]]", updated_at: future },
        ],
        folders: [],
        tags: [],
        noteTags: {},
    });

    const rows = await db
        .prepare("SELECT title, link_count FROM notes ORDER BY title")
        .bind()
        .all<{ title: string; link_count: number | null }>();
    const byTitle = Object.fromEntries((rows.results ?? []).map(r => [r.title, r.link_count]));
    assert.equal(byTitle["新增"], SAMPLE_EXPECTED, "导入新增的笔记要带上 link_count");
    assert.equal(byTitle["覆盖"], 2, "导入覆盖的笔记要重算 link_count");
    assert.equal(
        Object.values(byTitle).includes(null),
        false,
        "导入路径不该留下 NULL —— 那是「还没算过」的哨兵，统计时会当 0"
    );
});

test("迁移回填：老库（link_count = NULL）升级后一次填对，且不重复扫已填过的行", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    await api.createNote({ title: "a", content: SAMPLE });
    await api.createNote({ title: "b", content: "[[x]]" });

    // 模拟老库：这一列刚加上、全是 NULL；版本号也退回上一档
    await db.prepare("UPDATE notes SET link_count = NULL").run();
    await db.prepare("DELETE FROM configs WHERE key = ?").bind(SCHEMA_VERSION_KEY).run();
    // 2026-10-25：迁移机制从「全局单号」改成「已执行 step 集合」（见 methods/migration.ts）。
    // 模拟老库必须**两个键都删** —— 只删版本号的话，step 集合还在，
    // 所有步骤会被当成「已跑过」全部跳过，回填压根不会发生，
    // 这条用例就会变成假绿（而下面那条「不覆盖已有值」本来就已经是假绿了）。
    await db.prepare("DELETE FROM configs WHERE key = ?").bind("schema.steps").run();
    resetMigrationCacheForTests();
    await api.migrate();

    const nulls = await db
        .prepare("SELECT COUNT(*) AS n FROM notes WHERE link_count IS NULL")
        .bind()
        .first<{ n: number }>();
    assert.equal(nulls?.n, 0, "回填完成后不该再有 NULL");

    const stats = await api.notesStats();
    assert.equal(stats.links, SAMPLE_EXPECTED + 1);
});

test("回填只挑 NULL 的行：已经算过的值不会被重扫覆盖", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const a = await api.createNote({ title: "a", content: SAMPLE });
    // 人为把一个值改成一个「明显不是重算能得出的数」，再看回填会不会碰它
    await db.prepare("UPDATE notes SET link_count = 999 WHERE id = ?").bind(a.id).run();
    await db.prepare("DELETE FROM configs WHERE key = ?").bind(SCHEMA_VERSION_KEY).run();
    // 2026-10-25：迁移机制从「全局单号」改成「已执行 step 集合」（见 methods/migration.ts）。
    // 模拟老库必须**两个键都删** —— 只删版本号的话，step 集合还在，
    // 所有步骤会被当成「已跑过」全部跳过，回填压根不会发生，
    // 这条用例就会变成假绿（而下面那条「不覆盖已有值」本来就已经是假绿了）。
    await db.prepare("DELETE FROM configs WHERE key = ?").bind("schema.steps").run();
    resetMigrationCacheForTests();
    await api.migrate();

    const row = await db
        .prepare("SELECT link_count FROM notes WHERE id = ?")
        .bind(a.id)
        .first<{ link_count: number }>();
    assert.equal(row?.link_count, 999, "只回填 NULL 的行 —— 已有值不该被迁移覆盖");
});

test("pruneAttachments：正文引用的留下，没引用的删掉（SQL 侧判断，不拼正文大全集）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const usedId = "used-attachment";
    const orphanId = "orphan-attachment";
    for (const id of [usedId, orphanId]) {
        await db
            .prepare(
                `INSERT INTO attachments (id, user_id, storage, object_key, filename, mime, size, created_at)
                 VALUES (?, NULL, 'kv', ?, 'x.png', 'image/png', 1, CURRENT_TIMESTAMP)`
            )
            .bind(id, `notes/0/${id}`)
            .run();
    }
    await api.createNote({ title: "引用图", content: `![x](/api/notes/attachments/${usedId})` });

    const removed = await api.pruneAttachments();
    const goneIds = removed.removed.map(r => r.id);
    assert.deepEqual(goneIds, [orphanId], "只该删没有任何正文引用的那个");

    const left = await db
        .prepare("SELECT id FROM attachments ORDER BY id")
        .bind()
        .all<{ id: string }>();
    assert.deepEqual((left.results ?? []).map(r => r.id), [usedId]);
});

test("pruneAttachments：回收站里的笔记也算「还在用」（还原后图片还得能打开）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const id = "trashed-ref";
    await db
        .prepare(
            `INSERT INTO attachments (id, user_id, storage, object_key, filename, mime, size, created_at)
             VALUES (?, NULL, 'kv', ?, 'x.png', 'image/png', 1, CURRENT_TIMESTAMP)`
        )
        .bind(id, `notes/0/${id}`)
        .run();
    const note = await api.createNote({ title: "会被删的笔记", content: `/api/notes/attachments/${id}` });
    await api.deleteNote(note.id!);

    const removed = await api.pruneAttachments();
    assert.deepEqual(
        removed.removed.map(r => r.id),
        [],
        "笔记进回收站不代表附件没用了 —— 还原之后图还得能打开"
    );
});
