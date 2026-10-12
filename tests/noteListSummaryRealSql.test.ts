// tests/noteListSummaryRealSql.test.ts
//
// 列表摘要（?fields=list）的服务端语义，在**真 SQLite** 上验证。
// 假 D1 不执行 SQL —— 而这里要钉的正是 SQL：substr 那一段写错（比如写成
// 取错列、或把 content 整个替换掉导致其它字段错位）在假库上永远红不了，
// 上线就是「列表接口 500」或者「每条笔记的正文都变成标题」。
//
// 为什么现在只做服务端、前端默认不开：几十条笔记时列表带正文才 2 KB，
// 开了反而让**每次点开笔记多一次往返**（这条链路上一次往返 1~3 秒）。
// 这是给「笔记涨到几百条、列表接口变成 MB 级」那天准备的阀门。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

/** 一段明显超过 200 字符的正文，用来看出「到底有没有被截短」 */
const LONG_CONTENT = `开头${"很长的一段正文".repeat(40)}结尾`;

test("真实 SQLite：默认列表带全文，摘要模式只回前 200 字符并打标记", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const created = await api.createNote({ title: "长笔记", content: LONG_CONTENT });
    assert.ok(LONG_CONTENT.length > 200, "这段正文必须够长，否则测不出截断");

    // 默认（不带 summary）：正文原样回来，且**没有**截断标记
    const full = await api.listNotes();
    const long = full.find(n => n.id === created.id);
    assert.ok(long, "新建的笔记应当在列表里");
    assert.equal(long.content, LONG_CONTENT, "默认模式必须是全文");
    assert.equal(long.content_truncated, undefined, "全文不该带截断标记");

    // 摘要模式：正文被截短 + 打标记，其余字段一个都不能少
    const brief = await api.listNotes({ summary: true });
    const short = brief.find(n => n.id === created.id);
    assert.ok(short, "摘要模式下也要能找到这条");
    assert.equal(short.content_truncated, true, "被截短的必须打标记，前端才知道要补拉全文");
    assert.ok(short.content.length <= 200, `正文应当被截到 200 字符内，实际 ${short.content.length}`);
    assert.ok(LONG_CONTENT.startsWith(short.content), "摘要必须是正文的**开头**一段，不是随便切");

    // 关键：截的是正文，别把别的字段一起弄坏
    assert.equal(short.title, "长笔记", "标题不能被截断逻辑带歪");
    assert.equal(short.id, created.id);
    assert.equal(short.uuid, created.uuid, "uuid 也要原样回来（导入去重靠它）");
});

test("真实 SQLite：短笔记在摘要模式下不打标记（它本来就是全文）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    await api.createNote({ title: "一句话", content: "就这么点字" });
    const brief = await api.listNotes({ summary: true });
    const note = brief.find(n => n.title === "一句话");
    assert.ok(note);
    assert.equal(note.content, "就这么点字", "没到 200 字符就不该动它");
    assert.equal(
        note.content_truncated,
        undefined,
        "没被截短却打了标记，会让前端白白多补拉一次全文"
    );
});

test("真实 SQLite：摘要不影响写入（create / update 拿到的仍是全文）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    // 摘要模式只改 SELECT 的列，写操作的 RETURNING 必须用全字段 ——
    // 否则「保存后界面上只剩摘要」这种事故会在这一步发生。
    const created = await api.createNote({ title: "要改的", content: LONG_CONTENT });
    assert.equal(created.content, LONG_CONTENT, "createNote 回的必须是全文");

    const updated = await api.updateNote(created.id!, { content: LONG_CONTENT + "又加了一句" });
    assert.ok(updated);
    assert.ok(
        (updated.content ?? "").endsWith("又加了一句"),
        "updateNote 回的也必须是全文（摘要一旦混进写路径，保存就会丢正文）"
    );

    const single = await api.getNote(created.id!);
    assert.ok((single?.content ?? "").endsWith("又加了一句"), "单独取一条也是全文");
});
