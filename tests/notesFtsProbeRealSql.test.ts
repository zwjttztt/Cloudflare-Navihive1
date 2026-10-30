// tests/notesFtsProbeRealSql.test.ts
//
// 全文索引的**启动探测**在真实 SQLite 上跑一遍。
//
// 为什么单开一个文件：这次的三条修复盯的都是「检查一直是绿的、事情却没发生」那类失效。
//   · ftsReady 只在迁移步骤里点亮 → 步骤进了已完成集合就不再跑 → 每个**正常启动**
//     （也就是线上 99% 的冷启动，走版本快路径）里它恒为 false；
//   · 索引是空的而开关是 true → 0 命中直接返回空数组 → 用户真的搜不到东西；
//   · rowid 重建「先 DELETE 后 INSERT」→ 中途失败留下空索引，正好喂给上面第二条。
// 这三条在 FakeD1 上一条都红不了（它不执行 SQL），所以必须连真库。
import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { migrationState } from "../src/API/methods/internals";
import { NOTES_FTS_ROWID_REBUILD_SQL } from "../src/API/methods/internals";

/** 每个用例都要一张干净的真库（内存库 + 清空迁移缓存） */
async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

/**
 * 模拟「下一个 isolate 的冷启动」。
 *
 * ⚠️ 这里**不退版本号**：新鲜库跑完 migrate 之后，`schema.version` 与 `schema.steps`
 * 都已经写好了 —— 这正是线上已部署实例的形态，也正是会走 `migrateIfNeeded` 快路径
 * 的那条路。以前 ftsReady 在这一路上恒为 false，索引不写、搜索全表扫，一声不响。
 */
function coldBoot(db: ReturnType<typeof makeRealD1>) {
    resetMigrationCacheForTests();
    return makeRealApi(db);
}

test("真实 SQLite：走版本快路径的正常启动也要探出 FTS 可用（以前恒为 false）", async () => {
    const { db, api } = await fresh();
    await api.createNote({ title: "冷启动要能搜到", content: "正文里有个独特词 朱雀" });
    assert.equal(api.notesFtsReady, true, "全量迁移后当然该是 true");

    const cold = coldBoot(db);
    await cold.migrate();

    assert.equal(
        cold.notesFtsReady,
        true,
        "版本快路径上也必须探出「索引可用」—— 它只看当前状态，不看「步骤跑过没跑过」"
    );
    const hit = await cold.searchNotes("朱雀");
    assert.equal(hit.mode, "fts", "快路径上的搜索要走 FTS，不是静默退化成 LIKE");
    assert.equal(hit.results.length, 1);
});

test("真实 SQLite：索引是空的时，搜索退回 LIKE 而不是返回空结果", async () => {
    // 线上实测的形态：notes 4 行、notes_fts 0 行。
    // 而开关一旦被点亮（迁移步骤 / 上一次探测），0 命中会直接 return 空数组 ——
    // 用户看到的就是「搜什么都搜不到」，而且和「真没有」分不出来。
    const { db, api } = await fresh();
    await api.createNote({ title: "空索引测试", content: "正文里有个独特词 貔貅" });
    await db.exec("DELETE FROM notes_fts");
    // 开关保持「可用」，把索引空着 —— 这正是最危险的那组状态
    assert.equal(migrationState.ftsReady, true);

    const hit = await api.searchNotes("貔貅");
    assert.equal(hit.mode, "like", "索引空 + 开关为真时必须退 LIKE，绝不能返回空数组");
    assert.equal(hit.results.length, 1, "降级不能变成「搜不到」");
    assert.equal(hit.results[0].title, "空索引测试");
});

test("真实 SQLite：索引齐的时候 0 命中就是真没命中，不多付一次全表扫", async () => {
    // 与上一条配对：修的时候容易滑到「任何 0 命中都跑一遍 LIKE」那一头，
    // 那等于把每次正常的空搜索都变成一次全表扫。判据必须是「索引可不可信」。
    const { api } = await fresh();
    await api.createNote({ title: "甲", content: "正文里有个独特词 白泽" });

    const hit = await api.searchNotes("一个根本不存在的词");
    assert.equal(hit.mode, "fts", "索引齐的时候不该退 LIKE（多一次全表扫是白付的成本）");
    assert.deepEqual(hit.results, []);
});

test("真实 SQLite：空索引在启动时被补齐（自愈），补完就能走 FTS 搜到", async () => {
    const { db, api } = await fresh();
    await api.createNote({ title: "等着被补进索引", content: "正文里有个独特词 饕餮" });
    await db.exec("DELETE FROM notes_fts");

    const cold = coldBoot(db);
    await cold.migrate();

    // ① 启动时把缺的行补回去了（不是「看着对不上就装作没看见」）
    const counts = await db
        .prepare("SELECT (SELECT COUNT(*) FROM notes_fts) AS fts, (SELECT COUNT(*) FROM notes) AS n")
        .first<{ fts: number; n: number }>();
    assert.equal(counts?.fts, counts?.n, "冷启动要把索引的行数补齐");
    assert.equal(cold.notesFtsReady, true, "补齐之后就该说可用");

    // ② 而且补进去的是**分过词的**内容 —— 直接搬原文会让中文两字词搜不到
    const hit = await cold.searchNotes("饕餮");
    assert.equal(hit.results.length, 1, "补齐之后要能搜到");
    const twoChar = await cold.searchNotes("正文");
    assert.equal(twoChar.results.length, 1, "补齐的内容必须重新分过词（两字词也要命中）");
});

test("真实 SQLite：notes_fts 表整个没了，启动要么重建要么明确降级 —— 搜索绝不返回空", async () => {
    const { db, api } = await fresh();
    await api.createNote({ title: "表被删了", content: "正文里有个独特词 混沌" });
    await db.exec("DROP TABLE notes_fts");

    const cold = coldBoot(db);
    await cold.migrate();
    const hit = await cold.searchNotes("混沌");

    assert.equal(
        hit.results.length,
        1,
        "索引表没了也必须搜得到（重建后走 FTS，或明确降级走 LIKE —— 两条路都得有结果）"
    );
    // 「不撒谎」：说了 fts 就真得是索引给的，说了 like 就是降级；不许「说了 fts 却什么都没有」
    if (hit.mode === "fts") {
        assert.equal(cold.notesFtsReady, true, "mode 报 fts 时开关必须是真的可用");
    }
});

test("静态守卫：rowid 重建必须「先写新、再删旧」（D-14）", async () => {
    // 老写法是 `DELETE FROM notes_fts;` 排在 `INSERT OR REPLACE` 之前：
    // exec 中途失败就留下「行数对不上、内容却是空的」索引 —— 比没有索引更危险，
    // 因为 MATCH 不报错，只是永远 0 行。这里把顺序钉死。
    const insert = /INSERT\s+OR\s+REPLACE\s+INTO\s+notes_fts\b/.exec(NOTES_FTS_ROWID_REBUILD_SQL);
    // ⚠️ 只匹配「删 notes_fts 本体」那句：`notes_fts\b` 里的 \b 排除了 notes_fts_rebuild
    const drop = /DELETE\s+FROM\s+notes_fts\s+WHERE\b/.exec(NOTES_FTS_ROWID_REBUILD_SQL);

    assert.ok(insert, "重建脚本里必须有「写回 notes_fts」那句");
    assert.ok(drop, "重建脚本里必须有「删多余旧行」那句");
    assert.ok(
        insert!.index < drop!.index,
        "顺序必须是先把重建结果写回 notes_fts，再删多余的旧行 —— 反过来会在中途失败时留下空索引"
    );
});
