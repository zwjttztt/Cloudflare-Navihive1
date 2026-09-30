// tests/inactiveAccounts.test.ts
// 长期未登录账号治理（沉睡治理）的回归测试。
//
// 覆盖四件事：
//   1. 时间轴推算（纯函数）—— 什么时候被停用 / 什么时候被清除；
//   2. 每周扫描 —— 超期停用、宽限期满清除、owner 永不被治理；
//   3. owner 手动豁免 —— 重新启用要顺带刷新活跃时间，否则转头又被判沉睡；
//   4. 被停用的账号不能再登录（软禁用必须真的拦得住）。
//
// MockD1 只实现这几条用到的语句，碰上别的 SQL 一律当空操作返回 ——
// 这样 login() 里的 migrate() 那堆建表 / 补列也能安全跑完。

import test from "node:test";
import assert from "node:assert/strict";

import { computeInactiveTimeline } from "../src/API/http";
import { NavigationAPI } from "../src/API/navigationApi";
import { hashPassword } from "../src/API/crypto";

const DAY = 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

interface UserRow {
    id: number;
    username: string;
    role: string;
    password_hash: string;
    status: string;
    last_active_at: number | null;
    disabled_at: number | null;
    created_at: string;
}

/** 只实现本次用到的语句；未知 SQL 一律 no-op（返回空结果，写操作返回成功） */
class MockD1 {
    users: UserRow[] = [];
    audit: string[] = [];

    constructor(users: UserRow[]) {
        this.users = users;
    }

    private normalize(sql: string): string {
        return sql.replace(/\s+/g, " ").trim();
    }

    /** 沉睡判定的锚点：有最后活跃就用它，没有就退回创建时间 */
    private anchor(row: UserRow): number {
        return row.last_active_at ?? Math.floor(new Date(row.created_at).getTime() / 1000);
    }

    private run(sql: string, args: unknown[]): unknown[] {
        const s = this.normalize(sql);

        // 表结构探测：一律认为列都齐了（省掉迁移分支）
        if (s.includes("pragma_table_info")) {
            return [
                { name: "id" },
                { name: "username" },
                { name: "role" },
                { name: "password_hash" },
                { name: "status" },
                { name: "last_active_at" },
                { name: "disabled_at" },
                { name: "created_at" },
            ];
        }

        // 审计日志
        if (s.startsWith("INSERT INTO audit_log")) {
            this.audit.push(String(args[0] ?? ""));
            return [];
        }

        // 登录：按账号名查（含 status）
        if (s.includes("FROM users WHERE username = ?")) {
            return this.users
                .filter(u => u.username === args[0])
                .map(u => ({
                    id: u.id,
                    username: u.username,
                    password_hash: u.password_hash,
                    role: u.role,
                    status: u.status,
                }));
        }

        // 列表：全量
        if (s.includes("FROM users ORDER BY id")) {
            return this.users.map(u => ({ ...u }));
        }

        // 扫描候选：active 且非 owner 且锚点早于阈值（arg0 = 阈值）
        if (s.includes("COALESCE(last_active_at") && s.trim().startsWith("SELECT")) {
            return this.users
                .filter(u => u.role !== "owner" && u.status === "active" && this.anchor(u) < args[0])
                .map(u => ({ id: u.id }));
        }

        // 扫描停用：同样条件（args: [now, 阈值]）
        if (s.includes("COALESCE(last_active_at") && s.trim().startsWith("UPDATE")) {
            const threshold = args[1] as number;
            const nowValue = args[0] as number;
            for (const u of this.users) {
                if (u.role !== "owner" && u.status === "active" && this.anchor(u) < threshold) {
                    u.status = "disabled";
                    u.disabled_at = nowValue;
                }
            }
            return [];
        }

        // 宽限期满待清除
        if (s.includes('"status" = \'disabled\'') && s.trim().startsWith("SELECT")) {
            return this.users
                .filter(
                    u =>
                        u.role !== "owner" &&
                        u.status === "disabled" &&
                        u.disabled_at !== null &&
                        u.disabled_at < args[0]
                )
                .map(u => ({ id: u.id }));
        }

        // 限频刷新活跃时间
        if (s.includes("last_active_at = ? WHERE id = ? AND")) {
            const nowValue = args[0] as number;
            const threshold = args[2] as number;
            for (const u of this.users) {
                if (u.id === args[1] && (u.last_active_at === null || u.last_active_at < threshold)) {
                    u.last_active_at = nowValue;
                }
            }
            return [];
        }
        if (s.includes("SET last_active_at = ? WHERE id = ?")) {
            for (const u of this.users) {
                if (u.id === args[1]) u.last_active_at = args[0] as number;
            }
            return [];
        }

        // 豁免：置 active + 清停用时间 + 刷新活跃时间
        if (s.includes('SET "status" = \'active\'')) {
            for (const u of this.users) {
                if (u.id === args[1]) {
                    u.status = "active";
                    u.disabled_at = null;
                    u.last_active_at = args[0] as number;
                }
            }
            return [];
        }
        // 手动停用
        if (s.includes('SET "status" = \'disabled\', disabled_at = ?')) {
            for (const u of this.users) {
                if (u.id === args[1]) {
                    u.status = "disabled";
                    u.disabled_at = args[0] as number;
                }
            }
            return [];
        }

        // 清除：删 users 那一条
        if (s.startsWith("DELETE FROM users WHERE id = ?")) {
            this.users = this.users.filter(u => u.id !== args[0]);
            return [];
        }

        // 按 id 查（权限判断用）
        if (s.includes("SELECT id, username, role FROM users WHERE id = ?")) {
            return this.users
                .filter(u => u.id === args[0])
                .map(u => ({ id: u.id, username: u.username, role: u.role }));
        }

        // 会话校验：按 id 只取状态（令牌验签通过后确认账号还在 / 没被停用）
        if (s.includes('SELECT "status" FROM users WHERE id = ?')) {
            return this.users.filter(u => u.id === args[0]).map(u => ({ status: u.status }));
        }

        // 其余（建表 / 补列 / 读写 configs / 删 user_configs·invites·sites·groups）一律 no-op
        return [];
    }

    prepare(sql: string) {
        const self = this;
        let args: unknown[] = [];
        const stmt = {
            bind(...a: unknown[]) {
                args = a;
                return stmt;
            },
            async first<T>(): Promise<T | null> {
                const rows = self.run(sql, args) as T[];
                return rows.length > 0 ? rows[0] : null;
            },
            async all<T>(): Promise<{ results: T[]; success: boolean }> {
                return { results: (self.run(sql, args) as T[]) ?? [], success: true };
            },
            async run() {
                self.run(sql, args);
                return { success: true };
            },
        };
        return stmt;
    }

    async batch(statements: { run: () => Promise<unknown> }[]): Promise<{ success: boolean }[]> {
        const out: { success: boolean }[] = [];
        for (const s of statements) {
            await s.run();
            out.push({ success: true });
        }
        return out;
    }

    async exec(sql: string): Promise<void> {
        this.run(sql, []);
    }
}

function makeUser(partial: Partial<UserRow> & { id: number; username: string }): UserRow {
    return {
        id: partial.id,
        username: partial.username,
        role: partial.role ?? "user",
        password_hash: partial.password_hash ?? "x",
        status: partial.status ?? "active",
        last_active_at: partial.last_active_at ?? null,
        disabled_at: partial.disabled_at ?? null,
        created_at: partial.created_at ?? new Date().toISOString(),
    };
}

function apiWith(users: UserRow[]) {
    const db = new MockD1(users);
    const api = new NavigationAPI({
        // @ts-expect-error 测试里用最小替身充当 D1
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret-for-inactive",
        AUTH_USERNAME: "admin",
        AUTH_PASSWORD: "admin-pw",
    });
    return { api, db };
}

// ---------- 1. 时间轴推算（纯函数） ----------

test("computeInactiveTimeline：active 按最后活跃推算停用时间", () => {
    const last = nowSec() - 30 * DAY;
    const tl = computeInactiveTimeline(
        { status: "active", lastActiveAt: last, disabledAt: null, createdAt: null },
        180,
        30
    );
    assert.equal(tl.willDisableAt, last + 180 * DAY);
    assert.equal(tl.willDeleteAt, null);
});

test("computeInactiveTimeline：从没活跃过就退回创建时间当锚点", () => {
    const created = nowSec() - 200 * DAY;
    const tl = computeInactiveTimeline(
        { status: "active", lastActiveAt: null, disabledAt: null, createdAt: created },
        180,
        30
    );
    assert.equal(tl.willDisableAt, created + 180 * DAY);
});

test("computeInactiveTimeline：disabled 按停用时间推算清除时间", () => {
    const disabledAt = nowSec() - 10 * DAY;
    const tl = computeInactiveTimeline(
        { status: "disabled", lastActiveAt: nowSec(), disabledAt, createdAt: null },
        180,
        30
    );
    assert.equal(tl.willDisableAt, null);
    assert.equal(tl.willDeleteAt, disabledAt + 30 * DAY);
});

test("computeInactiveTimeline：没有锚点就不给倒计时", () => {
    const tl = computeInactiveTimeline(
        { status: "active", lastActiveAt: null, disabledAt: null, createdAt: null },
        180,
        30
    );
    assert.equal(tl.willDisableAt, null);
    assert.equal(tl.willDeleteAt, null);
});

// ---------- 2. 每周扫描 ----------

test("sweepInactiveUsers：停用超期账号、清除宽限期满的，owner 与活跃账号不动", async () => {
    const now = nowSec();
    const { api, db } = apiWith([
        // owner 哪怕一年没来也不治理（否则站点可能无人可管）
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now - 400 * DAY }),
        // 200 天没来：超过 180 天阈值 -> 停用
        makeUser({ id: 2, username: "dormant", last_active_at: now - 200 * DAY }),
        // 昨天还来过：不动
        makeUser({ id: 3, username: "fresh", last_active_at: now - 1 * DAY }),
        // 已停用且停用超过 30 天宽限 -> 清除
        makeUser({
            id: 4,
            username: "expired",
            status: "disabled",
            disabled_at: now - 40 * DAY,
            last_active_at: now - 300 * DAY,
        }),
    ]);

    const result = await api.sweepInactiveUsers();
    assert.equal(result.disabled, 1, "只该停用 dormant 一个");
    assert.equal(result.deleted, 1, "只该清除 expired 一个");

    const byId = new Map(db.users.map(u => [u.id, u]));
    assert.equal(byId.get(1)!.status, "active", "owner 不受治理");
    assert.equal(byId.get(2)!.status, "disabled", "dormant 已停用");
    assert.ok(byId.get(2)!.disabled_at !== null, "停用时间要记下来，清除倒计时靠它");
    assert.equal(byId.get(3)!.status, "active", "刚活跃的账号不动");
    assert.equal(byId.has(4), false, "宽限期满的已清除");
});

test("sweepInactiveUsers：刚停用、还在宽限期内的不会被清除", async () => {
    const now = nowSec();
    const { api, db } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now - 400 * DAY }),
        makeUser({
            id: 5,
            username: "just-disabled",
            status: "disabled",
            disabled_at: now - 3 * DAY,
        }),
    ]);
    const result = await api.sweepInactiveUsers();
    assert.equal(result.deleted, 0);
    assert.equal(db.users.length, 2, "宽限期内必须还在");
});

// ---------- 3. owner 手动豁免 ----------

test("setUserStatus：豁免会清停用时间并把活跃时间刷成现在", async () => {
    const now = nowSec();
    const { api, db } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now }),
        makeUser({
            id: 2,
            username: "dormant",
            status: "disabled",
            disabled_at: now - 50 * DAY,
            last_active_at: now - 300 * DAY,
        }),
    ]);

    const result = await api.setUserStatus(2, "active", 1);
    assert.equal(result.success, true);

    const target = db.users.find(u => u.id === 2)!;
    assert.equal(target.status, "active");
    assert.equal(target.disabled_at, null);
    assert.ok(
        target.last_active_at !== null && target.last_active_at >= now - 5,
        "豁免必须顺带刷新活跃时间，否则转头又被判沉睡"
    );
});

test("setUserStatus：非 owner 无权改别人状态", async () => {
    const now = nowSec();
    const { api } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner" }),
        makeUser({ id: 2, username: "alice", role: "user", last_active_at: now }),
        makeUser({ id: 3, username: "bob", role: "user", last_active_at: now }),
    ]);
    const result = await api.setUserStatus(3, "disabled", 2);
    assert.equal(result.success, false);
    assert.match(result.message || "", /所有者/);
});

// ---------- 4. 活跃时间刷新 ----------

test("touchLastActive：一天内只写一次（限频），过期才刷新", async () => {
    const now = nowSec();
    const { api, db } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now - 3600 }),
    ]);

    await api.touchLastActive(1);
    const first = db.users[0].last_active_at!;
    assert.equal(first, now - 3600, "刚活跃过（1 小时内）不该被改写");

    db.users[0].last_active_at = now - 2 * DAY;
    await api.touchLastActive(1);
    assert.ok(db.users[0].last_active_at! >= now - 5, "超过一天就该刷新");
});

test("touchLastActive：从没活跃过的账号会被立刻刷新", async () => {
    const now = nowSec();
    const { api, db } = apiWith([makeUser({ id: 7, username: "newbie", last_active_at: null })]);
    await api.touchLastActive(7);
    assert.ok(db.users[0].last_active_at! >= now - 5);
});

// ---------- 5. 被停用的账号不能登录 ----------

test("login：被停用的账号即使密码正确也进不来", async () => {
    const now = nowSec();
    const hash = await hashPassword("correct-pw");
    const { api } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now }),
        makeUser({
            id: 2,
            username: "dormant",
            password_hash: hash,
            status: "disabled",
            disabled_at: now - 40 * DAY,
            last_active_at: now - 300 * DAY,
        }),
    ]);

    const result = await api.login({ username: "dormant", password: "correct-pw", remember: false });
    assert.equal(result.success, false);
    assert.match(result.message || "", /停用/);
});

// ---------- 6. 老会话：账号被停用 / 被清除之后，手里的令牌必须立刻作废 ----------
// 令牌是自包含的，账号没了它不会跟着失效（「记住我」能活 30 天）。
// 只验签就放行的话：停用形同虚设，被清除的账号还能继续写库、留下孤儿数据。

test("会话校验：正常账号放行", async () => {
    const { api } = apiWith([makeUser({ id: 1, username: "owner", role: "owner" })]);
    assert.equal(await api.getAccountSessionState(1), "active");
});

test("会话校验：已被停用的账号 → disabled", async () => {
    const { api } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner" }),
        makeUser({ id: 2, username: "dormant", status: "disabled", disabled_at: nowSec() }),
    ]);
    assert.equal(await api.getAccountSessionState(2), "disabled");
});

test("会话校验：账号已不存在 → missing（老令牌不能再写库）", async () => {
    const { api } = apiWith([makeUser({ id: 1, username: "owner", role: "owner" })]);
    assert.equal(await api.getAccountSessionState(999), "missing");
});

test("会话校验：沉睡治理清除账号后立刻变 missing（缓存跟着翻）", async () => {
    const now = nowSec();
    const { api } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner", last_active_at: now }),
        makeUser({
            id: 2,
            username: "gone",
            status: "disabled",
            disabled_at: now - 40 * DAY, // 超过 30 天宽限期
            last_active_at: now - 400 * DAY,
        }),
    ]);
    // 先读一次把结论写进缓存，确认缓存不会把「已清除」捂住
    assert.equal(await api.getAccountSessionState(2), "disabled");
    const result = await api.sweepInactiveUsers();
    assert.equal(result.deleted, 1, "宽限期满应被清除");
    assert.equal(await api.getAccountSessionState(2), "missing");
});

test("会话校验：重新启用后缓存失效，立刻恢复放行", async () => {
    const now = nowSec();
    const { api } = apiWith([
        makeUser({ id: 1, username: "owner", role: "owner" }),
        makeUser({ id: 2, username: "dormant", status: "disabled", disabled_at: now }),
    ]);
    assert.equal(await api.getAccountSessionState(2), "disabled");
    const ok = await api.setUserStatus(2, "active", 1);
    assert.equal(ok.success, true, ok.message);
    assert.equal(await api.getAccountSessionState(2), "active", "重新启用后不该再被挡在门外");
});
