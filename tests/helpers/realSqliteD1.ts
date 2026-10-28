// tests/helpers/realSqliteD1.ts
//
// 把 node:sqlite（Node 22 自带）包成「D1 形状」的替身，让**真实的** NavigationAPI
// 方法能在真 SQLite 上跑一遍。
//
// 为什么需要它：FakeD1 / MockD1 根本不执行 SQL，只按前缀/结构匹配 ——
// 「列不存在」「SQL 语法错」「建表被跳过」这类线上 500 在它们身上永远红不了。
// 多次事故（note_folder.parent_id、note_share.views）都是单测全绿、线上照 500，
// 所以涉及表结构的功能必须真连一个会执行 SQL 的引擎。
//
// ⚠️ 这个文件**不是**用例（名字不带 .test.ts），不会被运行器当测试收集。
//
// ⚠️ 替身与自托管真适配器（server/sqlite-d1.ts）必须保持同一套形状，
// 差一处就等于「线上跑一套、测试验另一套」——已经踩过两回：
//   1) run() 漏了 meta.rows_written → claimIdempotency 永远抢不到锁，
//      导入/恢复在替身上被误判成「上一次恢复还没结束」（真库上是好的）；
//   2) batch() 只是 Promise.all → 没有事务，所以「失败整批回滚」在替身上
//      根本验不出来（真 D1 与自托管适配器都是整批一个事务）。
//   3) run() 只调 stmt.run() → 把 SELECT / 带 RETURNING 的行的查询结果丢了，
//      而 D1 的 batch 会把每条语句的行回在对应 D1Result.results 里。于是
//      「batch 里塞 SELECT 取计数」的写法（notesChanges 的 notesChanged）在替身上
//      永远拿到 0，测试假绿到另一头。已对齐：会返回行的语句走 all() 取行 + 连
//      接级 changes() 补 meta，与 server/sqlite-d1.ts 的 runSync 逐字一致。
// 这三条已补上，改动替身时先想清楚它替的是哪一边的真实行为。

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../../src/API/navigationApi";

export type RealD1 = ReturnType<typeof makeRealD1>;

/** 把 node:sqlite 包成 D1 形状的替身：prepare/bind/all/first/run/batch/exec 都对得上 */
export function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    // 与自托管适配器对齐：批内外键检查推迟到提交那一刻（见 server/sqlite-d1.ts）
    const deferral = db.prepare("PRAGMA defer_foreign_keys = ON");
    // 连接级 changes() / last_insert_rowid()，给 run() 在「会返回行」的语句后补 meta 用
    // （与 server/sqlite-d1.ts 的 readMeta 同一套；node:sqlite 的 stmt.run() 只回
    // changes/lastInsertRowid，不会把 SELECT/RETURNING 的行带出来，所以行得另走 all()）。
    const changesStmt = db.prepare("SELECT changes() AS c, last_insert_rowid() AS r");
    // 会返回行的语句：SELECT / WITH（CTE）/ VALUES，外加上带 RETURNING 的写语句。
    // 与 server/sqlite-d1.ts 的 RETURNS_ROWS_RE / RETURNING_RE 同口径 —— D1 的 batch
    // 会把每条语句的行回在对应 D1Result.results 里，只调 run() 不取行的话，
    // 「首页 bootstrap 拿到 0 分组」「notesChanges 的计数永远 0」这类无声错就会在替身上发生。
    const RETURNS_ROWS_RE = /^\s*(select|with|values)\b/i;
    const RETURNING_RE = /\breturning\b/i;
    const wrap = (sql: string, stmt: StatementSync) => {
        let bound: SQLInputValue[] = [];
        const prepared = {
            bind(...args: unknown[]) {
                bound = args as SQLInputValue[];
                return prepared;
            },
            // ⚠️ 真 D1 的 all()/first()/run() 都返回 Promise（哪怕立即 resolve），
            // 业务代码里有 `.all().then(...)` 这样的链式用法 —— 替身必须包成 Promise，
            // 否则「分享列表」这类方法在替身上跑不通（真库上反而没问题）。
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
                // 与 server/sqlite-d1.ts 的 runSync 对齐：会返回行的语句必须走 all() 取行，
                // 再读连接级 changes()/last_insert_rowid() 补 meta；否则 batch 里塞 SELECT
                // 取计数的写法在替身上拿不到行（notesChanges 的 notesChanged 永远 0）。
                if (RETURNS_ROWS_RE.test(sql) || RETURNING_RE.test(sql)) {
                    const rows = stmt.all(...bound) as Record<string, unknown>[];
                    const m = changesStmt.get() as { c: number; r: number };
                    return Promise.resolve({
                        results: rows,
                        success: true as const,
                        meta: { changes: m.c, rows_written: m.c, last_row_id: Number(m.r) },
                    });
                }
                const r = stmt.run(...bound);
                return Promise.resolve({
                    success: true as const,
                    // ⚠️ rows_written 必须给：抢占幂等锁（claimIdempotency）靠它
                    // 判断「这次 INSERT 到底落没落」。缺了这个字段，所有依赖互斥锁的
                    // 路径（恢复锁、离线重放）在替身上都走「抢不到」的分支。
                    meta: {
                        changes: r.changes,
                        rows_written: r.changes,
                        last_row_id: Number(r.lastInsertRowid),
                    },
                });
            },
        };
        return prepared;
    };
    return {
        prepare: (sql: string) => wrap(sql, db.prepare(sql)),
        /**
         * ⚠️ 真 D1 的 batch 是一个事务：要么整批生效、要么一个字节都不变。
         * 替身必须照做 —— 「导入失败后旧数据一条不少」这类断言靠的就是这个语义，
         * 用 Promise.all 的话前几条已经写进去了，测试反而会假绿到另一头（以为是回滚了）。
         */
        batch: async (stmts: Array<{ run: () => Promise<{ success: boolean }> }>) => {
            db.exec("BEGIN");
            try {
                // 与自托管适配器一致：批内开启外键延迟，外键冲突在 COMMIT 时才报
                deferral.run();
                const results = [];
                for (const stmt of stmts) results.push(await stmt.run());
                db.exec("COMMIT");
                return results;
            } catch (error) {
                // ⚠️ 事务里失败之后 COMMIT 仍会把前面的语句提交掉 —— 必须显式 ROLLBACK
                db.exec("ROLLBACK");
                throw error;
            }
        },
        async exec(sql: string) {
            db.exec(sql);
        },
    };
}

/** 套在真 SQLite 上的 NavigationAPI（单账号部署：setCurrentUser(null) 之前的默认态） */
export function makeRealApi(db: RealD1): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}
