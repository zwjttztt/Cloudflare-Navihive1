// tests/sitePasswordBackfill.test.ts
// 站点凭据「升级前明文 → 一次性加密写回」这一步（migration schema 20）。
//
// 为什么单独一组：写入路径早就加密了（insertSite/updateSiteRow），真正留下风险的是
// **升级前落库、之后没再编辑过**的那批行 —— 它们在 D1 导出 / 备份文件里是明文。
// 这一步的失败模式特别危险：encryptSecret 拿不到密钥时返回**空串**，照写就是把老凭据
// 清空（比留明文更糟），所以守卫「先探密钥再动笔」必须有用例钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";

async function fresh() {
    const db = makeRealD1();
    const api = makeRealApi(db);
    resetMigrationCacheForTests();
    await api.migrate();
    return { db, api };
}

/** 站点有 group_id 外键，先建一个分组（真 SQLite 强制外键） */
async function ensureGroup(db: ReturnType<typeof makeRealD1>): Promise<number> {
    await db
        .prepare("INSERT INTO groups (name, order_num) VALUES ('老分组', 0)")
        .run();
    const row = await db
        .prepare("SELECT id FROM groups WHERE name = '老分组'")
        .first<{ id: number }>();
    return row?.id ?? 0;
}

/** 造一张「升级前」的卡：密码是明文（没有 enc$ 前缀） */
async function legacySite(db: ReturnType<typeof makeRealD1>, password: string, name: string) {
    const groupId = await ensureGroup(db);
    await db
        .prepare(
            `INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num)
             VALUES (?, ?, 'https://legacy.example/', '', '', '', '', ?, 0)`
        )
        .bind(groupId, name, password)
        .run();
}

/** 把 schema 版本退回去再重置缓存 = 模拟「老库升级上来」的迁移流程 */
async function replayMigration(api: ReturnType<typeof makeRealApi>) {
    // ⚠️ 必须同时清空「已执行步骤」集合：现在的迁移闸门按步骤集合跳过已跑过的步骤，
    // 光退 schema.version 不够 —— 不然第一轮 migrate 已经把所有步骤记进集合，
    // 这一轮会整批跳过、明文永远不被加密（见 MIGRATION_STEPS / runMigrations）。
    await api.writeSchemaVersion("19");
    await api.writeMigrationSteps([]);
    resetMigrationCacheForTests();
    await api.migrate();
}

test("真实 SQLite：升级前的明文站点凭据会被加密写回，且能解密回原值", async () => {
    const { db, api } = await fresh();
    await legacySite(db, "plain-secret-1", "老卡片一");

    // 迁移前：库里躺着明文
    const before = await db
        .prepare("SELECT password FROM sites WHERE name = '老卡片一'")
        .first<{ password: string }>();
    assert.equal(before?.password, "plain-secret-1");
    assert.ok(!String(before?.password).startsWith("enc$"), "迁移前是明文");

    await replayMigration(api);

    const after = await db
        .prepare("SELECT password FROM sites WHERE name = '老卡片一'")
        .first<{ password: string }>();
    assert.ok(String(after?.password).startsWith("enc$"), "迁移后应是密文（enc$ 前缀）");

    // 走真实读路径：解密回来还是原值
    const sites = await api.getSites();
    const site = sites.find(s => s.name === "老卡片一");
    assert.equal(site?.password, "plain-secret-1", "读出来要还原成明文");
});

test("真实 SQLite：已经是密文的行不受影响（不被二次加密）", async () => {
    const { db, api } = await fresh();
    // 走正常写入路径建一张卡（落库即密文）
    const groupId = await ensureGroup(db);
    const created = await api.createSite({
        group_id: groupId,
        name: "新卡片",
        url: "https://new.example/",
        password: "new-secret",
        order_num: 0,
    } as never);
    assert.ok(created, "建卡要成功");

    const before = await db
        .prepare("SELECT password FROM sites WHERE name = '新卡片'")
        .first<{ password: string }>();
    assert.ok(String(before?.password).startsWith("enc$"));

    await replayMigration(api);

    const sites = await api.getSites();
    const site = sites.find(s => s.name === "新卡片");
    assert.equal(
        site?.password,
        "new-secret",
        "重复迁移不该把已经加密的凭据套成「密文的密文」"
    );
});

test("真实 SQLite：空密码行不被写入任何东西（不给空串加密）", async () => {
    const { db, api } = await fresh();
    await legacySite(db, "", "没有凭据的卡");

    await replayMigration(api);

    const row = await db
        .prepare("SELECT password FROM sites WHERE name = '没有凭据的卡'")
        .first<{ password: string }>();
    assert.equal(row?.password, "", "空密码保持为空，不该被写成 enc$ 空壳");
});

test("真实 SQLite：迁移是幂等的 —— 连跑两次读出来的还是原值", async () => {
    const { db, api } = await fresh();
    await legacySite(db, "plain-secret-2", "老卡片二");

    await replayMigration(api);
    await replayMigration(api);

    const sites = await api.getSites();
    const site = sites.find(s => s.name === "老卡片二");
    assert.equal(site?.password, "plain-secret-2");
});
