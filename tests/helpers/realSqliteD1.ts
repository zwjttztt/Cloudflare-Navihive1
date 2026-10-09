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

import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NavigationAPI } from "../../src/API/navigationApi";

export type RealD1 = ReturnType<typeof makeRealD1>;

/** 把 node:sqlite 包成 D1 形状的替身：prepare/bind/all/first/run/batch/exec 都对得上 */
export function makeRealD1() {
    const db = new DatabaseSync(":memory:");
    const wrap = (stmt: StatementSync) => {
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
        batch: async (stmts: Array<{ run: () => Promise<{ success: boolean }> }>) =>
            Promise.all(stmts.map(s => s.run())),
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
