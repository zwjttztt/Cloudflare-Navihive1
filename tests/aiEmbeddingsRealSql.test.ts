// tests/aiEmbeddingsRealSql.test.ts
//
// AI 向量的账号隔离，真 SQLite 钉死（2026-10-11 导航站侧自查的 P1 修复）：
// 修复前 `DELETE FROM site_embeddings WHERE model != ?` 是全表删——
// B 账号换模型补一次向量，A 账号的向量被静默清光（语义搜索悄悄退化成
// 关键词搜索，无报错）。修复后删除/写入都限定在本人站点内。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { makeRealD1, makeRealApi } from "./helpers/realSqliteD1";

/** 建两个账号（root 种子用户 + 邀请注册的 alice），返回各自 id */
async function twoUsers(db: ReturnType<typeof makeRealD1>, api: ReturnType<typeof makeRealApi>) {
    const rootRow = await db.prepare("SELECT id FROM users WHERE username = 'root'").first<{ id: number }>();
    const ownerId = rootRow!.id;
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    assert.ok(registered.success, "alice 注册成功");
    return { ownerId, aliceId: registered.user!.id as number };
}

async function makeSiteWithVector(
    api: ReturnType<typeof makeRealApi>,
    name: string
): Promise<number> {
    const group = await api.createGroup({ name, order_num: 0 } as never);
    const site = await api.createSite({
        group_id: group.id,
        name,
        url: `https://${name}.example.com/`,
        icon: "",
        description: "",
        order_num: 0,
    } as never);
    return Number(site!.id);
}

test("真实 SQLite：换模型补向量只清本人站点的旧向量，不碰别人的", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const { ownerId, aliceId } = await twoUsers(db, api);

    // 各建一张站点卡，先用同一模型 A 各写一份向量
    api.setCurrentUser(ownerId);
    const rootSite = await makeSiteWithVector(api, "root-site");
    await api.replaceEmbeddings([{ siteId: rootSite, vec: [1, 2, 3] }], "model-A");

    api.setCurrentUser(aliceId);
    const aliceSite = await makeSiteWithVector(api, "alice-site");
    await api.replaceEmbeddings([{ siteId: aliceSite, vec: [4, 5, 6] }], "model-A");

    // 各自都能读到自己的 model-A 向量
    assert.equal((await api.countEmbeddings("model-A")), 1, "alice 视角：自己 1 条");
    api.setCurrentUser(ownerId);
    assert.equal((await api.countEmbeddings("model-A")), 1, "root 视角：自己 1 条");

    // ⚠️ 关键断言：alice 换到 model-B 补向量——修复前这里会把 root 的 model-A 全删掉
    api.setCurrentUser(aliceId);
    const written = await api.replaceEmbeddings([{ siteId: aliceSite, vec: [7, 8] }], "model-B");
    assert.equal(written, 1);

    // root 的 model-A 向量必须完好
    api.setCurrentUser(ownerId);
    const rootRows = await api.listEmbeddings("model-A");
    assert.deepEqual(
        rootRows.map(r => r.id),
        [rootSite],
        "换模型清理不得波及其他账号的向量"
    );

    // alice 自己：model-A 已清、model-B 就位
    api.setCurrentUser(aliceId);
    assert.equal((await api.countEmbeddings("model-A")), 0, "本人的旧模型向量要清掉");
    assert.equal((await api.countEmbeddings("model-B")), 1);
});

test("真实 SQLite：给别人的站点写向量会被过滤掉", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    const { ownerId, aliceId } = await twoUsers(db, api);

    api.setCurrentUser(ownerId);
    const rootSite = await makeSiteWithVector(api, "root-site");

    // alice 伪造请求：把向量写到 root 的站点上——必须被归属校验拦下
    api.setCurrentUser(aliceId);
    const written = await api.replaceEmbeddings(
        [
            { siteId: rootSite, vec: [9, 9, 9] },
            { siteId: -1, vec: [1, 1] },
        ],
        "model-X"
    );
    assert.equal(written, 0, "别人的站点写不进向量");

    // root 的站点依旧没有向量（没有被污染）
    api.setCurrentUser(ownerId);
    assert.equal((await api.countEmbeddings("model-X")), 0);
});
