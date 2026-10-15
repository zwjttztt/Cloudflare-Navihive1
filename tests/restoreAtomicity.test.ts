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
interface SiteRow {
    id: number; group_id: number; user_id: number; name: string;
    /** 增量导入按「分组 + 链接」认同一条卡片，还要拿时间戳比新旧 */
    url?: string;
    updated_at?: string;
}

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
            // ⚠️ url 必须存下来：增量导入按「分组 + 链接」认同一条卡片，
            // 存不进去的话第二次读索引时这张卡就没有链接，会被当成另一条再插一遍
            const urlIdx = hasId ? 3 : 2;
            this.sites.push({
                id,
                group_id: Number(args[hasId ? 1 : 0]),
                user_id: Number(args[hasId ? 10 : 9]),
                name: String(args[hasId ? 2 : 1]),
                url: String(args[urlIdx] ?? ""),
                // SQL 里写的是 CURRENT_TIMESTAMP：用一个现实的时间盖上，让
                // 「本地较新 → 跳过」这条规则在重复导入时真的成立
                updated_at: new Date().toISOString(),
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
        // 增量导入命中「备份里那条更新」时走 UPDATE：就地改，不换 id
        if (s.startsWith("UPDATE sites SET")) {
            const scoped = s.includes("user_id = ?");
            const id = Number(args[args.length - (scoped ? 2 : 1)]);
            const row = this.sites.find(x => x.id === id);
            if (!row) return { rows: [], changed: 0 };
            row.group_id = Number(args[0]);
            row.name = String(args[1] ?? "");
            row.url = String(args[2] ?? "");
            row.updated_at = new Date().toISOString();
            return { rows: [], changed: 1 };
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
        // 增量导入的两张索引表：**只认当前账号**（多账号部署不能拿别人的分组去重）
        if (s.startsWith("SELECT id, name FROM groups")) {
            const uid = s.includes("user_id = ?") ? Number(args.at(-1)) : null;
            return this.groups
                .filter(g => uid === null || g.user_id === uid)
                .map(g => ({ id: g.id, name: g.name }));
        }
        if (s.startsWith("SELECT id, group_id, name, url, updated_at FROM sites")) {
            const uid = s.includes("user_id = ?") ? Number(args.at(-1)) : null;
            return this.sites
                .filter(x => uid === null || x.user_id === uid)
                .map(x => ({
                    id: x.id,
                    group_id: x.group_id,
                    name: x.name,
                    url: x.url ?? "",
                    updated_at: x.updated_at ?? "",
                }));
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
    // 以前这里有两个「清理旧数据」注入点，那两条 DELETE 已经不存在了 ——
    // 现在的失败点必须落在**读写链路本身**上，才能继续验证「失败后库里还是原样」。
    { label: "读取现有卡片索引时失败", rule: { when: /^SELECT id, group_id, name, url, updated_at FROM sites/, error: "模拟读取现有数据失败" } },
    // 「就地更新已存在卡片」也是条写路径，但它要先有匹配项才跑得起来，
    // 单独一条用例在下面用专门的夹具验（这里的通用夹具故意一组都不匹配）。
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

test("增量导入成功路径：一个事务提交，旧数据**原样保留**、新数据就位", async () => {
    const db = new MockD1();
    seed(db);

    const api = apiWith(db, 2);
    const result = await api.importData(makeBackup());

    assert.equal(result.success, true, "正常备份应当导入成功");
    // 所有写入（新建 + 就地更新 + 配置）在同一个 batch 里：全是 adult（要么全成、要么全不变）
    assert.equal(db.batchCalls, 1, `整份导入应只提交一个事务，实际 ${db.batchCalls} 次`);
    assert.ok(db.groups.some(g => g.name === "备份分组A"), "新分组该就位");
    assert.ok(db.sites.some(x => x.name === "备份站点1"), "新站点该就位");
    // ⚠️ 这是这次改动的硬约束：以前这一段是「旧分组 / 旧站点该被清掉」，
    // 现在反过来 —— 导入只能做加法，旧的一条都不能少。
    assert.ok(db.groups.some(g => g.id === 5 && g.name === "我的旧分组"), "旧分组必须还在");
    assert.ok(db.sites.some(x => x.id === 7) && db.sites.some(x => x.id === 8), "两个旧站点都必须在");
    // 账目要能自证：这份备份两组两卡全是新的，所以一次都没有命中已有的
    assert.deepEqual(result.stats, {
        groupsCreated: 2,
        groupsMatched: 0,
        sitesCreated: 2,
        sitesUpdated: 0,
        sitesSkipped: 0,
    });
    // id 映射要回传给前端（星标/标签是按旧 id 存在本机的）
    assert.equal(Object.keys(result.groupIdMap).length, 2);
    assert.equal(Object.keys(result.siteIdMap).length, 2);
});

test("重复导入同一份备份：第二次一行都不新增（幂等）", async () => {
    const db = new MockD1();
    seed(db);
    const api = apiWith(db, 2);
    const backup = makeBackup();

    await api.importData(backup);
    const after1 = db.groups.length + db.sites.length;
    const second = await api.importData(backup);

    assert.equal(second.success, true, "第二次导入同样该成功");
    assert.equal(
        db.groups.length + db.sites.length,
        after1,
        `重复导入不该再长出新行（实际 ${JSON.stringify({ groups: db.groups, sites: db.sites })}）`
    );
    assert.deepEqual(second.stats, {
        groupsCreated: 0,
        groupsMatched: 2,
        sitesCreated: 0,
        sitesUpdated: 0,
        // 本地那条没有 updated_at（万能夹具造的行），判「本地较新」→ 保守跳过
        sitesSkipped: 2,
    }, "第二次必须全都认出是同一条");
});

test("备份里那条更新时才覆盖，本地较新就跳过", async () => {
    const db = new MockD1();
    db.users.set(2, { id: 2, username: "u2", role: "user" });
    db.groups.push({ id: 5, user_id: 2, name: "我的旧分组", order_num: 0 });
    db.sites.push({
        id: 9, group_id: 5, user_id: 2, name: "本地改过的名字",
        url: "https://c.com", updated_at: "2030-01-01T00:00:00.000Z",
    });

    const api = apiWith(db, 2);
    const result = await api.importData({
        groups: [{ id: 1, name: "我的旧分组", order_num: 0 }],
        sites: [{
            id: 20, group_id: 1, name: "备份里的名字", url: "https://c.com",
            icon: "", description: "", notes: "", username: "", password: "",
            order_num: 0, updated_at: "2026-01-01T00:00:00.000Z",
        }],
        configs: {},
        version: "1.3",
        exportDate: new Date().toISOString(),
    } as ExportData);

    assert.equal(result.success, true);
    assert.equal(
        db.sites.find(x => x.id === 9)?.name,
        "本地改过的名字",
        "本地那条更新（2030 > 2026），不能被备份悄悄覆盖"
    );
    assert.deepEqual(result.stats, {
        groupsCreated: 0,
        groupsMatched: 1,
        sitesCreated: 0,
        sitesUpdated: 0,
        sitesSkipped: 1,
    });
});

test("就地更新失败时，本地那条必须原封不动", async () => {
    const db = new MockD1();
    db.users.set(2, { id: 2, username: "u2", role: "user" });
    db.groups.push({ id: 5, user_id: 2, name: "我的旧分组", order_num: 0 });
    db.sites.push({
        id: 9, group_id: 5, user_id: 2, name: "本地旧名字",
        url: "https://c.com", updated_at: "2020-01-01T00:00:00.000Z",
    });
    db.failRules = [{ when: /^UPDATE sites SET/, error: "模拟卡片就地更新失败" }];

    const api = apiWith(db, 2);
    const result = await api.importData({
        groups: [{ id: 1, name: "我的旧分组", order_num: 0 }],
        sites: [{
            id: 20, group_id: 1, name: "备份里的新名字", url: "https://c.com",
            icon: "", description: "", notes: "", username: "", password: "",
            order_num: 0, updated_at: "2026-01-01T00:00:00.000Z",
        }],
        configs: {},
        version: "1.3",
        exportDate: new Date().toISOString(),
    } as ExportData);

    assert.equal(result.success, false, "就地更新炸了必须报失败");
    assert.ok(result.message?.includes("就地更新"), `失败要说得出原因，实际：${result.message}`);
    assert.equal(
        db.sites.find(x => x.id === 9)?.name,
        "本地旧名字",
        "事务整批回滚：本地那条连半个字都不该改"
    );
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
