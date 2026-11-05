// tests/copyCalloutMigrationRealSql.test.ts
//
// 复制块语法整体删除后的**数据收尾**：`> [!COPY]` 标记行必须从历史数据里消失，
// 而正文其余部分**逐字节**不变。
//
// 为什么必须连真 SQLite（与 noteFtsRowidRealSql.test.ts 同一个理由）：
// 这条链路上的失败方式几乎都不报错 ——
//   · `LIKE '%[!COPY]%'` 少写一个方括号，预筛就漏行：迁移「成功」、脏数据还在；
//   · 写回时顺手把 `updated_at` 一起更新：数据是对的，用户的笔记列表却被重排了一遍；
//   · 忘了 `rev = rev + 1`：别的设备手里那份脏正文永远不失效，一直显示 `[!COPY]`；
//   · 忘了重写 notes_fts：正文干净了、索引里还留着 COPY 的 token，搜正文的词反而搜不到；
//   · 忘了回收站里那份 `{ note, tagIds }` 快照：用户一点「还原」，脏正文又回来了。
// FakeD1 不执行 SQL，上面五条一条都红不了。
//
// ⚠️ 断言一律先转成布尔值 / 字符串再交给 assert.equal：失败时 node:assert 会
//    util.inspect 参数，把 D1 结果对象（里面可能挂着别的东西）整个展开。
import assert from "node:assert/strict";
import test from "node:test";

import { makeRealApi, makeRealD1, type RealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import {
    MIGRATION_STEPS_KEY,
    SCHEMA_VERSION,
    SCHEMA_VERSION_KEY,
    stripCopyCalloutMarkers,
} from "../src/API/methods/migration";

/** 一个跑完全量迁移的空库 */
async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

/**
 * 把库退回「29 号版本」的样子，强制下一次 `migrate()` 把整批步骤重跑一遍。
 *
 * ⚠️ 必须**同时**退版本号和已执行步骤集合：只退版本号的话，runMigrations 会按
 * 「已执行集合」把每一步都跳过，整批迁移白跑（这个仓库栽过一次，见
 * migration.ts 里 STEPS_AT_V30 的注释）。
 */
async function downgradeTo29(db: RealD1): Promise<void> {
    await db.prepare("UPDATE configs SET value = ? WHERE key = ?").bind("29", SCHEMA_VERSION_KEY).run();
    await db.prepare("DELETE FROM configs WHERE key = ?").bind(MIGRATION_STEPS_KEY).run();
    resetMigrationCacheForTests();
}

/** 读一条笔记的正文与 rev */
async function readNote(db: RealD1, id: number): Promise<{ content: string; rev: number } | null> {
    return db
        .prepare("SELECT content, rev FROM notes WHERE id = ?")
        .bind(id)
        .first<{ content: string; rev: number }>();
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、纯函数边界（迁移的唯一口径来源，桩掉它 = 整条链失去意义）
// ─────────────────────────────────────────────────────────────────────────────

test("纯函数：整行标记连同它自己的换行一起删掉，其余字节一字不动", () => {
    const src = "第一段\n> [!COPY]\n> 甲\n> 乙\n第三段\n";
    assert.equal(
        stripCopyCalloutMarkers(src),
        "第一段\n> 甲\n> 乙\n第三段\n",
        "只该少掉标记那一行（连它的换行），不该多出空行"
    );
});

test("纯函数：大小写、前后空格 / 制表符、多层引用都认", () => {
    assert.equal(stripCopyCalloutMarkers("  >   [!copy]  \n正文"), "正文", "缩进 + 小写 + 行尾空格");
    assert.equal(stripCopyCalloutMarkers("\t>\t[!Copy]\t\n正文"), "正文", "制表符也要认");
    assert.equal(stripCopyCalloutMarkers("> > [!COPY]\n正文"), "正文", "嵌套引用里的标记同样是标记");
});

test("纯函数：首行 / 末行（末尾没有换行）/ CRLF 都吃得住，且不制造空行", () => {
    assert.equal(stripCopyCalloutMarkers("> [!COPY]"), "", "整篇只有一个标记（且没有结尾换行）");
    assert.equal(stripCopyCalloutMarkers("> [!COPY]\n> 甲"), "> 甲", "标记在首行");
    assert.equal(stripCopyCalloutMarkers("甲\n> [!COPY]"), "甲", "标记在末行、末尾没有换行");
    assert.equal(
        stripCopyCalloutMarkers("> [!COPY]\r\n> 甲\r\n"),
        "> 甲\r\n",
        "CRLF 笔记不许被洗成混合换行"
    );
});

test("纯函数：行中间的 [!COPY] 一个字都不许动", () => {
    const src = "这写法来自 [!COPY] 语法，别删。\n引用里也有 > [!COPY] 这种。";
    assert.equal(stripCopyCalloutMarkers(src), src, "行中没有引用前缀的 [!COPY] 是正常文字");
});

test("纯函数：行首是标记、后面还有正文时只摘标记，正文一字不丢", () => {
    assert.equal(
        stripCopyCalloutMarkers("> [!COPY] 见下方一段\n> 甲"),
        "> 见下方一段\n> 甲",
        "整行删会把「见下方一段」一起吃掉 —— 那是数据丢失"
    );
    assert.equal(stripCopyCalloutMarkers(">   [!copy]\t正文"), ">   正文", "引用前缀要原样保留");
});

test("纯函数：代码围栏里的示例代码不动（用户可能正在写语法文档）", () => {
    const src = ["```markdown", "> [!COPY]", "> 甲", "```", "真正的标记在这里：", "> [!COPY]", "> 乙"].join("\n");
    const want = ["```markdown", "> [!COPY]", "> 甲", "```", "真正的标记在这里：", "> 乙"].join("\n");
    assert.equal(stripCopyCalloutMarkers(src), want, "围栏内的示例不是数据，是用户写的文档");
});

test("纯函数：没有标记时原样返回（快路径），有标记时幂等", () => {
    const plain = "普通笔记里的 `code`，或者提到 COPY 这个词，都不该被碰。";
    assert.equal(stripCopyCalloutMarkers(plain), plain, "没有标记时一个字节都不该变");
    const once = stripCopyCalloutMarkers("> [!COPY]\n> 甲\n");
    assert.equal(once, "> 甲\n");
    assert.equal(stripCopyCalloutMarkers(once), once, "第二次跑必须完全不变（迁移会重试）");
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、真 SQLite：迁移在真库上的实际效果
// ─────────────────────────────────────────────────────────────────────────────

test("真实 SQLite：升级后标记行消失、其余字节逐字节相同、rev + 1", async () => {
    const { db, api } = await fresh();
    // 中段标记 + 行尾空格 + CRLF + 混合大小写 + 别的 callout，一次把边界全带上
    const before = "开头一句\r\n> [!COPY]  \r\n> 甲 `code` 乙\r\n\r\n> [!note] 提示\r\n> 结尾";
    const after = "开头一句\r\n> 甲 `code` 乙\r\n\r\n> [!note] 提示\r\n> 结尾";
    const note = await api.createNote({ title: "脏数据", content: before });
    const revBefore = (await readNote(db, note.id!))!.rev;

    await downgradeTo29(db);
    await makeRealApi(db).migrate();

    const row = await readNote(db, note.id!);
    assert.equal(row!.content, after, "只该少掉标记那一行，其余字节逐字节相同");
    assert.equal(row!.rev, revBefore + 1, "rev 必须 +1，否则别的设备缓存永远不失效");

    // 步骤要真的被记账：不然每次冷启动都会重洗一遍全库
    const stepsRaw = await db
        .prepare("SELECT value FROM configs WHERE key = ?")
        .bind(MIGRATION_STEPS_KEY)
        .first<{ value: string }>();
    const ids = JSON.parse(stepsRaw?.value ?? "[]") as string[];
    assert.equal(ids.includes("notes-copy-callout-marker"), true, "步骤要记进 schema.steps");
    // 版本号写回新值
    const ver = await db
        .prepare("SELECT value FROM configs WHERE key = ?")
        .bind(SCHEMA_VERSION_KEY)
        .first<{ value: string }>();
    assert.equal(ver?.value, SCHEMA_VERSION);
});

test("真实 SQLite：没有标记的笔记正文与 rev 都不动（预筛捞错也不许写回）", async () => {
    const { db, api } = await fresh();
    const clean = await api.createNote({ title: "干净", content: "> [!NOTE]\n> 甲\n\n普通段落" });
    const dirty = await api.createNote({ title: "脏", content: "> [!COPY]\n> 乙" });
    const revClean = (await readNote(db, clean.id!))!.rev;

    await downgradeTo29(db);
    await makeRealApi(db).migrate();

    const cleanRow = await readNote(db, clean.id!);
    assert.equal(cleanRow!.content, "> [!NOTE]\n> 甲\n\n普通段落", "别的 callout 一个字都不许动");
    assert.equal(cleanRow!.rev, revClean, "没变就**不许**写回（白涨 rev 会让客户端白刷新）");
    assert.equal((await readNote(db, dirty.id!))!.content, "> 乙", "脏的那条要洗干净");
});

test("真实 SQLite：第二次跑迁移不再改动任何东西（幂等 + 已记账就跳过）", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "脏", content: "> [!COPY]\n> 甲" });
    await downgradeTo29(db);
    await makeRealApi(db).migrate();
    const first = await readNote(db, note.id!);
    assert.equal(first!.content, "> 甲");

    // 再退一次，逼整批步骤重跑（模拟「有人手工清过 schema.steps」这类运维事故）
    await downgradeTo29(db);
    await makeRealApi(db).migrate();
    const second = await readNote(db, note.id!);
    assert.equal(second!.content, "> 甲", "第二次不许再改正文");
    assert.equal(second!.rev, first!.rev, "已经干净了就不该再涨 rev");
});

test("真实 SQLite：洗完正文后中文两字词仍然搜得到（FTS 跟着重写）", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "数据库", content: "> [!COPY]\n> 索引设计要注意" });

    // 迁移前：索引里确实带着 COPY 的 token（否则下面那条断言是空的）
    const beforeBody = await db
        .prepare("SELECT body FROM notes_fts WHERE rowid = ?")
        .bind(note.id)
        .first<{ body: string }>();
    assert.equal(/copy/i.test(beforeBody?.body ?? ""), true, "前置条件：索引里本来就有 COPY");

    await downgradeTo29(db);
    const upgraded = makeRealApi(db);
    await upgraded.migrate();

    // ① 中文两字词还能搜到（不重写索引 / 或不分词地重写都会让这条无声变 0 行）
    const hit = await upgraded.searchNotes("索引");
    assert.equal(hit.mode, "fts", "索引可用时必须走 FTS");
    assert.equal(hit.results.length, 1);
    assert.equal(hit.results[0].id, note.id);

    // ② 索引里不再有标记的分词残留
    const afterBody = await db
        .prepare("SELECT body FROM notes_fts WHERE rowid = ?")
        .bind(note.id)
        .first<{ body: string }>();
    assert.equal(
        /copy/i.test(afterBody?.body ?? ""),
        false,
        "正文洗干净了、索引里还留着 COPY 的 token —— 会搜出不该出现的命中"
    );
});

test("真实 SQLite：回收站里的笔记快照一起洗，别的 kind 一个字都不动", async () => {
    const { db, api } = await fresh();
    const note = await api.createNote({ title: "会被删的", content: "> [!COPY]\n> 甲" });
    await api.deleteNote(note.id!);

    // 另一条非笔记的回收站条目：形状与 note 无关，但 data 里同样有 [!COPY] 字样。
    // 迁移只按 kind='note' 选行，这条必须原封不动。
    const siteData = JSON.stringify({ id: 1, name: "站点 [!COPY]", url: "https://example.test" });
    await db
        .prepare("INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)")
        .bind("site", null, siteData, 111)
        .run();

    await downgradeTo29(db);
    await makeRealApi(db).migrate();

    const rows = await db
        .prepare("SELECT id, kind, data FROM recycle_bin ORDER BY id")
        .all<{ id: number; kind: string; data: string }>();
    const noteRow = rows.results.find(r => r.kind === "note");
    const siteRow = rows.results.find(r => r.kind === "site");
    assert.equal(noteRow !== undefined, true, "笔记快照不该被删掉（还原还要用它）");
    assert.equal(siteRow !== undefined, true);

    const parsed = JSON.parse(noteRow!.data) as {
        note: Record<string, unknown>;
        tagIds: number[];
    };
    assert.equal(parsed.note.content, "> 甲", "回收站快照里的正文也要洗（否则一还原又脏回来）");
    assert.equal(parsed.note.title, "会被删的", "快照里其余字段原样保留");
    assert.equal(Array.isArray(parsed.tagIds), true, "tagIds 结构不许被改形状");
    assert.equal(siteRow!.data, siteData, "非笔记的回收站条目一个字都不许动");
});
