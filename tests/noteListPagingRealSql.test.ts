// tests/noteListPagingRealSql.test.ts
//
// `listNotes` 的分页阀门（2026-10-28）：limit / offset 在**真 SQLite** 上验证。
//
// 三条不能只靠类型检查守住的东西：
//   1. **不传 limit = 全都要**。导出 / 备份 / 重建索引全靠这条语义，
//      给它加个默认上限就是静默丢数据（而且备份文件看上去是"成功"的）。
//   2. 分页必须**保持原排序** `pinned DESC, order_num, id`。改了排序等于让
//      idx_notes_user_order 这条覆盖索引失效，而且 `LIMIT 50` 反而更贵
//      （排序走不了索引时，得先把全部行排一遍才知道前 50 条是谁）。
//   3. 夹取口径（非正整数 / 0 / 超上限）在服务端、客户端、mock 三处必须一致 ——
//      任一处不一致，就出现「演示模式翻页正常、真机翻页重复」这种只在线上看得见的错。
import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { handleDataRoutes } from "../worker/routes/data";
import type { RouteCtx } from "../worker/routes/types";
import { NOTE_LIST_MAX_LIMIT, NOTE_SUMMARY_CHARS } from "../src/utils/noteLimits";
import type { Note } from "../src/API/types";

async function seeded() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    // 造出「排序有内容」的一批：置顶的排前面、同组内按 order_num、最后按 id 兜底。
    // 刻意让 C 与 B 的 order_num 相同 —— 只有 id 兜底才能定序，这正是分页稳定性的考点。
    // ⚠️ order_num / pinned 不能靠 createNote 的入参：createNote 一律取
    // `MAX(order_num)+1` 自己排队（见 notesNote.ts），所以这里建完再改。
    const created: Note[] = [];
    created.push(await api.createNote({ title: "A", content: "x" }));
    created.push(await api.createNote({ title: "B", content: "x" }));
    created.push(await api.createNote({ title: "C", content: "x" }));
    created.push(await api.createNote({ title: "D", content: "x" }));
    created.push(await api.createNote({ title: "E", content: "x" }));
    const layout: Array<{ title: string; pinned: boolean; order_num: number }> = [
        { title: "A", pinned: true, order_num: 5 },
        { title: "B", pinned: false, order_num: 2 },
        { title: "C", pinned: false, order_num: 2 },
        { title: "D", pinned: false, order_num: 9 },
        { title: "E", pinned: true, order_num: 1 },
    ];
    for (const row of created) {
        const spec = layout.find(l => l.title === row.title)!;
        await api.updateNote(row.id!, { pinned: spec.pinned, order_num: spec.order_num });
    }
    return { db, api, created };
}

test("真实 SQLite：不传 limit 时仍然返回**全部**（导出/备份依赖这条）", async () => {
    const { api } = await seeded();
    const all = await api.listNotes();
    assert.equal(all.length, 5, "默认必须全量 —— 这是给导出/备份/重建索引留的语义");
    assert.deepEqual(all.map(n => n.title), ["E", "A", "B", "C", "D"], "排序：置顶在前，再按 order_num，再按 id");
});

test("真实 SQLite：limit 切出来的就是全量列表的前 N 条（顺序一模一样）", async () => {
    const { api } = await seeded();
    const all = await api.listNotes();
    for (const limit of [1, 2, 3, 5]) {
        const page = await api.listNotes({ limit });
        assert.deepEqual(
            page.map(n => n.title),
            all.slice(0, limit).map(n => n.title),
            `limit=${limit} 的前 N 条必须与全量前 N 条逐条一致`
        );
    }
});

test("真实 SQLite：offset 翻页拼起来等于全量，不重不漏", async () => {
    const { api } = await seeded();
    const all = await api.listNotes();
    const pageSize = 2;
    const collected: string[] = [];
    for (let offset = 0; offset < all.length; offset += pageSize) {
        const page = await api.listNotes({ limit: pageSize, offset });
        collected.push(...page.map(n => n.title ?? ""));
    }
    assert.deepEqual(collected, all.map(n => n.title), "逐页翻完必须与全量逐条一致（不重不漏）");
    // 越过末尾：空数组，不是报错、不是重复最后一页
    assert.deepEqual(await api.listNotes({ limit: pageSize, offset: 100 }), []);
});

test("真实 SQLite：只给 offset（不给 limit）= 从 offset 拉到末尾", async () => {
    const { api } = await seeded();
    const all = await api.listNotes();
    const tail = await api.listNotes({ offset: 2 });
    assert.deepEqual(tail.map(n => n.title), all.slice(2).map(n => n.title));
});

test("真实 SQLite：limit 是非法值（0/负数/NaN/小数）时按「没传」处理，且夹在上限内", async () => {
    const { api } = await seeded();
    const all = await api.listNotes();
    // 0 / 负数 / NaN 一律当「没传」—— `LIMIT 0` 会白给一个空列表，
    // 那种 bug 长得和「笔记全没了」一模一样，必须挡在参数解析这一层。
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const rows = await api.listNotes({ limit });
        assert.equal(rows.length, all.length, `limit=${String(limit)} 应当按「没传」处理`);
    }
    // 小数向下取整，不报错
    assert.equal((await api.listNotes({ limit: 2.9 })).length, 2);
    // 超上限夹到 NOTE_LIST_MAX_LIMIT：这里只有 5 条，所以结果仍是 5 条（夹取不是截断数据）
    assert.equal((await api.listNotes({ limit: NOTE_LIST_MAX_LIMIT + 1000 })).length, 5);
});

test("真实 SQLite：分页与摘要档可以叠加（摘要标记仍然逐条正确）", async () => {
    const { api } = await seeded();
    const long = "长".repeat(NOTE_SUMMARY_CHARS + 50);
    // 放到最前面（置顶 + order_num 0），这样 limit=2 一定含它，断言才有指向
    const created = await api.createNote({ title: "长文", content: long });
    await api.updateNote(created.id!, { pinned: true, order_num: 0 });
    const page = await api.listNotes({ summary: true, limit: 2 });
    assert.equal(page.length, 2);
    for (const row of page) {
        assert.ok(row.content.length <= NOTE_SUMMARY_CHARS, "摘要档的正文被 substr 截断");
    }
    const longRow = page.find(r => r.title === "长文");
    assert.ok(longRow, "长文应当排在第一页（置顶 + order_num 最小）");
    assert.equal(longRow!.content_truncated, true, "被截断的要打标记，否则调用方会当成全文");
    // 短笔记不该被误标成截断（否则前端会白白多发一次 getNote 取全文）
    const shortRow = page.find(r => r.title !== "长文");
    assert.equal(shortRow?.content_truncated, undefined, "短正文不该打截断标记");
});

test("路由：?limit/?offset 透传到 listNotes，解析失败按没传处理", async () => {
    const { db, api } = await seeded();
    const call = async (query: string) => {
        const request = new Request(`https://example.com/api/notes${query}`, { method: "GET" });
        const ctx = {
            request,
            url: new URL(request.url),
            method: "GET",
            path: "notes",
            api,
            env: { DB: db },
        } as unknown as RouteCtx;
        const res = await handleDataRoutes(ctx);
        return (await res!.json()) as Note[];
    };
    assert.equal((await call("?fields=list&limit=2")).length, 2, "limit 要透传");
    assert.equal((await call("?fields=list&limit=2&offset=4")).length, 1, "offset 要透传");
    assert.equal((await call("?fields=list")).length, 5, "不带参数 = 全量");
    // ⚠️ 传坏了必须按「没传」处理，绝不能静默回空列表
    assert.equal((await call("?fields=list&limit=abc")).length, 5, "limit=abc 不能变成空列表");
    assert.equal((await call("?fields=list&limit=0")).length, 5, "limit=0 不能变成空列表");
    assert.equal((await call("?fields=list&limit=-3")).length, 5, "负数不能变成空列表");
});
