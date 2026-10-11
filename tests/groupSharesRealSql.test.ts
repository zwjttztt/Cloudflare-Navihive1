// tests/groupSharesRealSql.test.ts
//
// 分组分享（阶段④）的服务端语义，真 SQLite 钉死：
// 创建轮换令牌 / 更新保留令牌 / 撤销 / 公开读取脱敏（密码字段结构上不出门）/
// 口令 need-password / 组删除后 not-found。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

test("真实 SQLite：分组分享生命周期与公开读取", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    // 建一个分组 + 两张卡片（带密码字段的原始行，验证脱敏）
    const group = await api.createGroup({ name: "开发资源", order_num: 0 } as never);
    await api.createSite({
        group_id: group.id,
        name: "GitHub",
        url: "https://github.com",
        icon: "",
        description: "代码托管",
        notes: "",
        username: "secret-user",
        password: "secret-pass",
        order_num: 0,
    } as never);

    // 未分享时主人查配置 = null
    assert.equal(await api.getGroupShareConfig(group.id!), null);

    // 创建（7 天 + 口令）
    const created = await api.createGroupShare(group.id!, 7, "letmein");
    assert.ok(created?.token);
    assert.match(created!.token, /^[a-f0-9]{64}$/);
    assert.ok(!!created!.hasPassword, "创建带口令的分享后 hasPassword 应为真");

    // 更新设置：链接不变（token 保留）、改永久、清口令
    const updated = await api.updateGroupShare(group.id!, null, null);
    assert.equal(updated!.token, created!.token, "更新设置必须保留令牌");
    assert.equal(updated!.expires_at, null);
    assert.ok(!updated!.hasPassword, "清口令后 hasPassword 应为假");

    // 公开读取：脱敏（sites 无 username/password 字段）+ 计数
    const first = await api.getPublicGroupShare(created!.token);
    assert.equal(first.status, "ok");
    if (first.status === "ok") {
        assert.equal(first.group.name, "开发资源");
        assert.equal(first.sites.length, 1);
        const site = first.sites[0];
        assert.equal(site.name, "GitHub");
        assert.equal(site.url, "https://github.com");
        assert.equal("password" in site, false, "站点密码结构上不能出现在公开响应里");
        assert.equal("username" in site, false, "站点用户名结构上不能出现在公开响应里");
        assert.equal(first.views, 1);
    }

    // 设回口令后：不带口令 → need-password；带对 → ok；带错 → need-password
    await api.updateGroupShare(group.id!, null, "pw2");
    assert.equal((await api.getPublicGroupShare(created!.token)).status, "need-password");
    assert.equal((await api.getPublicGroupShare(created!.token, "wrong")).status, "need-password");
    assert.equal((await api.getPublicGroupShare(created!.token, "pw2")).status, "ok");

    // 撤销后 → not-found
    await api.revokeGroupShare(group.id!);
    assert.equal((await api.getPublicGroupShare(created!.token)).status, "not-found");
});

test("真实 SQLite：重新创建轮换令牌；组删除后公开读取 not-found；假 token 一律 not-found", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();

    const group = await api.createGroup({ name: "临时组", order_num: 0 } as never);
    const a = await api.createGroupShare(group.id!, null, null);
    const b = await api.createGroupShare(group.id!, null, null);
    assert.notEqual(a!.token, b!.token, "重复创建必须轮换令牌（旧链接立即失效）");
    assert.equal((await api.getPublicGroupShare(a!.token)).status, "not-found", "旧令牌要失效");

    // 删分组（进回收站 + 删行）：公开读取 JOIN groups 落空 → not-found
    await api.deleteGroup(group.id!);
    assert.equal((await api.getPublicGroupShare(b!.token)).status, "not-found");

    // 假 token / 非法 token 一律 not-found（不报错）
    assert.equal((await api.getPublicGroupShare("not-a-token")).status, "not-found");
    assert.equal((await api.getPublicGroupShare("z".repeat(64))).status, "not-found");
});
