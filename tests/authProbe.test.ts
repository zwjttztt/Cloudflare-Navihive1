// tests/authProbe.test.ts
// 「三读合一 + 两写合并」的回归测试（已认证请求的热路径）。
//
// 改造前每个已认证请求打 5 次库：getTokenVersion / isTokenBlacklisted /
// getAccountSessionState（三次独立的读）+ touchLastActive / touchSession（两次独立的写）。
// 改造后是 1 次合并读 + 1 个 batch（内含 2 条语句）。
//
// 这个文件钉四类东西，缺一条就可能在别处悄悄退化：
//   1. **次数**：读必须真的只剩一条 SQL、写必须真的只剩一个 batch —— 只断言「放行了」
//      是看不出退化的，someone 随手加一次 getTokenVersion 就会重新变回 5 次而测试全绿。
//   2. **降级路径等价**：任何历史库形态（缺 token_blacklist 表 / 缺 status 列）上合并 SQL
//      会炸，那时必须退回三次独立读，且**判定结果逐字段相同** —— 两边都跑一遍再比对。
//   3. **fail-closed / 首建豁免**：黑名单读异常 → 401（改前 catch → true 的语义不许丢）；
//      账号态读异常 → 只有「未就绪 + 缺表类错误」才补跑迁移重试（首建豁免），
//      其余一律 unavailable → 503。2026-11-04（R07）之前这里是「!dbReady 就放行」，
//      而 dbReady 当年是实例字段 → 稳态下恒为 false → 任何读异常都放行。
//   4. **两写合并的语句数**：uid 为 null 时不许碰 users 表（只发会话那一条）。
//
// 用真 SQLite（node:sqlite）而不是按前缀猜 SQL 的替身：合并 SQL 里有两个子查询和
// 一个保留字列名（"status"），替身根本执行不了它 —— 那测出来的「通过」毫无意义。

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRealD1 } from "./helpers/realSqliteD1";
import { errorBody } from "./helpers/apiErrorBody";
import { NavigationAPI } from "../src/API/navigationApi";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";
import { peekJwtClaim } from "../src/API/crypto";
import { enforceAuth, type TokenSession } from "../worker/routes/middleware";
import type { RouteCtx } from "../worker/routes/types";

const HOST = "https://nav.example.com";

type DB = ReturnType<typeof makeRealD1>;

interface Counters {
    /** db.prepare 的调用次数（≈ 语句条数，不含 batch 自身的往返） */
    prepare: number;
    /** db.batch 的调用次数（= 写往返次数） */
    batch: number;
    /** 每次 batch 里的语句条数 */
    sizes: number[];
    /** prepare 见过的 SQL（用来断言「某条旧读真的不发生了」） */
    sqls: string[];
}

function newCounters(): Counters {
    return { prepare: 0, batch: 0, sizes: [], sqls: [] };
}

function resetCounters(c: Counters): void {
    c.prepare = 0;
    c.batch = 0;
    c.sizes = [];
    c.sqls = [];
}

/** 给真 SQLite 替身套一层计数器（不改语义，只记次数） */
function countingDb(inner: DB, c: Counters): DB {
    return {
        prepare(sql: string) {
            c.prepare += 1;
            c.sqls.push(sql);
            return inner.prepare(sql);
        },
        batch(stmts: Parameters<DB["batch"]>[0]) {
            c.batch += 1;
            c.sizes.push(stmts.length);
            return inner.batch(stmts);
        },
        exec: (sql: string) => inner.exec(sql),
    };
}

/** 在命中的 SQL 上注入故障：模拟「这台库没有那张表 / 缺那一列 / 连接抖动」 */
function withFault(inner: DB, matcher: (sql: string) => boolean): DB {
    return {
        prepare(sql: string) {
            if (matcher(sql)) {
                throw new Error(`注入故障：${sql.replace(/\s+/g, " ").trim().slice(0, 60)}`);
            }
            return inner.prepare(sql);
        },
        batch: (stmts: Parameters<DB["batch"]>[0]) => inner.batch(stmts),
        exec: (sql: string) => inner.exec(sql),
    };
}

/**
 * 只抛**一次**、且错误文案可指定的故障：模拟「首请求上 users 表还没建出来」。
 * 一次性是这条用例的关键 —— 补跑迁移之后的**重试**必须真的能读到，否则验不到
 * 「首建豁免 = 补跑迁移 + 重试一次」这条路径。
 */
function withOneShotFault(inner: DB, matcher: (sql: string) => boolean, message: string): DB {
    let fired = false;
    return {
        prepare(sql: string) {
            if (!fired && matcher(sql)) {
                fired = true;
                throw new Error(message);
            }
            return inner.prepare(sql);
        },
        batch: (stmts: Parameters<DB["batch"]>[0]) => inner.batch(stmts),
        exec: (sql: string) => inner.exec(sql),
    };
}

/** 建一张够用的库：users / token_blacklist / user_sessions 三张表（列名与迁移一致） */
async function newDb(): Promise<DB> {
    const db = makeRealD1();
    await db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL DEFAULT '',
            role TEXT NOT NULL DEFAULT 'user',
            token_version INTEGER NOT NULL DEFAULT 0,
            "status" TEXT NOT NULL DEFAULT 'active',
            last_active_at INTEGER,
            disabled_at INTEGER,
            created_at TEXT
        )
    `);
    await db.exec(`CREATE TABLE token_blacklist (jti TEXT PRIMARY KEY, exp INTEGER, created_at INTEGER)`);
    await db.exec(`
        CREATE TABLE user_sessions (
            jti TEXT PRIMARY KEY,
            user_id INTEGER,
            user_agent TEXT,
            ip TEXT,
            created_at INTEGER,
            last_seen_at INTEGER,
            expires_at INTEGER,
            device_id TEXT
        )
    `);
    return db;
}

async function insertUser(
    db: DB,
    id: number,
    username: string,
    tokenVersion = 0,
    status = "active"
): Promise<void> {
    await db
        .prepare(
            `INSERT INTO users (id, username, role, token_version, "status", created_at)
             VALUES (?, ?, 'owner', ?, ?, '2026-01-01 00:00:00')`
        )
        .bind(id, username, tokenVersion, status)
        .run();
}

function makeApi(db: DB): NavigationAPI {
    return new NavigationAPI({
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_USERNAME: "root",
        AUTH_PASSWORD: "seed-password",
        AUTH_SECRET: "test-secret",
    } as never);
}

function makeCtx(
    api: NavigationAPI,
    token: string,
    path = "groups",
    method = "GET"
): { ctx: RouteCtx; session: TokenSession } {
    const request = new Request(`${HOST}/api/${path}`, {
        method,
        headers: { Cookie: `navihive_token=${token}` },
    });
    const session: TokenSession = { jti: "", exp: 0 };
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api,
        ip: "203.0.113.1",
        trustXFF: false,
        trustXRealIp: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    return { ctx, session };
}

/** 库里的账号形态：合并路径与降级路径必须在每一种上都给同一个答案 */
type ScenarioKind = "active" | "disabled" | "missing" | "blacklisted" | "stale";

/** 造一个指定账号状态的库，并签出一枚**当时有效**的令牌 */
async function scenarioDb(kind: ScenarioKind): Promise<{ db: DB; token: string }> {
    const db = await newDb();
    await insertUser(db, 1, "alice");
    const token = await makeApi(db).generateToken({ username: "alice", uid: 1 });
    const jti = String(peekJwtClaim(token, "jti") ?? "");

    switch (kind) {
        case "disabled":
            // 令牌签发之后账号才被停用（「记住我」那 30 天的典型场景）
            await db.prepare(`UPDATE users SET "status" = 'disabled', disabled_at = 1 WHERE id = 1`).run();
            break;
        case "missing":
            // 账号被清除，令牌还没过期
            await db.prepare("DELETE FROM users WHERE id = 1").run();
            break;
        case "blacklisted":
            await db
                .prepare("INSERT INTO token_blacklist (jti, exp, created_at) VALUES (?, ?, ?)")
                .bind(jti, 9999999999, 1)
                .run();
            break;
        case "stale":
            // 改密后 token_version +1，旧令牌应当失效
            await db.prepare("UPDATE users SET token_version = 1 WHERE id = 1").run();
            break;
        default:
            break;
    }
    return { db, token };
}

interface Outcome {
    status: number;
    code: string;
    message: string;
    /**
     * 放行时写回 session 的 jti 是否就是这张令牌的 jti。
     *
     * 存布尔而不是 jti 本身：每次 scenarioDb 都会新签一张令牌（jti 是随机 UUID），
     * 两条路径各自建库，直接比字符串必然不相等；而这个布尔值正是我们要的等价性。
     */
    jtiOk: boolean;
}

/**
 * 跑一遍中间件，返回「可逐字段比对」的结果。
 * @param degrade 强制让合并读抛错 → verifyToken 走降级路径（三次独立读）
 */
async function runAuth(kind: ScenarioKind, degrade = false): Promise<Outcome> {
    const { db, token } = await scenarioDb(kind);
    const expectedJti = String(peekJwtClaim(token, "jti") ?? "");
    const api = makeApi(db);
    if (degrade) {
        api.authProbe = async () => {
            throw new Error("注入：合并读在这台库上炸了（模拟缺 token_blacklist 表）");
        };
    }
    const { ctx, session } = makeCtx(api, token);
    const res = await enforceAuth(ctx, session);
    const jtiOk = session.jti === expectedJti;
    if (!res) return { status: 200, code: "ok", message: "", jtiOk };
    const body = await errorBody(res);
    return { status: res.status, code: body.code, message: body.message, jtiOk };
}

// ================= 1. 往返次数 =================
test("已认证请求：读只剩一条 SQL、写只剩一个 batch（prepare ≤ 3）", async () => {
    const db = await newDb();
    await insertUser(db, 1, "alice");

    const counters = newCounters();
    const api = makeApi(countingDb(db, counters));
    const token = await api.generateToken({ username: "alice", uid: 1 });
    const jti = String(peekJwtClaim(token, "jti") ?? "");

    // 先把会话行登记好（没有这一行也不影响计数，只是 touch 会 0 行变更）
    await db
        .prepare("INSERT INTO user_sessions (jti, user_id, last_seen_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(jti, 1, 0, 9999999999)
        .run();

    resetCounters(counters);
    const { ctx, session } = makeCtx(api, token);
    const res = await enforceAuth(ctx, session);

    assert.equal(res, null, "正常令牌必须放行");
    // 1 条合并读（authProbe）+ 2 条待发语句（touchActivity 的 prepare，但只算一次往返）
    assert.ok(
        counters.prepare <= 3,
        `已认证请求的语句数应 ≤ 3（1 读 + 2 写语句），实际 ${counters.prepare} 条：${JSON.stringify(
            counters.sqls.map((s) => s.replace(/\s+/g, " ").trim().slice(0, 50))
        )}`
    );
    assert.equal(counters.batch, 1, "两次独立的写必须合并成一个 batch（= 1 次往返）");
    assert.deepEqual(counters.sizes, [2], "batch 里应当是 2 条语句（users + user_sessions）");

    // 三次独立读里的「账号态查询」不该再单独发生（它已经并进 authProbe）
    const standaloneStateReads = counters.sqls.filter(
        (s) => s.replace(/\s+/g, " ").trim() === 'SELECT "status" FROM users WHERE id = ?'
    );
    assert.equal(standaloneStateReads.length, 0, "账号态必须来自合并读，不许再单查一次");
    // 黑名单只被查了一次（在合并 SQL 里），不再有独立的 isTokenBlacklisted
    const blacklistReads = counters.sqls.filter((s) => s.includes("token_blacklist"));
    assert.equal(blacklistReads.length, 1, "黑名单只该被查一次");
    assert.ok(
        !blacklistReads[0].trim().startsWith("SELECT jti FROM token_blacklist"),
        "不该再走 isTokenBlacklisted 那条独立语句"
    );
});

// ================= 2. fail-closed：黑名单读异常 → 401 =================
test("黑名单表读异常：fail-closed 拦下（401），不许让登出过的令牌复活", async () => {
    const { db, token } = await scenarioDb("active");
    // 模拟「老库里没有 token_blacklist 表」：合并且独立的两条读都会炸
    const api = makeApi(withFault(db, (sql) => sql.includes("token_blacklist")));
    const { ctx } = makeCtx(api, token);

    const res = await enforceAuth(ctx, { jti: "", exp: 0 });
    assert.equal(res?.status, 401, "黑名单读不了就必须拒绝，不能放行");
    const body = await errorBody(res!);
    assert.equal(body.code, "unauthenticated");
    assert.equal(body.message, "认证已过期或无效，请重新登录");
});

// ============ 3. 首建豁免（唯一还放行的路径）与未知态（503） ============
//
// 2026-11-04（审查报告 R07）：这一组原先是「!dbReady → 放行」和「dbReady → 401」。
// 前者把 bug 写成了契约（dbReady 是实例字段，稳态下恒为 false —— 「迁移没跑完」这条
// 分支永远成立，于是任何一次读异常都会放行）；后者用 401 顶替「没结论」，
// 会把一次 DB 抖动变成「所有人被踢下线」。现在的契约：
//   · 未就绪 + **缺表类**错误 → 补跑迁移 → 重试一次 → 采信重试结果（首建豁免）；
//   · 其余一律 `unavailable` → 鉴权回 503 + Retry-After（不是 401，也不是放行）。
test("首请求（未就绪 + 缺表）：补跑迁移后重试一次，读到真实状态就放行", async () => {
    resetMigrationCacheForTests(); // 前提：这个 isolate 还没迁移过
    const { db, token } = await scenarioDb("active");
    // 只让**独立的账号态查询**抛一次「no such table」：这里用行首锚点把它与合并 SQL
    // （以 `SELECT\n (SELECT "status" …` 开头）区分开，保证抛在 readState 那一次上。
    const api = makeApi(
        withOneShotFault(
            db,
            (sql) => /^\s*SELECT\s+"status"\s+FROM\s+users/i.test(sql),
            "no such table: users"
        )
    );
    // 合并读在首请求上同样会炸（users 表还没建），中间件于是退回 getAccountSessionState
    // —— 这正是线上首次部署时的真实路径，用显式抛错把它固定住。
    api.authProbe = async () => {
        throw new Error("no such table: users");
    };
    assert.equal(api.dbReady, false, "这个用例的前提就是迁移还没跑完");

    const { ctx, session } = makeCtx(api, token);
    const res = await enforceAuth(ctx, session);
    assert.equal(res, null, "首建豁免：补跑迁移之后读得到账号态，就必须放行");
    assert.equal(session.jti, String(peekJwtClaim(token, "jti") ?? ""), "放行时 jti 仍要写回");
    assert.equal(api.dbReady, true, "补跑迁移真的跑过（结构就绪标记应当翻成 true）");
});

test("未就绪但错误不是缺表类：不给首建豁免，按未知态回 503", async () => {
    resetMigrationCacheForTests();
    const { db, token } = await scenarioDb("active");
    const api = makeApi(withFault(db, (sql) => sql.includes('"status"')));
    assert.equal(api.dbReady, false);

    const { ctx } = makeCtx(api, token);
    const res = await enforceAuth(ctx, { jti: "", exp: 0 });
    assert.equal(res?.status, 503, "超时 / 抖动这类错误重跑迁移也没用，不能当成首建放行");
    assert.equal(await res?.headers.get("Retry-After"), "5", "503 要带 Retry-After");
    assert.equal((await errorBody(res!)).code, "service_unavailable");
});

test("迁移跑完之后同样的读异常：未知态 → 503（不是 401，401 会让人重新登录）", async () => {
    const { db, token } = await scenarioDb("active");
    const api = makeApi(withFault(db, (sql) => sql.includes('"status"')));
    api.dbReady = true;

    const { ctx } = makeCtx(api, token);
    const res = await enforceAuth(ctx, { jti: "", exp: 0 });
    assert.equal(res?.status, 503, "迁移完成后查不出账号态 → 按「不可用」拦（hardening item 5）");
    const body = await errorBody(res!);
    assert.equal(body.code, "service_unavailable");
    assert.equal(body.status, 503);
});

// ================= 4. 降级路径等价 =================
test("降级路径（三次独立读）与合并路径的判定逐字段相同", async () => {
    const expected: Record<ScenarioKind, number> = {
        active: 200,
        disabled: 403,
        missing: 401,
        blacklisted: 401,
        stale: 401,
    };
    for (const kind of Object.keys(expected) as ScenarioKind[]) {
        const merged = await runAuth(kind, false);
        const degraded = await runAuth(kind, true);
        assert.equal(merged.status, expected[kind], `${kind}：合并路径的判定要符合预期`);
        assert.deepEqual(
            degraded,
            merged,
            `${kind}：合并读失败时必须退回三次独立读，且 status / code / message / jti 全部一致`
        );
    }
});

// ================= 5. 401 / 403 的状态码与文案一个字都不许改 =================
test("账号已不存在：401 + unauthenticated + 原文案（两条路径都一样）", async () => {
    for (const degrade of [false, true]) {
        const out = await runAuth("missing", degrade);
        assert.equal(out.status, 401, `degrade=${degrade}`);
        assert.equal(out.code, "unauthenticated", `degrade=${degrade}`);
        assert.equal(out.message, "账号已不存在，请重新登录", `degrade=${degrade}：文案不许改`);
    }
});

test("账号被停用：403 + forbidden + 原文案（两条路径都一样）", async () => {
    for (const degrade of [false, true]) {
        const out = await runAuth("disabled", degrade);
        assert.equal(out.status, 403, `degrade=${degrade}`);
        assert.equal(out.code, "forbidden", `degrade=${degrade}`);
        assert.equal(
            out.message,
            "账号因长期未登录已被停用；可用恢复密钥找回，或联系站点所有者",
            `degrade=${degrade}：文案不许改`
        );
    }
});

test("logout 仍然跳过账号态检查（被停用的人也要能把自己登出去）", async () => {
    const { db, token } = await scenarioDb("disabled");
    const counters = newCounters();
    const api = makeApi(countingDb(db, counters));
    const { ctx, session } = makeCtx(api, token, "logout", "POST");

    const res = await enforceAuth(ctx, session);
    // 账号是 disabled 的：只要中间件采信了账号态，这里一定是 403。
    // 放行 = 那条既有例外还在（合并路径下账号态随合并读一起回来了，更不能顺手用上）。
    assert.equal(res, null, "logout 必须放行，否则界面卡在登录态出不去");
    const standaloneStateReads = counters.sqls.filter(
        (s) => s.replace(/\s+/g, " ").trim() === 'SELECT "status" FROM users WHERE id = ?'
    );
    assert.equal(standaloneStateReads.length, 0, "logout 不该再单独查一次账号态");
});

// ================= 6. 两写合并的语句形态 =================
test("touchActivity：uid 为 null 只发 1 条；非 null 发 2 条且在同一个 batch 里", async () => {
    const db = await newDb();
    await insertUser(db, 1, "alice");
    await db
        .prepare("INSERT INTO user_sessions (jti, user_id, last_seen_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind("j1", 1, 0, 9999999999)
        .run();

    const counters = newCounters();
    const api = makeApi(countingDb(db, counters));

    // ① 遗留令牌（没有 uid）：只刷新会话，绝不碰 users 表
    resetCounters(counters);
    await api.touchActivity(null, "j1");
    assert.equal(counters.batch, 1, "一次 batch");
    assert.deepEqual(counters.sizes, [1], "uid 为 null 时只该有会话那一条语句");
    const userAfterNull = await db
        .prepare("SELECT last_active_at FROM users WHERE id = 1")
        .first<{ last_active_at: number | null }>();
    assert.equal(userAfterNull?.last_active_at ?? null, null, "uid 为 null 时不许写 users 表");
    const sessionAfter = await db
        .prepare("SELECT last_seen_at FROM user_sessions WHERE jti = 'j1'")
        .first<{ last_seen_at: number }>();
    assert.ok((sessionAfter?.last_seen_at ?? 0) > 0, "会话的 last_seen_at 必须真的被刷新");

    // ② 正常令牌：两条语句，同一个 batch（= 1 次往返）
    resetCounters(counters);
    await api.touchActivity(1, "j1");
    assert.equal(counters.batch, 1, "两条写必须同批发出");
    assert.deepEqual(counters.sizes, [2], "users + user_sessions 各一条");
    const userAfter = await db
        .prepare("SELECT last_active_at FROM users WHERE id = 1")
        .first<{ last_active_at: number | null }>();
    const firstActive = userAfter?.last_active_at ?? 0;
    assert.ok(firstActive > 0, "账号活跃时间必须真的被刷新");

    // ③ 节流不许变：24 小时内再调一次，users 那一条不应再改（UPDATE 命中 0 行）
    await api.touchActivity(1, "j1");
    const userAgain = await db
        .prepare("SELECT last_active_at FROM users WHERE id = 1")
        .first<{ last_active_at: number }>();
    assert.equal(userAgain?.last_active_at, firstActive, "24 小时节流阈值必须保持原样");
    assert.ok(
        Math.abs(firstActive - Math.floor(Date.now() / 1000)) <= 5,
        "刚写过就该落「现在」这个时间戳，不该是别的值"
    );
});

test("touchActivity：uid 与 jti 都没有时连 batch 都不开", async () => {
    const db = await newDb();
    const counters = newCounters();
    const api = makeApi(countingDb(db, counters));

    resetCounters(counters);
    await api.touchActivity(null, "");
    assert.equal(counters.batch, 0, "空 batch 没有意义，不该产生一次往返");
    assert.equal(counters.prepare, 0, "没有语句要发时不该 prepare 任何东西");
});

// ================= 7. 遗留令牌（payload 里没有 uid）=================
test("遗留令牌：令牌版本走全站那份，账号态是 unknown（不冒充 active / missing）", async () => {
    const db = await newDb();
    await db.exec("CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT)");
    await db.prepare("INSERT INTO configs (key, value) VALUES (?, ?)").bind("auth.tokenVersion", "2").run();
    await insertUser(db, 1, "alice", 0, "active");

    const api = makeApi(db);
    // 没有 uid 的令牌：版本号只能认 configs 里那份（多账号上线前签的老令牌）
    const token = await api.generateToken({ username: "root" });
    const jti = String(peekJwtClaim(token, "jti") ?? "");
    assert.equal(peekJwtClaim(token, "uid"), undefined, "这枚令牌本来就不该带 uid");

    const probe = await api.authProbe(null, jti);
    assert.equal(probe.tokenVersion, 2, "老令牌的版本号必须仍取全站那份");
    assert.equal(probe.accountStatus, "unknown", "没有 uid 就没有账号态可言，不许编一个出来");
    assert.equal(probe.blacklisted, false);

    // 中间件对这类令牌走的是 hasAnyUser 那条老分支，不会用这个 unknown 去放行/拦截
    const verified = await api.verifyToken(token);
    assert.equal(verified.valid, true, "验签仍然通过（版本号对得上）");
});
