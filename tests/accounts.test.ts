// tests/accounts.test.ts
// 多账号：注册（邀请码）、数据隔离、注销、按账号隔离的恢复密钥。
// 这里用一个「够用」的内存 D1 替身：只识别本功能真正用到的那些 SQL，
// 目的是把服务端的多账号规则钉死（谁能看到谁的数据、邀请码什么时候失效）。
import test from "node:test";
import assert from "node:assert/strict";
import { NavigationAPI, resetMigrationCacheForTests } from "../src/API/http";
import { hashPassword } from "../src/API/crypto";

type Row = Record<string, unknown>;

interface Store {
    configs: Map<string, string>;
    users: Row[];
    invites: Row[];
    groups: Row[];
    sites: Row[];
    /** 每个账号一份的配置（WebDAV 备份那一整套） */
    userConfigs: Row[];
}

function makeDb(store: Store) {
    let nextId = 1;
    const allocId = () => nextId++;

    const matchRows = (table: string, sql: string, args: unknown[]): Row[] => {
        // user_configs 是「账号 + 键」双主键，键名单独过滤（getConfig 会带 AND key = ?）
        if (table === "user_configs") {
            let list = store.userConfigs;
            if (sql.includes("WHERE user_id = ?")) {
                list = list.filter(r => r.user_id === args[0]);
            }
            if (sql.includes("AND key = ?")) {
                list = list.filter(r => r.key === args[1]);
            }
            return list;
        }
        const rows = store[table as keyof Store] as Row[];
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
                // 沉睡治理用：新账号默认可用
                status: "active",
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
        if (sql.includes("INSERT INTO sites")) {
            const row: Row = {
                id: allocId(),
                group_id: args[0],
                name: args[1],
                url: args[2],
                icon: args[3] ?? "",
                description: args[4] ?? "",
                notes: args[5] ?? "",
                username: args[6] ?? "",
                password: args[7] ?? "",
                order_num: args[8],
                user_id: args[9] ?? null,
            };
            store.sites.push(row);
            return row;
        }
        if (sql.includes("INSERT INTO user_configs")) {
            const [userId, key, value] = args as [number, string, string];
            const exist = store.userConfigs.find(
                r => r.user_id === userId && r.key === key
            );
            if (exist) {
                // ON CONFLICT DO NOTHING：保留已有值；DO UPDATE：覆盖
                if (!sql.includes("DO NOTHING")) exist.value = value;
                return exist;
            }
            const row: Row = { user_id: userId, key, value };
            store.userConfigs.push(row);
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
                for (const table of ["users", "invites", "groups", "sites", "user_configs"] as const) {
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
                    const all = [...store.configs.entries()].map(([key, value]) => ({
                        key,
                        value,
                    }));
                    // 迁移里按前缀挑 WebDAV 那批：LIKE 'webdav.%'
                    const like = sql.includes("key LIKE ?");
                    const rows = like
                        ? all.filter(r => r.key.startsWith(String(args[0] || "").replace(/%/g, "")))
                        : all;
                    return { results: rows as T[], success: true };
                }
                for (const table of ["users", "invites", "groups", "sites", "user_configs"] as const) {
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
                if (sql.includes("DELETE FROM user_configs")) {
                    const [userId, key] = args as [number, string | undefined];
                    store.userConfigs = store.userConfigs.filter(
                        r => r.user_id !== userId || (key !== undefined && r.key !== key)
                    );
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
                if (sql.includes("UPDATE users SET token_version")) {
                    const [version, id] = args as [number, number];
                    const row = store.users.find(u => u.id === id);
                    if (row) row.token_version = version;
                    return { success: true };
                }
                // 站点排序 / 跨组移动：UPDATE sites SET ... WHERE id = ? [AND user_id = ?]
                if (sql.includes("UPDATE sites SET")) {
                    // 参数顺序见 updateSiteOrder：[...字段, id]（+ 末尾的 user_id）
                    const id = args[args.length - (sql.includes("user_id = ?") ? 2 : 1)];
                    const row = store.sites.find(s => s.id === id);
                    if (row) {
                        if (sql.includes("order_num = ?")) row.order_num = args[0];
                        if (sql.includes("group_id = ?")) {
                            const groupIdx = sql.indexOf("group_id = ?");
                            const argIdx =
                                sql.slice(0, groupIdx).split("?").length - 1;
                            row.group_id = args[argIdx];
                        }
                    }
                    return { success: true };
                }
                if (sql.includes("UPDATE users SET recovery_public_key")) {
                    const [value, id] = args as [string, number];
                    const row = store.users.find(u => u.id === id);
                    if (row) row.recovery_public_key = value;
                    return { success: true };
                }
                if (sql.includes('UPDATE users SET "status"')) {
                    // 状态是 SQL 里的字面量；只有 id 走 bind（见 bind 顺序：last_active_at, id）
                    const next = sql.includes("= 'active'") ? "active" : "disabled";
                    const id = args[args.length - 1] as number;
                    const row = store.users.find(u => u.id === id);
                    if (row) {
                        row.status = next;
                        if (next === "active") row.disabled_at = null;
                    }
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
        userConfigs: [],
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

    // 新账号看不到 owner 的分组，但自带一套默认分组（见下一条用例）
    api.setCurrentUser(aliceId);
    const aliceGroups = await api.getGroups();
    assert.ok(aliceGroups.length > 0, "新账号自带默认分组");
    assert.equal(
        aliceGroups.some(g => g.name === "owner 的分组"),
        false,
        "绝不能看到别人的分组"
    );
    await api.createGroup({ name: "alice 的分组", order_num: 0 });
    assert.equal((await api.getGroups()).length, aliceGroups.length + 1);

    // owner 仍然只看得到自己那一个
    api.setCurrentUser(ownerId);
    const ownerGroups = await api.getGroups();
    assert.equal(ownerGroups.length, 1);
    assert.equal(ownerGroups[0].name, "owner 的分组");
});

test("新注册的账号自带几个默认分组和示例卡片，全部挂在自己名下", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    const aliceId = registered.user?.id as number;

    api.setCurrentUser(aliceId);
    const groups = await api.getGroups();
    const sites = await api.getSites();

    assert.ok(groups.length >= 3, `新账号应该有几个默认分组，实际 ${groups.length}`);
    assert.ok(sites.length > 0, "默认分组里要有示例卡片，不能是空壳");
    // 每张卡片都得挂在 alice 自己的分组下
    const ownGroupIds = new Set(groups.map(g => g.id));
    assert.ok(sites.every(s => ownGroupIds.has(s.group_id)));
    assert.equal(store.groups.filter(g => g.user_id === aliceId).length, groups.length);

    // owner 那边不受影响（老账号不该被塞一份默认数据）
    api.setCurrentUser(ownerId);
    assert.equal((await api.getGroups()).length, 0);
});

test("恢复公钥按账号隔离：老的全局公钥搬给 owner，新账号显示未配置", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    // 升级前：整站只有一份公钥
    store.configs.set("recovery.publicKey", "legacy-pub-key");
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    api.setCurrentUser(ownerId);
    assert.equal(await api.hasRecoveryKey(), true, "owner 接手升级前那把公钥");
    assert.equal(await api.getRecoveryPublicKey(), "legacy-pub-key");
    assert.equal(
        store.configs.has("recovery.publicKey"),
        false,
        "搬完必须删掉全局那份，否则新账号会显示成「已配置」"
    );

    // 新账号不该看到别人配的密钥
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    api.setCurrentUser(registered.user?.id as number);
    assert.equal(await api.hasRecoveryKey(), false);
    assert.equal(await api.getRecoveryPublicKey(), "");
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

// ============ 以下四条守的是同一轮加固里改动的服务端行为 ============

test("改密后 configs 里那份旧凭据必须作废（否则改名前的种子账号名是永久后门）", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    api.setCurrentUser(ownerId);
    assert.equal(store.configs.has("auth.username"), true, "升级后旧凭据仍躺在 configs 里");

    await api.updateCurrentCredentials("", "BrandNew2026", "seed-password");

    assert.equal(
        store.configs.has("auth.password"),
        false,
        "改完密码必须把 configs 那份删掉：它不会跟着一起改"
    );
    assert.equal(store.configs.has("auth.username"), false);
});

test("改名后，旧账号名 + 旧密码不能再登进来（users 表有账号时禁止回落到 configs）", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    api.setCurrentUser(ownerId);

    // owner 把账号名改掉：users 表跟着改，configs 里那份（迁移残留）不会动
    const renamed = await api.updateCurrentCredentials("keeper", "", "seed-password");
    assert.equal(renamed.success, true, renamed.message);
    store.configs.set("auth.username", "root");
    store.configs.set("auth.password", await hashPassword("seed-password"));

    // 关键：回落那条路径签的令牌不带 uid，一旦放行就是「看得到全站数据」的万能令牌
    const intruder = await api.login({ username: "root", password: "seed-password" });
    assert.equal(intruder.success, false, "旧凭据回落必须堵死");
    // 补一道：即便有人设法签出来，缺 uid 的令牌也不该再签发
    const legit = await api.login({ username: "keeper", password: "seed-password" });
    assert.equal(legit.success, true, legit.message);
    assert.equal(legit.token ? typeof JSON.parse(atob(legit.token.split(".")[1])).uid : "缺失", "number");
});

test("令牌版本按账号走：A 改密不该把 B 的会话踢掉", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    api.setCurrentUser(ownerId);

    const invite = await api.createInvite(ownerId);
    const bob = await api.registerUser("bob", "password123", invite.code || "");
    const bobId = bob.user?.id as number;

    // 两人各自登录，拿到带着自己 uid 的令牌
    api.setCurrentUser(null);
    const ownerApi = makeApi(store);
    ownerApi.setCurrentUser(ownerId);
    const ownerLogin = await makeApi(store).login({ username: "root", password: "seed-password" });
    const bobLogin = await makeApi(store).login({ username: "bob", password: "password123" });
    assert.equal(ownerLogin.success, true);
    assert.equal(bobLogin.success, true);

    // owner 改自己的密码
    api.setCurrentUser(ownerId);
    const changed = await api.updateCurrentCredentials("", "OwnerNew2026", "seed-password");
    assert.equal(changed.success, true, changed.message);

    // owner 的旧令牌必须失效，bob 的仍然有效
    const api2 = makeApi(store);
    assert.equal((await api2.verifyToken(ownerLogin.token as string)).valid, false, "改密者本人应登出");
    assert.equal((await api2.verifyToken(bobLogin.token as string)).valid, true, "别人不该被连坐");
});

test("全站配置只有 owner 能写；每账号自己的 webdav.* 不受限制", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    const invite = await api.createInvite(ownerId);
    const bob = await api.registerUser("bob", "password123", invite.code || "");
    const bobId = bob.user?.id as number;

    // owner：全站标题能改
    api.setCurrentUser(ownerId);
    assert.equal(await api.setConfig("site.title", "我的导航"), true);

    // 普通账号：全站配置不能再写（过去只靠前端藏入口）
    api.setCurrentUser(bobId);
    assert.equal(await api.setConfig("site.title", "被劫持的标题"), false);
    assert.equal(await api.setConfigs({ "site.title": "批量也不行" }), false);
    assert.equal(await api.deleteConfig("site.title"), false);
    assert.equal(store.configs.get("site.title"), "我的导航", "原值必须纹丝不动");

    // 但按账号隔离的那批（自己的网盘配置）要照常能写
    assert.equal(await api.setConfig("webdav.url", "https://dav.bob.example/dav/"), true);
});

test("卡片跨组移动不能塞进别人的分组", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    const invite = await api.createInvite(ownerId);
    const bob = await api.registerUser("bob", "password123", invite.code || "");
    const bobId = bob.user?.id as number;

    // owner 的分组 + 卡片
    store.groups.push({ id: 9001, name: "owner 分组", order_num: 1, user_id: ownerId });
    store.sites.push({
        id: 8001,
        group_id: 9001,
        name: "我的卡片",
        url: "https://a.example",
        order_num: 1,
        user_id: ownerId,
    });
    // bob 的分组：owner 拖拽时若被传进来，就是越界移动
    store.groups.push({ id: 9002, name: "bob 分组", order_num: 1, user_id: bobId });

    api.setCurrentUser(ownerId);
    await api.updateSiteOrder([{ id: 8001, order_num: 2, group_id: 9002 }]);

    const moved = store.sites.find(s => s.id === 8001) as Row;
    assert.equal(moved.group_id, 9001, "目标分组不属于自己 → 只排序、不换组");
    assert.equal(moved.order_num, 2, "排序照常生效");
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
    const aliceGroups = store.groups.filter(g => g.user_id === aliceId).length;
    assert.ok(aliceGroups > 0, "alice 名下应该有分组（默认数据 + 刚建的）");

    const removed = await api.deleteAccount(aliceId);
    assert.equal(removed.success, true, removed.message);
    assert.equal(store.users.some(u => u.id === aliceId), false);
    // alice 的分组（含注册时送的默认分组）一个都不留
    assert.equal(store.groups.filter(g => g.user_id === aliceId).length, 0);
    assert.equal(store.sites.filter(s => s.user_id === aliceId).length, 0);
    // 只剩 owner 的分组
    assert.equal(store.groups.length, 1);
    assert.equal(store.groups[0].name, "要被删掉的分组");
});

test("WebDAV 备份配置按账号隔离：新账号看不到别人填的网盘地址与密码", async () => {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    // owner 配了自己的网盘（地址 / 账号 / 口令 / 备份目录）
    api.setCurrentUser(ownerId);
    await api.setConfig("webdav.url", "https://dav.example.com/owner");
    await api.setConfig("webdav.username", "owner-user");
    await api.setConfig("webdav.password", "owner-secret");
    await api.setConfig("webdav.path", "owner-backup");

    const ownerAll = await api.getConfigs();
    assert.equal(ownerAll["webdav.url"], "https://dav.example.com/owner");
    assert.equal(ownerAll["webdav.password"], "owner-secret");
    assert.equal(ownerAll["webdav.path"], "owner-backup");

    // 新注册的账号：一个 WebDAV 键都不该带过来（前端会回落到默认的 navihive-backup）
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    const aliceId = registered.user?.id as number;
    api.setCurrentUser(aliceId);

    const aliceAll = await api.getConfigs();
    for (const key of Object.keys(aliceAll)) {
        assert.ok(!key.startsWith("webdav."), `新账号不该看到 ${key}`);
    }
    assert.equal(await api.getConfig("webdav.url"), null);
    assert.equal(await api.getConfig("webdav.password"), null);
    assert.equal(await api.getConfig("webdav.path"), null);

    // 各自保存后互不影响
    await api.setConfig("webdav.url", "https://dav.example.com/alice");
    assert.equal(
        (await api.getConfigs())["webdav.url"],
        "https://dav.example.com/alice",
        "alice 应该读到自己那一份"
    );
    api.setCurrentUser(ownerId);
    assert.equal(
        await api.getConfig("webdav.url"),
        "https://dav.example.com/owner",
        "owner 的网盘地址不该被 alice 覆盖"
    );

    // 清空口令走 deleteConfig，也要只删自己那份
    api.setCurrentUser(aliceId);
    await api.deleteConfig("webdav.password");
    api.setCurrentUser(ownerId);
    assert.equal(await api.getConfig("webdav.password"), "owner-secret");
});

test("升级：全站那份 WebDAV 配置自动搬给 owner，且不留全局副本", async () => {
    const store = freshStore();
    // 模拟老部署：WebDAV 配置还躺在全站 configs 里
    store.configs.set("webdav.url", "https://dav.example.com/legacy");
    store.configs.set("webdav.password", "legacy-secret");
    store.configs.set("site.title", "全站共享的标题");

    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;

    // 全局那份被搬走后删掉：否则新账号会把它当「默认网盘」
    assert.equal(store.configs.has("webdav.url"), false);
    assert.equal(store.configs.has("webdav.password"), false);
    // 全站共享的配置不受影响
    assert.equal(store.configs.get("site.title"), "全站共享的标题");

    // 搬进 owner 自己的那份
    api.setCurrentUser(ownerId);
    assert.equal(await api.getConfig("webdav.url"), "https://dav.example.com/legacy");
    assert.equal(await api.getConfig("webdav.password"), "legacy-secret");

    // 新账号依然是干净的
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("bob", "password123", invite.code || "");
    api.setCurrentUser(registered.user?.id as number);
    assert.equal(await api.getConfig("webdav.url"), null);
});

// ---- 恢复密钥：凭私钥找回（账号名可以一起改，也可以干脆不填） ----
// 找回的前提只有一条：手里握着对应的私钥。账号名只是「顺便」能改的东西，
// 所以下面几条守的是「忘了账号名也能找回」和「改名不能占别人的名字」。

const enc = new TextEncoder();

function b64urlBytes(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** 造一对恢复密钥：公钥 SPKI（交给服务器）、私钥 PKCS8（留在本地签名用） */
async function newRecoveryKeypair() {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const pub = b64urlBytes(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
    const privBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const privKey = await crypto.subtle.importKey("pkcs8", privBytes, { name: "Ed25519" }, false, [
        "sign",
    ]);
    return { pub, privKey };
}

/** 本地签一张恢复令牌（JWS compact），与前端 signRecoveryToken 同格式 */
async function signRecoveryJws(
    privKey: CryptoKey,
    payload: Record<string, unknown>
): Promise<string> {
    const header = b64urlBytes(enc.encode(JSON.stringify({ alg: "EdDSA", typ: "JWS" })));
    const body = b64urlBytes(enc.encode(JSON.stringify(payload)));
    const sig = new Uint8Array(
        await crypto.subtle.sign(
            { name: "Ed25519" } as unknown as Parameters<SubtleCrypto["sign"]>[0],
            privKey,
            enc.encode(header + "." + body)
        )
    );
    return header + "." + body + "." + b64urlBytes(sig);
}

function futureExpSec(hours = 1): number {
    return Math.floor(Date.now() / 1000) + hours * 3600;
}

/** 起手：owner + 一个注册账号 alice，且 alice 已配好自己的恢复公钥 */
async function setupAliceWithRecoveryKey() {
    const store = freshStore();
    resetMigrationCacheForTests();
    const api = makeApi(store);
    await api.migrate();
    const ownerId = store.users[0].id as number;
    const invite = await api.createInvite(ownerId);
    const registered = await api.registerUser("alice", "password123", invite.code || "");
    const aliceId = registered.user?.id as number;

    const { pub, privKey } = await newRecoveryKeypair();
    api.setCurrentUser(aliceId);
    const saved = await api.setRecoveryPublicKey(pub, "password123");
    assert.equal(saved.success, true, saved.message);
    // 找回是不带身份的公网入口
    api.setCurrentUser(null);
    return { store, api, ownerId, aliceId, privKey };
}

test("恢复密钥：账号名留空也能找回（私钥认领自己的账号，不动 owner）", async () => {
    const { api, ownerId, aliceId, privKey } = await setupAliceWithRecoveryKey();

    const token = await signRecoveryJws(privKey, {
        username: "",
        passwordHash: await hashPassword("AliceNewPass2026"),
        exp: futureExpSec(),
        jti: "forget-name-1",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, true, result.message);
    assert.match(result.message, /alice/, "成功提示要告诉用户是哪个账号被重置了");
    assert.equal(await api.verifyPasswordOfUser(aliceId, "AliceNewPass2026"), true);
    // owner 的密码必须纹丝不动：拿 alice 的私钥绝不能改到别人头上
    assert.equal(await api.verifyPasswordOfUser(ownerId, "seed-password"), true);
});

test("恢复密钥：账号名可以和密码一起改", async () => {
    const { store, api, aliceId, privKey } = await setupAliceWithRecoveryKey();

    const token = await signRecoveryJws(privKey, {
        username: "alice-new",
        passwordHash: await hashPassword("AliceRename2026"),
        exp: futureExpSec(),
        jti: "rename-1",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, true, result.message);
    assert.equal(
        (store.users.find(u => u.id === aliceId) as Row).username,
        "alice-new",
        "新账号名要真的落到 users 表上"
    );
    assert.equal(await api.verifyPasswordOfUser(aliceId, "AliceRename2026"), true);
    // 改名后用新账号名能登录
    const login = await api.login({ username: "alice-new", password: "AliceRename2026" });
    assert.equal(login.success, true, login.message);
});

test("恢复密钥：改成别人在用的账号名 → 拒绝，且不动任何凭据", async () => {
    const { store, api, aliceId, privKey } = await setupAliceWithRecoveryKey();

    const token = await signRecoveryJws(privKey, {
        username: "root", // owner 的账号名
        passwordHash: await hashPassword("GrabOwnerName2026"),
        exp: futureExpSec(),
        jti: "rename-clash-1",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, false);
    assert.match(result.message, /已被占用/);
    assert.equal((store.users.find(u => u.id === aliceId) as Row).username, "alice");
    assert.equal(await api.verifyPasswordOfUser(aliceId, "password123"), true, "旧密码仍然有效");
});

test("恢复密钥：被停用的账号找回后自动恢复可用（否则重置完仍登不进去）", async () => {
    const { store, api, aliceId, privKey } = await setupAliceWithRecoveryKey();

    // 模拟沉睡治理扫到 alice：停用后应当连登录都进不去
    (store.users.find(u => u.id === aliceId) as Row).status = "disabled";
    const blocked = await api.login({ username: "alice", password: "password123" });
    assert.equal(blocked.success, false, "停用期间不能放行");
    assert.match(blocked.message, /停用/);

    const token = await signRecoveryJws(privKey, {
        username: "",
        passwordHash: await hashPassword("AliceIsBack2026"),
        exp: futureExpSec(),
        jti: "reactivate-1",
    });

    const result = await api.redeemRecoveryToken(token);
    assert.equal(result.success, true, result.message);
    assert.equal(
        (store.users.find(u => u.id === aliceId) as Row).status,
        "active",
        "用私钥找回 = 本人回来了，停用状态必须一并解除"
    );

    // 关键：找回之后能直接用新密码登录，而不是卡在「账号已被停用」
    const login = await api.login({ username: "alice", password: "AliceIsBack2026" });
    assert.equal(login.success, true, login.message);
});
