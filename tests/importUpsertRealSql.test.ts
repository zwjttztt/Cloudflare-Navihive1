// tests/importUpsertRealSql.test.ts
//
// 「导入必须是增量 upsert」这条硬约束，用**真 SQLite** 钉死。
//
// 为什么不用 MockD1：那类桩按 SQL 前缀匹配、压根不执行语句，
// 「建表少一列」「SQL 语法错」「ON CONFLICT 没生效」都测不出来 ——
// 而这次改动的全部价值就在「第二条对比第一次的数据不会变」，
// 那种真假与否只有真引擎说了算（ागले +++ 同理nav”。
//
// 三条验收：
//   1. 重复导入同一份备份：分组 / 卡片行数不增长（幂等）；
//   2. 本地多出来的行一条都不少（不清库、不删 anything）；
//   3. 备份里那条更新时才覆盖本地，本地较新就保留本地。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { EXPORT_VERSION, type ExportData } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

type Harness = ReturnType<typeof makeRealApi>;

function backup(sites?: ExportData["sites"]): ExportData {
    return {
        groups: [
            { id: 1, name: "常用工具", order_num: 0 },
            { id: 2, name: "开发", order_num: 1 },
        ],
        sites: sites ?? [
            {
                id: 10, group_id: 1, name: "示例", url: "https://example.com/",
                icon: "", description: "", notes: "", username: "", password: "",
                order_num: 0,
            },
            {
                id: 11, group_id: 2, name: "文档", url: "https://docs.example.com/",
                icon: "", description: "", notes: "", username: "", password: "",
                order_num: 0,
            },
        ],
        configs: { "site.title": "备份里的站名" },
        version: EXPORT_VERSION,
        exportDate: new Date().toISOString(),
    };
}

const countRows = async (api: Harness, table: string): Promise<number> => {
    const row = await api.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
    return Number(row?.c ?? 0);
};

async function setup() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    return { db, api };
}

/** 先在库里造一份「本来就有」的数据：1 个同名的分组（里面一张同链接的卡）+ 1 个无关分组 */
async function seedLocal(api: Harness) {
    const group = await api.createGroup({ name: "常用工具", order_num: 5 } as never);
    await api.createSite({
        group_id: group.id,
        name: "本地这张卡",
        url: "https://example.com/",
        icon: "",
        description: "本地写的描述",
        notes: "",
        order_num: 0,
    } as never);
    const other = await api.createGroup({ name: "本地独有分组", order_num: 9 } as never);
    await api.createSite({
        group_id: other.id,
        name: "本地独有卡片",
        url: "https://only-local.example.com/",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
    } as never);
    return { groupId: group.id as number, otherId: other.id as number };
}

test("真实 SQLite：重复导入同一份备份，行数不再增长（幂等）", async () => {
    const { api } = await setup();
    // 先导入一次：两份分组 + 两张卡片全部新建
    const first = await api.importData(backup());
    assert.equal(first.success, true, `首次导入应成功：${first.message ?? ""}`);
    const groupsAfterFirst = await countRows(api, "groups");
    const sitesAfterFirst = await countRows(api, "sites");

    const second = await api.importData(backup());
    assert.equal(second.success, true, `第二次导入应成功：${second.message ?? ""}`);

    assert.equal(await countRows(api, "groups"), groupsAfterFirst, "重复导入不该再建分组");
    assert.equal(await countRows(api, "sites"), sitesAfterFirst, "重复导入不该再建卡片");
    // 第二次必须全都认出是同一条：这一行是整个「增量 upsert」最直白的验收
    assert.deepEqual(second.stats, {
        groupsCreated: 0,
        groupsMatched: 2,
        sitesCreated: 0,
        sitesUpdated: 0,
        sitesSkipped: 2,
    });
});

test("真实 SQLite：本地已有的分组、卡片一条都不少，对照组还在", async () => {
    const { api } = await setup();
    const local = await seedLocal(api);
    const beforeGroups = await countRows(api, "groups");
    const beforeSites = await countRows(api, "sites");

    const result = await api.importData(backup());
    assert.equal(result.success, true, `导入应成功：${result.message ?? ""}`);

    // 只做加法：备份里 1 个新分组（开发）+ 1 张新卡（文档），其余全部认同一条
    assert.equal(await countRows(api, "groups"), beforeGroups + 1, "不该清掉本地分组");
    assert.equal(await countRows(api, "sites"), beforeSites + 1, "不该清掉本地卡片");
    assert.deepEqual(result.stats, {
        groupsCreated: 1,
        groupsMatched: 1,
        sitesCreated: 1,
        sitesUpdated: 0,
        sitesSkipped: 1,
    });

    // 本地那条独有的分组与卡片也必须在（对照「与之无关的本地数据不能被碰」）
    const still = await api.db
        .prepare("SELECT id FROM groups WHERE name = ?")
        .bind("本地独有分组")
        .first<{ id: number }>();
    assert.equal(still?.id, local.otherId, "本地独有的分组必须还在");
});

test("真实 SQLite：本地那条较新就不覆盖，备份里较新才更新", async () => {
    const { api } = await setup();
    await seedLocal(api);

    // ① 备份里那条没有 updated_at（老备份的样子）：判定为「本地较新」→ 保留本地
    const keep = await api.importData(backup());
    const row = await api.db
        .prepare("SELECT description FROM sites WHERE name = ?")
        .bind("本地这张卡")
        .first<{ description: string }>();
    assert.equal(row?.description, "本地写的描述", "不该被备份里的空值/旧值覆盖");
    assert.equal(keep.stats?.sitesUpdated, 0);
    assert.equal(keep.stats?.sitesSkipped, 1);

    // ② 备份里那条带着更新的时间戳：这时才应该把它写上去
    const newer = backup([
        {
            id: 10, group_id: 1, name: "示例（备份里改过）", url: "https://example.com/",
            icon: "", description: "备份里的新描述", notes: "", username: "", password: "",
            order_num: 0, updated_at: new Date(Date.now() + 60_000).toISOString(),
        },
    ] as ExportData["sites"]);
    const applied = await api.importData(newer);
    assert.equal(applied.stats?.sitesUpdated, 1, "备份那条更新就该覆盖");
    const after = await api.db
        .prepare("SELECT url, description FROM sites WHERE name = ?")
        .bind("示例（备份里改过）")
        .first<{ url: string; description: string }>();
    assert.equal(after?.description, "备份里的新描述", `实际行：${JSON.stringify(after)}`);
    // 就地更新：不能换 id（换了本地的星标 / 访问统计就全丢了）
    const stillOne = await api.db
        .prepare("SELECT COUNT(*) AS c FROM sites WHERE name = ?")
        .bind("示例（备份里改过）")
        .first<{ c: number }>();
    assert.equal(Number(stillOne?.c ?? 0), 1, "同一条只该有一行");
});

test("真实 SQLite：孤兜底分组「导入的站点」不会被一次导入一个", async () => {
    const { api } = await setup();
    // 站点指向了备份里不存在的分组：要造一个通用分组兜底，
    // 但重复导入时必须复用上一次那个 —— 否则每次导入都长出一个同名空分组。
    const orphan: ExportData = {
        ...backup([
            {
                id: 10, group_id: 999, name: "没有家的卡片", url: "https://orphan.example.com/",
                icon: "", description: "", notes: "", username: "", password: "", order_num: 0,
            },
        ] as ExportData["sites"]),
        groups: [],
    };

    await api.importData(orphan);
    const firstCount = await api.db
        .prepare("SELECT COUNT(*) AS c FROM groups WHERE name = ?")
        .bind("导入的站点")
        .first<{ c: number }>();
    assert.equal(Number(firstCount?.c ?? 0), 1, "第一次该造一个兜底分组");

    await api.importData(orphan);
    const secondCount = await api.db
        .prepare("SELECT COUNT(*) AS c FROM groups WHERE name = ?")
        .bind("导入的站点")
        .first<{ c: number }>();
    assert.equal(Number(secondCount?.c ?? 0), 1, "第二次必须复用它，不能再造一个");
    const cardCount = await api.db
        .prepare("SELECT COUNT(*) AS c FROM sites WHERE name = ?")
        .bind("没有家的卡片")
        .first<{ c: number }>();
    assert.equal(Number(cardCount?.c ?? 0), 1, "孤立卡片也只能有一张");
});

test("真实 SQLite：备份里的空配置不会把现有配置清空", async () => {
    const { api } = await setup();
    await api.setSystemConfig("site.title", "我自己的站名");

    await api.importData({
        ...backup(),
        configs: { "site.title": "" },
    });

    const title = await api.db
        .prepare("SELECT value FROM configs WHERE key = ?")
        .bind("site.title")
        .first<{ value: string }>();
    assert.equal(title?.value, "我自己的站名", "导入不该拿一个空值把现有配置擦掉");
});

test("真实 SQLite：校验不过就一行都不写（失败发生在动笔之前）", async () => {
    const { api } = await setup();
    await api.importData(backup());
    const beforeGroups = await countRows(api, "groups");
    const beforeSites = await countRows(api, "sites");

    // 一个超过上限的配置值：会在**进入唯一那次 batch 之前**就抛出，
    // 所以库里连一个字节都不该动（真要说「失败后数据不变」，这是最干净的一种）。
    const result = await api.importData({
        ...backup(),
        groups: [{ id: 1, name: "全新分组", order_num: 0 }],
        configs: { "site.iconApi": "x".repeat(300 * 1024) },
    });

    assert.equal(result.success, false, "这种数据必须报失败");
    assert.equal(await countRows(api, "groups"), beforeGroups, "失败后分组数不变");
    assert.equal(await countRows(api, "sites"), beforeSites, "失败后卡片数不变");
});
