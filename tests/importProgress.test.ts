// tests/importProgress.test.ts
// 第四章第 7 项「批量导入」的验收：
//   - 密码加密限并发（不再是一条一条串行 await），且顺序不乱
//   - 大备份也只能单事务提交；容量拒绝不能分块重试
//   - 阶段进度是服务端数出来的真实条数，不是前端编的百分比
//   - 事务后段失败时：旧数据完好 + 新数据全部撤销
//
// MockD1 使用事务语义（batch 里一条炸 = 整批撤销），并单独模拟容量拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ExportData } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { decryptSecret } from "../src/API/crypto";
import {
    COMMIT_CHUNK_STATEMENTS,
    ENCRYPT_CONCURRENCY,
    mapWithConcurrency,
} from "../src/API/methods/transfer";

interface Row { id: number; group_id: number; user_id: number; name: string; order_num: number }

type FailRule = {
    when: RegExp;
    error: string;
    /** 可选的二次判定：只炸满足条件的那一条（用来模拟「分块提交到一半才失败」） */
    args?: (args: unknown[]) => boolean;
};

class MockD1 {
    groups: Row[] = [];
    sites: Row[] = [];
    configs = new Map<string, string>();
    idempotency = new Map<string, { state: string; expiresAt: number }>();
    failRules: FailRule[] = [];
    batchCalls = 0;
    batchSizes: number[] = [];
    maxBatchSize = Infinity;

    private norm(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    private maxId(rows: Row[]): number {
        return rows.reduce((m, r) => Math.max(m, r.id), 0);
    }

    private run(sql: string, args: unknown[]): { rows: unknown[]; changed: number } {
        const s = this.norm(sql);
        for (const rule of this.failRules) {
            if (rule.when.test(s) && (!rule.args || rule.args(args))) {
                throw new Error(rule.error);
            }
        }
        if (s.startsWith("INSERT INTO groups")) {
            const id = Number(args[0]);
            this.groups.push({ id, group_id: 0, user_id: Number(args[3]), name: String(args[1]), order_num: Number(args[2]) });
            return { rows: [{ id }], changed: 1 };
        }
        if (s.startsWith("INSERT INTO sites")) {
            const id = Number(args[0]);
            this.sites.push({
                id,
                group_id: Number(args[1]),
                user_id: Number(args[10]),
                name: String(args[2]),
                order_num: Number(args[9]),
            });
            return { rows: [{ id }], changed: 1 };
        }
        if (s.startsWith("INSERT INTO configs")) {
            this.configs.set(String(args[0]), String(args[1]));
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
            return { rows: [], changed: this.idempotency.delete(`${args[0]}|${args[1]}`) ? 1 : 0 };
        }
        if (s.startsWith("DELETE FROM groups WHERE id IN") || s.startsWith("DELETE FROM sites WHERE id IN")) {
            const table = s.startsWith("DELETE FROM groups") ? this.groups : this.sites;
            const n = (s.match(/id IN \(([?,\s]*)\)/)?.[1].match(/\?/g) ?? []).length;
            const ids = args.slice(0, n || args.length).map(Number);
            const before = table.length;
            const kept = table.filter(r => !ids.includes(r.id));
            if (table === this.groups) this.groups = kept;
            else this.sites = kept;
            return { rows: [], changed: before - kept.length };
        }
        return { rows: [], changed: 0 };
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
        if (s.startsWith("SELECT state, status, body") && s.includes("idempotency_keys")) {
            const rec = this.idempotency.get(`${args[0]}|${args[1]}`);
            return rec ? [{ state: rec.state, status: null, body: null, created_at: 0, expires_at: rec.expiresAt }] : [];
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
                const out = self.run(sql, args);
                return { results: out.rows.length ? out.rows : self.select(sql, args), success: true };
            },
            async run() {
                const out = self.run(sql, args);
                return { success: true, results: out.rows, meta: { rows_written: out.changed } };
            },
        };
        return stmt;
    }

    async batch<T>(stmts: { _sql: string; _args?: unknown[] }[]): Promise<{ results: T[]; success: boolean }[]> {
        this.batchCalls++;
        this.batchSizes.push(stmts.length);
        if (stmts.length > this.maxBatchSize) throw new Error("恢复事务超过容量限制");
        const snapG = this.groups.map(r => ({ ...r }));
        const snapS = this.sites.map(r => ({ ...r }));
        const snapC = new Map(this.configs);
        try {
            return stmts.map(s => {
                const r = this.run(s._sql, s._args || []);
                return { results: r.rows as T[], success: true };
            });
        } catch (error) {
            this.groups = snapG;
            this.sites = snapS;
            this.configs = snapC;
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
        AUTH_SECRET: "test-secret-for-import",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
    api.setCurrentUser(uid);
    return api;
}

/** 造一个含 siteCount 个站点的大备份，站点名带序号方便定位 */
function makeBackup(siteCount: number): ExportData {
    return {
        groups: [{ id: 1, name: "大分组", order_num: 0 }],
        sites: Array.from({ length: siteCount }, (_, i) => ({
            id: 100 + i,
            group_id: 1,
            name: `站点${i}`,
            url: `https://s${i}.com`,
            icon: "",
            description: "",
            notes: "",
            username: "u",
            password: `pw-${i}`,
            order_num: i,
        })),
        configs: {},
        version: "1.3",
        exportDate: new Date().toISOString(),
    };
}

/**
 * 建表（migrate）自己也要发几个 batch —— 那是建库的开销，不该算进「这次导入提交了几次」。
 * 先跑完迁移再把计数器清零，观察到的才是导入本身的提交次数。
 */
async function prepared(db: MockD1, uid: number): Promise<NavigationAPI> {
    const api = apiWith(db, uid);
    await api.migrate();
    db.batchCalls = 0;
    db.batchSizes = [];
    return api;
}

function seed(db: MockD1): void {
    db.groups.push({ id: 5, group_id: 0, user_id: 2, name: "旧分组", order_num: 0 });
    db.sites.push({ id: 7, group_id: 5, user_id: 2, name: "旧站点", order_num: 0 });
}

// ============ 限并发：窗口真的生效，且顺序不乱 ============

test("mapWithConcurrency：同时在飞的数量不超过窗口，输出顺序与输入一致", async () => {
    const items = Array.from({ length: 32 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const progress: number[] = [];

    const out = await mapWithConcurrency(
        items,
        4,
        async item => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            // 让出一次事件循环，好让其它车道有机会并发起来（不 await 就测不出并发）
            await new Promise(resolve => setTimeout(resolve, 0));
            inFlight--;
            return item * 2;
        },
        done => progress.push(done)
    );

    assert.equal(peak, 4, `并发窗口应是 4，实际峰值 ${peak} —— 限并发没生效`);
    assert.deepEqual(out, items.map(i => i * 2), "输出顺序必须与输入一致");
    assert.equal(progress.length, items.length, "每条都要报一次进度");
    assert.equal(progress.at(-1), items.length);
});

test("mapWithConcurrency：窗口大于条目数时不白开车道，也不会卡死", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 64, async v => v + 1);
    assert.deepEqual(out, [2, 3, 4]);
    // limit 传 0 这种会永久挂住的值也要夹住
    const safe = await mapWithConcurrency([1], 0, async v => v);
    assert.deepEqual(safe, [1]);
});

test("批量加密：并发窗口 = ENCRYPT_CONCURRENCY，且每条都真的加密了", async () => {
    const db = new MockD1();
    const api = apiWith(db, 2);
    const drafts = Array.from({ length: ENCRYPT_CONCURRENCY * 2 }, (_, i) => ({
        id: i + 1,
        groupId: 1,
        name: `s${i}`,
        url: "https://x.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: `plain-${i}`,
        order_num: i,
    }));

    const seen: number[] = [];
    const out = await api.encryptSitePasswords(drafts, done => seen.push(done));

    assert.equal(out.length, drafts.length);
    assert.equal(seen.length, drafts.length, "每条都要报一次进度");
    // 加密后不再是明文，且能解开回原文（走的是同一套密钥环）
    assert.ok(out.every(s => s.password.startsWith("enc$")), "每条密码都应变成密文");
    const plain = await Promise.all(
        out.map((s, i) => decryptSecret(s.password, api.keyring).then(v => [v, `plain-${i}`] as const))
    );
    for (const [got, want] of plain) assert.equal(got, want, "解密后要回到原文明文");
});

// ============ 分块提交：小备份一个事务，大备份分块 ============

test("小备份：仍然一个事务切过去（分块不该把日常备份拆碎）", async () => {
    const db = new MockD1();
    seed(db);
    const api = await prepared(db, 2);
    const result = await api.importData(makeBackup(5));

    assert.equal(result.success, true);
    assert.equal(db.batchCalls, 1, `小备份应只提交一个事务，实际 ${db.batchCalls} 次`);
    assert.ok(db.batchSizes[0] <= COMMIT_CHUNK_STATEMENTS);
});

test("大备份：超过旧分块阈值仍原子提交，且数据一条不少", async () => {
    const siteCount = COMMIT_CHUNK_STATEMENTS; // 加分组 / 配置 / 删除语句后必然超过上限
    const db = new MockD1();
    seed(db);
    const api = await prepared(db, 2);

    const stages: string[] = [];
    const writes: number[] = [];
    const result = await api.importData(makeBackup(siteCount), {
        onProgress: p => {
            stages.push(p.stage);
            if (p.stage === "write") writes.push(p.done);
        },
    });

    assert.equal(result.success, true, "大备份也要能恢复成功");
    assert.equal(db.batchCalls, 1, "新旧数据必须在同一个事务内切换");
    assert.ok(db.batchSizes[0] > COMMIT_CHUNK_STATEMENTS, "超过旧分块阈值也不能拆开事务");
    assert.equal(db.sites.filter(s => s.name.startsWith("站点")).length, siteCount, "站点一条都不能少");
    assert.ok(!db.sites.some(s => s.name === "旧站点"), "旧数据该被清掉");

    // 进度：必须覆盖全部阶段，且 write 阶段的 done 单调推进到总数
    for (const stage of ["verify", "encrypt", "write", "cleanup", "done"]) {
        assert.ok(stages.includes(stage), `进度里缺 ${stage} 阶段`);
    }
    const lastWrite = writes.at(-1);
    assert.ok(typeof lastWrite === "number" && lastWrite > 0, "write 阶段要报出真实条数");
    for (let i = 1; i < writes.length; i++) {
        assert.ok(writes[i] >= writes[i - 1], "进度不能倒着走");
    }
    assert.equal(writes[0], 0, "write 阶段从 0 开始");
});

test("事务后段写入失败：旧数据完好、新数据整批撤销，保留失败原因", async () => {
    const siteCount = COMMIT_CHUNK_STATEMENTS;
    const db = new MockD1();
    seed(db);
    // 在事务后段注入失败，确认前段执行过的插入也被数据库撤销。
    db.failRules = [
        {
            when: /^INSERT INTO sites/,
            error: "模拟分块提交中途失败",
            args: a => String(a[2]) === `站点${COMMIT_CHUNK_STATEMENTS - 5}`,
        },
    ];

    const api = await prepared(db, 2);
    const result = await api.importData(makeBackup(siteCount));

    assert.equal(result.success, false, "中途失败必须报失败");
    assert.match(result.message ?? "", /模拟分块提交中途失败/, "必须保留数据库返回的失败原因");
    assert.equal(db.batchCalls, 1, "失败后不能另发按预分配 ID 删除的补偿事务");
    // 旧数据全程没被动过
    assert.ok(db.sites.some(s => s.id === 7 && s.name === "旧站点"), "旧站点必须还在");
    assert.ok(db.groups.some(g => g.id === 5), "旧分组必须还在");
    // 本次新建的行全部回滚掉（分块提交的那几块也要收干净）
    assert.ok(
        !db.sites.some(s => s.name.startsWith("站点")),
        `不该留下半截新数据，实际残留 ${db.sites.filter(s => s.name.startsWith("站点")).length} 条`
    );
});

test("服务端容量拒绝：不得分块重试，原有数据和配置完整保留", async () => {
    const db = new MockD1();
    seed(db);
    const api = await prepared(db, 2);
    db.configs.set("sentinel", "before");
    const before = { groups: structuredClone(db.groups), sites: structuredClone(db.sites), configs: [...db.configs] };
    db.maxBatchSize = 10;
    const result = await api.importData(makeBackup(20));
    assert.equal(result.success, false);
    assert.match(result.message ?? "", /容量限制/);
    assert.equal(db.batchCalls, 1);
    assert.deepEqual(db.groups, before.groups);
    assert.deepEqual(db.sites, before.sites);
    assert.deepEqual([...db.configs], before.configs);
});

test("恢复锁被占用：拒绝请求不得释放另一个请求的锁", async () => {
    const db = new MockD1();
    const api = await prepared(db, 2);
    assert.equal(await api.claimIdempotency("restore.lock", "u2", 120000), true);
    const result = await api.importData(makeBackup(1));
    assert.equal(result.success, false);
    assert.match(result.message ?? "", /上一次恢复/);
    assert.ok(db.idempotency.has("restore.lock|u2"));
    assert.equal(db.batchCalls, 0);
});
