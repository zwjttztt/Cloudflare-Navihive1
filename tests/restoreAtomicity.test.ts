// tests/restoreAtomicity.test.ts
// D01 的验收条件（审查报告原文）：
//   「插入中、配置中、旧站点删除后、旧分组删除中分别注入错误，始终保留一份完整可用版本；
//     失败提示不能声称恢复成功。」
//
// 所以这个文件的 MockD1 必须**真的有事务语义**：batch 里任意一条语句炸了，
// 前面已经执行的那些要一起撤销 —— 否则测出来的是「代码以为自己回滚了」而不是
// 「数据库确实没变」。没有这层，下面 5 条故障注入断言全是自欺欺人。
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExportData } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";

interface GroupRow { id: number; user_id: number; name: string; order_num: number }
interface SiteRow { id: number; group_id: number; user_id: number; name: string }

/** 让某条语句失败：按 SQL 归一化后的前缀匹配 */
type FailRule = { when: RegExp; error: string };

class MockD1 {
    groups: GroupRow[] = [];
    sites: SiteRow[] = [];
    configs = new Map<string, string>();
    userConfigs = new Map<string, string>();
    users = new Map<number, { id: number; username: string; role: string }>();
    idempotency = new Map<string, { state: string; expiresAt: number }>();
    /** 注入故障：命中规则的语句（含 batch 内的）会抛错 */
    failRules: FailRule[] = [];
    /** batch 的调用次数，用来观察「是不是真的整批提交」 */
    batchCalls = 0;
    /** batch 里执行过的语句数（每次调用重置） */
    lastBatchSize = 0;

    private norm(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    /** 单条语句的执行体；batch 与 run/all 共用，保证故障注入对两条路径都生效 */
    private runStatement(sql: string, args: unknown[]): { rows: unknown[]; changed: number } {
        const s = this.norm(sql);
        for (const rule of this.failRules) {
            if (rule.when.test(s)) throw new Error(rule.error);
        }

        if (s.startsWith("INSERT INTO groups")) {
            const hasId = /^INSERT INTO groups \(id,/.test(s);
            const id = hasId ? Number(args[0]) : this.maxId(this.groups) + 1;
            this.groups.push({
                id,
                user_id: Number(args[hasId ? 3 : 2]),
                name: String(args[hasId ? 1 : 0]),
                order_num: Number(args[hasId ? 2 : 1]),
            });
            return { rows: [{ id }], changed: 1 };
        }
        if (s.startsWith("INSERT INTO sites")) {
            const hasId = /^INSERT INTO sites \(id,/.test(s);
            const id = hasId ? Number(args[0]) : this.maxId(this.sites) + 1;
            this.sites.push({
                id,
                group_id: Number(args[hasId ? 1 : 0]),
                user_id: Number(args[hasId ? 10 : 9]),
                name: String(args[hasId ? 2 : 1]),
            });
            return { rows: [{ id }], changed: 1 };
        }
        if (s.startsWith("INSERT INTO configs")) {
            this.configs.set(String(args[0]), String(args[1]));
            return { rows: [], changed: 1 };
        }
        if (s.startsWith("INSERT INTO user_configs")) {
            this.userConfigs.set(`${args[0]}|${args[1]}`, String(args[2]));
            return { rows: [], changed: 1 };
        }
        if (s.startsWith("INSERT INTO idempotency_keys")) {
            const key = `${args[0]}|${args[1]}`;
            if (this.idempotency.has(key)) return { rows: [], changed: 0 };
            this.idempotency.set(key, { state: "pending", expiresAt: Number(args[6]) });
            return { rows: [], changed: 1 };
        }
        if (s.startsWith("DELETE FROM idempotency_keys")) {
            if (/expires_at <= \?/.test(s)) {
                const now = Number(args.at(-1));
                for (const [k, v] of [...this.idempotency]) {
                    if (v.expiresAt <= now) this.idempotency.delete(k);
                }
                return { rows: [], changed: 0 };
            }
            const key = `${args[0]}|${args[1]}`;
            return { rows: [], changed: this.idempotency.delete(key) ? 1 : 0 };
        }
        if (s.startsWith("DELETE FROM groups WHERE id IN")) {
            const ids = this.inIds(s, args);
            const before = this.groups.length;
            this.groups = this.groups.filter(g => !ids.includes(g.id));
            return { rows: [], changed: before - this.groups.length };
        }
        if (s.startsWith("DELETE FROM sites WHERE id IN")) {
            const ids = this.inIds(s, args);
            const before = this.sites.length;
            this.sites = this.sites.filter(x => !ids.includes(x.id));
            return { rows: [], changed: before - this.sites.length };
        }
        // 建表 / 迁移 / 审计写入一律当成功
        return { rows: [], changed: 0 };
    }

    private maxId(rows: { id: number }[]): number {
        return rows.reduce((m, r) => Math.max(m, r.id), 0);
    }

    /** 从 `WHERE id IN (?, ?) AND user_id = ?` 里只取前 N 个 id 参数 */
    private inIds(s: string, args: unknown[]): number[] {
        const n = (s.match(/id IN \(([?,\s]*)\)/)?.[1].match(/\?/g) ?? []).length;
        return args.slice(0, n || args.length).map(Number);
    }

    private select(sql: string, args: unknown[]): unknown[] {
        const s = this.norm(sql);
        const maxMatch = /^SELECT COALESCE\(MAX\(id\), 0\) AS m FROM (groups|sites)$/.exec(s);
        if (maxMatch) {
            return [{ m: this.maxId(maxMatch[1] === "groups" ? this.groups : this.sites) }];
        }
        if (s.startsWith("SELECT id FROM groups")) {
            const uid = s.includes("user_id = ?") ? Number(args.at(-1)) : null;
            return this.groups.filter(g => uid === null || g.user_id === uid).map(g => ({ id: g.id }));
        }
        if (s.startsWith("SELECT id FROM sites")) {
            const uid = s.includes("user_id = ?") ? Number(args.at(-1)) : null;
            return this.sites.filter(x => uid === null || x.user_id === uid).map(x => ({ id: x.id }));
        }
        if (s === "SELECT key, value FROM configs") {
            return [...this.configs.entries()].map(([key, value]) => ({ key, value }));
        }
        if (s.startsWith("SELECT state, status, body") && s.includes("idempotency_keys")) {
            const rec = this.idempotency.get(`${args[0]}|${args[1]}`);
            return rec ? [{ state: rec.state, status: null, body: null, created_at: 0, expires_at: rec.expiresAt }] : [];
        }
        if (s.includes("FROM users")) {
            const id = Number(args[0]);
            const u = this.users.get(id);
            return u ? [u] : [];
        }
        return [];
    }

    prepare(sql: string) {
        const self = this;
        let args: unknown[] = [];
        const stmt = {
            _sql: sql,
            get _args() { return args; },
            bind(...a: unknown[]) {
                args = a;
                return stmt;
            },
            async first() {
                return self.select(sql, args)[0] ?? null;
            },
            async all() {
                const out = self.runStatement(sql, args);
                return { results: out.rows.length ? out.rows : self.select(sql, args), success: true };
            },
            async run() {
                const out = self.runStatement(sql, args);
                return { success: true, results: out.rows, meta: { rows_written: out.changed } };
            },
        };
        return stmt;
    }

    /**
     * 真·事务：整批成功才生效，任意一条抛错就整批撤销。
     * D1 的 batch 就是这个语义，mock 不照做的话故障注入测不出「原子」这件事。
     */
    async batch<T>(stmts: { _sql: string; _args?: unknown[] }[]): Promise<{ results: T[]; success: boolean }[]> {
        this.batchCalls++;
        this.lastBatchSize = stmts.length;
        const snapshotGroups = this.groups.map(g => ({ ...g }));
        const snapshotSites = this.sites.map(x => ({ ...x }));
        const snapshotConfigs = new Map(this.configs);
        const snapshotUserConfigs = new Map(this.userConfigs);
        try {
            const out = stmts.map(s => {
                const r = this.runStatement(s._sql, s._args || []);
                return { results: r.rows as T[], success: true };
            });
            return out;
        } catch (error) {
            this.groups = snapshotGroups;
            this.sites = snapshotSites;
            this.configs = snapshotConfigs;
            this.userConfigs = snapshotUserConfigs;
            throw error;
        }
    }

    async exec(): Promise<{ count: number }> {
        return { count: 0 };
    }
}

function apiWith(db: MockD1, uid: number): NavigationAPI {
    const api = new NavigationAPI({
        // @ts-expect-error 测试替身
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-restore",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
    api.setCurrentUser(uid);
    return api;
}

function makeBackup(): ExportData {
    return {
        groups: [
            { id: 1, name: "备份分组A", order_num: 0 },
            { id: 2, name: "备份分组B", order_num: 1 },
        ],
        sites: [
            { id: 10, group_id: 1, name: "备份站点1", url: "https://a.com", icon: "", description: "", notes: "", username: "", password: "", order_num: 0 },
            { id: 11, group_id: 2, name: "备份站点2", url: "https://b.com", icon: "", description: "", notes: "", username: "", password: "", order_num: 0 },
        ],
        configs: { "site.title": "备份里的站名" },
        version: "1.3",
        exportDate: new Date().toISOString(),
    };
}

/** 造一个「有旧数据」的库：uid=2 有 1 个分组 + 2 个站点 */
function seed(db: MockD1): void {
    db.users.set(2, { id: 2, username: "u2", role: "user" });
    db.groups.push({ id: 5, user_id: 2, name: "我的旧分组", order_num: 0 });
    db.sites.push({ id: 7, group_id: 5, user_id: 2, name: "我的旧站点1" });
    db.sites.push({ id: 8, group_id: 5, user_id: 2, name: "我的旧站点2" });
}

/** 断言「一份完整可用版本还在」：旧分组 + 两个旧站点都原样在库里 */
function assertOldDataIntact(db: MockD1, label: string): void {
    assert.ok(
        db.groups.some(g => g.id === 5 && g.user_id === 2 && g.name === "我的旧分组"),
        `${label}：旧分组不该消失`
    );
    assert.equal(
        db.sites.filter(x => x.user_id === 2 && [7, 8].includes(x.id)).length,
        2,
        `${label}：两个旧站点都该还在（实际 ${JSON.stringify(db.sites)}）`
    );
}

/** 断言「没有留下半截的新数据」：备份里的分组/站点一个都不该残留在库里 */
function assertNoPartialImport(db: MockD1, label: string): void {
    assert.ok(
        !db.groups.some(g => g.name === "备份分组A" || g.name === "备份分组B"),
        `${label}：不该留下半截的新分组（实际 ${JSON.stringify(db.groups)}）`
    );
    assert.ok(
        !db.sites.some(x => x.name === "备份站点1" || x.name === "备份站点2"),
        `${label}：不该留下半截的新站点（实际 ${JSON.stringify(db.sites)}）`
    );
}

// ================= 故障注入：五个失败点 =================
const failPoints: { label: string; rule: FailRule }[] = [
    { label: "插入分组时失败", rule: { when: /^INSERT INTO groups/, error: "模拟分组写入失败" } },
    { label: "插入站点时失败", rule: { when: /^INSERT INTO sites/, error: "模拟站点写入失败" } },
    // 配置按归属可能落到 configs（全站）或 user_configs（按账号），两个都要能炸
    { label: "写入配置时失败", rule: { when: /^INSERT INTO (?:configs|user_configs)/, error: "模拟配置写入失败" } },
    { label: "删除旧站点后失败", rule: { when: /^DELETE FROM sites WHERE id IN/, error: "模拟旧站点清理失败" } },
    { label: "删除旧分组时失败", rule: { when: /^DELETE FROM groups WHERE id IN/, error: "模拟旧分组清理失败" } },
];

for (const { label, rule } of failPoints) {
    test(`恢复故障注入 · ${label}：始终保留一份完整可用版本，且不谎报成功`, async () => {
        const db = new MockD1();
        seed(db);
        db.failRules = [rule];

        const api = apiWith(db, 2);
        const result = await api.importData(makeBackup());

        assert.equal(result.success, false, `${label}：这次恢复必须报失败`);
        assert.ok(
            typeof result.message === "string" && result.message.length > 0,
            `${label}：失败要给得出原因，不能报 success=false 却没话可说`
        );
        assertOldDataIntact(db, label);
        assertNoPartialImport(db, label);
    });
}

test("恢复故障注入 · 成功路径：旧数据清掉、新数据就位，且真的只提交了一个事务", async () => {
    const db = new MockD1();
    seed(db);

    const api = apiWith(db, 2);
    const result = await api.importData(makeBackup());

    assert.equal(result.success, true, "正常备份应当恢复成功");
    // 「旧数据清理 + 新数据写入」在同一个 batch 里：切过去是一步，不存在中间态
    assert.equal(db.batchCalls, 1, `整份恢复应只提交一个事务，实际 ${db.batchCalls} 次`);
    assert.ok(db.groups.some(g => g.name === "备份分组A"), "新分组该就位");
    assert.ok(db.sites.some(x => x.name === "备份站点1"), "新站点该就位");
    assert.ok(!db.groups.some(g => g.id === 5), "旧分组该被清掉");
    assert.ok(!db.sites.some(x => x.id === 7 || x.id === 8), "旧站点该被清掉");
    // id 映射要回传给前端（星标/标签是按旧 id 存在本机的）
    assert.equal(Object.keys(result.groupIdMap).length, 2);
    assert.equal(Object.keys(result.siteIdMap).length, 2);
});

test("站点挂到重新发号的分组上（旧 group_id 翻译正确）", async () => {
    const db = new MockD1();
    seed(db);
    const api = apiWith(db, 2);
    const result = await api.importData(makeBackup());

    const newGroupA = result.groupIdMap["1"];
    const newGroupB = result.groupIdMap["2"];
    assert.equal(db.sites.find(x => x.name === "备份站点1")?.group_id, newGroupA);
    assert.equal(db.sites.find(x => x.name === "备份站点2")?.group_id, newGroupB);
    assert.notEqual(newGroupA, newGroupB, "两个分组不能拿到同一个号");
});

test("恢复锁：上一个恢复还没结束时，第二次直接被挡下", async () => {
    const db = new MockD1();
    seed(db);
    // 预置一把没过期的锁，模拟「另一个恢复正在跑」
    db.idempotency.set("restore.lock|u2", { state: "pending", expiresAt: Date.now() + 60_000 });

    const api = apiWith(db, 2);
    const result = await api.importData(makeBackup());

    assert.equal(result.success, false, "并发恢复必须被挡下");
    assert.match(result.message ?? "", /上一次恢复还没结束/);
    assertOldDataIntact(db, "并发被挡");
});

test("恢复锁过期后可以再恢复（崩掉的进程不会把账号永久堵死）", async () => {
    const db = new MockD1();
    seed(db);
    // 一把早已过期的锁：claimIdempotency 会先清掉它
    db.idempotency.set("restore.lock|u2", { state: "pending", expiresAt: Date.now() - 1 });

    const api = apiWith(db, 2);
    const result = await api.importData(makeBackup());

    assert.equal(result.success, true, "过期的锁不该挡住新的恢复");
    assert.ok(db.sites.some(x => x.name === "备份站点1"));
});
