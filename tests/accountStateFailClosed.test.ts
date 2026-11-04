// tests/accountStateFailClosed.test.ts
// 审查报告 R07：「账号未知状态的降级边界」。
//
// 被修的三件事（改之前每一条都能在线上咬人）：
//   1. `dbReady` 是**实例字段**，而 NavigationAPI 每个请求 new 一个 —— 迁移只在
//      isolate 的第一个请求里跑，于是第二个请求起 dbReady 恒为 false。
//   2. `getAccountSessionState` 的 catch 里「!dbReady → active」因此在**稳态下永远成立**：
//      任何一次账号态读失败（抖动、超时、语法错）都被当成「首次建表」放行。
//      加上 `migrateIfNeeded` 的全量迁移那条路径压根没置位，这条豁免几乎必然成立。
//   3. 没有「未知态」这个值：查不出来只能拿 active / missing 顶替 —— 前者是放行，
//      后者会让中间件回 401、客户端清 token 并退登录页。一次 D1 抖动 = 全员重新登录。
//
// 这个文件钉的是修完之后的边界，五个断言组：
//   A. 就绪状态跨实例（模块级）：迁移完的库，新实例 dbReady 也是 true 且能读到状态；
//   B. 非缺表类错误 → unavailable → 鉴权 503 + Retry-After（不是 200、不是 401）；
//   C. 未迁移 + 缺表错误 → 补跑迁移 + 重试一次 → 拿到真实状态（首建豁免只认这条）；
//   D. 确定的结论照旧：disabled → 403、missing → 401（这两条行为一行没改）；
//   E. 逃生口 NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1 → unavailable 降级成 active，
//      并且**必须**留下一条能被搜到的日志；
//   F. 端到端：走 worker/index.ts 的请求入口，未知态在受保护 handler 之前就被挡住。
//
// 用真 SQLite（node:sqlite）而不是按前缀猜 SQL 的替身：这里要验的正是
// 「users 表还不存在时抛什么错」和「补跑迁移之后能不能真的读到」—— 替身两样都验不出来。

import { test } from "node:test";
import assert from "node:assert/strict";

import { makeRealApi, makeRealD1, type RealD1 } from "./helpers/realSqliteD1";
import { errorBody } from "./helpers/apiErrorBody";
import { resetMigrationCacheForTests } from "../src/API/methods/internals";
import { NavigationAPI } from "../src/API/navigationApi";
import { enforceAuth, type TokenSession } from "../worker/routes/middleware";
import type { RouteCtx } from "../worker/routes/types";
import workerEntry from "../worker/index";

const HOST = "https://nav.example.com";
/** 账号态查询那条语句：行首锚点，用来把它与三读合一的合并 SQL 区分开 */
const STATUS_SQL = /^\s*SELECT\s+"status"\s+FROM\s+users/i;
/** 三读合一的合并 SQL 里同样有 `SELECT "status" FROM users`（缩进不同、在子查询里） */
const STATUS_ANYWHERE_SQL = /SELECT\s+"status"\s+FROM\s+users/i;

/**
 * 在命中的 SQL 上注入故障。
 *
 * `once = true` 时只抛第一次 —— 「补跑迁移后重试必须能成功」那条用例靠它，
 * 否则重试依旧抛同一个错，验不到首建豁免修复后的样子。
 */
function faultOn(
    inner: RealD1,
    matcher: (sql: string) => boolean,
    error: Error,
    once = false
): RealD1 {
    let fired = false;
    return {
        prepare(sql: string) {
            if ((!once || !fired) && matcher(sql)) {
                fired = true;
                throw error;
            }
            return inner.prepare(sql);
        },
        batch: (stmts: Parameters<RealD1["batch"]>[0]) => inner.batch(stmts),
        exec: (sql: string) => inner.exec(sql),
    };
}

/** 迁移之后 users 表的完整形状（外加一行账号）；缺表类用例要在「迁移前」先有这张表 */
const USERS_DDL = `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    token_version INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    last_active_at INTEGER,
    disabled_at INTEGER,
    recovery_public_key TEXT
)`;

async function seedUser(db: RealD1, id: number, status: string): Promise<void> {
    await db
        .prepare(
            `INSERT INTO users (id, username, password_hash, role, "status") VALUES (?, ?, 'x', 'owner', ?)`
        )
        .bind(id, `user${id}`, status)
        .run();
}

/** 与 worker/index.ts 的入口同形状的 RouteCtx（只填中间件用得到的字段） */
function makeCtx(api: NavigationAPI, token: string, path = "configs"): {
    ctx: RouteCtx;
    session: TokenSession;
} {
    const request = new Request(`${HOST}/api/${path}`, {
        method: "GET",
        headers: { Cookie: `navihive_token=${token}` },
    });
    const session: TokenSession = { jti: "", exp: 0 };
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method: "GET",
        api,
        ip: "203.0.113.9",
        trustXFF: false,
        trustXRealIp: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    return { ctx, session };
}

/** 迁移会顺手建出首个 owner 账号（id 1），所以用例自己的账号一律从 7 起编 */
const UID = 7;

/** 造一套「迁移已完成 + 有一个 active 账号」的真库，并签出一枚有效令牌 */
async function readyScenario(): Promise<{ db: RealD1; token: string }> {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await seedUser(db, UID, "active");
    const token = await api.generateToken({ username: `user${UID}`, uid: UID });
    return { db, token };
}

// ============ A. 就绪状态是 isolate 级（module-level），不是实例级 ============
test("迁移完的库：新建的第二个实例 dbReady 也是 true，且能正常读到账号状态", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const first = makeRealApi(db);
    assert.equal(first.dbReady, false, "空库上第一个实例还没迁移，就绪标记必须是 false");
    await first.migrate();
    assert.equal(first.dbReady, true);

    // 下一个请求 = 新实例（worker/index.ts 每个请求 new 一个）
    const second = makeRealApi(db);
    assert.equal(
        second.dbReadyOverride,
        null,
        "新实例没有任何实例标记 —— 这个 true 只能来自模块级 migrationState.ready"
    );
    assert.equal(second.dbReady, true, "就绪状态必须跨实例：否则稳态下又退回「未就绪」");

    await seedUser(db, UID, "active");
    assert.equal(await second.getAccountSessionState(UID), "active", "新实例照样读得到账号状态");
});

// ============ B. 非缺表类错误 → unavailable → 503 ============
test("非缺表类错误（连接抖动）：账号态是 unavailable，鉴权回 503 + Retry-After", async () => {
    const { db, token } = await readyScenario();
    // 只让「读 status」炸，且是**非**缺表类错误
    const api = makeRealApi(
        faultOn(db, (sql) => STATUS_ANYWHERE_SQL.test(sql), new Error("D1_ERROR: 连接被重置"))
    );

    assert.equal(await api.getAccountSessionState(UID), "unavailable", "读不出来就是没结论");

    const { ctx } = makeCtx(api, token);
    const res = await enforceAuth(ctx, { jti: "", exp: 0 });
    assert.notEqual(res, null, "未知态绝不能放行");
    assert.equal(res?.status, 503, "DB 抖动不能把令牌判死（401 会让客户端清 token）");
    assert.equal(res?.headers.get("Retry-After"), "5", "503 要告诉客户端过多久再试");
    const body = await errorBody(res!);
    assert.equal(body.code, "service_unavailable");
    assert.equal(body.status, 503);
});

// ============ C. 首建豁免：只认「未就绪 + 缺表」这一种组合 ============
test("未迁移的库 + 缺表错误：补跑迁移后重试一次，成功拿到 active", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    // 模拟「库里已经有账号、但这套结构还没跑过迁移」：只手工建 users 表
    await db.exec(USERS_DDL);
    await db.exec(
        `INSERT INTO users (id, username, password_hash, role, "status") VALUES (1, 'user1', 'x', 'owner', 'active')`
    );

    // 第一次读账号态抛「no such table」——一次性，补跑迁移之后的重试必须真的能读到
    const api = makeRealApi(
        faultOn(db, (sql) => STATUS_SQL.test(sql), new Error("no such table: users"), true)
    );
    assert.equal(api.dbReady, false, "前提：这个 isolate 还没迁移过");

    assert.equal(await api.getAccountSessionState(1), "active", "首建豁免：补跑迁移后读得到就采信");
    assert.equal(api.dbReady, true, "补跑迁移真的跑完了，就绪标记翻成 true");

    // 证明迁移真的补跑过：configs / sites 这些表只有迁移才会建出来
    const tables = await db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all<{ name: string }>();
    const names = tables.results.map(row => row.name);
    assert.ok(names.includes("configs"), "补跑迁移应当建出 configs 表");
    assert.ok(names.includes("sites"), "补跑迁移应当建出 sites 表");
});

test("已就绪 + 缺表错误：不补跑、不豁免，直接 unavailable", async () => {
    const { db } = await readyScenario();
    // 就绪之后再报缺表 = 结构被回退 / 库不是那套库 —— 这不是「首建」，没有豁免可言，
    // 而且此时重跑迁移也解决不了（users 表在，缺的是别的），所以连重试都不该发生。
    const api = makeRealApi(
        faultOn(db, (sql) => STATUS_SQL.test(sql), new Error("no such column: status"))
    );
    assert.equal(api.dbReady, true);
    assert.equal(await api.getAccountSessionState(1), "unavailable");
});

// ============ D. 确定的结论照旧（这两条行为一行没改） ============
test("disabled → disabled（403）、行不存在 → missing（401）", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const api = makeRealApi(db);
    await api.migrate();
    await seedUser(db, 11, "disabled");
    await seedUser(db, 12, "active");
    const token = await api.generateToken({ username: "user11", uid: 11 });

    // disabled：中间件回 403（停用不是「令牌无效」，所以不是 401 —— 既有行为，未改）
    const disabledCtx = makeCtx(makeRealApi(db), token);
    assert.equal(await disabledCtx.ctx.api.getAccountSessionState(11), "disabled");
    const disabledRes = await enforceAuth(disabledCtx.ctx, { jti: "", exp: 0 });
    assert.equal(disabledRes?.status, 403, "停用的账号仍按原样拦（403）");
    assert.equal((await errorBody(disabledRes!)).code, "forbidden");

    // missing：账号被清掉了，令牌还没过期 → 401（客户端会清登录标记）
    const goneToken = await api.generateToken({ username: "user2", uid: 99 });
    const missingCtx = makeCtx(makeRealApi(db), goneToken);
    assert.equal(await missingCtx.ctx.api.getAccountSessionState(99), "missing");
    const missingRes = await enforceAuth(missingCtx.ctx, { jti: "", exp: 0 });
    assert.equal(missingRes?.status, 401, "账号已不存在仍按原样 401");
    assert.equal((await errorBody(missingRes!)).code, "unauthenticated");
});

// ============ E. 逃生口：唯一还放行的路径，且必须留痕 ============
test("逃生口 NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1：unavailable 降级成 active 并打日志", async () => {
    resetMigrationCacheForTests();
    const db = makeRealD1();
    const base = makeRealApi(db);
    await base.migrate();
    await seedUser(db, UID, "active");

    const faulted = faultOn(
        db,
        (sql) => STATUS_ANYWHERE_SQL.test(sql),
        new Error("D1_ERROR: 查询超时")
    );
    const api = new NavigationAPI({
        DB: faulted,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret",
        NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR: "1",
    } as never);

    // logger.warn → console.warn：抓一下，验证「逃生口放行」这件事在日志里说得清楚
    const warns: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warns.push(args);
    };
    let state: string;
    try {
        state = await api.getAccountSessionState(UID);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(state, "active", "开了逃生口才放行（与改造前的开关行为一致）");
    const flat = warns
        .map(args => args.map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
        .join("\n");
    assert.match(flat, /逃生开关/, "日志要说清「这次是逃生口放行的」");
    assert.match(flat, /NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR/, "日志要能按开关名被搜到");
    assert.match(flat, /uid/, "日志要带 uid，否则事后不知道是谁被放过去了");
});

// ============ F. 端到端：未知态进不了受保护 handler ============
test("端到端（worker/index.ts 入口）：未知态在受保护 handler 之前回 503", async () => {
    const { db, token } = await readyScenario();
    const env = {
        DB: db,
        AUTH_ENABLED: "true",
        AUTH_SECRET: "test-secret",
        AUTH_USERNAME: "user1",
        AUTH_PASSWORD: "seed-password",
    } as never;

    // 对照组：库正常 → /api/configs 是受保护路由，令牌有效 → 200
    // （证明下面那个 503 不是「路径不存在 / 没进路由」造成的）
    const healthy = await workerEntry.fetch(
        new Request(`${HOST}/api/configs`, { headers: { Cookie: `navihive_token=${token}` } }),
        env
    );
    assert.equal(healthy.status, 200, "对照组：库正常时这个请求必须是 200");

    // 实验组：只有账号态那条读炸掉 → 未知态 → 受保护 handler 之前就被挡住
    const faultedEnv = {
        ...(env as Record<string, unknown>),
        DB: faultOn(db, (sql) => STATUS_ANYWHERE_SQL.test(sql), new Error("D1_ERROR: 连接被重置")),
    } as never;
    const res = await workerEntry.fetch(
        new Request(`${HOST}/api/configs`, { headers: { Cookie: `navihive_token=${token}` } }),
        faultedEnv
    );
    assert.equal(res.status, 503, "未知态不许走到受保护 handler（更不许 200）");
    assert.equal(res.headers.get("Retry-After"), "5");
    // 响应体是错误信封而不是 configs 数据 —— 同时证明受保护 handler 根本没跑
    // （它成功时会回 `{ "site.title": … }` 这类 JSON，顶层键是配置名而不会是 error）
    const raw = (await res.json()) as { error?: { code?: string } };
    assert.equal(raw.error?.code, "service_unavailable", "响应体必须是错误信封，不是 configs 数据");
    assert.deepEqual(Object.keys(raw), ["error"], "响应体只该有 error 一个顶层键");
});
