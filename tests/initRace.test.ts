// tests/initRace.test.ts
// 审查报告「生产环境必须另验」里两条可以在本地钉死的边界：
//   1. 初始化接口首次竞争：两个请求同时看到 users 表为空，会不会建出两个 owner？
//   2. 缺表 / DB 故障时的实际鉴权行为：是放行还是拦下？逃生开关是否真的能开？
//
// 两者都用内存版 D1 直接跑真实方法体，不联网、不碰真实数据库。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";

type Row = Record<string, unknown>;

// ---------------- 只撑起本文件几条语句的内存 D1 ----------------
class MockD1 {
    users: Row[] = [];
    idempotency = new Map<string, { expiresAt: number }>();
    configs = new Map<string, string>();
    /** users 表查询是否抛错（模拟缺表 / D1 抖动） */
    usersFail = false;
    /** 幂等表是否抛错（模拟建表之前 / 表不可用） */
    idempotencyFail = false;
    insertCount = 0;

    prepare(sql: string) {
        const self = this;
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => {
                const rows = self.run(sql, args);
                return (rows[0] as Row) ?? null;
            },
            all: async () => ({ results: self.run(sql, args), success: true }),
            run: async () => {
                const results = self.run(sql, args);
                const write = /INSERT INTO idempotency_keys/.test(sql)
                    ? self.written
                    : /DELETE FROM idempotency_keys/.test(sql)
                      ? 1
                      : results.length;
                return { success: true, results, meta: { rows_written: write } };
            },
        });
        return make([]);
    }

    private written = 0;

    async batch<T>(stmts: Array<{ all: () => Promise<{ results: T[] }> }>) {
        return Promise.all(stmts.map((s) => s.all()));
    }

    async exec(): Promise<{ success: boolean }> {
        return { success: true };
    }

    private run(sql: string, args: unknown[]): Row[] {
        if (/FROM users/.test(sql) && this.usersFail) throw new Error("no such table: users");
        if (/idempotency_keys/.test(sql) && this.idempotencyFail) {
            throw new Error("no such table: idempotency_keys");
        }

        // ---- users ----
        if (/SELECT id, username FROM users/.test(sql)) {
            return this.users.length ? [{ id: this.users[0].id, username: this.users[0].username }] : [];
        }
        if (/SELECT "status" FROM users/.test(sql)) {
            const row = this.users.find((u) => u.id === args[0]);
            return row ? [{ status: row.status ?? null }] : [];
        }
        if (/INSERT INTO users/.test(sql)) {
            this.insertCount++;
            const id = this.users.length + 1;
            this.users.push({ id, username: String(args[0]), role: "owner" });
            return [{ id }];
        }

        // ---- idempotency_keys（只需要「主键冲突即抢锁」这一条语义）----
        if (/DELETE FROM idempotency_keys/.test(sql)) {
            if (/expires_at <= \?/.test(sql)) {
                for (const [k, v] of [...this.idempotency]) {
                    if (v.expiresAt <= Number(args.at(-1))) this.idempotency.delete(k);
                }
            } else {
                this.idempotency.delete(`${args[0]}|${args[1]}`);
            }
            return [];
        }
        if (/INSERT INTO idempotency_keys/.test(sql)) {
            const key = `${args[0]}|${args[1]}`;
            if (this.idempotency.has(key)) {
                this.written = 0; // ON CONFLICT DO NOTHING
            } else {
                this.idempotency.set(key, { expiresAt: Number(args.at(-1)) });
                this.written = 1;
            }
            return [];
        }

        // ---- configs ----
        if (/SELECT value FROM configs WHERE key = \?/.test(sql)) {
            const v = this.configs.get(String(args[0]));
            return v == null ? [] : [{ value: v }];
        }
        return [];
    }
}

function newApi(db: MockD1, env: Record<string, unknown> = {}): NavigationAPI {
    return new NavigationAPI({
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "seed-password-123",
        AUTH_SECRET: "test-secret",
        ...env,
    } as never);
}

// ================= 1. 首次初始化竞争 =================
test("首次初始化并发：两个请求同时看到空表，只会建出一个 owner", async () => {
    const db = new MockD1();
    const a = newApi(db);
    const b = newApi(db);
    // 让 b 抢不到锁：模拟它慢一步（真实场景是另一个 isolate / 另一次刷新）
    const [idA, idB] = await Promise.all([a.ensureOwnerUser(), b.ensureOwnerUser()]);
    assert.equal(db.users.length, 1, `只应有一个 owner，实际 ${db.users.length}`);
    assert.equal(db.insertCount, 1, "INSERT 只应成功一次");
    assert.ok(idA !== null || idB !== null, "至少一个请求要拿到 owner id");
    if (idA !== null && idB !== null) assert.equal(idA, idB, "两个请求应看到同一个 owner");
});

test("首次初始化：已有 owner 时走快路径，一次 INSERT 都不做", async () => {
    const db = new MockD1();
    db.users.push({ id: 7, username: "admin", role: "owner" });
    const api = newApi(db);
    assert.equal(await api.ensureOwnerUser(), 7);
    assert.equal(db.insertCount, 0);
});

test("首次初始化：幂等表不可用时仍能建出 owner（锁失效不阻断初始化）", async () => {
    const db = new MockD1();
    db.idempotencyFail = true; // 建表之前 / 表不可用
    const api = newApi(db);
    assert.equal(await api.ensureOwnerUser(), 1);
    assert.equal(db.insertCount, 1);
});

test("首次初始化：users 表查询直接抛错时返回 null 而不是崩溃", async () => {
    const db = new MockD1();
    db.usersFail = true;
    const api = newApi(db);
    assert.equal(await api.ensureOwnerUser(), null);
});

// ================= 2. 缺表 / DB 故障时的鉴权取向 =================
test("DB 故障（迁移已完成）：默认 fail-closed —— 查不到账号状态就按不可用拦下", async () => {
    const db = new MockD1();
    db.usersFail = true;
    const api = newApi(db);
    api.dbReady = true;
    assert.equal(await api.getAccountSessionState(1), "missing");
});

test("DB 故障：开了逃生开关 NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1 才放行", async () => {
    const db = new MockD1();
    db.usersFail = true;
    const api = newApi(db, { NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR: "1" });
    api.dbReady = true;
    assert.equal(await api.getAccountSessionState(1), "active");
});

test("迁移还没跑完（缺表）：fail-open 放行，否则整站登不进去", async () => {
    const db = new MockD1();
    db.usersFail = true;
    const api = newApi(db);
    api.dbReady = false;
    assert.equal(await api.getAccountSessionState(1), "active");
});

test("DB 故障推出的结论不进缓存：抖动恢复后立刻拿到真实状态", async () => {
    const db = new MockD1();
    db.users.push({ id: 1, username: "admin", status: "disabled" });
    db.usersFail = true;
    const api = newApi(db);
    api.dbReady = true;
    assert.equal(await api.getAccountSessionState(1), "missing");
    // DB 恢复
    db.usersFail = false;
    assert.equal(await api.getAccountSessionState(1), "disabled", "不该被上一次的兜底结论卡住");
});
