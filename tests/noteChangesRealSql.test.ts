// tests/noteChangesRealSql.test.ts
//
// 阶段 5（2026-10-11）：跨设备变更轮询的服务端语义，全部在**真 SQLite** 上验证。
//
// 假 D1 不执行 SQL，「墓碑表缺失」「ambiguous column」「bind 不匹配」这类线上
// 500 在它身上永远红不了 —— 涉及新表（note_tombstone）与时间游标比较的语义
// 必须真库钉死。口径提醒：
//   - 游标用 SQLite CURRENT_TIMESTAMP（秒精度），比较用 >=；
//   - 「宁可重复不可遗漏」：同一秒内的变更被相邻两轮各看见一次是**预期行为**；
//   - 首次轮询（无 since）只初始化游标，恒报 0 变更。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

test("真实 SQLite：notes/changes 的变更计数与墓碑语义", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    // 首次轮询：没有 since，只回快照，恒 0 变更
    const first = await api.notesChanges();
    assert.equal(first.success, true);
    assert.equal(first.notesChanged, 0);
    assert.ok(Array.isArray(first.folders));
    assert.ok(Array.isArray(first.tags));
    const cursor1 = first.now;
    assert.ok(cursor1.length >= 19, "游标必须是 SQLite 时间戳格式");

    // 建一条笔记：下一轮必须看见（updated_at >= cursor1）
    await api.createNote({ title: "设备A建的", content: "v1" });
    const second = await api.notesChanges(cursor1);
    assert.equal(second.notesChanged, 1, "新建的笔记必须被对端看见");
    assert.deepEqual(second.folders, await api.listFolders());

    // 从「上一轮之后」再问：不再重复计数（游标推进到 now 之后就安静了）。
    // ⚠️ 游标是秒精度、比较用 >=：同一秒内的变更可能被相邻两轮各看见一次（预期），
    // 所以这里的「安静」用未来游标验证 —— 真实部署轮询间隔 ≥30s，天然推进。
    const cursor2 = second.now;
    const future = new Date(Date.parse(new Date().toISOString()) + 5_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
    const quiet = await api.notesChanges(future);
    assert.equal(quiet.notesChanged, 0, "游标越过所有变更时间后应该是 0");

    // 软删除（进回收站）：notes 行没了，但墓碑让对端仍能看见
    const notes = await api.listNotes();
    const del = await api.deleteNote(notes[0].id!);
    assert.ok(del.success);
    const afterDelete = await api.notesChanges(cursor2);
    assert.ok(afterDelete.notesChanged >= 1, "软删除必须通过墓碑/updated_at 被看见");

    // 彻底删除（回收站清除）：又一条墓碑
    const purge = await api.purgeRecycleItem(del.recycleId!);
    assert.ok(purge);
    const tombstones = await db
        .prepare("SELECT COUNT(*) AS n FROM note_tombstone")
        .first<{ n: number }>();
    assert.ok((tombstones?.n ?? 0) >= 2, "软删除 + 彻底删除各留一条墓碑");
    const afterPurge = await api.notesChanges(cursor2);
    assert.ok(afterPurge.notesChanged >= 1);
});

test("真实 SQLite：清空回收站与批量清除都写墓碑；空仓库清空不炸", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const a = await api.createNote({ title: "甲", content: "x" });
    const b = await api.createNote({ title: "乙", content: "y" });
    await api.deleteNote(a.id!);
    await api.deleteNote(b.id!);
    const before = await db.prepare("SELECT COUNT(*) AS n FROM note_tombstone").first<{ n: number }>();
    assert.ok((before?.n ?? 0) >= 2);

    await api.emptyRecycleBin();
    // 墓碑只增不减（保留期清理才回收），清空回收站再补两条
    const after = await db.prepare("SELECT COUNT(*) AS n FROM note_tombstone").first<{ n: number }>();
    assert.ok((after?.n ?? 0) >= (before?.n ?? 0) + 2, "清空回收站必须为每条笔记补一条墓碑");

    // 空仓库上重复清空：不该抛错（轮询的稳定性比什么都重要）
    assert.ok(await api.emptyRecycleBin());
});

test("真实 SQLite：folder/tag 变更通过全量快照暴露（即便没有时间戳）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const first = await api.notesChanges();
    const cursor = first.now;
    await api.createFolder({ name: "新夹" });
    const second = await api.notesChanges(cursor);
    // notesChanged 不变（动的是文件夹），但快照内容变了 —— 客户端靠 JSON 比对发现
    assert.equal(second.notesChanged, 0);
    assert.equal(second.folders.length, 1);
    assert.equal(second.folders[0].name, "新夹");
});
