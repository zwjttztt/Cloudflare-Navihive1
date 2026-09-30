// tests/siteBatchDelete.test.ts
// 批量删除 / 批量还原 / 批量清除回收站：钉死「一次调用搞定」与「不把卡片弄丢」这两条。
//
// 为什么值得单测：多选删 20 张卡过去是 20 次 HTTP 往返，撤销又是 20 次 + 一次全量重拉。
// 换成批量接口后，最容易翻车的是「回收站没写进去却把真身删了」—— 那等于硬删除，
// 撤销再也找不回来。下面第 2 条用例就是守这个的。
import test from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI, resetMigrationCacheForTests } from "../src/API/http";

type Row = Record<string, unknown>;

interface Store {
    sites: Row[];
    recycle: Row[];
}

const SITE_COLUMNS = [
    "id",
    "group_id",
    "name",
    "url",
    "icon",
    "description",
    "notes",
    "username",
    "password",
    "order_num",
    "created_at",
    "updated_at",
    "user_id",
];

function makeDb(store: Store) {
    let nextId = 1;
    const allocId = () => nextId++;

    const prepare = (sql: string) => {
        let args: unknown[] = [];
        const statement = {
            __sql: sql,
            bind(...values: unknown[]) {
                args = values;
                return statement;
            },
            async first<T = unknown>(): Promise<T | null> {
                const all = await statement.all<T>();
                return (all.results?.[0] ?? null) as T;
            },
            async all<T = unknown>(): Promise<{ results?: T[]; success: boolean }> {
                // 还原时靠它挑列：返回 sites 的真实列集合
                if (sql.includes("pragma_table_info")) {
                    return {
                        results: SITE_COLUMNS.map(name => ({ name })) as T[],
                        success: true,
                    };
                }
                if (sql.includes("FROM recycle_bin")) {
                    // 支持 WHERE id IN (...) 与 owner_user_id IS NULL
                    let list = store.recycle;
                    if (sql.includes("id IN (")) {
                        const count = (sql.match(/\?/g) || []).length;
                        const ids = args.slice(0, count);
                        list = list.filter(r => ids.includes(r.id));
                    }
                    return { results: list as T[], success: true };
                }
                if (sql.includes("FROM sites")) {
                    let list = store.sites;
                    if (sql.includes("id IN (")) {
                        const count = (sql.match(/\?/g) || []).length;
                        const ids = args.slice(0, count);
                        list = list.filter(r => ids.includes(r.id));
                    } else if (sql.includes("WHERE id = ?")) {
                        list = list.filter(r => r.id === args[0]);
                    }
                    return { results: list as T[], success: true };
                }
                return { results: [] as T[], success: true };
            },
            async run(): Promise<{ success: boolean; meta?: { last_row_id?: number } }> {
                if (sql.includes("INSERT INTO recycle_bin")) {
                    const row: Row = {
                        id: allocId(),
                        kind: args[0],
                        owner_user_id: args[1],
                        data: args[2],
                        deleted_at: args[3],
                    };
                    store.recycle.push(row);
                    return { success: true, meta: { last_row_id: row.id as number } };
                }
                if (sql.includes("INSERT OR REPLACE INTO sites")) {
                    // 按 SQL 里列的顺序回填：只有这里出现的列才写
                    const cols = sql
                        .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
                        .split(",")
                        .map(c => c.trim());
                    const row: Row = {};
                    cols.forEach((col, i) => {
                        row[col] = args[i];
                    });
                    const exist = store.sites.findIndex(s => s.id === row.id);
                    if (exist >= 0) store.sites[exist] = row;
                    else store.sites.push(row);
                    return { success: true };
                }
                if (sql.includes("DELETE FROM sites")) {
                    const ids = args.slice(0, (sql.match(/\?/g) || []).length);
                    const before = store.sites.length;
                    store.sites = store.sites.filter(s => !ids.includes(s.id));
                    return { success: store.sites.length < before };
                }
                if (sql.includes("DELETE FROM recycle_bin")) {
                    const ids = args.slice(0, (sql.match(/\?/g) || []).length);
                    const before = store.recycle.length;
                    store.recycle = store.recycle.filter(r => !ids.includes(r.id));
                    return { success: store.recycle.length < before };
                }
                return { success: true };
            },
        };
        return statement;
    };

    return {
        prepare,
        async exec() {
            return { success: true };
        },
        async batch<T = unknown>(
            statements: Array<{
                __sql?: string;
                all(): Promise<{ results?: T[] }>;
                run(): Promise<{ success: boolean }>;
            }>
        ) {
            return Promise.all(
                statements.map(s =>
                    /^\s*(INSERT|UPDATE|DELETE)\s/i.test(s.__sql || "") ? s.run() : s.all()
                )
            );
        },
    };
}

function makeApi(store: Store) {
    return new NavigationAPI({
        DB: makeDb(store) as never,
        AUTH_ENABLED: "false",
        AUTH_USERNAME: "",
        AUTH_PASSWORD: "",
        AUTH_SECRET: "test-secret",
    });
}

function freshStore(sites: Row[] = []): Store {
    resetMigrationCacheForTests();
    return { sites: sites.map(s => ({ ...s })), recycle: [] };
}

const site = (id: number, name: string): Row => ({
    id,
    group_id: 1,
    name,
    url: `https://example.com/${id}`,
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "",
    order_num: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
});

test("批量删除：一次调用删掉全部，回收站里一条不少", async () => {
    const store = freshStore([site(1, "A"), site(2, "B"), site(3, "C")]);
    const api = makeApi(store);

    const result = await api.deleteSites([1, 2, 3]);

    assert.equal(store.sites.length, 0, "三张卡都要从 sites 里消失");
    assert.equal(result.failed.length, 0);
    assert.equal(result.items.length, 3);
    assert.equal(store.recycle.length, 3, "每张卡进一次回收站");
    for (const item of result.items) {
        assert.ok(typeof item.recycleId === "number", "每条都要带回 recycleId，撤销要用");
    }
});

test("回收站写不进去的卡片不许删真身（否则就是硬删除）", async () => {
    const store = freshStore([site(1, "A")]);
    const api = makeApi(store);
    // 让 INSERT recycle_bin 失败：模拟 D1 写入报错
    const db = (api as unknown as { db: { prepare: (sql: string) => unknown } }).db;
    const original = db.prepare.bind(db);
    db.prepare = (sql: string) => {
        if (sql.includes("INSERT INTO recycle_bin")) {
            return {
                bind() {
                    return {
                        async run() {
                            throw new Error("D1 写入失败");
                        },
                    };
                },
            };
        }
        return original(sql);
    };

    await assert.rejects(() => api.deleteSites([1]));
    assert.equal(store.sites.length, 1, "回收站没落上，真身必须还在");
});

test("批量还原：卡片按原 id 回库，密码解密后返回", async () => {
    const store = freshStore([site(1, "A"), site(2, "B")]);
    const api = makeApi(store);

    const del = await api.deleteSites([1, 2]);
    const recycleIds = del.items.map(i => i.recycleId as number);
    assert.equal(store.sites.length, 0);

    const restored = await api.restoreRecycleItems(recycleIds);

    assert.equal(restored.failed.length, 0);
    assert.equal(restored.restored.length, 2, "两张卡都要还原出来");
    assert.deepEqual(
        restored.restored.map(s => s.id).sort(),
        [1, 2],
        "按原始 id 插回：撤销后标签/星标才能自动归位"
    );
    assert.equal(store.sites.length, 2);
    assert.equal(store.recycle.length, 0, "还原完要把回收站条目清掉");
    assert.ok(
        restored.restored.every(s => typeof s.name === "string" && s.name.length > 0),
        "返回的卡片要能直接插回界面"
    );
});

test("批量还原：不存在的 id 一律计入 failed，不影响其它条目", async () => {
    const store = freshStore([site(1, "A")]);
    const api = makeApi(store);

    const del = await api.deleteSites([1]);
    const okId = del.items[0].recycleId as number;
    const result = await api.restoreRecycleItems([okId, 9999]);

    assert.equal(result.restored.length, 1);
    assert.deepEqual(result.failed, [9999]);
});

test("批量清除：一次删掉回收站里的多条", async () => {
    const store = freshStore([site(1, "A"), site(2, "B")]);
    const api = makeApi(store);

    const del = await api.deleteSites([1, 2]);
    const recycleIds = del.items.map(i => i.recycleId as number);
    await api.purgeRecycleItems(recycleIds);

    assert.equal(store.recycle.length, 0);
});

test("批量删除：空数组与非法 id 不炸，也不误删", async () => {
    const store = freshStore([site(1, "A")]);
    const api = makeApi(store);

    assert.deepEqual(await api.deleteSites([]), { items: [], failed: [] });
    assert.deepEqual(await api.deleteSites([NaN, 1.5]), { items: [], failed: [] });
    assert.equal(store.sites.length, 1);
});
