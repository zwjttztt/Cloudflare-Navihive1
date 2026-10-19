// tests/attachmentRenameRealSql.test.ts
//
// 附件重命名的「正文同步」在**真实 SQLite** 上跑一遍（2026-10-19 需求 4「完整方案」）。
//
// 为什么必须真库：这段逻辑有两句生成出来的 SQL ——
//   `SELECT id, content FROM notes WHERE content LIKE ?1 ${scopeSql(true)}`
//   `UPDATE notes SET content = ?, rev = rev + 1 ... WHERE id = ?${scopeSql(true)}`
// —— 而 scopeSql 在登录态会多追加一个 ` AND user_id = ?` 占位符。占位符个数与
// bind 参数个数对不上时（附件方法历史上出过两次线上 500），FakeD1 只会静默照跑，
// 只有真引擎会当场抛错。
//
// 另外三条业务红线也在这里钉住：
//   1. 只改**显示名**，URL（里面是附件 id）一个字都不能动，否则链接点不开；
//   2. 图片语法 `![alt](url)` 不许被改成链接 —— 重命名只对 txt / json 开放；
//   3. 正文真变了就必须 rev + 1，否则别的设备永远不知道这条被改过。
import test from "node:test";
import assert from "node:assert/strict";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";

const ATT_ID = "11111111-2222-3333-4444-555555555555";

/** 直接往库里塞一条附件元数据（不走上传链路，单测不需要存储） */
async function seedAttachment(db: ReturnType<typeof makeRealD1>) {
    await db
        .prepare(
            `INSERT INTO attachments (id, user_id, storage, object_key, filename, mime, size, created_at)
             VALUES (?, NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        )
        .bind(ATT_ID, "kv", `attach/0/${ATT_ID}`, "旧名字.txt", "text/plain", 6)
        .run();
}

test("真实 SQLite：重命名只换方括号里的显示名，URL 与附件 id 不变", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await seedAttachment(db);

    const before = await api.createNote({
        title: "有附件",
        // 上传时插的就是这个形状（带尖括号），见 NotesPage 的 handleAttach
        content: `看附件：[旧名字.txt](</api/notes/attachments/${ATT_ID}>)\n别的正文不动`,
    });
    const result = await api.renameAttachment(ATT_ID, "新名字.txt");
    assert.ok(result.ok);
    assert.equal(result.filename, "新名字.txt");
    assert.equal(result.updatedNotes.length, 1, "引用了它的那篇笔记要被同步");

    const after = await api.getNote(before.id!);
    assert.ok(after);
    assert.ok(
        after.content.includes(`[新名字.txt](</api/notes/attachments/${ATT_ID}>)`),
        after.content
    );
    assert.ok(after.content.includes("别的正文不动"), "正文其它部分不许被顺手改掉");
    assert.ok(
        after.rev !== before.rev,
        `正文变了 rev 必须 +1（before=${before.rev} after=${after.rev}）—— 不然别的设备看不到`
    );

    // 元数据改名成功，且 object_key 没被动过（id 不变 ⇒ 正文链接永不失效）
    const row = await db
        .prepare("SELECT filename, object_key FROM attachments WHERE id = ?")
        .bind(ATT_ID)
        .first<{ filename: string; object_key: string }>();
    assert.equal(row?.filename, "新名字.txt");
    assert.equal(row?.object_key, `attach/0/${ATT_ID}`);
});

test("真实 SQLite：图片语法 ![](…) 不被重命名改成链接", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await seedAttachment(db);

    const note = await api.createNote({
        title: "误当图片嵌入",
        content: `![旧名字.txt](/api/notes/attachments/${ATT_ID})`,
    });
    const result = await api.renameAttachment(ATT_ID, "新名字.txt");
    assert.ok(result.ok);
    assert.deepEqual(result.updatedNotes, [], "图片语法没有可替换的链接 label，应当跳过");

    const after = await api.getNote(note.id!);
    assert.equal(after?.rev, note.rev, "没改动就不该动 rev");
    assert.ok(after?.content.startsWith("![旧名字.txt]"), after?.content);
});

test("真实 SQLite：没有被引用的附件也能改名（只是没有笔记要同步）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await seedAttachment(db);

    const result = await api.renameAttachment(ATT_ID, "孤儿.txt");
    assert.ok(result.ok);
    assert.deepEqual(result.updatedNotes, []);
});

test("真实 SQLite：不存在的附件 → 404，不会静默成功", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const result = await api.renameAttachment("not-exist", "x.txt");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.status : 0, 404);
});
