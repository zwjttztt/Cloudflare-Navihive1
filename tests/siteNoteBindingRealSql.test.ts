// tests/siteNoteBindingRealSql.test.ts
//
// #477 站点↔笔记双向绑定：**真实 SQLite** 里跑一遍。
//
// 为什么又是真库：这一批改的全是 SQL 细节，FakeD1 / MockD1 一个也测不出来 ——
//   1. `SITE_SELECT_WITH_NOTE` 里那两个相关子查询用了 `n.user_id IS s.user_id`。
//      单账号部署两边都是 NULL，写成 `=` 的话条件永远不成立（一条也带不出来）；
//      多账号部署又必须真按账号对上。这种 NULL 语义只有真引擎说得清。
//   2. 「一个站点只绑一篇」是靠 batch 里**先解绑、再更新**的顺序保证的。
//      顺序反了不会报错，只会静默地把刚绑好的又清掉 —— 必须跑真 SQL 断言最终状态。
//   3. 卡片删了笔记要留下（悬空引用），这条也只在真有行的库里看得出。
//
// 用例覆盖：绑定往返 / 换绑（一站一篇）/ 解除 / 新建即绑 / 账号隔离 / 站点删除后悬空。

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/http";

/** 把 node:sqlite 包成 D1 形状的替身（与 noteFolderTagRealSql.test.ts 同一套） */
function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) {
                bound = args as SQLInputValue[];
                return prepared;
            },
            all<T = Record<string, unknown>>() {
                return Promise.resolve({
                    results: stmt.all(...bound) as T[],
                    success: true as const,
                });
            },
            first<T = Record<string, unknown>>() {
                const row = stmt.get(...bound) as T | undefined;
                return Promise.resolve((row ?? null) as T | null);
            },
            run() {
                const r = stmt.run(...bound);
                return Promise.resolve({
                    success: true as const,
                    meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
                });
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(db.prepare(sql)),
        // ⚠️ 必须把每条语句的**行**带回来：真 D1 的 batch() 返回的每一项都有
        // `results`（RETURNING / SELECT 的行就在里面），而业务代码里
        // `(await db.batch([...]))[i].results` 是拿来判断「插进去了没有」的。
        // 早先这个替身用 run() 拼，results 恒为 undefined ——
        // createNote 会因此一路抛「创建笔记失败」，看着像业务 bug、其实是桩不准。
        batch: async (stmts: Array<{ all: () => Promise<unknown> }>) =>
            Promise.all(stmts.map(s => s.all())) as never,
        async exec(sql: string) {
            db.exec(sql);
        },
        /** 直接查一行（断言库里的真实状态用，不经过业务代码） */
        raw: <T = Record<string, unknown>>(sql: string, ...args: SQLInputValue[]): T | undefined =>
            db.prepare(sql).get(...args) as T | undefined,
    };
}

type RealD1 = ReturnType<typeof makeRealD1>;

function makeApi(db: RealD1): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

/** 建一个分组 + 一张卡片，返回卡片 id */
async function seedSite(api: NavigationAPI, name = "示例站"): Promise<number> {
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

test("真实 SQLite：绑定后站点读接口带出 note_id / note_title", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    api.setCurrentUser(null); // 单账号部署：sites.user_id 与 notes.user_id 都是 NULL

    const siteId = await seedSite(api);
    const note = await api.createNote({ title: "这个站的登录方式", content: "账号 admin" });

    // 绑定前：两个字段是 null（不是缺字段 —— 前端靠 null 判断「没绑」）
    const before = await api.querySite(siteId);
    assert.equal(before?.note_id, null);
    assert.equal(before?.note_title, null);

    await api.updateNote(note.id as number, { site_id: siteId });

    const after = await api.querySite(siteId);
    assert.equal(after?.note_id, note.id);
    assert.equal(after?.note_title, "这个站的登录方式");

    // 列表路径同样要带出来（卡片是走 getSites 的，不是 getSite）
    const list = await api.querySites();
    assert.equal(list.length, 1);
    assert.equal(list[0].note_id, note.id);
    assert.equal(list[0].note_title, "这个站的登录方式");
});

test("真实 SQLite：一个站点只留一篇 —— 换绑会把上一篇解绑", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    api.setCurrentUser(null);

    const siteId = await seedSite(api);
    const first = await api.createNote({ title: "第一篇", content: "" });
    const second = await api.createNote({ title: "第二篇", content: "" });

    await api.updateNote(first.id as number, { site_id: siteId });
    await api.updateNote(second.id as number, { site_id: siteId });

    // 卡片上只剩后来的那篇
    const site = await api.querySite(siteId);
    assert.equal(site?.note_id, second.id);
    assert.equal(site?.note_title, "第二篇");

    // 第一篇仍然存在，只是不再挂在站点上（笔记本身绝不能被删）
    const stale = await api.getNote(first.id as number);
    assert.ok(stale, "被换下来的笔记必须还在");
    assert.equal(stale?.site_id, null);
    // 库里也真的没有第二条指向这个站点
    const count = db.raw<{ c: number }>(
        "SELECT COUNT(*) AS c FROM notes WHERE site_id = ?",
        siteId
    );
    assert.equal(count?.c, 1, "同一个站点在库里最多只能有一篇笔记指着它");
});

test("真实 SQLite：解除绑定后站点侧回到 null，笔记保留", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    api.setCurrentUser(null);

    const siteId = await seedSite(api);
    const note = await api.createNote({ title: "临时绑定", content: "" });
    await api.updateNote(note.id as number, { site_id: siteId });
    assert.equal((await api.querySite(siteId))?.note_id, note.id);

    // 显式传 null 才是「解除」；不传 == 不动它（这个语义与 folder_id 一致）
    await api.updateNote(note.id as number, { site_id: null });
    assert.equal((await api.querySite(siteId))?.note_id, null);
    assert.ok(await api.getNote(note.id as number));
});

test("真实 SQLite：新建笔记时就带 site_id，原来那篇同样让位", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    api.setCurrentUser(null);

    const siteId = await seedSite(api);
    const old = await api.createNote({ title: "旧笔记", content: "" });
    await api.updateNote(old.id as number, { site_id: siteId });

    // 「新建笔记并绑定」走的就是这条路：一次 INSERT，不需要再补一次 UPDATE
    const created = await api.createNote({ title: "新笔记", content: "", site_id: siteId });
    assert.equal(created.site_id, siteId);

    const site = await api.querySite(siteId);
    assert.equal(site?.note_id, created.id);
    assert.equal((await api.getNote(old.id as number))?.site_id, null);
});

test("真实 SQLite：账号隔离 —— 别人的卡片不会带出我的笔记标题", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();

    // 账号 1 建卡 + 建笔记并绑定
    api.setCurrentUser(1);
    const siteId = await seedSite(api, "别人的站");
    const note = await api.createNote({ title: "账号一的私密笔记", content: "" });
    await api.updateNote(note.id as number, { site_id: siteId });
    assert.equal((await api.querySite(siteId))?.note_title, "账号一的私密笔记");

    // 账号 2 看不到这张卡（sites 自己就按账号隔离）
    api.setCurrentUser(2);
    assert.equal(await api.querySite(siteId), null);
    assert.deepEqual(await api.querySites(), []);

    // 账号 2 即使把自己的笔记 site_id 硬指到账号 1 的站点上（绕过路由校验的极端情况），
    // 也不能让账号 1 的卡片显示账号 2 的标题 —— 子查询里的 user_id 对得上才算。
    const mine = await api.createNote({ title: "账号二的笔记", content: "" });
    await api.updateNote(mine.id as number, { site_id: siteId });

    api.setCurrentUser(1);
    const viewByOwner = await api.querySite(siteId);
    assert.equal(viewByOwner?.note_id, note.id);
    assert.equal(viewByOwner?.note_title, "账号一的私密笔记");
});

test("真实 SQLite：站点被删后笔记留下，site_id 变成悬空引用", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeApi(db);
    await api.migrate();
    api.setCurrentUser(null);

    const siteId = await seedSite(api);
    const note = await api.createNote({ title: "卡片没了也要留下", content: "" });
    await api.updateNote(note.id as number, { site_id: siteId });

    await api.deleteSite(siteId);

    // 笔记还在，并且 site_id 仍指向那个已经不存在的 id：
    // 这是**刻意**的设计（见 types.ts 里 Note.site_id 的注释），
    // 前端据此显示「站点已删除」而不是把绑定静默抹掉。
    const kept = await api.getNote(note.id as number);
    assert.ok(kept);
    assert.equal(kept?.site_id, siteId);
});
