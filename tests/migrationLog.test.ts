// tests/migrationLog.test.ts
// D3：迁移的「失败与耗时记账」。
//
// 事实先摆清（审计原文不准）：迁移**本来就有** `schema.version` + `schema.steps` 记账，
// 失败的步骤不进集合、末尾抛错、下次冷启动只重跑那几步。缺的是另外三件事：
//   1. 事后没法回答「哪一步、花了多久、为什么没过」—— 现场只有一行 logger.error；
//   2. `dbReady` 原来无条件置 true，等于「迁移挂了也当成结构已就绪」；
//   3. 失败之后 `getAccountSessionState` 走的是 fail-closed —— 迁移没跑完就把整站
//      锁在门外，方向正好反了（结构不完整时该更宽松，不是更严）。
//
// 所以这里钉四件事：日志有失败记录、下次只重跑那一步、dbReady 跟着失败变成 false、
// 以及「dbReady=false 时账号状态查询是 fail-open」这条方向的对照。

import { test } from "node:test";
import assert from "node:assert/strict";

import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";
import {
    MIGRATION_LOG_ERROR_MAX,
    MIGRATION_LOG_KEY,
    MIGRATION_LOG_KEEP,
    MIGRATION_STEPS_KEY,
    SCHEMA_VERSION,
    SCHEMA_VERSION_KEY,
    type MigrationLogEntry,
} from "../src/API/methods/migration";

/**
 * 会「按正则挑一条语句炸」的假 D1。
 *
 * 为什么不用 CountingD1 那种全放行的桩：这里必须让**某一步真的失败**，
 * 才能验日志、验 dbReady、验「下次只重跑那一步」。挑的是 `group-share-table`
 * —— 它用的是 `prepare(...).run()` 且自带注释说明「不能吞错误」，失败会真的抛出来
 * （不像 core-tables / encrypt-legacy 那几步内部有 try/catch 会把失败吃掉）。
 */
class ScriptedD1 {
    configs = new Map<string, string>();
    statements: string[] = [];
    /** 命中这个正则的语句在 prepare / exec 阶段直接抛错（模拟这一步挂了） */
    failOn: RegExp | null = null;
    /** 命中这个正则的语句在查询时抛错（模拟「迁移之后 D1 真出问题」） */
    throwOn: RegExp | null = null;

    private normalize(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    prepare(sql: string) {
        const norm = this.normalize(sql);
        if (this.failOn && this.failOn.test(norm)) {
            throw new Error(`模拟迁移步骤失败：${norm.slice(0, 60)}`);
        }
        const self = this;
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => {
                self.statements.push(norm);
                if (self.throwOn && self.throwOn.test(norm)) throw new Error("模拟 D1 异常");
                if (/^SELECT value FROM configs WHERE key = \?/.test(norm)) {
                    const value = self.configs.get(String(args[0]));
                    return value === undefined ? null : { value };
                }
                return null;
            },
            all: async () => {
                self.statements.push(norm);
                if (self.throwOn && self.throwOn.test(norm)) throw new Error("模拟 D1 异常");
                return { results: [] as unknown[], success: true };
            },
            run: async () => {
                self.statements.push(norm);
                if (self.throwOn && self.throwOn.test(norm)) throw new Error("模拟 D1 异常");
                if (/^INSERT INTO configs/.test(norm)) {
                    self.configs.set(String(args[0]), String(args[1]));
                }
                return { success: true, results: [], meta: { rows_written: 1 } };
            },
        });
        return make([]);
    }

    async batch(stmts: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
        const out: unknown[] = [];
        for (const stmt of stmts) out.push(await stmt.run());
        return out;
    }

    async exec(sql: string): Promise<{ count: number }> {
        const norm = this.normalize(sql);
        this.statements.push(norm);
        if (this.failOn && this.failOn.test(norm)) {
            throw new Error(`模拟迁移步骤失败：${norm.slice(0, 60)}`);
        }
        return { count: 0 };
    }
}

function apiWith(db: ScriptedD1): NavigationAPI {
    return new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
}

/** 让 `group-share-table` 这一步挂掉 */
const FAIL_GROUP_SHARE = /CREATE TABLE IF NOT EXISTS group_share/;

function readLog(db: ScriptedD1): MigrationLogEntry[] {
    const raw = db.configs.get(MIGRATION_LOG_KEY);
    assert.ok(raw, `schema.log 没写进去（键名必须是 ${MIGRATION_LOG_KEY}）`);
    return JSON.parse(raw as string) as MigrationLogEntry[];
}

function readSteps(db: ScriptedD1): string[] {
    return JSON.parse(db.configs.get(MIGRATION_STEPS_KEY) ?? "[]") as string[];
}

test("某步抛错：schema.log 里有 ok:false 的这条，且该步不在 steps 里", async () => {
    resetMigrationCacheForTests();
    const db = new ScriptedD1();
    db.failOn = FAIL_GROUP_SHARE;
    const api = apiWith(db);

    await api.migrate();

    const log = readLog(db);
    const failed = log.filter(entry => !entry.ok);
    assert.equal(failed.length, 1, `只该有 1 条失败记录，实际：${JSON.stringify(failed)}`);
    assert.equal(failed[0].step, "group-share-table");
    assert.ok(typeof failed[0].err === "string" && failed[0].err.length > 0, "要留下原因");
    assert.ok(
        (failed[0].err as string).length <= MIGRATION_LOG_ERROR_MAX,
        `原因要截断到 ${MIGRATION_LOG_ERROR_MAX} 字符（不记堆栈、不记绑定值）`
    );
    assert.ok(failed[0].ms >= 0, "耗时要记下来（哪怕是 0）");
    assert.ok(failed[0].at > 0, "开始时刻要记下来");
    assert.ok(log.length <= MIGRATION_LOG_KEEP, "日志是环形缓冲，不许无限增长");

    // 成功的步骤照旧进集合 + 有 ok:true 的记录
    const steps = readSteps(db);
    assert.ok(!steps.includes("group-share-table"), "失败的步骤不许进 schema.steps");
    assert.ok(steps.includes("core-tables"), "其它步骤照旧要记进集合");
    assert.ok(
        log.some(entry => entry.ok && entry.step === "core-tables"),
        "成功的步骤也要有记录"
    );
});

test("下次启动只重跑失败的那一步", async () => {
    resetMigrationCacheForTests();
    const db = new ScriptedD1();
    db.failOn = FAIL_GROUP_SHARE;
    await apiWith(db).migrate();

    const logBefore = readLog(db);
    const statementsBefore = db.statements.length;

    // 新 isolate：模块级迁移缓存要清掉；这次那一步不再失败
    resetMigrationCacheForTests();
    db.failOn = null;
    const second = apiWith(db);
    await second.migrate();

    const added = readLog(db).slice(logBefore.length);
    assert.deepEqual(
        added.map(entry => entry.step),
        ["group-share-table"],
        `第二次只该跑失败的那一步，实际跑了：${added.map(e => e.step).join(", ")}`
    );
    assert.equal(added[0].ok, true, "这次它跑成功了");

    // 上一次已经成功的步骤不许重发语句
    const resent = db.statements.slice(statementsBefore);
    assert.equal(
        resent.some(sql => /ALTER TABLE users ADD COLUMN token_version/.test(sql)),
        false,
        "已经在 steps 里的步骤不该重跑"
    );
    assert.equal(
        db.configs.get(SCHEMA_VERSION_KEY),
        SCHEMA_VERSION,
        "补齐之后版本号要写进去，否则下次还要重跑"
    );
});

test("有步骤失败时 dbReady = false（迁移没跑完就不冒充「结构已就绪」）", async () => {
    resetMigrationCacheForTests();
    const db = new ScriptedD1();
    db.failOn = FAIL_GROUP_SHARE;
    const api = apiWith(db);

    await api.migrate();

    assert.equal(api.dbReady, false, "还有步骤没跑成，dbReady 就不能是 true");
    assert.equal(db.configs.get(SCHEMA_VERSION_KEY), undefined, "迁移没跑完不该写版本号");
});

test("全部成功：schema.log 每条 ok:true、ms >= 0，dbReady = true", async () => {
    resetMigrationCacheForTests();
    const db = new ScriptedD1();
    const api = apiWith(db);

    await api.migrate();

    assert.equal(api.dbReady, true);
    const log = readLog(db);
    assert.ok(log.length > 0, "跑过的每一步都该有一条记录");
    assert.equal(log.filter(entry => !entry.ok).length, 0);
    assert.ok(log.every(entry => entry.ms >= 0 && entry.at > 0));
    assert.equal(db.configs.get(SCHEMA_VERSION_KEY), SCHEMA_VERSION);
});

test("迁移失败期间更宽松（不是更严）：账号状态查询 fail-open 放行", async () => {
    // 方向必须钉死：迁移失败 → dbReady=false → 查账号状态出错时**放行**。
    // 反过来（fail-closed）就是「迁移一挂，连登录页都进不去」，那是最糟的失败模式。
    resetMigrationCacheForTests();
    const failed = new ScriptedD1();
    failed.failOn = FAIL_GROUP_SHARE;
    const failedApi = apiWith(failed);
    await failedApi.migrate();
    assert.equal(failedApi.dbReady, false);
    failed.throwOn = /SELECT "status" FROM users/;
    assert.equal(
        await failedApi.getAccountSessionState(1),
        "active",
        "迁移没跑完时不该把全站锁在门外"
    );

    // 对照：迁移成功过（dbReady=true）之后同样的异常是 fail-closed
    resetMigrationCacheForTests();
    const healthy = new ScriptedD1();
    const healthyApi = apiWith(healthy);
    await healthyApi.migrate();
    assert.equal(healthyApi.dbReady, true);
    healthy.throwOn = /SELECT "status" FROM users/;
    assert.equal(
        await healthyApi.getAccountSessionState(1),
        "missing",
        "结构已就绪之后的 DB 异常仍要 fail-closed（被停用/清除的账号不能靠旧令牌过审）"
    );
});
