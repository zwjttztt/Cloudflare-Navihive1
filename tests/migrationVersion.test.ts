// tests/migrationVersion.test.ts
// 「迁移移到部署流程、保留版本检测」：每个 isolate 冷启动不该把二十多条建表/补列/建索引
// 语句再跑一遍。版本对得上时，迁移应当只花**一条查询**。
//
// 这个文件的重点不是「迁移跑得对不对」（那由其它测试覆盖），而是
// 「跑过一次之后，下一次到底还发不发那些语句」——只断言查询条数。
import { test } from "node:test";
import assert from "node:assert/strict";

import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "../src/API/methods/migration";

/** 什么都放行、只数语句条数的替身：迁移里大量语句靠 try/catch 兜，不需要真的建出表 */
class CountingD1 {
    /** 执行过的语句（归一化后），用来数「这次冷启动发了多少条」 */
    statements: string[] = [];
    configs = new Map<string, string>();

    prepare(sql: string) {
        const self = this;
        let args: unknown[] = [];
        const norm = sql.replace(/\s+/g, " ").trim();
        const stmt = {
            bind(...a: unknown[]) {
                args = a;
                return stmt;
            },
            async first() {
                self.statements.push(norm);
                if (/^SELECT value FROM configs WHERE key = \?/.test(norm)) {
                    const v = self.configs.get(String(args[0]));
                    return v === undefined ? null : { value: v };
                }
                return null;
            },
            async all() {
                self.statements.push(norm);
                return { results: [], success: true };
            },
            async run() {
                self.statements.push(norm);
                if (/^INSERT INTO configs/.test(norm)) {
                    self.configs.set(String(args[0]), String(args[1]));
                }
                return { success: true, results: [], meta: { rows_written: 1 } };
            },
        };
        return stmt;
    }

    async batch<T>(stmts: { _sql?: string }[]): Promise<{ results: T[]; success: boolean }[]> {
        return Promise.all(
            stmts.map(s => {
                if (s._sql) this.statements.push(s._sql.replace(/\s+/g, " ").trim());
                return { results: [] as T[], success: true };
            })
        );
    }

    async exec(): Promise<{ count: number }> {
        return { count: 0 };
    }
}

function apiWith(db: CountingD1): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
}

test("首次冷启动：版本读不到 → 跑完整迁移，并把版本号写进去", async () => {
    resetMigrationCacheForTests();
    const db = new CountingD1();
    const api = apiWith(db);

    await api.migrate();

    assert.ok(db.statements.length > 1, "空库必须真的建一遍表");
    assert.equal(
        db.configs.get(SCHEMA_VERSION_KEY),
        SCHEMA_VERSION,
        "跑完要把版本号记下来，否则下次还要重跑"
    );
    assert.equal(api.dbReady, true);
});

test("第二次冷启动（版本号对得上）：迁移只花一条查询", async () => {
    // 上一个用例跑完的那份库，直接当成「已经迁移好的线上库」
    resetMigrationCacheForTests();
    const db = new CountingD1();
    db.configs.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
    const api = apiWith(db);

    await api.migrate();

    assert.equal(
        db.statements.length,
        1,
        `版本对得上时不该再发建表/补列语句，实际发了 ${db.statements.length} 条：\n  ${db.statements.join("\n  ")}`
    );
    assert.match(db.statements[0], /SELECT value FROM configs/);
    assert.equal(api.dbReady, true, "跳过迁移也要把 dbReady 置上（否则鉴权会一直 fail-open）");
});

test("版本号对不上（加了新迁移步骤）→ 重新跑一遍全量迁移", async () => {
    resetMigrationCacheForTests();
    const db = new CountingD1();
    db.configs.set(SCHEMA_VERSION_KEY, "0"); // 旧版本
    const api = apiWith(db);

    await api.migrate();

    assert.ok(db.statements.length > 1, "版本落后必须重跑");
    assert.equal(db.configs.get(SCHEMA_VERSION_KEY), SCHEMA_VERSION);
});

test("同一个 isolate 内多次调用只跑一次（并发请求共享同一份迁移 Promise）", async () => {
    resetMigrationCacheForTests();
    const db = new CountingD1();
    const api = apiWith(db);

    await Promise.all([api.migrate(), api.migrate(), api.migrate()]);
    const afterFirst = db.statements.length;

    await api.migrate();
    assert.equal(db.statements.length, afterFirst, "第二次起不该再多发语句");
});
