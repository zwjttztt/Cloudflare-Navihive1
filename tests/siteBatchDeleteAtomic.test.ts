// tests/siteBatchDeleteAtomic.test.ts
// 批量删除的两条硬性质（P1 第 12 项，2026-10-30）：
//
//  1) **每批都不越过 D1 的单条语句上限**。以前 500 个 id 拼成一条 `IN (?×500)`：
//     本机 SQLite 上限 32766 跑得飞起，D1 上限 100 个绑定参数 —— 一到线上整条失败。
//     这条性质本机测不出来，只能靠「记录每条 SQL 绑了几个参数」来钉。
//  2) **中途失败不留半截状态**。以前「写回收站」是一个 batch、「删真身 + 墓碑 + 审计」
//     是另一个 batch，中间崩一次就留下「回收站里有、站点还在」—— 用户看到的是
//     卡片没删掉，回收站却多了一堆条目，而且无从解释。
//
// 为什么值得单独一个文件：这两条以前**任何绿灯检查都发现不了**。siteBatchDelete.test.ts
// 守的是「一次调用删完 / 回收站一条不少」，它用的是逐条生效的假 db（batch 就是
// Promise.all），所以也测不出原子性 —— 这里给了一个**会回滚的 batch** 才测得出来。
import test from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { D1_MAX_BOUND_PARAMS } from "../src/API/d1Limits";

/**
 * 还原用的兜底列清单 —— **故意在测试里自己写一份**，不从 internals.ts 引。
 *
 * 为什么：那个文件正被另一位同事同时修改（FTS 第 8 项），我的测试去引它的导出，
 * 等于让「他的改动」能红「我的用例」—— 两个人互不知情地耦合在同一个常量上。
 * 这里要的只是「还原站点时该带哪些列」，与表结构一致即可，没有共享的必要。
 * （真值以 internals.ts 的 SITE_RESTORE_COLUMNS 为准，改表结构时两边都可能要动，
 *   但动的是测试自己的清单，不会拖累别人。）
 */
const RESTORE_COLUMNS = [
    "id", "group_id", "name", "url", "icon", "description", "notes",
    "username", "password", "order_num", "created_at", "updated_at", "user_id",
];

type Row = Record<string, unknown>;

interface Store {
    sites: Row[];
    recycle: Row[];
    tombstones: Row[];
    audits: number;
}

interface Call {
    sql: string;
    args: unknown[];
}

/** 假库回给 pragma_table_info 的列集合：还原路径靠它挑列 */
const SITE_COLUMNS = RESTORE_COLUMNS;

interface FakeDb {
    db: unknown;
    store: Store;
    calls: Call[];
    /** 让 DELETE FROM sites 抛错：模拟「写完回收站之后、删真身时」崩掉 */
    failSiteDelete: boolean;
}

/**
 * 一个**有事务语义**的假 D1。
 *
 * 关键点在 batch：先把整个 store 快照下来，逐条执行，任何一条抛错就把快照装回去
 * 再往外抛 —— 这就是 D1（与自托管适配器的 BEGIN IMMEDIATE）的语义。
 * 只有这样的替身才测得出「半截状态」：逐条生效的替身里，失败前写的东西已经落地了，
 * 断言必然是绿的，等于没测。
 */
function makeFakeDb(sites: Row[]): FakeDb {
    let nextRecycleId = 1;
    const calls: Call[] = [];
    const fake: FakeDb = {
        db: null,
        store: { sites: sites.map(s => ({ ...s })), recycle: [], tombstones: [], audits: 0 },
        calls,
        failSiteDelete: false,
    };

    const clone = (store: Store): Store => JSON.parse(JSON.stringify(store)) as Store;

    // 语句真正作用的那个 store。batch 期间临时指向「工作副本」，
    // 成功才整体装回 fake.store —— 否则每条 run() 直接改 live store，
    // 快照回滚就形同虚设（这个坑我自己踩了一次：回滚把刚写的效果又盖掉了）。
    let active: Store = fake.store;

    /** 执行一条语句：直接改传入的 store（batch 里传的是快照的副本） */
    const apply = (store: Store, sql: string, args: unknown[]): { success: boolean; lastRowId?: number } => {
        if (/^\s*select|pragma_table_info/i.test(sql)) return { success: true };
        if (/insert\s+into\s+recycle_bin/i.test(sql)) {
            const id = nextRecycleId++;
            store.recycle.push({ id, kind: args[0], owner_user_id: args[1], data: args[2], deleted_at: args[3] });
            return { success: true, lastRowId: id };
        }
        if (/insert\s+into\s+site_tombstone/i.test(sql)) {
            store.tombstones.push({ user_id: args[0], site_id: args[1], deleted_at: args[2] });
            return { success: true };
        }
        if (/insert\s+into\s+audit_log/i.test(sql)) {
            store.audits += 1;
            return { success: true };
        }
        if (/delete\s+from\s+sites/i.test(sql)) {
            if (fake.failSiteDelete) throw new Error("D1 抖动：删除真身失败");
            const count = (sql.match(/\?/g) || []).length;
            const ids = args.slice(0, count);
            store.sites = store.sites.filter(s => !ids.includes(s.id));
            return { success: true };
        }
        if (/insert\s+(or\s+replace\s+)?into\s+sites/i.test(sql)) {
            const cols = sql
                .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
                .split(",")
                .map(c => c.trim());
            const row: Row = {};
            cols.forEach((col, i) => {
                row[col] = args[i];
            });
            if (row.id === undefined || row.id === null) row.id = (store.sites.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0)) + 1;
            const at = store.sites.findIndex(s => s.id === row.id);
            if (at >= 0) store.sites[at] = row;
            else store.sites.push(row);
            return { success: true, lastRowId: Number(row.id) };
        }
        return { success: true };
    };

    const read = (store: Store, sql: string, args: unknown[]): Row[] => {
        if (/pragma_table_info/i.test(sql)) return SITE_COLUMNS.map(name => ({ name }));
        if (/from\s+sites/i.test(sql)) {
            if (/id\s+in\s*\(/i.test(sql)) {
                const count = (sql.match(/\?/g) || []).length;
                const ids = args.slice(0, count);
                return store.sites.filter(s => ids.includes(s.id));
            }
            return store.sites;
        }
        if (/from\s+recycle_bin/i.test(sql)) return store.recycle;
        return [];
    };

    const prepare = (sql: string) => {
        let args: unknown[] = [];
        const statement = {
            __sql: sql,
            bind(...values: unknown[]) {
                args = values;
                calls.push({ sql, args: values });
                return statement;
            },
            async first<T = unknown>(): Promise<T | null> {
                const rows = read(active, sql, args);
                return (rows[0] as T) ?? null;
            },
            async all<T = unknown>(): Promise<{ results: T[]; success: boolean }> {
                return { results: read(active, sql, args) as T[], success: true };
            },
            async run(): Promise<{ success: boolean; meta?: { last_row_id?: number } }> {
                const r = apply(active, sql, args);
                return { success: r.success, meta: { last_row_id: r.lastRowId } };
            },
        };
        return statement;
    };

    fake.db = {
        prepare,
        async exec() {
            return { success: true, count: 0, duration: 0 };
        },
        async batch<T = unknown>(statements: Array<{ __sql?: string; run(): Promise<unknown>; all(): Promise<unknown> }>) {
            const snapshot = clone(fake.store);
            const working = clone(fake.store);
            const previous = active;
            active = working;
            const out: unknown[] = [];
            try {
                for (const statement of statements) {
                    const sql = statement.__sql || "";
                    if (/^\s*(select|with|values)/i.test(sql)) {
                        out.push(await statement.all());
                        continue;
                    }
                    out.push(await statement.run());
                }
                // 全部成功 → 把工作副本装回 store（整体提交）
                fake.store.sites = working.sites;
                fake.store.recycle = working.recycle;
                fake.store.tombstones = working.tombstones;
                fake.store.audits = working.audits;
                return out as T[];
            } catch (error) {
                // 事务语义：整批回滚，前面写的一句都不留
                fake.store.sites = snapshot.sites;
                fake.store.recycle = snapshot.recycle;
                fake.store.tombstones = snapshot.tombstones;
                fake.store.audits = snapshot.audits;
                throw error;
            } finally {
                active = previous;
            }
        },
    };
    return fake;
}

function makeApi(fake: FakeDb) {
    return new NavigationAPI({
        DB: fake.db as never,
        AUTH_ENABLED: "false",
        AUTH_USERNAME: "",
        AUTH_PASSWORD: "",
        AUTH_SECRET: "test-secret",
    });
}

const site = (id: number): Row => ({
    id,
    group_id: 1,
    name: `站点 ${id}`,
    url: `https://example.com/${id}`,
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    user_id: null,
});

test("批量删除：每一条 SQL 的绑定参数都不超过 D1 的 100 个", async () => {
    resetMigrationCacheForTests();
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const fake = makeFakeDb(ids.map(site));
    const api = makeApi(fake);

    const result = await api.deleteSites(ids);

    assert.equal(result.failed.length, 0, "250 张卡都要删掉");
    assert.equal(fake.store.sites.length, 0);
    assert.equal(fake.store.recycle.length, 250, "每张卡进一次回收站");
    assert.equal(fake.store.tombstones.length, 250, "每张卡留一条墓碑");

    // 核心断言：没有任何一条 SQL 越过上限
    const worst = fake.calls.reduce((max, c) => Math.max(max, c.args.length), 0);
    assert.ok(
        worst <= D1_MAX_BOUND_PARAMS,
        `有 SQL 绑了 ${worst} 个参数，D1 上限是 ${D1_MAX_BOUND_PARAMS} —— 本机 SQLite 上限 32766 试不出来，` +
            `这条红线只能这样钉`
    );
    // 而且真的切了批（否则一条 SELECT 就带 250 个 id）
    assert.ok(
        fake.calls.filter(c => /id\s+in\s*\(/i.test(c.sql)).length >= 4,
        "250 个 id 至少要切成 3 批 SELECT + 3 批 DELETE"
    );
});

test("批量删除：删真身失败时，回收站与墓碑一条都不留（半截状态）", async () => {
    resetMigrationCacheForTests();
    const fake = makeFakeDb([site(1), site(2), site(3)]);
    const api = makeApi(fake);
    fake.failSiteDelete = true;

    await assert.rejects(() => api.deleteSites([1, 2, 3]));

    assert.equal(fake.store.sites.length, 3, "真身没删掉");
    assert.equal(fake.store.recycle.length, 0, "回收站里不许留下没删成的条目（否则用户以为删过了）");
    assert.equal(fake.store.tombstones.length, 0, "墓碑也不许留（否则别的设备会以为这几张卡没了）");
    assert.equal(fake.store.audits, 0, "审计同样在事务里");
});

test("批量删除：500 个 id（路由上限）也能删完，且仍不越过 100 参数", async () => {
    resetMigrationCacheForTests();
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const fake = makeFakeDb(ids.map(site));
    const api = makeApi(fake);

    const result = await api.deleteSites(ids);

    assert.equal(result.items.length, 500);
    assert.equal(fake.store.sites.length, 0);
    assert.equal(fake.store.recycle.length, 500);
    const worst = fake.calls.reduce((max, c) => Math.max(max, c.args.length), 0);
    assert.ok(worst <= D1_MAX_BOUND_PARAMS, `最坏一条绑了 ${worst} 个参数`);
    assert.ok(result.items.every(i => typeof i.recycleId === "number"), "每条都要带回 recycleId");
});

test("批量删除：审计只写一条（分了几批也不重复写）", async () => {
    resetMigrationCacheForTests();
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const fake = makeFakeDb(ids.map(site));
    const api = makeApi(fake);

    await api.deleteSites(ids, { action: "site.batchDelete", actor: "", ip: "127.0.0.1", detail: "250 个" });

    assert.equal(fake.store.audits, 1, "一次调用一条审计：分了 3 批也不该变成 3 条");
});

test("还原：目标 id 已被活卡片占用时改用新 id，不再把活卡片顶掉（D-21）", async () => {
    resetMigrationCacheForTests();
    // 场景：删了两次、两个回收站条目里的 site id 恰好都是 7
    const fake = makeFakeDb([site(7)]);
    const api = makeApi(fake);

    const stmt = await api.buildReinsert("sites", site(7), RESTORE_COLUMNS, new Set([7]));
    assert.ok(stmt, "要能组装出语句");
    const withId = await api.buildReinsert("sites", site(7), RESTORE_COLUMNS, new Set());
    assert.ok(withId);

    // 占用时不指定 id → 让 SQLite 另分一个（两张卡都在）
    await api.reinsertSitesBatch([site(7), { ...site(7), name: "第二次删的那张" }]);

    assert.equal(fake.store.sites.length, 3, "原来那张活卡 + 两条回收站条目，一共三张");
    const names = fake.store.sites.map(s => String(s.name));
    assert.ok(names.includes("站点 7"), "原来活着的卡片不许被顶掉");
    assert.ok(names.includes("第二次删的那张"), "第二次删的那张也要还原出来");
});
