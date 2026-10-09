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
            // ⚠️ 真 D1 的 all()/first()/run() 都返回 Promise（哪怕立即 resolve），
            // 业务代码里有 `.all().then(...)` 这样的链式用法 —— 替身必须包成 Promise，
            // 否则「分享列表」这类方法在替身上跑不通（真库上反而没问题）。
            all<T = Record<string, unknown>>() {
                return Promise.resolve({
                    results: stmt.all(...bound) as T[],
                    success: true as const,
                });
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return Promise.resolve((row ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({ success: true as const, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } });
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
    const pub0 = await api.getPublicNote(share.token);
    assert.equal(pub0.status, "ok");
    assert.deepEqual(Object.keys(pub0.note).sort(), ["content", "title", "updated_at"]);
    api.setCurrentUser(123);
    assert.equal(await api.getNoteShare(id), null);
    assert.equal(await api.createNoteShare(id, 1), null);
    await api.revokeNoteShare(id);
    assert.ok(await api.getPublicNote(share.token));
    api.setCurrentUser(null);
    const rotated = await api.createNoteShare(id, null);
    assert.ok(rotated);
    assert.notEqual(rotated.token, share.token);
    assert.equal((await api.getPublicNote(share.token)).status, "not-found");
    await db.prepare("UPDATE note_share SET expires_at = 0 WHERE note_id = ?").bind(id).run();
    assert.equal((await api.getPublicNote(rotated.token)).status, "not-found");
    const fresh = await api.createNoteShare(id, 1);
    assert.ok(fresh);
    await api.revokeNoteShare(id);
    assert.equal((await api.getPublicNote(fresh.token)).status, "not-found");
    assert.equal((await api.getPublicNote("../../notes")).status, "not-found");
    await assert.rejects(api.createNoteShare(id, 2), /有效期/);
    const beforeDelete = await api.createNoteShare(id, null);
    assert.ok(beforeDelete);
    await api.deleteNote(id);
    assert.equal((await api.getPublicNote(beforeDelete.token)).status, "not-found");
    assert.equal(await db.prepare("SELECT token FROM note_share WHERE note_id = ?").bind(id).first(), null);
});

test("真实 SQLite：访问口令（need-password / 校验）与浏览次数自增", async () => {
    // 2026-10-09 补的 SharePanel 能力：分享可设访问口令（公开页弹框）、每次成功打开 +1。
    // 口令校验失败必须回 need-password 而不是 ok；浏览次数只在「成功打开」时自增，
    // 被口令拦下不能算一次浏览。
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署
    const note = await api.createNote({ title: "受口令保护", content: "正文" });
    const id = note.id!;

    // 建分享时不设口令 → 公开直接可取，浏览次数记 1
    const open = await api.createNoteShare(id, null);
    assert.ok(open);
    assert.equal(!open!.hasPassword, true, "不设口令时 hasPassword 应为假");
    const first = await api.getPublicNote(open!.token);
    assert.equal(first.status, "ok", "不设口令应直接出正文");
    assert.equal(first.status === "ok" ? first.views : 0, 1, "首次打开应记 1 次浏览");

    // 设口令
    const setPw = await api.updateNoteShare(id, null, "s3cret");
    assert.ok(setPw);
    assert.equal(!!setPw!.hasPassword, true, "设口令后 hasPassword 应为真");

    // 没给口令 → need-password（且不计浏览）
    assert.equal((await api.getPublicNote(open!.token)).status, "need-password");
    // 错口令 → need-password（且不计浏览）
    assert.equal((await api.getPublicNote(open!.token, "wrong")).status, "need-password");

    // 对口令 → ok，浏览次数 +1（1 → 2）
    const ok = await api.getPublicNote(open!.token, "s3cret");
    assert.equal(ok.status, "ok", "对口令应出正文");
    assert.equal(ok.status === "ok" ? ok.views : 0, 2, "输对口令打开应再 +1");

    // 清除口令（传 null）→ 又可直接打开，且再 +1（2 → 3）
    const cleared = await api.updateNoteShare(id, null, null);
    assert.ok(cleared);
    assert.equal(!cleared!.hasPassword, true, "清除口令后 hasPassword 应为假");
    const reopen = await api.getPublicNote(open!.token);
    assert.equal(reopen.status, "ok", "清除口令后应可直接打开");
    assert.equal(reopen.status === "ok" ? reopen.views : 0, 3, "再打开应 +1");

    // 令牌格式校验：乱填的 token 永不命中
    assert.equal((await api.getPublicNote("../../evil")).status, "not-found");
});

test("真实 SQLite：notesStats 全站计数（版本历史 = 快照数，双链 = [[引用]] 次数不含嵌入）", async () => {
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署

    // 初始为 0
    const empty = await api.notesStats();
    assert.deepEqual(empty, { versions: 0, links: 0 });

    const a = await api.createNote({ title: "甲", content: "见 [[乙]] 与 [[丙]]，嵌入不算 [[...]]".replace("[[...]]", "![[嵌入块]]") });
    const b = await api.createNote({ title: "乙", content: "没有链接的正文" });
    assert.ok(a.id && b.id);

    // 每次更新留一份快照（pushRevision，存的是改动前的内容）：改两次 = 2 份
    await api.updateNote(a.id!, { content: "见 [[乙]]（改）" });
    await api.updateNote(a.id!, { content: "见 [[乙]] 与 [[丙]]（再改）" });

    const stats = await api.notesStats();
    // 双链扫的是**当前正文**（不是历史快照）：甲现文 [[乙]]+[[丙]] = 2，乙 = 0 → 共 2
    assert.equal(stats.links, 2, "双链按当前正文出现次数计（不含 ![[嵌入]]）");
    assert.equal(stats.versions, 2, "版本历史 = 快照行数（创建不算，更新两次 = 2）");

    // 账号隔离：另一个账号看不到这批计数
    api.setCurrentUser(777);
    const other = await api.notesStats();
    assert.deepEqual(other, { versions: 0, links: 0 }, "别的账号必须看到全 0");
});

test("真实 SQLite：importNotesData 按 uuid 合并（较新者胜）+ 文件夹/标签重映射", async () => {
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    const api = makeApi(realDb);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署

    const expFolder = { id: 11, name: "工作", parent_id: null };
    const expTag = { id: 21, name: "重要", color: "#ff0000" };
    const base = {
        kind: "navihive-notes-export",
        folders: [expFolder],
        tags: [expTag],
        noteTags: { "101": [21] },
    };

    // 1) 首次导入：全部新增，文件夹/标签重建、关联翻译
    let r = await api.importNotesData({
        ...base,
        notes: [{
            id: 101,
            uuid: "uuid-a",
            title: "甲",
            content: "正文甲",
            folder_id: 11,
            updated_at: "2026-10-01T10:00:00.000Z",
        } as never],
    });
    assert.deepEqual({ created: r.created, updated: r.updated, skipped: r.skipped }, { created: 1, updated: 0, skipped: 0 });

    const imported = (await api.listNotes()).find(n => n.uuid === "uuid-a");
    assert.ok(imported, "导入的笔记要能查到");
    assert.equal(imported!.folder_id, (await api.listFolders()).find(f => f.name === "工作")?.id, "文件夹要按名称重映射");
    const tagLinks = await api.listNoteTags();
    const importedTag = (await api.listTags()).find(t => t.name === "重要");
    assert.ok(importedTag, "标签要重建");
    assert.deepEqual(tagLinks[imported!.id!], [importedTag!.id], "标签关联要翻译到新 id");

    // 2) 原样再导一次：同 updated_at → 保留本地，不重复建
    r = await api.importNotesData({
        ...base,
        notes: [{
            id: 101, uuid: "uuid-a", title: "甲", content: "正文甲", folder_id: 11,
            updated_at: "2026-10-01T10:00:00.000Z",
        } as never],
    });
    assert.deepEqual({ created: r.created, updated: r.updated, skipped: r.skipped }, { created: 0, updated: 0, skipped: 1 });
    assert.equal((await api.listNotes()).length, 1, "重复导入不能多出笔记");

    // 3) 文件里较新 → 覆盖本地（本地 updated_at 是导入时的 CURRENT_TIMESTAMP「今天」，
    //    所以「较新」必须用一个明确的未来日期才立得住）
    r = await api.importNotesData({
        ...base,
        notes: [{
            id: 101, uuid: "uuid-a", title: "甲（新）", content: "正文甲 v2", folder_id: 11,
            updated_at: "2027-06-01T00:00:00.000Z",
        } as never],
    });
    assert.deepEqual({ created: r.created, updated: r.updated }, { created: 0, updated: 1 });
    const after = (await api.listNotes()).find(n => n.uuid === "uuid-a");
    assert.equal(after!.title, "甲（新）", "文件较新时要覆盖本地");
    assert.equal((await api.listNotes()).length, 1, "覆盖写回原条目，不能多出一条");

    // 4) 本地较新 → 保留本地
    r = await api.importNotesData({
        ...base,
        notes: [{
            id: 101, uuid: "uuid-a", title: "甲（旧）", content: "旧内容", folder_id: 11,
            updated_at: "2020-01-01T00:00:00.000Z",
        } as never],
    });
    assert.equal(r.skipped, 1, "本地较新要跳过");
    assert.equal((await api.listNotes()).find(n => n.uuid === "uuid-a")!.title, "甲（新）", "跳过时本地内容不动");

    // 5) 脏数据容错：形状不对的条目丢弃，不拖垮整批
    r = await api.importNotesData({
        notes: [
            { uuid: "uuid-b", title: "乙", content: "正文乙" },
            { title: 123, content: null },
        ] as never,
    });
    assert.equal(r.created, 1, "有效的那条要进来");
    assert.ok((await api.listNotes()).some(n => n.uuid === "uuid-b"));

    // 6) 账号隔离：另一个账号导入同 uuid 是新增，互不干扰
    api.setCurrentUser(555);
    r = await api.importNotesData({
        notes: [{ id: 101, uuid: "uuid-a", title: "别人的甲", content: "x", updated_at: "2026-10-03T10:00:00.000Z" } as never],
    });
    assert.equal(r.created, 1, "别的账号导入同 uuid 应当是新增");
    api.setCurrentUser(null);
    assert.equal((await api.listNotes()).find(n => n.uuid === "uuid-a")!.title, "甲（新）", "别的账号的导入不能动本账号数据");
});

test("真实 SQLite：migrateNoteShareColumns 幂等（password/views 可重复迁移不报错）", async () => {
    // 升级前老库 note_share 没有 password / views 两列，CREATE TABLE IF NOT EXISTS 不补列，
    // 必须靠 migrateNoteShareColumns 的 ALTER 补。连跑两次不能因为「列已存在」而崩。
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    // 手动建一张「老结构」的 note_share（无 password / views），模拟升级前库
    await realDb.exec(
        "CREATE TABLE note_share (note_id INTEGER PRIMARY KEY, note_uuid TEXT NOT NULL, user_id INTEGER, token TEXT NOT NULL UNIQUE, expires_at INTEGER);"
    );
    const api = makeApi(realDb);
    await api.migrate();
    // 再跑一次完整迁移：hasColumn 守卫必须让 ALTER 跳过，不能重复加列报错
    await api.migrate();
    // 直接再调一次底层方法，证明 ALTER 守卫本身幂等
    await api.migrateNoteShareColumns();
    const cols = (await realDb.prepare("SELECT name FROM pragma_table_info('note_share')").all<{ name: string }>())
        .results.map(c => c.name);
    assert.ok(cols.includes("password"), "缺 password 列");
    assert.ok(cols.includes("views"), "缺 views 列");
});

test("真实 SQLite：已部署老库（版本号已存 12）也必须补出 password/views 列", async () => {
    // 2026-10-09 线上「分享列表 API错误: 500」的回归钉子：
    // 补列代码（runMigrations 6.7 步）写了但 SCHEMA_VERSION 忘了 +1 —— 已部署的库
    // 存着 "12"，新代码也是 "12"，migrateIfNeeded 快路径整段跳过迁移，
    // views 列永远补不上 → listNoteShares 的 SELECT s.views 500。
    // 本地/新库是全新迁移必然跑，所以这个坑只有「伪造已部署状态」才测得出。
    resetMigrationCacheForTests();
    const realDb = makeRealD1();
    await realDb.exec(`
        CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE note_share (note_id INTEGER PRIMARY KEY, note_uuid TEXT NOT NULL,
            user_id INTEGER, token TEXT NOT NULL UNIQUE, expires_at INTEGER);
        INSERT INTO configs (key, value) VALUES ('schema.version', '12');
    `);
    const api = makeApi(realDb);
    await api.migrate();
    const cols = (await realDb.prepare("SELECT name FROM pragma_table_info('note_share')").all<{ name: string }>())
        .results.map(c => c.name);
    assert.ok(cols.includes("views"), "老库（版本号 12）升级后必须补出 views 列");
    assert.ok(cols.includes("password"), "老库（版本号 12）升级后必须补出 password 列");
    // 版本号要写到新值，下次冷启动不再重跑。
    // ⚠️ 别钉死具体数字：每加一次迁移 SCHEMA_VERSION 就要 +1，钉死的用例会
    // 变成「每次加迁移都红一次」的噪音（真正要守住的是「比老值 12 大」）。
    const ver = await realDb.prepare("SELECT value FROM configs WHERE key = 'schema.version'").first<{ value: string }>();
    assert.ok(
        Number(ver?.value) > 12,
        "迁移完要把版本号写成比 12 大的新值（当前：" + ver?.value + "）"
    );
    // 补完列后分享全链路要真的能跑（这正是线上 500 的那条查询）
    api.setCurrentUser(null);
    const note = await api.createNote({ title: "升级后", content: "正文" });
    const share = await api.createNoteShare(note.id!, 7);
    assert.ok(share);
    const list = await api.listNoteShares();
    assert.equal(list.length, 1);
    assert.equal(list[0].views, 0, "老分享的浏览次数从 0 计起");
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
