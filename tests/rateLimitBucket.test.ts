// tests/rateLimitBucket.test.ts
// C1：限速计数从「configs 里一整块 JSON」改成「rate_limit_bucket 一桶一行」。
//
// 这次改动的卖点只有一句：**记一次失败 = 一条语句**。所以这里的用例不测「锁多久」
// （那由 loginGuard.test.ts / endpointGuards.test.ts 钉着），只测换存储之后最容易坏的四件事：
//   1. 计数一次都不能丢（并发/连续 bump 之后 count 必须精确）；
//   2. 越过阈值时 `until` 只写一次，值对得上，锁不会越滚越长；
//   3. 桶数超上限时裁掉最久不活跃的，但**锁定中的桶必须幸存**；
//   4. 表不存在 / prepare 直接抛错时**全部 fail-open**（放行、不抛异常）——
//      这是既有的故障策略，换成表存储之后一条都不能变。

import { test } from "node:test";
import assert from "node:assert/strict";

import type { NavigationAPI } from "../src/API/navigationApi";
import {
    DAV_BASE_LOCK_MS,
    DAV_FREE_ATTEMPTS,
    DAV_GUARD_KEY,
    LOGIN_GUARD_KEY,
    bumpGuard,
    enforceDavGuard,
    pruneAllRateLimitBuckets,
    readLoginGuard,
    resetRateLimitPruneThrottleForTests,
} from "../worker/loginGuard";
import { FakeBucketTable } from "./helpers/fakeBucketTable";

/**
 * 只带 `db` + 三个 configs 方法的假 api。
 *
 * `db` 上识别不了的 SQL 会直接抛错 —— 这是刻意的：如果 loginGuard 里还残留
 * 「读整块 JSON」那条老路，它就会在这里现形，而不是安静地变成一次全表读。
 */
function makeApi(table = new FakeBucketTable()) {
    const db = {
        prepare(sql: string) {
            const norm = sql.replace(/\s+/g, " ").trim();
            let args: unknown[] = [];
            const run = (mode: "first" | "all" | "run"): unknown => {
                const hit = table.exec(norm, args);
                if (!hit) throw new Error(`假存储不认识这条 SQL: ${norm}`);
                if (mode === "first") return hit.rows[0] ?? null;
                if (mode === "all") return { results: hit.rows, success: true };
                return { success: true, results: hit.rows, meta: { changes: hit.rows.length } };
            };
            const stmt = {
                bind(...a: unknown[]) {
                    args = a;
                    return stmt;
                },
                first: async () => run("first"),
                all: async () => run("all"),
                run: async () => run("run"),
            };
            return stmt;
        },
        async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
            return Promise.all(stmts.map(s => s.run()));
        },
        async exec() {
            return { success: true };
        },
    };
    const api = {
        db,
        getConfig: async () => null,
        setConfig: async () => true,
        compareAndSetConfig: async () => true,
    };
    return { api: api as unknown as NavigationAPI, table };
}

test("同桶连续 bump 20 次：count 恰好 20，一次不丢", async () => {
    resetRateLimitPruneThrottleForTests();
    const { api, table } = makeApi();

    for (let i = 1; i <= 20; i++) {
        const bumped = await bumpGuard(api, LOGIN_GUARD_KEY, "1.2.3.4", prev => ({
            count: prev.count + 1,
            until: 0,
        }));
        assert.equal(bumped?.count, i, `第 ${i} 次必须拿到 ${i}（丢一次就等于给爆破续一次杯）`);
    }

    assert.equal((await readLoginGuard(api, "1.2.3.4")).count, 20);
    assert.equal(table.row(LOGIN_GUARD_KEY, "1.2.3.4")?.count, 20);

    // 热路径只该发「原子 +1」那一条语句：不读整块、不 serialize、不 CAS 重试
    assert.equal(table.ops.filter(op => op === "bump").length, 20, "20 次递增就该是 20 条 upsert");
    assert.equal(table.ops.filter(op => op === "lock").length, 0, "没超额就不该写 until");
});

test("跨过失败阈值后 until 只写一次，值正确；锁定期内不会越滚越长", async () => {
    resetRateLimitPruneThrottleForTests();
    const { api, table } = makeApi();

    // 免罚额度内：全部放行，且一条 until 都不该写
    for (let i = 0; i < DAV_FREE_ATTEMPTS; i++) {
        assert.equal(await enforceDavGuard(api, "1.2.3.4"), null, `第 ${i + 1} 次不该被拦`);
    }
    assert.equal(table.ops.filter(op => op === "lock").length, 0, "额度内不该出现锁");

    // 第 DAV_FREE_ATTEMPTS + 1 次：越线 → 锁
    const startedAt = Date.now();
    const limited = await enforceDavGuard(api, "1.2.3.4");
    assert.equal(limited?.status, 429, "越过阈值当次就该拦，不能多放行一次");
    assert.ok(Number(limited?.headers.get("Retry-After")) >= 1);

    const locked = table.row(DAV_GUARD_KEY, "1.2.3.4");
    assert.ok(locked, "桶必须真的落库");
    assert.equal(locked!.count, DAV_FREE_ATTEMPTS + 1);
    // until = 越线那一刻 + 基础锁定时长（给 200ms 的宽限，避免机器慢的偶发失败）
    assert.ok(
        locked!.until >= startedAt + DAV_BASE_LOCK_MS - 200 &&
            locked!.until <= Date.now() + DAV_BASE_LOCK_MS + 200,
        `until 必须等于「越线时刻 + ${DAV_BASE_LOCK_MS}ms」，实际 ${locked!.until - startedAt}ms`
    );
    assert.equal(table.ops.filter(op => op === "lock").length, 1, "锁只写一次");

    // 锁定期内继续尝试：仍然 429，但**不再**写 until（否则锁会越滚越长）
    const again = await enforceDavGuard(api, "1.2.3.4");
    assert.equal(again?.status, 429);
    assert.equal(table.row(DAV_GUARD_KEY, "1.2.3.4")!.until, locked!.until, "锁定期内不该延长 until");
    assert.equal(table.row(DAV_GUARD_KEY, "1.2.3.4")!.count, locked!.count, "锁定期内不该继续加计数");
    assert.equal(table.ops.filter(op => op === "lock").length, 1, "until 全程只写了一次");
});

test("桶数超上限时裁掉最久不活跃的，锁定中的桶必须幸存", async () => {
    resetRateLimitPruneThrottleForTests();
    const { api, table } = makeApi();
    const now = Date.now();

    // 2000 个「最近都动过」的桶（seen 落在 24 小时内 → 空闲那条裁不到它们）
    for (let i = 0; i < 2000; i++) {
        table.seed(LOGIN_GUARD_KEY, `b${i}`, { count: 1, seen: now - 1_000 * (2000 - i) });
    }
    // 最久没动静的那个正被锁着 —— 它绝不能被裁（裁掉等于把正在等解锁的人提前放出来）
    table.seed(LOGIN_GUARD_KEY, "locked-oldest", { count: 9, until: now + 60_000, seen: now - 5_000_000 });
    // 新来的来源
    table.seed(LOGIN_GUARD_KEY, "newcomer", { count: 1, seen: now });
    assert.equal(table.countOf(LOGIN_GUARD_KEY), 2002);

    await pruneAllRateLimitBuckets(api);

    assert.ok(table.row(LOGIN_GUARD_KEY, "newcomer"), "新来的桶必须留着，否则新 IP 永远攒不起计数");
    assert.ok(table.row(LOGIN_GUARD_KEY, "locked-oldest"), "锁定中的桶永远不许被裁");
    assert.equal(table.row(LOGIN_GUARD_KEY, "b0"), null, "最久不活跃的那个该被裁掉");
    assert.ok(table.row(LOGIN_GUARD_KEY, "b1999"), "最近动过的桶要留着");
    assert.ok(
        table.countOf(LOGIN_GUARD_KEY) <= 2001,
        `裁完最多 2000 个活跃桶 + 1 个锁定桶，实际 ${table.countOf(LOGIN_GUARD_KEY)}`
    );
    assert.equal(
        table.row(LOGIN_GUARD_KEY, "locked-oldest")!.until,
        now + 60_000,
        "裁桶不该动锁定行的 until"
    );
});

test("空闲超过 24 小时的桶会被裁掉（锁定中的除外）", async () => {
    resetRateLimitPruneThrottleForTests();
    const { api, table } = makeApi();
    const now = Date.now();

    table.seed(LOGIN_GUARD_KEY, "stale", { count: 3, seen: now - 25 * 60 * 60 * 1000 });
    table.seed(LOGIN_GUARD_KEY, "fresh", { count: 1, seen: now - 60_000 });
    table.seed(LOGIN_GUARD_KEY, "stale-but-locked", {
        count: 7,
        until: now + 60_000,
        seen: now - 25 * 60 * 60 * 1000,
    });

    await pruneAllRateLimitBuckets(api);

    assert.equal(table.row(LOGIN_GUARD_KEY, "stale"), null, "25 小时没动静的桶该裁掉");
    assert.ok(table.row(LOGIN_GUARD_KEY, "fresh"), "刚动过的不能被裁");
    assert.ok(table.row(LOGIN_GUARD_KEY, "stale-but-locked"), "再老也不能裁正在锁定的桶");
});

test("表不存在 / prepare 抛错时全部 fail-open（放行，不抛异常）", async () => {
    // 这条是 C1 的不变量之一：读不到限速状态 = 无限制放行，不许改成 fail-closed
    const brokenDb = {
        prepare() {
            throw new Error("no such table: rate_limit_bucket");
        },
    };
    const api = {
        db: brokenDb,
        getConfig: async () => null,
        setConfig: async () => true,
        compareAndSetConfig: async () => true,
    } as unknown as NavigationAPI;

    for (let i = 0; i < DAV_FREE_ATTEMPTS + 3; i++) {
        assert.equal(await enforceDavGuard(api, "1.2.3.4"), null, "记不上数就放行，不许 503");
    }
    assert.deepEqual(await readLoginGuard(api, "1.2.3.4"), { count: 0, until: 0 });
    assert.equal(
        await bumpGuard(api, LOGIN_GUARD_KEY, "1.2.3.4", prev => ({ count: prev.count + 1, until: 0 })),
        null,
        "写不进去返回 null（调用方按「没记上」继续处理），不能抛"
    );
    // 裁剪同样不许抛
    await pruneAllRateLimitBuckets(api);
});
