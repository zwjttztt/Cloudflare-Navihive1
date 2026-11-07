// tests/revisionThrottle.test.ts
// P2-8（2026-11 审计整改）：版本快照节流闸门 `shouldSkipRevision` 的判据。
//
// 这条纯函数只做「查最新一次快照时间，再比较距今是否 < REVISION_MIN_INTERVAL_MS」，
// 本身不写库、不碰正文，所以单测可以只喂一个可控的假 db 来验证三种分支：
//   ① 距上次快照 < 5min            → 返回 true（跳过写新快照）
//   ② 无快照记录 / 距上次快照超时  → 返回 false（照常写）
//   ③ 查询异常                     → 返回 false（优雅降级，宁可多写也不丢历史）
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetMigrationCacheForTests } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { REVISION_MIN_INTERVAL_MS } from "../src/utils/noteLimits";
import { shouldSkipRevision } from "../src/API/methods/notes/revisionThrottle";

/** SQLite datetime 字符串（`YYYY-MM-DD HH:MM:SS`，与时区无关，按 UTC 解读） */
function sqlTimeString(date: Date): string {
    return date.toISOString().slice(0, 19).replace("T", " ");
}

interface FakeRevDbOptions {
    /** 预先放进 note_revision 的快照（created_at 已是字符串） */
    rows?: Array<{ id: number; note_id: number; created_at: string }>;
    /** 让 `first()` 直接抛错，模拟查询异常 */
    failFirst?: boolean;
}

/**
 * 一个只认识「SELECT created_at FROM note_revision」的假 D1。
 * `shouldSkipRevision` 只用这一条查询，所以足够覆盖全部分支。
 */
function makeApi(opts: FakeRevDbOptions = {}): NavigationAPI {
    const rows = opts.rows ?? [];
    const db = {
        prepare(sql: string) {
            let args: unknown[] = [];
            const stmt = {
                __sql: sql,
                bind(...values: unknown[]) {
                    args = values;
                    return stmt;
                },
                async first<T = unknown>(): Promise<T | null> {
                    if (opts.failFirst) throw new Error("D1 抖动：查询 note_revision 失败");
                    if (/SELECT created_at FROM note_revision/i.test(sql)) {
                        const noteId = Number(args[0]);
                        const mine = rows.filter(r => r.note_id === noteId);
                        if (mine.length === 0) return null;
                        const latest = mine.reduce((a, b) => (b.id > a.id ? b : a));
                        return { created_at: latest.created_at } as unknown as T;
                    }
                    return null;
                },
                async all<T = unknown>(): Promise<{ results: T[]; success: boolean }> {
                    return { results: [], success: true };
                },
                async run() {
                    return { success: true };
                },
            };
            return stmt;
        },
        async batch() {
            return [] as unknown[];
        },
        async exec() {
            return { success: true };
        },
    };
    // 单账号部署：currentUserId 为 null，scopeSql 走 `IS NULL`，scopeParams 不追加 uid
    return new NavigationAPI({
        DB: db as never,
        AUTH_ENABLED: "false",
        AUTH_USERNAME: "",
        AUTH_PASSWORD: "",
        AUTH_SECRET: "test-secret",
    } as never);
}

test("节流：距上次快照 < 5 分钟 → 返回 true（跳过写新快照）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi({
        rows: [
            { id: 1, note_id: 7, created_at: sqlTimeString(new Date(Date.now() - 60_000)) },
        ],
    });
    assert.equal(await shouldSkipRevision(api, 7), true, "1 分钟前刚存过版本，不该再写一份");
});

test("无快照记录 → 返回 false（该写第一份）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi({ rows: [] });
    assert.equal(await shouldSkipRevision(api, 7), false, "从没存过版本，必须落第一份");
});

test("距上次快照已超过 5 分钟 → 返回 false（照常写）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi({
        rows: [
            {
                id: 1,
                note_id: 7,
                created_at: sqlTimeString(new Date(Date.now() - REVISION_MIN_INTERVAL_MS - 60_000)),
            },
        ],
    });
    assert.equal(await shouldSkipRevision(api, 7), false, "6 分钟前那次早已过期，照常写新版本");
});

test("查询异常 → 优雅降级为 false（宁可多写也不丢历史）", async () => {
    resetMigrationCacheForTests();
    const api = makeApi({ failFirst: true });
    assert.equal(
        await shouldSkipRevision(api, 7),
        false,
        "读不到上次快照时间时不能把正常路径变成「不写」"
    );
});

test("边界：恰好等于最小间隔不算「不足」，应照常写", async () => {
    resetMigrationCacheForTests();
    const api = makeApi({
        rows: [
            { id: 1, note_id: 7, created_at: sqlTimeString(new Date(Date.now() - REVISION_MIN_INTERVAL_MS)) },
        ],
    });
    // `Date.now() - last === REVISION_MIN_INTERVAL_MS`，`<` 不成立 → 不跳过
    assert.equal(await shouldSkipRevision(api, 7), false);
});
