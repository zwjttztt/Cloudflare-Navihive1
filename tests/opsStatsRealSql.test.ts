// tests/opsStatsRealSql.test.ts
//
// 运维统计看板聚合（getOpsStats）的服务端语义，真 SQLite 钉死：
// 内容计数（scope）/ 近 30 天审计活跃（缺日补零 + 窗口外排除）/
// 分享浏览 Top（note+group 合并排序）/ 链接健康快照解析 / 多账号隔离。
//
// 为什么必须真库：这条聚合里有 JOIN（note_share × notes、group_share × groups），
// JOIN 里 user_id 限不限表名、别名对不对，FakeD1 一律看不出来 —— 只有真 SQLite
// 能把「ambiguous column」「列不存在」这类线上 500 提前拦下。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

test("真实 SQLite：运维统计聚合四块齐全且按账号隔离", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(123);

    // —— 内容：两分组、两站点、两笔记、两附件（直接 SQL，免走上传链路）——
    const g1 = await api.createGroup({ name: "开发", order_num: 0 } as never);
    const g2 = await api.createGroup({ name: "生活", order_num: 1 } as never);
    await api.createSite({
        group_id: g1.id, name: "GitHub", url: "https://github.com", icon: "",
        description: "", notes: "", username: "", password: "", order_num: 0,
    } as never);
    await api.createSite({
        group_id: g1.id, name: "GitLab", url: "https://gitlab.com", icon: "",
        description: "", notes: "", username: "", password: "", order_num: 1,
    } as never);
    const noteA = await api.createNote({ title: "待办", content: "- [ ] x" } as never);
    const noteB = await api.createNote({ title: "笔记乙", content: "y" } as never);
    for (const [id, size] of [["att-1", 100], ["att-2", 200]] as const) {
        await db.prepare(
            "INSERT INTO attachments (id, user_id, note_id, filename, mime, size, storage, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, 123, noteA.id, `${id}.png`, "image/png", size, "r2", `k-${id}`, 1).run();
    }

    // —— 审计流水：今天 2 条 login、昨天 1 条 export、40 天前 1 条（窗口外）——
    for (const [action, offset] of [["login", "-0 day"], ["login", "-0 day"], ["export", "-1 day"], ["login", "-40 day"]] as const) {
        await db.prepare(
            "INSERT INTO audit_log (action, actor, ip, detail, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))"
        ).bind(action, "root", "127.0.0.1", "", offset).run();
    }

    // —— 分享浏览：分组 9 > 笔记甲 5 > 笔记乙 2 ——
    await db.prepare(
        "INSERT INTO note_share (note_id, note_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(noteA.id, noteA.uuid ?? "uuid-a", 123, "tok-a", 5).run();
    await db.prepare(
        "INSERT INTO note_share (note_id, note_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(noteB.id, noteB.uuid ?? "uuid-b", 123, "tok-b", 2).run();
    await db.prepare(
        "INSERT INTO group_share (group_id, group_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(g2.id, "guuid-2", 123, "tok-g", 9).run();

    // —— 链接健康快照 ——
    await api.setUserConfig(
        123,
        "link.health",
        JSON.stringify({
            v: 1,
            dead: { "https://dead.example": 200, "https://older.example": 100 },
            probe: { "https://ok.example": 1 },
            white: ["https://w.example"],
        })
    );

    const stats = await api.getOpsStats();
    assert.deepEqual(stats.counts, { sites: 2, groups: 2, notes: 2, attachments: 2, attachmentBytes: 300 });
    assert.equal(stats.auditDaily.length, 30);
    assert.equal(stats.auditDaily[29].count, 2, "最后一天是今天，应有 2 条 login");
    assert.equal(stats.auditDaily[0].count, 0, "29 天前那天没有记录（40 天前那条在窗口外）");
    assert.equal(stats.auditTopActions[0]?.action, "login");
    assert.equal(stats.auditTopActions[0]?.count, 2, "窗口内 login 只有 2 条（40 天前那条不算）");
    assert.deepEqual(stats.shareTop[0], { kind: "group", title: "生活", views: 9 });
    assert.deepEqual(stats.shareTop[1], { kind: "note", title: "待办", views: 5 });
    assert.deepEqual(stats.shareTop[2], { kind: "note", title: "笔记乙", views: 2 });
    assert.equal(stats.health.deadCount, 2);
    assert.equal(stats.health.total, 4);
    assert.equal(stats.health.deadLatest[0]?.url, "https://dead.example", "按失效时间倒序");
});

test("真实 SQLite：看板聚合按账号隔离，别人的数据不进来", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    api.setCurrentUser(123);

    await api.createGroup({ name: "我的分组", order_num: 0 } as never);
    const myNote = await api.createNote({ title: "我的笔记", content: "" } as never);
    await db.prepare(
        "INSERT INTO note_share (note_id, note_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(myNote.id, myNote.uuid ?? "uuid-mine", 123, "tok-mine", 1).run();

    // 别的账号：一组一站点一笔记带高分分享
    api.setCurrentUser(456);
    const otherGroup = await api.createGroup({ name: "别人的分组", order_num: 0 } as never);
    await api.createSite({
        group_id: otherGroup.id, name: "别人的站", url: "https://other.example", icon: "",
        description: "", notes: "", username: "", password: "", order_num: 0,
    } as never);
    const otherNote = await api.createNote({ title: "别人的笔记", content: "" } as never);
    await db.prepare(
        "INSERT INTO note_share (note_id, note_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(otherNote.id, otherNote.uuid ?? "uuid-other", 456, "tok-other", 99).run();
    await db.prepare(
        "INSERT INTO group_share (group_id, group_uuid, user_id, token, views) VALUES (?, ?, ?, ?, ?)"
    ).bind(otherGroup.id, "guuid-o", 456, "tok-g-other", 88).run();

    // 回到 123 看板
    api.setCurrentUser(123);
    const stats = await api.getOpsStats();
    assert.equal(stats.counts.sites, 0, "别人的站点不进我的计数");
    assert.equal(stats.counts.groups, 1);
    assert.equal(stats.counts.notes, 1);
    assert.ok(!stats.shareTop.some(s => s.title === "别人的笔记"), "别人的高分分享不进我的榜单");
    assert.ok(!stats.shareTop.some(s => s.title === "别人的分组"));
    assert.deepEqual(stats.shareTop, [{ kind: "note", title: "我的笔记", views: 1 }]);
});
