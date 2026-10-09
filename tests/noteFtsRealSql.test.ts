// tests/noteFtsRealSql.test.ts
//
// 笔记全文检索（FTS5）在**真实 SQLite** 里跑一遍。
//
// 为什么必须真跑：这套东西的失败方式几乎全是「不报错但不工作」——
//   · 分词器选错（trigram）→ 中文两字词永远搜不到，而且 MATCH 不报错、只返回 0 行；
//   · 写入侧分了词、查询侧没分（或反之）→ 同样是 0 行；
//   · 迁移的版本号没 +1 → 老库上 notes_fts 根本不存在；
//   · 索引没跟着删 → 删掉的笔记还在搜索结果里（点进去 404）。
// FakeD1 不执行 SQL，这些都红不了。所以这里连真库，跑真的 MATCH。

import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";

/** 每个用例都要一张干净的真库（内存库 + 清空迁移缓存） */
async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

test("真实 SQLite：迁移后 notes_fts 建出来，且 MATCH 真能跑（不是懒失败）", async () => {
    const { api } = await fresh();
    assert.equal(
        api.notesFtsReady,
        true,
        "FTS5 虚拟表没建起来（建不出来要降级成 LIKE，但本地 SQLite 必须能建）"
    );
    // 建完还没索引任何内容，搜什么都该是空 —— 但不能报错
    const empty = await api.searchNotes("随便搜点什么");
    assert.equal(empty.mode, "fts", "有索引就该走 FTS 分支");
    assert.deepEqual(empty.results, []);
});

test("真实 SQLite：中文两字词能搜到（trigram 分词器在这里会一条都搜不到）", async () => {
    // 这是选 unicode61 + segmentCJK 而不是 trigram 的唯一理由，必须钉死：
    // trigram 要求查询串 ≥3 字符，「设计」这种最常见的中文输入会返回 0 行。
    const { api } = await fresh();
    await api.createNote({ title: "数据库设计说明", content: "正文讲表结构和索引设计" });
    const hit = await api.searchNotes("设计");
    assert.equal(hit.mode, "fts");
    assert.equal(hit.results.length, 1, "两字中文查询必须命中");
    assert.ok(hit.results[0].snippet.length > 0, "命中要给摘要片段");
});

test("真实 SQLite：标题命中排在正文命中之前（bm25 给了标题更高权重）", async () => {
    const { api } = await fresh();
    const inBody = await api.createNote({ title: "无关标题甲", content: "这里有设计二字" });
    const inTitle = await api.createNote({ title: "设计稿", content: "没有那个词" });
    const hit = await api.searchNotes("设计");
    assert.equal(hit.results.length, 2, "两条都要命中");
    assert.equal(
        hit.results[0].id,
        inTitle.id,
        "标题命中的必须排第一（实际顺序：" + hit.results.map(r => r.title).join(" / ") + "）"
    );
    assert.equal(hit.results[1].id, inBody.id);
});

test("真实 SQLite：删掉的笔记搜不到（索引跟着 drop）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "待删除", content: "内容里有个独特的词 麒麟芯片" });
    assert.equal((await api.searchNotes("麒麟")).results.length, 1, "删之前要搜得到");
    await api.deleteNote(note.id!);
    const after = await api.searchNotes("麒麟");
    assert.equal(after.results.length, 0, "删掉的笔记不该还留在搜索结果里");
});

test("真实 SQLite：改正文后索引跟着更新（新词能搜到、旧词搜不到）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "草稿", content: "旧关键词在这里" });
    assert.equal((await api.searchNotes("旧关键词")).results.length, 1);
    await api.updateNote(note.id!, { content: "换成了新关键词" });
    assert.equal(
        (await api.searchNotes("新关键词")).results.length,
        1,
        "改过的正文必须能搜到（索引没跟着更新）"
    );
    assert.equal(
        (await api.searchNotes("旧关键词")).results.length,
        0,
        "已经不存在的旧词不该还搜得到"
    );
});

test("真实 SQLite：从回收站还原的笔记重新可搜（删除时 drop、还原时补回）", async () => {
    const { api } = await fresh();
    const note = await api.createNote({ title: "待还原", content: "独特词 凤凰" });
    const res = await api.deleteNote(note.id!);
    assert.ok(res.recycleId, "删除要进回收站");
    assert.equal((await api.searchNotes("凤凰")).results.length, 0, "删了就搜不到");
    assert.equal(await api.restoreRecycleItem(res.recycleId!), true, "还原失败");
    assert.equal(
        (await api.searchNotes("凤凰")).results.length,
        1,
        "还原回来的笔记必须重新能搜到（否则界面上有、搜索里没有）"
    );
});

test("真实 SQLite：多个词是 AND，且索引不可用时退回 LIKE（结果一致）", async () => {
    const { api } = await fresh();
    await api.createNote({ title: "甲", content: "设计 与 索引 都有" });
    await api.createNote({ title: "乙", content: "只有设计" });

    const both = await api.searchNotes("设计 索引");
    assert.equal(both.results.length, 1, "两个词都要命中（AND 语义）");

    // 手动关掉 FTS（模拟 D1 上建不出虚拟表的实例）：必须自动回退到 LIKE，
    // 而且搜出来的东西跟 FTS 一致 —— 降级不能变成「搜不到」
    api.notesFtsReady = false;
    const like = await api.searchNotes("设计");
    assert.equal(like.mode, "like", "FTS 关掉后要走 LIKE 分支");
    assert.equal(like.results.length, 2, "LIKE 回退要能搜出两条（降级不能少结果）");
    assert.ok(like.results[0].score >= like.results[1].score, "LIKE 回退也要按相关度排");
});

test("真实 SQLite：LIKE 回退下输入 % 和 _ 不当通配符（转义过的）", async () => {
    const { api } = await fresh();
    api.notesFtsReady = false;
    await api.createNote({ title: "百分比", content: "进度 100% 完成" });
    await api.createNote({ title: "别的", content: "一点关系都没有" });
    // 不转义的话 `%` 匹配任意串 → 第二条也会被搜出来
    const hit = await api.searchNotes("100%");
    assert.equal(hit.results.length, 1, "LIKE 里的 % 必须被转义（不转义会命中无关笔记）");
    assert.equal(hit.results[0].title, "百分比");
});

test("真实 SQLite：导入的笔记进索引（批量导入后能搜到）", async () => {
    const { api } = await fresh();
    const stats = await api.importNotesData({
        kind: "navihive-notes-export",
        exportedAt: new Date().toISOString(),
        notes: [
            {
                uuid: "imported-1",
                title: "导入的标题",
                content: "正文里有个独特词 玄武",
                updated_at: new Date(Date.now() + 86400000).toISOString(),
            },
        ],
        folders: [],
        tags: [],
        noteTags: {},
    } as never);
    assert.equal(stats.created, 1, "导入要真的写进去");
    assert.equal(
        (await api.searchNotes("玄武")).results.length,
        1,
        "导入的笔记必须进全文索引（否则导入完搜不到）"
    );
});

test("真实 SQLite：登录态（uid≠null）下搜索也能跑通（JOIN 里 user_id 必须限定表名）", async () => {
    // ⚠️ 这条盯的是「本机怎么点都点不出、线上登录用户一搜就 500」那类错：
    // 单账号部署（uid = null）时 scopeSql 返回**空串**，那句 SQL 根本不带 user_id ——
    // 于是「两张表都有 user_id 列」造成的 ambiguous column 在本机永远不出现。
    //（同一类坑之前在附件那组出过一次：bind 数量与占位符不匹配。）
    const { api } = await fresh();
    api.setCurrentUser(42);
    const mine = await api.createNote({ title: "我的", content: "我的独特词 玄武" });
    assert.ok(mine.id);

    const hit = await api.searchNotes("玄武");
    assert.equal(hit.mode, "fts", "登录态下也要走 FTS");
    assert.equal(hit.results.length, 1, "登录态下要搜得到自己的笔记");
    assert.equal(hit.results[0].id, mine.id);

    // 别人的笔记搜不到（账号隔离真的生效，不是「全都搜出来」）
    api.setCurrentUser(43);
    const theirs = await api.searchNotes("玄武");
    assert.equal(theirs.results.length, 0, "搜不到别的账号的笔记");

    // LIKE 回退那条路同样要在登录态下通
    api.setCurrentUser(42);
    api.notesFtsReady = false;
    const like = await api.searchNotes("玄武");
    assert.equal(like.mode, "like");
    assert.equal(like.results.length, 1, "登录态下 LIKE 回退也要搜得到");
});
