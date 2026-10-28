// tests/noteFtsRowidRealSql.test.ts
//
// FTS5 的 rowid 契约（2026-10-28，性能）：**fts 行的 rowid 恒等于 notes.id**，
// 所有写入路径按 rowid 定位，不再按 note_id。
//
// 为什么必须真 SQLite：这件事的失败方式**全都不报错**
//   · `DELETE FROM notes_fts WHERE note_id = ?` 在 fts5 上不是错误、只是**全表扫**
//     （note_id 是 UNINDEXED，它不是索引）—— 慢 30~160 倍，日志里一个字节都没有；
//   · 老库的 rowid 与 notes.id 对不上时，按 rowid 删**删不到**，紧接着插一条新的 →
//     同一篇笔记在索引里攒出两行 → 搜索重复返回，仍然不报错；
//   · 迁移若改成从 notes 表搬正文，中文会丢掉 segmentCJK 分词 →
//     **全库老笔记的两字词搜索失效**，MATCH 只回 0 行，也不报错。
// FakeD1 不执行 SQL，这三条一条都红不了。所以这里连真库。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { projectDir as findProjectDir } from "./helpers/notesSource";
import { resetMigrationCacheForTests } from "../src/API/http";
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY, MIGRATION_STEPS_KEY } from "../src/API/methods/migration";
import { segmentCJK } from "../src/utils/ftsQuery";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);
const read = (rel: string) => readFileSync(resolve(projectDir(), rel), "utf8");

async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

test("真实 SQLite：新建笔记后 fts 行的 rowid 就等于 notes.id", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "标题甲", content: "内容甲" });
    const row = await db
        .prepare("SELECT rowid AS r, note_id AS n FROM notes_fts")
        .first<{ r: number; n: number }>();
    assert.ok(row, "创建笔记必须写进全文索引");
    assert.equal(row!.r, note.id, "rowid 必须等于 notes.id（新契约）");
    assert.equal(row!.n, note.id, "note_id 列仍然保留并等于 notes.id（搜索的 JOIN 还用它）");
});

test("真实 SQLite：改写正文后按 rowid 更新，索引里只剩一行（不会攒出重复）", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "草稿", content: "旧关键词在这里" });
    await api.updateNote(note.id!, { content: "换成了新关键词" });
    const count = await db
        .prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE rowid = ?")
        .bind(note.id)
        .first<{ n: number }>();
    assert.equal(count?.n, 1, "同一条笔记在索引里只能有一行（先删后插要删得掉旧行）");
    const total = await db.prepare("SELECT COUNT(*) AS n FROM notes_fts").first<{ n: number }>();
    assert.equal(total?.n, 1, "整张索引里也只该有这一行");
    // 索引里的正文是**新**的
    const body = await db
        .prepare("SELECT body FROM notes_fts WHERE rowid = ?")
        .bind(note.id)
        .first<{ body: string }>();
    assert.equal(body?.body, segmentCJK("换成了新关键词"));
});

test("真实 SQLite：按 rowid 删除后 MATCH 搜不到（删除路径也走 rowid）", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "待删除", content: "独特词 麒麟芯片" });
    assert.equal((await api.searchNotes("麒麟")).results.length, 1);
    await api.deleteNote(note.id!);
    const left = await db
        .prepare("SELECT COUNT(*) AS n FROM notes_fts WHERE rowid = ?")
        .bind(note.id)
        .first<{ n: number }>();
    assert.equal(left?.n, 0, "删除笔记必须按 rowid 把索引行删掉");
    assert.equal((await api.searchNotes("麒麟")).results.length, 0);
});

test("真实 SQLite：老库（rowid 与 notes.id 无关）升级后按新契约重建，且中文搜索不退化", async () => {
    // 这是这次改造最关键的一条：**模拟已部署的老库**。
    // ⚠️ 必须同时把 schema.version 和 schema.steps 退掉 —— 只退版本号的话
    // runMigrations 会按「已执行集合」把每一步都跳过，整批迁移白跑
    //（这个仓库栽过一次，见 migration.ts 里 STEPS_AT_V28 的注释）。
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "数据库设计说明", content: "正文讲表结构和索引设计" });

    // 伪造成老库形态：索引里只有一行、rowid 由 fts5 自动分配（这里给一个与 notes.id
    // **一定不同**的值，避免「第一条笔记的 id 恰好是 1」把断言变成恒真），
    // 正文是**已经 segmentCJK 过的**（真实老库就是这样写的）
    await db.exec("DELETE FROM notes_fts");
    await db
        .prepare("INSERT INTO notes_fts (rowid, note_id, user_id, title, body) VALUES (?, ?, ?, ?, ?)")
        .bind(note.id! + 1000, note.id, null, segmentCJK("数据库设计说明"), segmentCJK("正文讲表结构和索引设计"))
        .run();

    // 先证明「不重建就是坏的」：按 notes.id 删，一行都删不掉
    await db.prepare("DELETE FROM notes_fts WHERE rowid = ?").bind(note.id).run();
    const stillThere = await db.prepare("SELECT COUNT(*) AS n FROM notes_fts").first<{ n: number }>();
    assert.equal(stillThere?.n, 1, "老库上按 rowid 删不到 —— 这正是必须重建的理由");

    // 退回老版本状态：版本号和「已执行步骤集合」一起退
    await db.prepare("UPDATE configs SET value = ? WHERE key = ?").bind("27", SCHEMA_VERSION_KEY).run();
    await db.prepare("DELETE FROM configs WHERE key = ?").bind(MIGRATION_STEPS_KEY).run();
    resetMigrationCacheForTests();
    const upgraded = makeRealApi(db);
    await upgraded.migrate();

    // ① rowid 重建成了 notes.id
    const rebuilt = await db
        .prepare("SELECT rowid AS r, note_id AS n FROM notes_fts")
        .first<{ r: number; n: number }>();
    assert.ok(rebuilt, "重建后索引行要还在（不能把索引清空了）");
    assert.equal(rebuilt!.r, note.id, "升级后 rowid 必须等于 notes.id");
    assert.equal(rebuilt!.n, note.id);

    // ② 中文两字词还能搜到 —— 这一条钉住「内容必须从 fts 表自己搬」
    // 如果迁移改成 `SELECT title, body FROM notes`（原文），分词就没了，
    // 这里会返回 0 行，而且不报错。
    const hit = await upgraded.searchNotes("设计");
    assert.equal(hit.mode, "fts", "升级后仍要走 FTS");
    assert.equal(hit.results.length, 1, "升级后老笔记的中文两字词必须还能搜到");
    assert.equal(hit.results[0].id, note.id);

    // ③ 版本号写回新值，下次冷启动不再重跑
    const ver = await db
        .prepare("SELECT value FROM configs WHERE key = ?")
        .bind(SCHEMA_VERSION_KEY)
        .first<{ value: string }>();
    assert.equal(ver?.value, SCHEMA_VERSION);
});

test("真实 SQLite：重建时顺手清掉孤儿索引行（笔记已删、索引还在）", async () => {
    const { db, api } = await fresh();
    const keep = await api.createNote({ title: "留着的", content: "独特词 白虎" });
    const gone = await api.createNote({ title: "会被删的", content: "独特词 朱雀" });
    // 造一条孤儿：直接把 notes 行删掉（不走 deleteNote，所以索引没跟着删）
    await db.prepare("DELETE FROM notes WHERE id = ?").bind(gone.id).run();
    await db.exec("UPDATE configs SET value = '27' WHERE key = 'schema.version'");
    await db.exec("DELETE FROM configs WHERE key = 'schema.steps'");
    resetMigrationCacheForTests();
    await makeRealApi(db).migrate();

    const rows = await db
        .prepare("SELECT note_id AS n FROM notes_fts ORDER BY note_id")
        .all<{ n: number }>();
    assert.deepEqual(rows.results.map(r => r.n), [keep.id], "孤儿索引行必须被清掉（点进去会 404）");
});

test("静态守卫：源码里不准再出现「按 note_id 定位 fts 行」的写法", async () => {
    // 三种必须存在的形态：DELETE ... WHERE rowid = ?、INSERT 带 rowid 列。
    // 反向验证正则本身抓得住旧写法，免得守卫是假的。
    const legacyDelete = /DELETE\s+FROM\s+notes_fts\s+WHERE\s+note_id/i;
    const legacyInsert = /INSERT\s+INTO\s+notes_fts\s*\(\s*note_id\s*,/i;
    assert.equal(
        legacyDelete.test("DELETE FROM notes_fts WHERE note_id = ?"),
        true,
        "正则要能抓到旧写法"
    );
    assert.equal(
        legacyInsert.test("INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?,?,?,?)"),
        true,
        "正则要能抓到旧写法"
    );

    const files = [
        "src/API/methods/notes/notesNote.ts",
        "src/API/methods/notes/notesBackup.ts",
        "src/API/methods/notes/notesSearch.ts",
        "worker/routes/data.ts",
    ];
    for (const file of files) {
        const src = read(file);
        assert.equal(legacyDelete.test(src), false, `${file} 里还有「DELETE ... WHERE note_id」—— 那是全表扫`);
        assert.equal(legacyInsert.test(src), false, `${file} 里还有「INSERT INTO notes_fts (note_id, ...)」—— 少了 rowid，新行定位不到`);
    }
});
