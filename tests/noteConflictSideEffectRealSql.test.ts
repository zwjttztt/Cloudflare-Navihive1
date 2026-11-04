// tests/noteConflictSideEffectRealSql.test.ts
//
// R02 回归钉子：**真实 SQLite** 里断言「乐观锁冲突（主 UPDATE 命中 0 行）时，
// 解绑同站其它笔记 + 自动标签这两条副作用也完全不发生」。
//
// 为什么必须真库：副作用和主 UPDATE 在同一个 batch（= 一个事务）里，但 batch 的原子性
// 只覆盖「语句报错回滚」，不覆盖「主语句 0 行命中」这种静默分支。只有真引擎才会让
// 0 行命中的事实落到 EXISTS 守卫上 —— FakeD1 / MockD1 永远 success，测不出这个。
//
// 修复前的症状：A 持过期 rev 并请求把笔记绑到 S（S 已被 B 绑着）→ 主 UPDATE 0 行，
// 但 B 已被静默解绑、A 旧正文里的标签也被写进库。修复后：冲突时这两件事都不发生。

import assert from "node:assert/strict";
import test from "node:test";
import { makeRealApi, makeRealD1 } from "./helpers/realSqliteD1";
import { resetMigrationCacheForTests } from "../src/API/http";
import { isNoteConflict } from "../src/utils/noteConflict";

async function fresh() {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署：user_id 都是 NULL，IS/=/ 语义只在真引擎上说得清
    return { db, api };
}

/** 建一个分组 + 一张卡片，返回卡片 id */
async function seedSite(api: ReturnType<typeof makeRealApi>, name = "示例站"): Promise<number> {
    const group = await api.createGroup({ name: "默认分组", order_num: 0 });
    const site = await api.createSite({
        group_id: group.id as number,
        name,
        url: "https://example.com",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
    });
    return site.id as number;
}

test("真实 SQLite：过期 rev 换绑冲突时，不得解绑同站点的另一篇笔记", async () => {
    const { db, api } = await fresh();
    const siteId = await seedSite(api);
    const note1 = await api.createNote({ title: "第一篇", content: "" });
    const note2 = await api.createNote({ title: "第二篇", content: "" });

    // note1 先绑到 S
    await api.updateNote(note1.id as number, { site_id: siteId });
    assert.equal((await api.querySite(siteId))?.note_id, note1.id);

    // 别人（另一设备）把 note2 绑到 S —— 这会解绑 note1，S→note2
    await api.updateNote(note2.id as number, { site_id: siteId });
    assert.equal((await api.querySite(siteId))?.note_id, note2.id, "换绑后 S 指向 note2");
    assert.equal((await api.getNote(note1.id as number))?.site_id, null, "note1 被让位");

    // note1 的客户端手里的还是旧 rev（=1），拿过期 rev 重试换绑 S —— 必须冲突且不旁写
    let caught: unknown = null;
    try {
        await api.updateNote(note1.id as number, { site_id: siteId, rev: 1 });
    } catch (error) {
        caught = error;
    }
    assert.ok(isNoteConflict(caught), "过期 rev 换绑必须抛冲突");

    // ⚠️ 关键断言：note2 仍稳稳绑在 S 上，不能被「冲突的那次」静默解绑
    assert.equal((await api.querySite(siteId))?.note_id, note2.id, "冲突不得解绑 note2");
    assert.equal((await api.getNote(note2.id as number))?.site_id, siteId, "note2 的绑定必须完好");
    // note1 自己的 site_id 也不该被这次失败的操作改动
    assert.equal((await api.getNote(note1.id as number))?.site_id, null, "note1 仍应是解绑态");
    const bound = await db.prepare("SELECT COUNT(*) AS c FROM notes WHERE site_id = ?").bind(siteId).first<{ c: number }>();
    assert.equal(bound?.c, 1, "同一个站点在库里依旧只有一篇笔记指着它");
});

test("真实 SQLite：过期 rev 冲突时，旧正文里的自动标签不得被写进库", async () => {
    const { db, api } = await fresh();
    const note1 = await api.createNote({ title: "甲", content: "初始正文" });
    // 先正常改一次把 rev 顶到 2（模拟别人已改过），这版也不带标签
    await api.updateNote(note1.id as number, { content: "被别人改过" });
    assert.equal((await api.getNote(note1.id as number))?.rev, 2);
    // 冲突前库里没有任何标签、note1 没有任何标签链接
    const beforeTags = await db.prepare("SELECT COUNT(*) AS c FROM note_tag").first<{ c: number }>();
    assert.equal(beforeTags?.c, 0, "冲突前不应有任何标签");

    // 旧客户端手里的还是 rev=1，且正文里多了一个新标签 #stale，拿过期 rev 重试
    let caught: unknown = null;
    try {
        await api.updateNote(note1.id as number, { content: "旧正文 #stale", rev: 1 });
    } catch (error) {
        caught = error;
    }
    assert.ok(isNoteConflict(caught), "过期 rev 保存必须抛冲突");

    // ⚠️ 关键断言：冲突时 #stale 这个标签既不能被新建、也不能被挂到 note1 上
    const staleTag = await db.prepare("SELECT id FROM note_tag WHERE name = ?").bind("stale").first<{ id: number }>();
    assert.equal(staleTag, null, "冲突不得新建 #stale 标签");
    const link = await db.prepare("SELECT COUNT(*) AS c FROM note_note_tag WHERE note_id = ?").bind(note1.id as number).first<{ c: number }>();
    assert.equal(link?.c, 0, "冲突不得给 note1 挂任何标签");
    const tagCount = await db.prepare("SELECT COUNT(*) AS c FROM note_tag").first<{ c: number }>();
    assert.equal(tagCount?.c, 0, "冲突不得创建任何标签");
    // 库里内容必须是被别人改过的那一版，冲突的那版一个字节都没落
    assert.equal((await api.getNote(note1.id as number))?.content, "被别人改过");
});

test("真实 SQLite：带上正确 rev 换绑，副作用照常生效（解绑旧 + 绑定新 + 标签）", async () => {
    const { db, api } = await fresh();
    const siteId = await seedSite(api);
    const note1 = await api.createNote({ title: "甲", content: "#init" });
    const note2 = await api.createNote({ title: "乙", content: "" });

    // note1 绑到 S
    await api.updateNote(note1.id as number, { site_id: siteId });
    // note2 是新建且从未改过的笔记，rev 仍是 1 —— 带上正确 rev 换绑到 S，
    // 正文再带个新标签 #fresh：解绑旧笔记、绑定新笔记、自动标签三种副作用都该生效
    const saved = await api.updateNote(note2.id as number, {
        site_id: siteId,
        content: "#fresh 正文",
        rev: 1,
    });
    assert.ok(saved, "正确 rev 必须能保存");
    // note1 应被让位
    assert.equal((await api.getNote(note1.id as number))?.site_id, null, "换绑后旧笔记解绑");
    assert.equal((await api.querySite(siteId))?.note_id, note2.id, "S 指向新笔记");
    // 新标签 #fresh 必须真的建好并挂上
    const freshTag = await db.prepare("SELECT id FROM note_tag WHERE name = ?").bind("fresh").first<{ id: number }>();
    assert.ok(freshTag, "#fresh 标签应被创建");
    const link = await db.prepare("SELECT COUNT(*) AS c FROM note_note_tag WHERE note_id = ? AND tag_id = ?").bind(note2.id as number, freshTag!.id).first<{ c: number }>();
    assert.equal(link?.c, 1, "#fresh 必须挂到 note2 上");
});

test("真实 SQLite：不传 rev（老客户端）换绑仍照旧生效，且冲突语义不影响老路径", async () => {
    const { api } = await fresh();
    const siteId = await seedSite(api);
    const note1 = await api.createNote({ title: "甲", content: "" });
    const note2 = await api.createNote({ title: "乙", content: "" });

    // 老客户端不知道 rev，两次换绑都该成功（后到的让位）
    await api.updateNote(note1.id as number, { site_id: siteId });
    await api.updateNote(note2.id as number, { site_id: siteId });
    assert.equal((await api.querySite(siteId))?.note_id, note2.id, "老客户端换绑顺序生效");
    assert.equal((await api.getNote(note1.id as number))?.site_id, null);
});
