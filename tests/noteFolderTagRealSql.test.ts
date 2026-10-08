// tests/noteFolderTagRealSql.test.ts
//
// 「文件夹 / 标签」的建、删在**真实 SQLite**里跑一遍 —— 而不是 FakeD1 / MockD1。
//
// 为什么必须真的跑 SQL：2026-10-06 线上「新建文件夹 500」「删除文件夹 500」，
// 根因是已部署的 note_folder 表**没有 parent_id 列**（老库建表时还没有这列，
// CREATE TABLE IF NOT EXISTS 不补、migrateFolderTagTables 又没接进 runMigrations）。
// createFolder 的 `INSERT INTO note_folder (user_id, name, parent_id, order_num)`
// 和 deleteFolder 的 `UPDATE note_folder SET parent_id = NULL` 都踩到这个缺列 → 500。
//
// 而 FakeD1 / MockD1 根本不执行 SQL、只按前缀/结构匹配，这种「真实库里缺一列」的错
// 在它们身上永远红不了 —— 所以单测全绿、线上照 500。只有真连一个会执行 SQL 的引擎，
// 才能把「列到底存不存在、SQL 到底跑不跑得通」钉死。
//
// 这里用 node:sqlite（Node 22 自带）起一个内存库，套一层「长得像 D1」的适配器，
// 直接调真实的 notesImpl 方法。任一操作踩到缺列 / 语法错，就会真的抛出来 → 用例红。

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";

/** 把 node:sqlite 包成 D1 形状的替身：prepare/bind/all/first/run/batch/exec 都对得上 */
function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) {
                bound = args as SQLInputValue[];
                return prepared;
            },
            all<T = Record<string, unknown>>() {
                return { results: stmt.all(...bound) as T[], success: true as const };
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return (row ?? null) as T | null;
            },
            run() {
                const r = stmt.run(...bound);
                return { success: true as const, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        batch: async (stmts: Array<{ run: () => Promise<{ success: boolean }> }>) =>
            Promise.all(stmts.map(s => s.run())),
        async exec(sql: string) {
            db.exec(sql);
        },
    };
}

test("真实 SQLite：分享隔离、令牌轮换、到期、撤销与公开字段白名单", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    const note = await api.createNote({ title: "公开标题", content: "正文" });
    const id = note.id!;
    const share = await api.createNoteShare(id, 7);
    assert.ok(share);
    assert.match(share.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys((await api.getPublicNote(share.token))!).sort(), ["content", "title", "updated_at"]);
    api.setCurrentUser(123);
    assert.equal(await api.getNoteShare(id), null);
    assert.equal(await api.createNoteShare(id, 1), null);
    await api.revokeNoteShare(id);
    assert.ok(await api.getPublicNote(share.token));
    api.setCurrentUser(null);
    const rotated = await api.createNoteShare(id, null);
    assert.ok(rotated);
    assert.notEqual(rotated.token, share.token);
    assert.equal(await api.getPublicNote(share.token), null);
    await db.prepare("UPDATE note_share SET expires_at = 0 WHERE note_id = ?").bind(id).run();
    assert.equal(await api.getPublicNote(rotated.token), null);
    const fresh = await api.createNoteShare(id, 1);
    assert.ok(fresh);
    await api.revokeNoteShare(id);
    assert.equal(await api.getPublicNote(fresh.token), null);
    assert.equal(await api.getPublicNote("../../notes"), null);
    await assert.rejects(api.createNoteShare(id, 2), /有效期/);
    const beforeDelete = await api.createNoteShare(id, null);
    assert.ok(beforeDelete);
    await api.deleteNote(id);
    assert.equal(await api.getPublicNote(beforeDelete.token), null);
    assert.equal(await db.prepare("SELECT token FROM note_share WHERE note_id = ?").bind(id).first(), null);
});

test("真实 SQLite：附件四方法在登录态（uid≠null）下 bind 数量与占位符必须匹配", async () => {
    // 2026-10-09 线上「图片显示不出（服务器返回 500）」的真因：
    // getAttachment / deleteAttachment 直接 .bind(id)（SQL 里 scopeSql(true) 还有一个
    // user_id 占位符），listAttachments / pruneAttachments 的 scopeSql(false) 干脆没 bind
    // —— 登录用户下占位符比参数多一个，D1 抛 wrong number of bindings → 500。
    // 单账号部署（uid=null）scopeSql 返回空串，所以本机/旧用例全绿测不出；
    // FakeD1 不校验 bind 数量，只有真 SQLite 能把这类错钉死。
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();
    api.setCurrentUser(123);

    // 正文里带 att-1 的引用（prune 的判据是「正文全集里没出现过的 id 才清」）
    const note = await api.createNote({
        title: "带图笔记",
        content: "![a](/api/notes/attachments/att-1)",
    });
    assert.ok(note.id, "建笔记失败");
    await api.createAttachment({
        id: "att-1",
        note_id: note.id!,
        filename: "a.png",
        mime: "image/png",
        size: 3,
        storage: "kv",
        object_key: "attach/123/att-1",
    });
    await api.createAttachment({
        id: "att-orphan",
        note_id: null,
        filename: "b.png",
        mime: "image/png",
        size: 4,
        storage: "kv",
        object_key: "attach/123/att-orphan",
    });

    // 1) listAttachments：scopeSql(false) 的 WHERE user_id = ? 必须补 bind
    const listed = await api.listAttachments();
    assert.equal(listed.length, 2, "listAttachments 在登录态下失败（疑似 bind 数量不匹配 → 线上 500）");

    // 2) getAttachment：scopeSql(true) 追加的占位符必须 scopeParams 补上
    const found = await api.getAttachment("att-1");
    assert.ok(found, "getAttachment 在登录态下失败（疑似 bind 数量不匹配 → 线上取图 500）");
    assert.equal(found!.object_key, "attach/123/att-1");

    // 3) pruneAttachments：两条 scopeSql(false) 的 SELECT 同样要 bind
    const pruned = await api.pruneAttachments();
    assert.deepEqual(
        pruned.removed.map(r => r.id),
        ["att-orphan"],
        "pruneAttachments 清单不对（未被引用的才清）"
    );

    // 4) deleteAttachment：SELECT + DELETE 两处都要 scopeParams
    const del = await api.deleteAttachment("att-1");
    assert.ok(del.ok, "deleteAttachment 在登录态下失败（疑似 bind 数量不匹配 → 线上删图 500）");
    assert.equal(del.ok && del.objectKey, "attach/123/att-1");

    assert.equal((await api.listAttachments()).length, 0, "删完应该一张不剩");
});

type RealD1 = ReturnType<typeof makeRealD1>;

function makeApi(db: RealD1): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

test("真实 SQLite：迁移后 note_folder 必须有 parent_id 列", async () => {
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();

    const cols = (await realDb.prepare("SELECT name FROM pragma_table_info('note_folder')").all<{ name: string }>()).results;
    assert.ok(
        cols.some(c => c.name === "parent_id"),
        "迁移后 note_folder 仍缺 parent_id 列 —— 老库上 createFolder / deleteFolder 会 500"
    );
});

test("真实 SQLite：createFolder / deleteFolder / createTag / deleteTag 全部跑通", async () => {
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();

    // 1) 新建文件夹：INSERT 直接引用 parent_id，缺列就 500
    const folder = await api.createFolder({ name: "测试文件夹" });
    assert.ok(folder?.id, "createFolder 没返回有效 id（疑似 500）");
    const folderId = folder.id!;
    const row = await realDb.prepare("SELECT parent_id FROM note_folder WHERE id = ?").bind(folderId).first<{ parent_id: unknown }>();
    assert.equal(row?.parent_id, null, "parent_id 列不可写");

    // 2) 删除文件夹：batch 里 UPDATE note_folder SET parent_id = NULL，缺列就 500
    const delFolder = await api.deleteFolder(folderId);
    assert.equal(delFolder.success, true, "deleteFolder 失败（疑似 500）");

    // 3) 新建标签 + 4) 删除标签
    const tag = await api.createTag({ name: "测试标签" });
    assert.ok(tag?.id, "createTag 没返回有效 id");
    const tagId = tag.id!;
    const delTag = await api.deleteTag(tagId);
    assert.equal(delTag.success, true, "deleteTag 失败");

    // 兜底：文件夹确实删掉了
    const remaining = (await realDb.prepare("SELECT id FROM note_folder").all()).results;
    assert.equal(remaining.length, 0, "文件夹没被真正删掉");

    // 标签也确实删掉了（关联表跟着清）
    const tagsLeft = (await realDb.prepare("SELECT id FROM note_tag").all()).results;
    assert.equal(tagsLeft.length, 0, "标签没被真正删掉");
});

test("真实 SQLite：删带子文件夹的父文件夹，子文件夹的 parent_id 被置空而非悬空", async () => {
    // deleteFolder 的 batch 第二条：`UPDATE note_folder SET parent_id = NULL WHERE parent_id = ?`
    // 缺 parent_id 列时这一条会炸、整批回滚 → 父文件夹也删不掉。这里验证它真的把子项解绑。
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();

    const parent = await api.createFolder({ name: "父" });
    assert.ok(parent?.id, "建父文件夹失败");
    const parentId = parent.id!;
    const child = await api.createFolder({ name: "子", parent_id: parentId });
    assert.ok(child?.id, "建子文件夹失败");
    const childId = child.id!;
    assert.equal(child.parent_id, parentId, "子文件夹没挂到父上");

    const res = await api.deleteFolder(parentId);
    assert.equal(res.success, true, "删父文件夹失败（疑似 parent_id 列缺失）");

    const childAfter = await realDb.prepare("SELECT parent_id FROM note_folder WHERE id = ?").bind(childId).first<{ parent_id: unknown }>();
    assert.equal(childAfter?.parent_id, null, "删父文件夹后，子文件夹的 parent_id 没被置空（会悬空）");
});
