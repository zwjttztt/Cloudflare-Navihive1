// tests/accounts.test.ts
// 多账号：注册（邀请码）、数据隔离、注销。
// 这里用一个「够用」的内存 D1 替身：只识别本功能真正用到的那些 SQL，
// 目的是把服务端的多账号规则钉死（谁能看到谁的数据、邀请码什么时候失效）。
import test from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI, resetMigrationCacheForTests } from "../src/API/http";

type Row = Record<string, unknown>;

interface Store {
    configs: Map<string, string>;
    users: Row[];
    invites: Row[];
    groups: Row[];
    sites: Row[];
}

function makeDb(store: Store) {
    let nextId = 1;
    const allocId = () => nextId++;

    const matchRows = (table: keyof Store, sql: string, args: unknown[]): Row[] => {
        const rows = store[table] as Row[];
        if (table === "users") {
            if (sql.includes("WHERE username = ?")) {
                return rows.filter(r => r.username === args[0]);
            }
            if (sql.includes("WHERE id = ?")) {
                return rows.filter(r => r.id === args[0]);
            }
            if (sql.includes("WHERE role = 'owner'")) {
                return rows.filter(r => r.role === "owner");
            }
            return rows;
        }
        if (table === "invites") {
            if (sql.includes("WHERE code = ?")) {
                return rows.filter(r => r.code === args[0]);
            }
            if (sql.includes("WHERE created_by = ?")) {
                return rows.filter(r => r.created_by === args[0]);
            }
            return rows;
        }
        // 数据隔离的关键：SQL 里带 user_id = ? 就只返回属于该账号的行
        const whereUser = sql.includes("user_id = ?");
        const whereId = sql.includes("WHERE id = ?");
        let list = rows;
        if (whereId) list = list.filter(r => r.id === args[0]);
        if (whereUser) {
            const uid = args[args.length - 1];
            list = list.filter(r => r.user_id === uid);
        }
        return list;
    };

    const isInsert = (sql: string) => /^\s*INSERT\s/i.test(sql);

    // D1 的 INSERT ... RETURNING 既可能用 first() 也可能用 all()，所以插入单独抽出来共用
    const doInsert = (sql: string, args: unknown[]): Row | null => {
        if (sql.includes("INSERT INTO configs")) {
            store.configs.set(args[0] as string, args[1] as string);
            return { key: args[0], value: args[1] };
        }
        if (sql.includes("INSERT INTO users")) {
            const username = args[0] as string;
            if (store.users.some(u => u.username === username)) {
                throw new Error("UNIQUE constraint failed: users.username");
            }
            const row: Row = {
                id: allocId(),
                username,
                password_hash: args[1],
                role: args[2] ?? "user",
                created_at: "now",
            };
            store.users.push(row);
            return row;
        }
        if (sql.includes("INSERT INTO invites")) {
            const [code, createdBy, createdAt, expiresAt] = args as [
                string,
                number,
                number,
                number,
            ];
            if (store.invites.some(i => i.code === code)) {
                throw new Error("UNIQUE constraint failed: invites.code");
            }
            const row: Row = {
                code,
                created_by: createdBy,
                created_at: createdAt,
                expires_at: expiresAt,
                used_by: null,
                used_at: null,
            };
            store.invites.push(row);
            return row;
        }
        if (sql.includes("INSERT INTO groups")) {
            const row: Row = {
                id: allocId(),
                name: args[0],
                order_num: args[1],
                user_id: args[2] ?? null,
            };
            store.groups.push(row);
            return row;
        }
        // audit_log 之类不需要回看的表
        return null;
    };

    const prepare = (sql: string) => {
        let args: unknown[] = [];
        const statement = {
            // 供 batch 判断该走 run() 还是 all()（D1 本身按语句类型自动决定）
            __sql: sql,
            bind(...values: unknown[]) {
                args = values;
                return statement;
            },
            async first<T = unknown>(): Promise<T | null> {
                if (isInsert(sql)) return doInsert(sql, args) as T;
                if (sql.includes("SELECT value FROM configs WHERE key = ?")) {
                    const v = store.configs.get(args[0] as string);
                    return (v === undefined ? null : { value: v }) as T;
                }
                for (const table of ["users", "invites", "groups", "sites"] as const) {
                    if (sql.includes(`FROM ${table}`)) {
                        const rows = matchRows(table, sql, args);
                        return (rows[0] ?? null) as T;
                    }
                }
                if (sql.includes("COUNT(*)")) {
                    return { total: matchRows("users", sql, args).length } as T;
                }
                return null;
            },
            async all<T = unknown>(): Promise<{ results?: T[]; success: boolean }> {
                if (isInsert(sql)) {
                    const row = doInsert(sql, args);
                    return { results: (row ? [row] : []) as T[], success: true };
                }
                if (sql.includes("SELECT key, value FROM configs")) {
                    return {
                        results: [...store.configs.entries()].map(([key, value]) => ({
                            key,
                            value,
                        })) as T[],
                        success: true,
                    };
                }
                for (const table of ["users", "invites", "groups", "sites"] as const) {
                    if (sql.includes(`FROM ${table}`)) {
                        return { results: matchRows(table, sql, args) as T[], success: true };
                    }
                }
                // pragma_table_info 返回空 → 让迁移走一遍 ALTER 分支
                return { results: [] as T[], success: true };
            },
            async run<T = unknown>(): Promise<{ success: boolean; meta?: { changes?: number } }> {
                if (isInsert(sql)) {
                    doInsert(sql, args);
                    return { success: true };
                }
                if (sql.includes("DELETE FROM configs")) {
                    store.configs.delete(args[0] as string);
                    return { success: true };
                }
                if (sql.includes("DELETE FROM users")) {
                    const before = store.users.length;
                    store.users = store.users.filter(u => u.id !== args[0]);
                    return { success: store.users.length < before };
                }
                if (sql.includes("DELETE FROM invites")) {
                    const before = store.invites.length;
                    store.invites = store.invites.filter(i => i.created_by !== args[0]);
                    return { success: store.invites.length < before };
                }
                if (sql.includes("UPDATE users SET password_hash")) {
                    const [hash, id] = args as [string, number];
                    const row = store.users.find(u => u.id === id);
                    if (row) row.password_hash = hash;
                    return { success: true };
                }
                if (sql.includes("UPDATE users SET username")) {
                    const [name, id] = args as [string, number];
                    const row = store.users.find(u => u.id === id);
                    if (row) row.username = name;
                    return { success: true };
                }
                if (sql.includes("UPDATE invites SET used_by")) {
                    const [usedBy, usedAt, code] = args as [number, number, string];
                    const row = store.invites.find(i => i.code === code && !i.used_at);
                    if (!row) return { success: true, meta: { changes: 0 } };
                    row.used_by = usedBy;
                    row.used_at = usedAt;
                    return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes("DELETE FROM groups")) {
                    const uid = args[args.length - 1];
                    store.groups = store.groups.filter(g => g.user_id !== uid);
                    return { success: true };
                }
                if (sql.includes("DELETE FROM sites")) {
                    const uid = args[args.length - 1];
                    store.sites = store.sites.filter(s => s.user_id !== uid);
                    return { success: true };
                }
                if (sql.includes("UPDATE groups SET user_id")) {
                    for (const g of store.groups) if (g.user_id === null) g.user_id = args[0];
                    return { success: true };
                }
                if (sql.includes("UPDATE sites SET user_id")) {
                    for (const s of store.sites) if (s.user_id === null) s.user_id = args[0];
                    return { success: true };
                }
                return { success: true };
            },
        };
        return statement;
    };

    return {
        prepare,
        async exec(_sql: string) {
            return { success: true };
        },
        async batch<T = unknown>(
            statements: Array<{
                __sql?: string;
                all(): Promise<{ results?: T[] }>;
                run(): Promise<{ success: boolean }>;
            }>
        ) {
            return Promise.all(
                statements.map(s =>
                    /^\s*(INSERT|UPDATE|DELETE)\s/i.test(s.__sql || "") ? s.run() : s.all()
                )
            );
        },
    };
}

function makeApi(store: Store) {
    return new NavigationAPI({
        DB: makeDb(store) as never,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    });
}

function freshStore(): Store {
    return {
        configs: new Map(),
        users: [],
        invites: [],
        groups: [],
        sites: [],
    };
}

test("首次访问把旧的单管理员凭据迁移成 users 表里的 owner", async () => {
    const store = freshStore();
    // 每个用例换一套全新的内存库，必须让下一条 migrate() 真的重跑一遍
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();

    assert.equal(store.users.length, 1);
    assert.equal(store.users[0].username, "root");
    assert.equal(store.users[0].role, "owner");
});

test("种子账号可以登录", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    const result = await api.login({ username: "root", password: "seed-password" });
    assert.equal(result.success, true);
    assert.equal(result.username, "root");
});

test("邀请码：30 分钟有效，用过一次就作废", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    const invite = await api.createInvite(ownerId);
    assert.equal(invite.success, true);
    assert.equal(invite.code?.length, 8);
    assert.equal(invite.ttlSeconds, 30 * 60);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok((invite.expiresAt ?? 0) - nowSec > 29 * 60);

    const first = await api.registerUser("alice", "password123", invite.code || "");
    assert.equal(first.success, true, first.message);
    assert.equal(first.user?.role, "user");

    // 同一枚码第二次注册必须被拒
    const second = await api.registerUser("bob", "password123", invite.code || "");
    assert.equal(second.success, false);
    assert.match(second.message, /已被使用/);
});

test("邀请码过期后不能再用", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    const invite = await api.createInvite(ownerId);
    // 把过期时间拨到过去
    const row = store.invites.find(i => i.code === invite.code);
    assert.ok(row);
    row.expires_at = Math.floor(Date.now() / 1000) - 1;

    const result = await api.registerUser("carol", "password123", invite.code || "");
    assert.equal(result.success, false);
    assert.match(result.message, /过期/);
});

test("没有邀请码 / 邀请码无效 / 账号名重复都注册不了", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    const invite = await api.createInvite(ownerId);

    assert.equal((await api.registerUser("dave", "password123", "")).success, false);
    assert.equal((await api.registerUser("dave", "password123", "NOPE1234")).success, false);
    // 密码太短
    assert.equal((await api.registerUser("dave", "123", invite.code || "")).success, false);
    // 与 owner 重名
    assert.equal((await api.registerUser("root", "password123", invite.code || "")).success, false);
});

test("数据隔离：A 账号看不到 B 账号的分组", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    api.setCurrentUser(ownerId);
    await api.createGroup({ name: "owner 的分组", order_num: 0 });

    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    const aliceId = registered.user?.id as number;

    // 新账号名下什么都没有
    api.setCurrentUser(aliceId);
    assert.equal((await api.getGroups()).length, 0);
    await api.createGroup({ name: "alice 的分组", order_num: 0 });
    assert.equal((await api.getGroups()).length, 1);

    // owner 仍然只看得到自己那一个
    api.setCurrentUser(ownerId);
    const ownerGroups = await api.getGroups();
    assert.equal(ownerGroups.length, 1);
    assert.equal(ownerGroups[0].name, "owner 的分组");
});

test("改密必须校验当前密码，改完旧密码失效", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    api.setCurrentUser(ownerId);

    const wrong = await api.updateCurrentCredentials("", "new-password", "错的密码");
    assert.equal(wrong.success, false);
    assert.match(wrong.message, /当前密码不正确/);

    const ok = await api.updateCurrentCredentials("", "new-password", "seed-password");
    assert.equal(ok.success, true, ok.message);
    assert.equal(await api.verifyPasswordOfUser(ownerId, "new-password"), true);
    assert.equal(await api.verifyPasswordOfUser(ownerId, "seed-password"), false);
});

test("注销账号：数据一起删除；最后一个 owner 不允许注销", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    api.setCurrentUser(ownerId);
    await api.createGroup({ name: "要被删掉的分组", order_num: 0 });

    // 只有一个 owner 时不给注销
    const denied = await api.deleteAccount(ownerId);
    assert.equal(denied.success, false);
    assert.match(denied.message, /最后一个管理员/);

    // 邀请一个新账号进来，再注销它
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    const aliceId = registered.user?.id as number;
    api.setCurrentUser(aliceId);
    await api.createGroup({ name: "alice 的分组", order_num: 0 });
    assert.equal(store.groups.length, 2);

    const removed = await api.deleteAccount(aliceId);
    assert.equal(removed.success, true, removed.message);
    assert.equal(store.users.some(u => u.id === aliceId), false);
    // 只剩 owner 的分组
    assert.equal(store.groups.length, 1);
    assert.equal(store.groups[0].name, "要被删掉的分组");
});
