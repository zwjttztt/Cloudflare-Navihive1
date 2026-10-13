// tests/siteTombstone.test.ts
// 卡片删除墓碑 + /api/sites/changes（增量同步）。
//
// 为什么需要它：删除是**物理删行**（数据搬进 recycle_bin），只看 updated_at 的
// 轮询永远看不见「少了哪张卡」。笔记侧为此加了 note_tombstone + notes/changes，
// 卡片侧是同一个问题、同一个解法。这里用真 SQLite 钉住「删了 → 端点能查到」。

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";

/** 让两次删除落在不同的毫秒上：真库操作太快，同一毫秒的墓碑游标区分不出先后 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fresh() {
    const db = makeRealD1();
    const api = makeRealApi(db);
    resetMigrationCacheForTests();
    await api.migrate();
    return { db, api };
}

async function makeSite(api: ReturnType<typeof makeRealApi>) {
    const group = await api.createGroup({ name: "分组", order_num: 0 } as never);
    const site = await api.createSite({
        group_id: group.id,
        name: "待删的卡",
        url: "https://gone.example/",
        order_num: 0,
    } as never);
    return site;
}

test("真实 SQLite：删卡会写墓碑，/api/sites/changes 能查到这个 id", async () => {
    const { api } = await fresh();
    const site = await makeSite(api);
    const id = site.id as number;

    // 删除前的基线：没有墓碑
    const before = await api.siteChanges();
    assert.deepEqual(before.deleted, [], "还没删，不该有墓碑");

    const del = await api.deleteSite(id);
    assert.equal(del.success, true);

    const after = await api.siteChanges();
    assert.ok(after.deleted.includes(id), "删掉的卡片 id 要出现在增量里");
});

test("真实 SQLite：批量删除每张卡各留一条墓碑", async () => {
    const { api } = await fresh();
    const a = await makeSite(api);
    const b = await makeSite(api);
    const ids = [a.id as number, b.id as number];

    const result = await api.deleteSites(ids);
    assert.equal(result.failed.length, 0, "两张都要删成功");

    const changes = await api.siteChanges();
    for (const id of ids) {
        assert.ok(changes.deleted.includes(id), `批量删除要留 ${id} 的墓碑`);
    }
});

test("真实 SQLite：带 since 游标只回之后的删除（旧墓碑不再重复下发）", async () => {
    const { api } = await fresh();
    const first = await makeSite(api);
    await api.deleteSite(first.id as number);

    const cursor = (await api.siteChanges()).since;
    await sleep(10);
    // 游标之后的这次删除
    const second = await makeSite(api);
    await api.deleteSite(second.id as number);

    const after = await api.siteChanges(cursor);
    assert.ok(after.deleted.includes(second.id as number), "游标之后的删除要回");
    assert.ok(!after.deleted.includes(first.id as number), "游标之前的删除不该重复下发");
});

test("真实 SQLite：墓碑表缺失时端点退化成空而不是 500", async () => {
    const { db, api } = await fresh();
    // 模拟「老库：表还没建出来」—— 直接删掉这张表
    await db.exec("DROP TABLE IF EXISTS site_tombstone");
    const changes = await api.siteChanges();
    assert.deepEqual(changes.deleted, [], "表缺失时退化成「没有删除」，不能 500");
});
