// tests/siteOrder.test.ts
// 批量改排序 / 跨组移动的「部分失败」要如实回传。
//
// D1 没有跨语句事务：一批 UPDATE 里第 N 条没命中（卡片不存在、不是自己的），
// 前面的照样写进去了。以前只回一个 boolean，前端拿到 false 就整体不更新 ——
// 库里搬走一半、界面还停在原样，用户刷新才发现少了一半。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";

interface DbOptions {
    /** 这些 id 的 UPDATE 会命中一行（其余返回 rows_written: 0，即「没写进去」） */
    writableIds: number[];
    /** 这些分组属于当前账号（不在里面的话移动会被降级成只改排序） */
    ownedGroups?: number[];
    /** 让整个 batch 抛错，模拟 D1 抽风 */
    failBatch?: boolean;
}

function makeDb(opts: DbOptions) {
    const writable = new Set(opts.writableIds);
    const owned = new Set(opts.ownedGroups ?? []);
    const executed: string[] = [];

    const selectResults = (sql: string, args: unknown[]): unknown[] => {
        // filterOwnedGroupIds：SELECT id FROM groups WHERE id IN (...)[ AND user_id = ?]
        if (/SELECT id FROM groups WHERE id IN/.test(sql)) {
            // 最后一个参数是 scopeParams 补的 user_id（无账号时可能没有）
            const ids = args.filter(id => typeof id === "number" && owned.has(id as number));
            return ids.map(id => ({ id }));
        }
        return [];
    };

    const bound = (sql: string, args: unknown[]) => ({
        sql,
        args,
        async run() {
            executed.push(sql);
            return { success: true, meta: { rows_written: 1 } };
        },
        async all() {
            return { success: true, results: selectResults(sql, args) };
        },
        async first() {
            return selectResults(sql, args)[0] ?? null;
        },
        async raw() {
            return [];
        },
    });

    return {
        executed,
        prepare(sql: string) {
            return {
                bind: (...args: unknown[]) => bound(sql, args),
                ...bound(sql, []),
            };
        },
        async batch(stmts: unknown[]) {
            if (opts.failBatch) throw new Error("D1 batch 失败");
            return (stmts as { sql: string; args: unknown[] }[]).map(stmt => {
                executed.push(stmt.sql);
                const id = stmt.args?.[stmt.args.length - 1];
                return {
                    success: true,
                    meta: { rows_written: typeof id === "number" && writable.has(id) ? 1 : 0 },
                };
            });
        },
        async exec(sql: string) {
            executed.push(sql);
            return { count: 0, duration: 0 };
        },
    };
}

function makeApi(opts: DbOptions) {
    resetMigrationCacheForTests();
    const db = makeDb(opts);
    const api = new NavigationAPI({
        DB: db as never,
        AUTH_ENABLED: "false",
        AUTH_SECRET: "test-secret",
    });
    return { api, db };
}

test("全部命中：success=true，没有 failed", async () => {
    const { api } = makeApi({ writableIds: [1, 2, 3] });
    const result = await api.updateSiteOrder([
        { id: 1, order_num: 0 },
        { id: 2, order_num: 1 },
        { id: 3, order_num: 2 },
    ]);

    assert.equal(result.success, true);
    assert.deepEqual(result.updated, [1, 2, 3]);
    assert.deepEqual(result.failed, []);
});

test("部分没命中：success=false，成功的和失败的分别列出来", async () => {
    // 2 号卡片不存在（或不是自己的）：UPDATE 一行都没匹配上，D1 仍算 batch 成功
    const { api } = makeApi({ writableIds: [1, 3] });
    const result = await api.updateSiteOrder([
        { id: 1, order_num: 0 },
        { id: 2, order_num: 1 },
        { id: 3, order_num: 2 },
    ]);

    assert.equal(result.success, false);
    assert.deepEqual(result.updated, [1, 3]);
    assert.deepEqual(result.failed, [2]);
});

test("整批失败：已提交的算已生效，剩下的全部算失败", async () => {
    const { api } = makeApi({ writableIds: [1, 2, 3], failBatch: true });
    const result = await api.updateSiteOrder([
        { id: 1, order_num: 0 },
        { id: 2, order_num: 1 },
    ]);

    assert.equal(result.success, false);
    assert.deepEqual(result.updated, [], "整批都没提交成功");
    assert.deepEqual(result.failed, [1, 2], "一条都不能算成功，否则界面会以为搬过去了");
});

test("空请求：直接算成功，不发 SQL", async () => {
    const { api, db } = makeApi({ writableIds: [] });
    const result = await api.updateSiteOrder([]);
    assert.equal(result.success, true);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.failed, []);
    const before = db.executed.length;
    await api.updateSiteOrder([]);
    assert.equal(db.executed.length, before);
});

test("目标分组不是自己的：只改排序，不把卡片搬过去", async () => {
    const { api, db } = makeApi({ writableIds: [7], ownedGroups: [99] });
    await api.updateSiteOrder([{ id: 7, order_num: 0, group_id: 42 }]);

    const updates = db.executed.filter(sql => /^UPDATE sites/.test(sql));
    assert.equal(updates.length, 1);
    assert.ok(!updates[0].includes("group_id"), "分组不属于自己时不能写 group_id");
});

test("目标分组是自己的：排序和分组一起写", async () => {
    const { api, db } = makeApi({ writableIds: [7], ownedGroups: [42] });
    const result = await api.updateSiteOrder([{ id: 7, order_num: 0, group_id: 42 }]);

    assert.equal(result.success, true);
    const updates = db.executed.filter(sql => /^UPDATE sites/.test(sql));
    assert.ok(updates[0].includes("group_id"));
});
