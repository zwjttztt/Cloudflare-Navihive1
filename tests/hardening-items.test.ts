// tests/hardening-items.test.ts
// 本轮加固项（2/3/4/5/7/8/10/12）的回归测试，把「修过就别再破」钉死：
//   2  XFF 伪造绕过登录限速：默认不信任 X-Forwarded-For，只有显式 NAVIHIVE_TRUST_XFF=1 才读首段
//   3  恢复令牌接口加限速：computeLockAfterFailure 指数退避 + 按桶持久化
//   4  verifyJwt 钉死 alg/typ：alg=none / 非 HS256 / typ≠JWT 一律拒
//   5  getAccountSessionState 由 fail-open 改为 fail-closed（迁移跑完后 DB 异常按「不可用」拦）
//   7  审计日志可读写（owner 只读视图，倒序 + 过滤 + 分页）
//   8  删除站点/分组走软删除进回收站，可还原 / 彻底删除 / 清空
//   10 备份导入/上传请求体大小限制（Content-Length 超 10MB 拦下）
//   12 站点图标经 sanitizeIconUrl 清洗（挡 javascript:/data:text/html 等危险协议）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clientBucket,
    computeLockAfterFailure,
    readRecoverGuard,
    writeRecoverGuard,
    RECOVER_FREE_ATTEMPTS,
    RECOVER_BASE_LOCK_MS,
    RECOVER_MAX_LOCK_MS,
} from "../worker/loginGuard";
import { signJwt, verifyJwt } from "../src/API/crypto";
import { isBodyTooLarge, MAX_REQUEST_BODY_BYTES } from "../worker/util";
import { RETENTION_DAYS_MAX } from "../src/API/http";
import { NavigationAPI } from "../src/API/http";
import { validateSite } from "../worker/validate";

function b64url(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// ================= Item 2：XFF 不默认信任 =================
test("Item2：不信任 XFF 时，X-Forwarded-For 被忽略（无真实 IP 则共用 unknown 桶）", () => {
    const req = new Request("https://x.test/api/login", {
        headers: { "X-Forwarded-For": "1.2.3.4, 9.9.9.9" },
    });
    assert.equal(clientBucket(req, false), "unknown", "默认不信任 XFF，伪造不了来源桶");
});

test("Item2：显式信任 XFF 时，取 XFF 首段作为限速桶", () => {
    const req = new Request("https://x.test/api/login", {
        headers: { "X-Forwarded-For": "1.2.3.4, 9.9.9.9" },
    });
    assert.equal(clientBucket(req, true), "1.2.3.4");
});

test("Item2：CF-Connecting-IP 优先于 XFF（无论是否信任 XFF）", () => {
    const req = new Request("https://x.test/api/login", {
        headers: {
            "CF-Connecting-IP": "203.0.113.7",
            "X-Forwarded-For": "1.2.3.4",
        },
    });
    assert.equal(clientBucket(req, true), "203.0.113.7");
    assert.equal(clientBucket(req, false), "203.0.113.7");
});

// ================= Item 3：恢复令牌限速 =================
test("Item3：computeLockAfterFailure 前 freeAttempts 次不锁，之后指数退避并封顶", () => {
    assert.equal(
        computeLockAfterFailure(RECOVER_FREE_ATTEMPTS, RECOVER_FREE_ATTEMPTS, RECOVER_BASE_LOCK_MS, RECOVER_MAX_LOCK_MS),
        0,
        "免费次数内不锁"
    );
    assert.equal(
        computeLockAfterFailure(RECOVER_FREE_ATTEMPTS + 1, RECOVER_FREE_ATTEMPTS, RECOVER_BASE_LOCK_MS, RECOVER_MAX_LOCK_MS),
        RECOVER_BASE_LOCK_MS,
        "第 11 次起锁 1 分钟"
    );
    assert.equal(
        computeLockAfterFailure(RECOVER_FREE_ATTEMPTS + 2, RECOVER_FREE_ATTEMPTS, RECOVER_BASE_LOCK_MS, RECOVER_MAX_LOCK_MS),
        RECOVER_BASE_LOCK_MS * 2,
        "之后每次翻倍"
    );
    assert.equal(
        computeLockAfterFailure(RECOVER_FREE_ATTEMPTS + 10, RECOVER_FREE_ATTEMPTS, RECOVER_BASE_LOCK_MS, RECOVER_MAX_LOCK_MS),
        RECOVER_MAX_LOCK_MS,
        "封顶 30 分钟"
    );
});

test("Item3：恢复限速按桶持久化（read/writeRecoverGuard 往返且互不连坐）", async () => {
    const configs = new Map<string, string>();
    const api = {
        async getConfig(k: string) {
            return configs.has(k) ? (configs.get(k) as string) : null;
        },
        async setConfig(k: string, v: string) {
            configs.set(k, v);
            return true;
        },
    };
    const until = Date.now() + 60_000;
    await writeRecoverGuard(api as never, { count: 11, until }, "1.2.3.4");
    const mine = await readRecoverGuard(api as never, "1.2.3.4");
    assert.equal(mine.count, 11);
    assert.equal(mine.until, until);
    const other = await readRecoverGuard(api as never, "9.9.9.9");
    assert.equal(other.count, 0, "别人的失败不应累到本桶");
});

// ================= Item 4：verifyJwt 钉死 alg/typ =================
test("Item4：verifyJwt 拒绝 alg=none 的令牌（纵深防御钉死 HS256）", async () => {
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ username: "admin", tv: 1 })}.x`;
    const r = await verifyJwt(token, "secret", { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("Item4：verifyJwt 拒绝 typ 不是 JWT 的令牌", async () => {
    const token = `${b64url({ alg: "HS256", typ: "JWS" })}.${b64url({ username: "admin", tv: 1 })}.x`;
    const r = await verifyJwt(token, "secret", { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("Item4：verifyJwt 拒绝非 HS256 算法（如 RS256）", async () => {
    const token = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ username: "admin", tv: 1 })}.x`;
    const r = await verifyJwt(token, "secret", { tokenVersion: 1 });
    assert.equal(r.valid, false);
});

test("Item4：正常 HS256/JWT 头仍验签通过", async () => {
    const token = await signJwt({ username: "admin", tv: 1 }, "secret");
    const r = await verifyJwt(token, "secret", { tokenVersion: 1 });
    assert.equal(r.valid, true);
});

// ================= Item 10：请求体大小限制 =================
test("Item10：无 Content-Length 不拦", () => {
    const req = new Request("https://x.test/api/import", { method: "POST" });
    assert.equal(isBodyTooLarge(req), false);
});

test("Item10：等于 10MB 上限不拦，超过才拦", () => {
    const ok = new Request("https://x.test/api/import", {
        method: "POST",
        headers: { "content-length": String(MAX_REQUEST_BODY_BYTES) },
    });
    assert.equal(isBodyTooLarge(ok), false, "等于上限不视为过大");
    const big = new Request("https://x.test/api/import", {
        method: "POST",
        headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
    });
    assert.equal(isBodyTooLarge(big), true, "超过 10MB 必须拦下");
});

test("Item10：自定义上限生效", () => {
    const req = new Request("https://x.test/x", { method: "POST", headers: { "content-length": "100" } });
    assert.equal(isBodyTooLarge(req, 50), true);
    assert.equal(isBodyTooLarge(req, 200), false);
});

// ================= Item 12：站点图标清洗 =================
test("Item12：validateSite 的图标经 sanitizeIconUrl 清洗（危险协议清空、正常图标保留）", () => {
    const base = { name: "x", url: "https://a.com", group_id: 1, order_num: 1 };

    const a = validateSite({ ...base, icon: "data:text/html,<script>alert(1)</script>" } as never);
    assert.equal(a.valid, true);
    assert.equal(a.sanitizedData?.icon, "", "data:text/html 图标被清空（能过 new URL，但渲染有风险）");

    const b = validateSite({ ...base, icon: "https://cdn.com/a.png" } as never);
    assert.equal(b.sanitizedData?.icon, "https://cdn.com/a.png", "正常图标保留");

    const c = validateSite({ ...base, icon: "javascript:alert(1)" } as never);
    assert.equal(c.sanitizedData?.icon, "", "javascript: 图标被清空");

    const d = validateSite({ ...base, icon: "file:///etc/passwd" } as never);
    assert.equal(d.sanitizedData?.icon, "", "file: 图标被清空");
});

// ================= 内存版 D1（只撑起本文件要用到的几条查询） =================
type Row = Record<string, unknown>;

class InMemoryD1 {
    configs = new Map<string, string>();
    userConfigs = new Map<number, Map<string, string>>();
    sites: Row[] = [];
    groups: Row[] = [];
    users: Row[] = [];
    audit: Row[] = [];
    recycle: Row[] = [];
    /** 让账号状态查询的 users 查询抛出，模拟「迁移跑完后 DB 异常」 */
    throwOnUsersStatus = false;
    private seq: Record<string, number> = {
        configs: 1,
        user_configs: 1,
        sites: 1,
        groups: 1,
        users: 1,
        audit: 1,
        recycle: 1,
    };

    private next(table: string): number {
        return this.seq[table]++;
    }

    prepare(sql: string) {
        // make 是箭头函数，this 天然指向实例，不需要别名中转
        const make = (args: unknown[]) => ({
            _sql: sql,
            _args: args,
            bind: (...a: unknown[]) => make(a),
            first: async () => this.read(sql, args, "first"),
            all: async () => ({ results: this.read(sql, args, "all"), success: true }),
            run: async () => this.write(sql, args),
        });
        return make([]);
    }

    async batch(stmts: Array<{ run: () => Promise<unknown> }>): Promise<{ results: unknown[]; success: boolean }> {
        for (const s of stmts) await s.run();
        return { results: [], success: true };
    }

    async exec(): Promise<{ success: boolean }> {
        return { success: true };
    }

    private read(sql: string, args: unknown[], mode: "first" | "all"): unknown | unknown[] | null {
        if (/pragma_table_info/.test(sql)) {
            const table = args[0] as string;
            const cols: Record<string, string[]> = {
                sites: [
                    "id", "group_id", "name", "url", "icon", "description", "notes",
                    "username", "password", "order_num", "created_at", "updated_at", "user_id",
                ],
                groups: ["id", "name", "order_num", "created_at", "updated_at", "user_id"],
            };
            const rows = (cols[table] || []).map(name => ({ name }));
            return mode === "first" ? (rows[0] ?? null) : rows;
        }
        if (/SELECT "status" FROM users/.test(sql)) {
            if (this.throwOnUsersStatus) throw new Error("simulated DB error after migration");
            const id = args[0] as number;
            const row = this.users.find(u => u.id === id);
            return row ? { status: (row.status as string) ?? "active" } : null;
        }
        if (/SELECT id, username FROM users/.test(sql)) {
            const row = this.users[0];
            return row ? { id: row.id, username: row.username } : null;
        }
        if (/SELECT recovery_public_key FROM users/.test(sql)) {
            const id = args[0] as number;
            const row = this.users.find(u => u.id === id);
            return row ? { recovery_public_key: row.recovery_public_key ?? null } : null;
        }
        if (/SELECT \* FROM groups WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            return this.groups.find(g => g.id === id) ?? null;
        }
        if (/SELECT \* FROM sites WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            return this.sites.find(s => s.id === id) ?? null;
        }
        if (/SELECT \* FROM sites WHERE group_id = \?/.test(sql)) {
            const gid = args[0] as number;
            return this.sites.filter(s => s.group_id === gid);
        }
        if (/SELECT id, kind, data, deleted_at FROM recycle_bin/.test(sql)) {
            // 带账号上下文时是 owner_user_id = ?（args[0]）；无上下文时是 IS NULL（不带参数）
            const owner = args.length > 0 ? args[0] : null;
            const rows = this.recycle.filter(r =>
                owner === null
                    ? r.owner_user_id === null || r.owner_user_id === undefined
                    : r.owner_user_id === owner
            );
            return mode === "first" ? (rows[0] ?? null) : rows;
        }
        if (/SELECT kind, data FROM recycle_bin WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            const owner = args.length > 1 ? args[1] : null;
            const row = this.recycle.find(
                r =>
                    r.id === id &&
                    (owner === null
                        ? r.owner_user_id === null || r.owner_user_id === undefined
                        : r.owner_user_id === owner)
            );
            return row ? { kind: row.kind, data: row.data } : null;
        }
        if (/SELECT id, action, actor, ip, detail, created_at FROM audit_log/.test(sql)) {
            let rows = [...this.audit].sort((a, b) => (b.id as number) - (a.id as number));
            if (/WHERE actor = \?/.test(sql)) {
                const actor = String(args[0]);
                rows = rows.filter(r => r.actor === actor);
                const limit = args[1] as number;
                const offset = args[2] as number;
                return rows.slice(offset, offset + limit);
            }
            const limit = args[0] as number;
            const offset = args[1] as number;
            return rows.slice(offset, offset + limit);
        }
        if (/SELECT value FROM configs WHERE key = \?/.test(sql)) {
            const v = this.configs.get(String(args[0]));
            return v == null ? null : { value: v };
        }
        if (/SELECT key, value FROM configs/.test(sql)) {
            return [...this.configs.entries()].map(([key, value]) => ({ key, value }));
        }
        if (/SELECT value FROM user_configs WHERE user_id = \? AND key = \?/.test(sql)) {
            const uid = args[0] as number;
            const k = String(args[1]);
            const v = this.userConfigs.get(uid)?.get(k);
            return v == null ? null : { value: v };
        }
        if (/SELECT key, value FROM user_configs WHERE user_id = \?/.test(sql)) {
            const uid = args[0] as number;
            const m = this.userConfigs.get(uid);
            return m ? [...m.entries()].map(([key, value]) => ({ key, value })) : [];
        }
        return mode === "first" ? null : [];
    }

    private async write(sql: string, args: unknown[]): Promise<{ success: boolean; meta?: { last_row_id?: number } }> {
        if (/INSERT INTO configs/.test(sql)) {
            this.configs.set(String(args[0]), String(args[1]));
            return { success: true };
        }
        if (/INSERT INTO user_configs/.test(sql)) {
            const uid = args[0] as number;
            const k = String(args[1]);
            const v = String(args[2]);
            if (!this.userConfigs.has(uid)) this.userConfigs.set(uid, new Map());
            this.userConfigs.get(uid)!.set(k, v);
            return { success: true };
        }
        if (/INSERT INTO audit_log/.test(sql)) {
            const id = this.next("audit");
            this.audit.push({
                id,
                action: args[0],
                actor: args[1] ?? "",
                ip: args[2] ?? "",
                detail: args[3] ?? "",
                created_at: new Date().toISOString(),
            });
            return { success: true };
        }
        if (/INSERT INTO recycle_bin/.test(sql)) {
            const id = this.next("recycle");
            this.recycle.push({ id, kind: args[0], owner_user_id: args[1], data: args[2], deleted_at: args[3] });
            return { success: true, meta: { last_row_id: id } };
        }
        if (/INSERT OR REPLACE INTO sites/.test(sql)) {
            const m = sql.match(/INSERT OR REPLACE INTO sites \((.*?)\) VALUES/);
            const cols = m ? m[1].split(",").map(s => s.trim()) : [];
            const row: Row = {};
            cols.forEach((c, i) => (row[c] = args[i]));
            const idx = this.sites.findIndex(s => s.id === row.id);
            if (idx >= 0) this.sites[idx] = row;
            else this.sites.push(row);
            return { success: true };
        }
        if (/INSERT OR REPLACE INTO groups/.test(sql)) {
            const m = sql.match(/INSERT OR REPLACE INTO groups \((.*?)\) VALUES/);
            const cols = m ? m[1].split(",").map(s => s.trim()) : [];
            const row: Row = {};
            cols.forEach((c, i) => (row[c] = args[i]));
            const idx = this.groups.findIndex(g => g.id === row.id);
            if (idx >= 0) this.groups[idx] = row;
            else this.groups.push(row);
            return { success: true };
        }
        if (/DELETE FROM sites WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            this.sites = this.sites.filter(s => s.id !== id);
            return { success: true };
        }
        if (/DELETE FROM groups WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            this.groups = this.groups.filter(g => g.id !== id);
            return { success: true };
        }
        if (/DELETE FROM recycle_bin WHERE id = \?/.test(sql)) {
            const id = args[0] as number;
            this.recycle = this.recycle.filter(r => r.id !== id);
            return { success: true };
        }
        if (/DELETE FROM recycle_bin WHERE owner_user_id/.test(sql)) {
            // 只清 owner_user_id IS NULL 的（当前账号 = 系统/owner）
            this.recycle = this.recycle.filter(r => r.owner_user_id !== null && r.owner_user_id !== undefined);
            return { success: true };
        }
        // 保留期清理：回收站按 deleted_at（epoch 秒）判新旧
        if (/DELETE FROM recycle_bin WHERE deleted_at < \?/.test(sql)) {
            const cutoff = args[0] as number;
            const before = this.recycle.length;
            this.recycle = this.recycle.filter(r => Number(r.deleted_at) >= cutoff);
            return { success: true, meta: { changes: before - this.recycle.length } };
        }
        // 保留期清理：审计日志按 created_at 判新旧（SQL 里是 datetime('now','-N days')）
        if (/DELETE FROM audit_log WHERE created_at < datetime/.test(sql)) {
            const days = Number(sql.match(/'-(\d+) days'/)![1]);
            const cutoff = Date.now() - days * 24 * 3600 * 1000;
            const before = this.audit.length;
            this.audit = this.audit.filter(r => {
                const t = Date.parse(String(r.created_at).replace(" ", "T"));
                return Number.isNaN(t) ? true : t >= cutoff;
            });
            return { success: true, meta: { changes: before - this.audit.length } };
        }
        if (/SELECT role FROM users WHERE id = \?/.test(sql)) {
            const row = this.users.find(u => u.id === args[0]);
            return row ? { role: (row.role as string) ?? null } : null;
        }
        if (/UPDATE .* SET user_id = \? WHERE user_id IS NULL/.test(sql)) return { success: true };
        if (/UPDATE users SET recovery_public_key = \? WHERE id = \?/.test(sql)) return { success: true };
        // CREATE / ALTER / 其它写语句：迁移用，忽略即可
        return { success: true };
    }
}

function newApi(db: InMemoryD1): NavigationAPI {
    return new NavigationAPI({ DB: db } as never);
}

// ================= Item 5：账号状态 fail-closed =================
test("Item5：迁移未跑完（dbReady=false）时账号状态查询 fail-open，不锁死首请求", async () => {
    const db = new InMemoryD1();
    db.throwOnUsersStatus = true; // 模拟首请求时 users 表还没建好
    const api = newApi(db);
    const state = await api.getAccountSessionState(1);
    assert.equal(state, "active", "迁移未就绪时不应把整站挡在门外");
});

test("Item5：迁移跑完后（dbReady=true）账号状态查询 fail-closed，DB 异常按「不可用」拦", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    await api.migrate(); // 让 dbReady=true
    db.throwOnUsersStatus = true; // 迁移后若还出错，说明是真异常
    const state = await api.getAccountSessionState(1);
    assert.equal(state, "missing", "迁移后 DB 异常应 fail-closed，拦下被停用/清除的旧令牌");
});

// ================= Item 7：审计日志 =================
test("Item7：writeAudit 写入后 getAuditLog 能倒序读到", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    await api.writeAudit("login.success", "admin", "1.2.3.4", "登录成功");
    await api.writeAudit("password.reset", "admin", "1.2.3.4", "改密");
    const log = await api.getAuditLog();
    assert.equal(log.length, 2);
    assert.equal(log[0].action, "password.reset", "倒序：最新在前");
    assert.equal(log[1].action, "login.success");
    assert.equal(log[0].actor, "admin");
});

test("Item7：getAuditLog 支持按 actor 过滤与分页", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    await api.writeAudit("a", "alice", "1.1.1.1", "");
    await api.writeAudit("b", "bob", "2.2.2.2", "");
    await api.writeAudit("c", "alice", "1.1.1.1", "");
    const alice = await api.getAuditLog({ actor: "alice" });
    assert.equal(alice.length, 2, "按操作者过滤");
    const page = await api.getAuditLog({ limit: 1, offset: 0 });
    assert.equal(page.length, 1, "分页生效");
});

// ================= Item 8：回收站（软删除） =================
test("Item8：删除站点走软删除进回收站，且可还原", async () => {
    const db = new InMemoryD1();
    db.sites.push({
        id: 1,
        group_id: 1,
        name: "示例",
        url: "https://a.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "enc$x",
        order_num: 1,
    });
    const api = newApi(db);

    const del = await api.deleteSite(1);
    assert.equal(del.success, true);
    assert.equal(typeof del.recycleId, "number", "应返回回收站条目 id");
    assert.equal(db.sites.length, 0, "原表已移除");

    const list = await api.listRecycleBin();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, "site");
    assert.equal(list[0].id, del.recycleId);

    const ok = await api.restoreRecycleItem(del.recycleId as number);
    assert.equal(ok, true);
    assert.equal(db.sites.length, 1, "还原后回到原表");
    assert.equal((db.sites[0] as { name: string }).name, "示例");
    assert.equal((await api.listRecycleBin()).length, 0, "还原后该条移出回收站");
});

test("Item8：回收站可彻底删除（purge）与清空（empty）", async () => {
    const db = new InMemoryD1();
    db.sites.push({
        id: 1,
        group_id: 1,
        name: "s1",
        url: "https://a.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 1,
    });
    const api = newApi(db);

    const del = await api.deleteSite(1);
    assert.equal((await api.listRecycleBin()).length, 1);
    await api.purgeRecycleItem(del.recycleId as number);
    assert.equal((await api.listRecycleBin()).length, 0, "purge 后回收站为空且不可恢复");

    db.sites.push({
        id: 2,
        group_id: 1,
        name: "s2",
        url: "https://b.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 2,
    });
    await api.deleteSite(2);
    assert.equal((await api.listRecycleBin()).length, 1);
    await api.emptyRecycleBin();
    assert.equal((await api.listRecycleBin()).length, 0, "empty 后回收站清空");
});

test("Item8：删除分组软删除（含其站点），可整体还原", async () => {
    const db = new InMemoryD1();
    db.groups.push({ id: 5, name: "G", order_num: 1 });
    db.sites.push({
        id: 10,
        group_id: 5,
        name: "inG",
        url: "https://g.com",
        icon: "",
        description: "",
        notes: "",
        username: "",
        password: "",
        order_num: 1,
    });
    const api = newApi(db);

    const del = await api.deleteGroup(5);
    assert.equal(del.success, true);
    assert.equal(typeof del.recycleId, "number");
    assert.equal(db.groups.length, 0, "分组已从原表移除");

    const list = await api.listRecycleBin();
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, "group");
    assert.ok((list[0].name as string).includes("G"), "名称带出分组名");
    assert.ok((list[0].name as string).includes("1"), "名称带出卡片数");

    const ok = await api.restoreRecycleItem(del.recycleId as number);
    assert.equal(ok, true);
    assert.equal(db.groups.length, 1, "分组还原");
    assert.equal(db.sites.length, 1, "组内站点也还原");
});

// ================= 回收站还原必须保留归属（登录后才可见） =================
// 站点 / 分组是按 user_id 做账号隔离的（scopeSql）。还原时若漏掉 user_id，
// 插回去的行 user_id 为 NULL，会被 "user_id = ?" 过滤掉 —— 表现为「还原没反应」。
const aliceSite = {
    id: 1,
    group_id: 1,
    name: "示例",
    url: "https://a.com",
    icon: "",
    description: "",
    notes: "",
    username: "",
    password: "enc$x",
    order_num: 1,
    user_id: 7,
};

test("回收站还原站点后仍属于原账号（user_id 不能丢）", async () => {
    const db = new InMemoryD1();
    db.groups.push({ id: 1, name: "G", order_num: 1, user_id: 7 });
    db.sites.push({ ...aliceSite });
    const api = newApi(db);
    api.setCurrentUser(7);

    const del = await api.deleteSite(1);
    assert.equal(del.success, true);
    assert.equal(db.sites.length, 0, "原表已移除");

    const list = await api.listRecycleBin();
    assert.equal(list.length, 1, "本人能在回收站看到自己删的");

    const ok = await api.restoreRecycleItem(list[0].id);
    assert.equal(ok, true);
    assert.equal(db.sites.length, 1, "还原后回到原表");
    assert.equal(
        (db.sites[0] as { user_id: number | null }).user_id,
        7,
        "还原后 user_id 必须仍是原账号，否则会被账号作用域过滤掉"
    );
});

test("回收站还原分组后，分组与其卡片都仍属于原账号", async () => {
    const db = new InMemoryD1();
    db.groups.push({ id: 1, name: "G", order_num: 1, user_id: 7 });
    db.sites.push({ ...aliceSite });
    const api = newApi(db);
    api.setCurrentUser(7);

    const del = await api.deleteGroup(1);
    assert.equal(del.success, true);

    const list = await api.listRecycleBin();
    assert.equal(list[0].kind, "group");
    const ok = await api.restoreRecycleItem(list[0].id);
    assert.equal(ok, true);

    assert.equal(db.groups.length, 1, "分组还原");
    assert.equal(
        (db.groups[0] as { user_id: number | null }).user_id,
        7,
        "分组的 user_id 必须保留"
    );
    assert.equal(db.sites.length, 1, "组内卡片一并还原");
    assert.equal(
        (db.sites[0] as { user_id: number | null }).user_id,
        7,
        "卡片的 user_id 必须保留"
    );
});

test("回收站按账号隔离：看不到别人删的东西", async () => {
    const db = new InMemoryD1();
    db.sites.push({ ...aliceSite });
    const api = newApi(db);

    api.setCurrentUser(7);
    const del = await api.deleteSite(1);
    assert.equal(del.success, true);

    api.setCurrentUser(8);
    const other = await api.listRecycleBin();
    assert.equal(other.length, 0, "8 号账号不该看到 7 号删的东西");
    assert.equal(await api.restoreRecycleItem(del.recycleId as number), false, "也还原不了");
});

// ================= 7 天保留期：审计日志 / 回收站 =================
// 两处存的都是「事后补救」性质的东西，超期就该自动清掉，不然一直挂在界面上还占行数。
const DAY = 24 * 3600;

test("保留期：审计日志超过 7 天的会被清掉，7 天内的保留", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    const now = Date.now();
    db.audit.push(
        { id: 1, action: "login.success", actor: "a", ip: "1", detail: "", created_at: new Date(now - 2 * DAY * 1000).toISOString() },
        { id: 2, action: "login.success", actor: "a", ip: "1", detail: "", created_at: new Date(now - 8 * DAY * 1000).toISOString() },
    );

    const log = await api.getAuditLog({ limit: 50, offset: 0 });
    assert.equal(log.length, 1, "超过 7 天的那条应被清掉");
    assert.equal(log[0].id, 1, "留下的应是 2 天前的那条");
});

test("保留期：回收站超过 7 天的条目自动清除，还原不了", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    api.setCurrentUser(7);
    const nowSec = Math.floor(Date.now() / 1000);
    db.recycle.push(
        { id: 1, kind: "site", owner_user_id: 7, data: "{}", deleted_at: nowSec - 2 * DAY },
        { id: 2, kind: "site", owner_user_id: 7, data: "{}", deleted_at: nowSec - 9 * DAY },
    );

    const items = await api.listRecycleBin();
    assert.equal(items.length, 1, "超过 7 天的条目不该再出现在回收站");
    assert.equal(items[0].id, 1);
    assert.equal(await api.restoreRecycleItem(2), false, "已过期的条目不能还原");
});

test("保留期：cleanupExpiredRows 同时清审计与回收站并各自计数", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    const nowSec = Math.floor(Date.now() / 1000);
    db.audit.push({ id: 1, action: "x", actor: "", ip: "", detail: "", created_at: new Date(nowSec * 1000 - 30 * DAY * 1000).toISOString() });
    db.recycle.push({ id: 1, kind: "site", owner_user_id: null, data: "{}", deleted_at: nowSec - 30 * DAY });

    const counts = await api.cleanupExpiredRows();
    assert.equal(counts.audit, 1, "审计清掉 1 条");
    assert.equal(counts.recycle, 1, "回收站清掉 1 条");
});

test("保留期可按配置调整：改成 30 天后，8 天前的记录不再被清掉", async () => {
    const db = new InMemoryD1();
    db.configs.set("retention.days", "30");
    const api = newApi(db);
    const now = Date.now();
    db.audit.push({
        id: 1,
        action: "login.success",
        actor: "a",
        ip: "1",
        detail: "",
        created_at: new Date(now - 8 * DAY * 1000).toISOString(),
    });

    const log = await api.getAuditLog({ limit: 50, offset: 0 });
    assert.equal(log.length, 1, "保留期放宽到 30 天后，8 天前这条应当还在");
});

test("保留期配置越界时夹回上下界，不会把数据全删或永不清理", async () => {
    // 0 天 = 每次都把自己刚记的东西清掉；999 天则是让 D1 行数线性涨。两头都要夹住。
    const db = new InMemoryD1();
    db.configs.set("retention.days", "0");
    const api0 = newApi(db);
    const now = Date.now();
    db.audit.push({
        id: 1,
        action: "x",
        actor: "a",
        ip: "1",
        detail: "",
        created_at: new Date(now - 1 * 3600 * 1000).toISOString(),
    });
    assert.equal((await api0.getAuditLog({})).length, 1, "0 天被夹到 1 天，1 小时前的记录还在");

    // 上限：写 9999 会被夹到 RETENTION_DAYS_MAX，比它更早的记录照样清掉
    const db2 = new InMemoryD1();
    db2.configs.set("retention.days", "9999");
    const apiMax = newApi(db2);
    db2.audit.push({
        id: 1,
        action: "x",
        actor: "a",
        ip: "1",
        detail: "",
        created_at: new Date(now - (RETENTION_DAYS_MAX + 30) * DAY * 1000).toISOString(),
    });
    assert.equal(
        (await apiMax.getAuditLog({})).length,
        0,
        "写再大的数也只保留到上限，超上限的记录照清"
    );
});

// ================= 首次改密提示只约束种子管理员本人 =================
test("改密提示：新注册账号（role=user）不提示，种子管理员（owner）仍然提示", async () => {
    const db = new InMemoryD1();
    db.users.push({ id: 1, username: "admin", role: "owner" });
    db.users.push({ id: 2, username: "newbie", role: "user" });
    db.configs.set("auth.mustChangePassword", "1");
    const api = newApi(db);

    assert.equal(await api.mustChangePassword("user"), false, "新注册账号用的是自己设的密码，不该被牵连");
    assert.equal(await api.mustChangePassword("owner"), true, "种子管理员仍必须先改密");
});

test("改密提示：标志解除后谁都不再提示；查不到角色时维持要求改密", async () => {
    const db = new InMemoryD1();
    const api = newApi(db);
    db.configs.set("auth.mustChangePassword", "0");
    assert.equal(await api.mustChangePassword("owner"), false, "已经改过密就不再拦");

    db.configs.set("auth.mustChangePassword", "1");
    assert.equal(await api.mustChangePassword(null), true, "老式单管理员（没有角色上下文）维持原行为");
});
