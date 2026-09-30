// tests/clientErrors.test.ts
// 前端错误上报聚合视图（D-2）的回归测试。钉住几条容易写错的规则：
//   1. 只统计 action = client-error 的记录，其它审计条目不混进来；
//   2. 同一条错误反复出现要合并成一组并计数，而不是刷出一长串；
//   3. 排序按「次数多的在前」，次数相同最近发生的在前；
//   4. detail 不是 JSON（老记录）时不丢，退化成整条当消息。
import { test } from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI } from "../src/API/navigationApi";

interface AuditRow {
    action: string;
    detail: string;
    created_at: string;
}

/** 只实现 getClientErrors 用得到的那条查询 */
class AuditD1 {
    rows: AuditRow[] = [];

    prepare(sql: string) {
        const make = (args: unknown[]) => ({
            bind: (...a: unknown[]) => make(a),
            first: async () => null,
            all: async () => ({
                results: this.read(sql, args),
                success: true,
            }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
        });
        return make([]);
    }

    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        for (const s of stmts) await s.run();
        return { results: [], success: true };
    }

    async exec() {
        return { success: true };
    }

    private read(sql: string, args: unknown[]): unknown {
        if (/FROM audit_log WHERE action = \?/.test(sql)) {
            const [action, limit] = args as [string, number];
            // 真实 SQL 是 ORDER BY id DESC LIMIT ?，这里按数组顺序倒序取尾部
            return this.rows
                .filter(r => r.action === action)
                .slice(-limit)
                .reverse();
        }
        return [];
    }
}

function newApi(db: AuditD1): NavigationAPI {
    return new NavigationAPI({
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-client-errors",
        AUTH_USERNAME: "",
        AUTH_PASSWORD: "",
    } as unknown as ConstructorParameters<typeof NavigationAPI>[0]);
}

const report = (source: string, message: string, path = "/") =>
    JSON.stringify({ source, message, path, name: "Error" });

test("只统计前端错误上报，其它审计条目不混进来", async () => {
    const db = new AuditD1();
    db.rows = [
        { action: "login.success", detail: "管理员登录", created_at: "2026-09-30 09:00:00" },
        { action: "client-error", detail: report("auth", "boom"), created_at: "2026-09-30 10:00:00" },
    ];
    const groups = await newApi(db).getClientErrors();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source, "auth");
    assert.equal(groups[0].message, "boom");
});

test("同一条错误反复出现要合并计数，并按次数排序", async () => {
    const db = new AuditD1();
    db.rows = [
        { action: "client-error", detail: report("render", "偶发"), created_at: "2026-09-30 10:00:00" },
        { action: "client-error", detail: report("save", "写库失败"), created_at: "2026-09-30 10:01:00" },
        { action: "client-error", detail: report("save", "写库失败"), created_at: "2026-09-30 10:02:00" },
        { action: "client-error", detail: report("save", "写库失败"), created_at: "2026-09-30 10:03:00" },
    ];
    const groups = await newApi(db).getClientErrors();
    assert.equal(groups.length, 2, "两条不同的错误不该刷出四行");
    assert.equal(groups[0].source, "save");
    assert.equal(groups[0].count, 3);
    assert.equal(groups[0].lastAt, "2026-09-30 10:03:00", "最近时间取最后一次");
    assert.equal(groups[1].count, 1);
});

test("次数相同时，最近发生的排在前面", async () => {
    const db = new AuditD1();
    db.rows = [
        { action: "client-error", detail: report("a", "先发生的"), created_at: "2026-09-30 10:00:00" },
        { action: "client-error", detail: report("b", "后发生的"), created_at: "2026-09-30 11:00:00" },
    ];
    const groups = await newApi(db).getClientErrors();
    assert.equal(groups[0].message, "后发生的");
});

test("同一条错误在不同页面上出现，路径合并进去且最多留 3 个", async () => {
    const db = new AuditD1();
    const msg = "同一个错";
    db.rows = [
        { action: "client-error", detail: report("render", msg, "/a"), created_at: "2026-09-30 10:00:00" },
        { action: "client-error", detail: report("render", msg, "/b"), created_at: "2026-09-30 10:01:00" },
        { action: "client-error", detail: report("render", msg, "/c"), created_at: "2026-09-30 10:02:00" },
        { action: "client-error", detail: report("render", msg, "/d"), created_at: "2026-09-30 10:03:00" },
    ];
    const groups = await newApi(db).getClientErrors();
    assert.equal(groups.length, 1);
    // 取的是最近三条（SQL 按 id 倒序），不是最早三条
    assert.deepEqual(groups[0].paths, ["/d", "/c", "/b"], "路径去重且封顶 3 个");
});

test("detail 不是 JSON 时不丢，退化成整条当消息", async () => {
    const db = new AuditD1();
    db.rows = [{ action: "client-error", detail: "手写的一条旧记录", created_at: "2026-09-30 10:00:00" }];
    const groups = await newApi(db).getClientErrors();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source, "unknown");
    assert.match(groups[0].message, /手写的一条旧记录/);
});

test("没有上报时返回空数组，不报错", async () => {
    const db = new AuditD1();
    db.rows = [{ action: "login.success", detail: "登录", created_at: "2026-09-30 09:00:00" }];
    assert.deepEqual(await newApi(db).getClientErrors(), []);
});
