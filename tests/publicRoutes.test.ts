// tests/publicRoutes.test.ts
// 公开路由（worker/routes/public.ts，379 行）的行为用例。
//
// 这是全站**唯一不需要登录就能打**的一批接口，写错的后果也最重：
//
// 1. 注册是唯一「不带任何凭据就能写库」的入口 —— 开关关掉后必须彻底关死；
// 2. 恢复令牌是「忘了密码还能进来」的后门 —— 验签全在 api 里，但**限频必须在路由层**，
//    否则私钥泄露就是无限次重试；
// 3. 登录失败文案三态（还能试几次 / 已达上限 / 已锁定）曾经判断反过 ——
//    第 5 次还没锁上就说「已暂时锁定」，用户被凭空多锁一轮；
// 4. init 必须**对已初始化与未初始化返回完全一样的响应**，否则等于告诉扫描器
//    「这台是新装的，快来注册管理员」。
//
// routeCoverage 只证明这些 path/method 有模块认领，认领之后做了什么全靠这里。

import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePublicRoutes } from "../worker/routes/public";
import {
    INIT_GUARD_KEY,
    LOGIN_GUARD_KEY,
    RECOVER_GUARD_KEY,
    REGISTER_GUARD_KEY,
    SHARE_GUARD_KEY,
    shareBucket,
} from "../worker/loginGuard";
import { REMEMBER_TOKEN_TTL } from "../src/API/http";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";
import { ApiError } from "../worker/lib/apiError";
import { errorBody } from "./helpers/apiErrorBody";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

interface Log {
    logins: Array<{ username?: string; remember?: boolean }>;
    audits: Array<{ action: string; detail?: string }>;
    sessions: string[];
    registers: Array<{ username: string; inviteCode: string }>;
    issued: Array<{ uid: number; ttl: number }>;
    redeems: string[];
    setUsers: Array<number | null>;
    inits: number;
    /** 公开分享被真正读了几次（限速在锁定期间必须让它保持 0） */
    publicShareReads: Array<{ kind: "note" | "group"; token: string; password: string | null }>;
    /**
     * 真实发生过的 configs 写入。限频是「有没有真的计上数」的唯一凭据 ——
     * 只看 HTTP 状态码看不出来（计不计数接口都照常返回），必须盯写库。
     */
    configWrites: Array<{ key: string; count: number }>;
    /**
     * 原始写入内容（key → 整份 JSON）。
     * 分享口令那把锁按「IP + token」分桶，桶名不是固定的 BUCKET，
     * configWrites 里那个 count 读的是固定桶、对它没意义 —— 要原始串才能核对。
     */
    configRaw: Array<{ key: string; raw: string }>;
}

function emptyLog(): Log {
    return {
        logins: [],
        audits: [],
        sessions: [],
        registers: [],
        issued: [],
        redeems: [],
        setUsers: [],
        inits: 0,
        publicShareReads: [],
        configWrites: [],
        configRaw: [],
    };
}

/** 取某个 guard key 最后一次写入里、指定桶的 count */
function lastCountOf(log: Log, key: string, bucket: string): number | null {
    const hits = log.configRaw.filter(w => w.key === key);
    if (hits.length === 0) return null;
    return countOfBucket(hits[hits.length - 1].raw, bucket);
}

interface Options {
    /** 鉴权开关（关掉时注册必须被拒） */
    authEnabled?: boolean;
    /** api.login 的返回；success 走成功分支 */
    login?: { success: boolean; message?: string; token?: string; role?: string; username?: string };
    register?: { success: boolean; message?: string; user?: { id: number; username: string } };
    recover?: { success: boolean; message?: string };
    verify?: { valid: boolean; payload?: { uid?: number } };
    hasRecoveryKey?: boolean;
    initResult?: { alreadyInitialized: boolean };
    mustChange?: boolean;
    /**
     * 预置的限速桶内容。给 `{ until: Date.now() + 60_000 }` 表示「这个来源正在锁定期」。
     * 键是 guard key，值是该来源桶的状态（桶名固定是 BUCKET）。
     */
    guards?: Record<string, { count?: number; until?: number }>;
    /**
     * 多桶预置：guard key → 桶名 → 状态。
     * 分享口令那把锁的桶名是「IP + token」，不是固定的 BUCKET，所以需要这一档。
     */
    guardBuckets?: Record<string, Record<string, { count?: number; until?: number }>>;
    /** api.getPublicNote 的返回 */
    publicNote?: Record<string, unknown>;
    /** api.getPublicGroupShare 的返回 */
    publicGroupShare?: Record<string, unknown>;
}

/** 从 guard store 的 JSON 里取出**指定桶**的 count */
function countOfBucket(raw: string, bucket: string): number {
    try {
        const parsed = JSON.parse(raw) as {
            buckets?: Record<string, { count?: number }>;
        };
        return parsed.buckets?.[bucket]?.count ?? 0;
    } catch {
        return 0;
    }
}

/** 从 guard store 的 JSON 里取出本来源桶的 count（写没写进去就看它） */
function bucketCount(raw: string): number {
    try {
        const parsed = JSON.parse(raw) as {
            buckets?: Record<string, { count?: number }>;
        };
        return parsed.buckets?.[BUCKET]?.count ?? 0;
    } catch {
        return 0;
    }
}

function makeApi(log: Log, o: Options, bucket: string): NavigationAPI {
    const store = new Map<string, string>();
    // 多桶预置（分享口令那把锁按「IP + token」分桶，桶名不固定）
    for (const [key, buckets] of Object.entries(o.guardBuckets ?? {})) {
        const entries: Record<string, unknown> = {};
        for (const [name, g] of Object.entries(buckets)) {
            entries[name] = { count: g.count ?? 0, until: g.until ?? 0, seen: Date.now() };
        }
        store.set(key, JSON.stringify({ version: 2, buckets: entries }));
    }
    for (const [key, g] of Object.entries(o.guards ?? {})) {
        store.set(
            key,
            JSON.stringify({
                buckets: {
                    [bucket]: { count: g.count ?? 0, until: g.until ?? 0, seen: Date.now() },
                },
            })
        );
    }

    return {
        isAuthEnabled: () => o.authEnabled ?? true,
        getConfig: async (key: string) => store.get(key) ?? null,
        setConfig: async (key: string, value: string) => {
            store.set(key, value);
            log.configWrites.push({ key, count: bucketCount(value) });
            log.configRaw.push({ key, raw: value });
            return true;
        },
        compareAndSetConfig: async (key: string, expected: string | null, next: string) => {
            if ((store.get(key) ?? null) !== expected) return false;
            store.set(key, next);
            log.configWrites.push({ key, count: bucketCount(next) });
            log.configRaw.push({ key, raw: next });
            return true;
        },
        getPublicNote: async (token: string, password?: string | null) => {
            log.publicShareReads.push({ kind: "note", token, password: password ?? null });
            return o.publicNote ?? { status: "need-password" };
        },
        getPublicGroupShare: async (token: string, password?: string | null) => {
            log.publicShareReads.push({ kind: "group", token, password: password ?? null });
            return o.publicGroupShare ?? { status: "need-password" };
        },
        login: async (data: { username?: string; remember?: boolean }) => {
            log.logins.push(data);
            return (
                o.login ?? {
                    success: true,
                    message: "登录成功",
                    token: "tok-1",
                    role: "owner",
                    username: "admin",
                }
            );
        },
        registerUser: async (username: string, _password: string, inviteCode: string) => {
            log.registers.push({ username, inviteCode });
            return o.register ?? { success: true, user: { id: 7, username } };
        },
        issueTokenForUser: async (uid: number, _username: string, ttl: number) => {
            log.issued.push({ uid, ttl });
            return "tok-new";
        },
        redeemRecoveryToken: async (token: string) => {
            log.redeems.push(token);
            return o.recover ?? { success: true, message: "密码已重置" };
        },
        hasRecoveryKey: async () => o.hasRecoveryKey ?? false,
        verifyToken: async () => o.verify ?? { valid: true, payload: { uid: 1 } },
        setCurrentUser: (uid: number | null) => {
            log.setUsers.push(uid);
        },
        mustChangePassword: async () => o.mustChange ?? false,
        recordSession: async (token: string) => {
            log.sessions.push(token);
        },
        initDB: async () => {
            log.inits += 1;
            return o.initResult ?? { alreadyInitialized: true };
        },
        writeAudit: async (action: string, _u: string, _ip: string, detail?: string) => {
            log.audits.push({ action, detail });
        },
    } as unknown as NavigationAPI;
}

const BUCKET = "203.0.113.1";

/** 分享分支会碰 env.DB（查 note_share 的 password 用来签附件会话 Cookie） */
function fakeEnv(): Record<string, unknown> {
    const stmt = {
        bind: () => stmt,
        first: async () => ({ password: null }),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
    };
    return {
        DB: {
            prepare: () => stmt,
            batch: async () => [],
        },
    };
}

function makeCtx(
    api: NavigationAPI,
    request: Request,
    path: string,
    method: string,
    env: Record<string, unknown> = {}
): RouteCtx {
    return {
        request,
        env,
        url: new URL(request.url),
        path,
        method,
        api,
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
}

async function call(
    o: Options,
    path: string,
    method: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    env: Record<string, unknown> = fakeEnv()
): Promise<{ res: Response | null; log: Log }> {
    const log = emptyLog();
    const api = makeApi(log, o, BUCKET);
    const request = new Request(`${HOST}/api/${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": IP,
            ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await handlePublicRoutes(makeCtx(api, request, path, method, env));
    return { res, log };
}

async function json(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
}

// ==================== 登录 ====================

test("登录：校验不通过就 400，根本不碰 api.login", async () => {
    const { res, log } = await call({}, "login", "POST", { username: "", password: "" });
    assert.equal(res?.status, 400);
    assert.deepEqual(log.logins, [], "不合法的入参不该送去校验密码");
});

test("登录：锁定期内直接 429 + Retry-After，且不调用 api.login", async () => {
    const { res, log } = await call(
        { guards: { [LOGIN_GUARD_KEY]: { count: 6, until: Date.now() + 60_000 } } },
        "login",
        "POST",
        { username: "admin", password: "x" }
    );
    assert.equal(res?.status, 429);
    assert.ok(Number(res?.headers.get("Retry-After")) > 0, "要告诉还要等多久");
    assert.deepEqual(log.logins, [], "锁定期间不该再去跑一次密码校验");
    const loginLocked = await errorBody(res!);
    assert.equal(loginLocked.code, "rate_limited");
    assert.ok(loginLocked.message.includes("请"));
});

test("登录成功：写成功审计、登记设备、令牌只进 cookie 不进响应体", async () => {
    const { res, log } = await call({}, "login", "POST", {
        username: "admin",
        password: "x",
    });
    assert.equal(res?.status, 200);
    const body = await json(res!);
    assert.equal(body.success, true);

    assert.ok(
        log.audits.some(a => a.action === "login.success"),
        "登录成功要留审计"
    );
    assert.deepEqual(log.sessions, ["tok-1"], "要登记设备，之后才好单独踢下线");

    const setCookie = res!.headers.getSetCookie();
    assert.ok(setCookie.length > 0, "令牌要放进 Set-Cookie");
    assert.ok(
        setCookie.some(c => c.includes("HttpOnly")),
        "必须是 httpOnly，JS 拿不到才不怕 XSS 偷令牌"
    );
    assert.equal(
        JSON.stringify(body).includes("tok-1"),
        false,
        "令牌不能出现在响应体里（只走 httpOnly cookie）"
    );
});

test("登录：「记住我」用长 TTL，不勾用默认 TTL", async () => {
    const remembered = await call({}, "login", "POST", {
        username: "admin",
        password: "x",
        remember: true,
    });
    const maxAge = (c: string) => Number(/Max-Age=(\d+)/i.exec(c)?.[1] ?? 0);
    const longMax = Math.max(...remembered.res!.headers.getSetCookie().map(maxAge));

    const normal = await call({}, "login", "POST", { username: "admin", password: "x" });
    const shortMax = Math.max(...normal.res!.headers.getSetCookie().map(maxAge));

    assert.equal(longMax, REMEMBER_TOKEN_TTL);
    assert.ok(shortMax < longMax, "不勾记住我不该拿到 30 天的令牌");
});

test("登录失败第 1 次：文案说还剩几次，状态码仍是 401（还没锁）", async () => {
    const { res, log } = await call(
        { login: { success: false, message: "用户名或密码错误" } },
        "login",
        "POST",
        { username: "admin", password: "bad" }
    );
    assert.equal(res?.status, 401, "第 1 次失败不该就上 429");
    const body = await json(res!);
    assert.ok(String(body.message).includes("还可尝试"), `实际文案：${body.message}`);
    assert.ok(log.audits.some(a => a.action === "login.failed"));
    assert.deepEqual(
        log.configWrites.filter(w => w.key === LOGIN_GUARD_KEY),
        [{ key: LOGIN_GUARD_KEY, count: 1 }],
        "失败要真的计上数，否则锁永远不会落下来"
    );
});

test("登录失败刚好用光免费次数：说「已达上限」但仍未锁定", async () => {
    // 这是修过的 bug：早先按「剩余次数」判断，第 5 次（还没真锁）就说「已暂时锁定」
    const { res } = await call(
        {
            login: { success: false, message: "用户名或密码错误" },
            guards: { [LOGIN_GUARD_KEY]: { count: 4 } },
        },
        "login",
        "POST",
        { username: "admin", password: "bad" }
    );
    assert.equal(res?.status, 401, "第 5 次只是用光免费次数，锁还没落下来");
    const body = await json(res!);
    assert.ok(String(body.message).includes("已达尝试上限"), `实际文案：${body.message}`);
});

test("登录失败超过阈值：429 + Retry-After，文案说要等多久", async () => {
    const { res } = await call(
        {
            login: { success: false, message: "用户名或密码错误" },
            guards: { [LOGIN_GUARD_KEY]: { count: 5 } },
        },
        "login",
        "POST",
        { username: "admin", password: "bad" }
    );
    assert.equal(res?.status, 429);
    assert.ok(Number(res?.headers.get("Retry-After")) > 0);
    const body = await json(res!);
    assert.ok(String(body.message).includes("秒后再试"), `实际文案：${body.message}`);
});

test("登录成功要把限频计数清零（之前的手滑不该一直累积）", async () => {
    const { res, log } = await call(
        { guards: { [LOGIN_GUARD_KEY]: { count: 3 } } },
        "login",
        "POST",
        { username: "admin", password: "x" }
    );
    assert.equal(res?.status, 200);
    // readLoginGuard 拿到 count=3 → 成功分支会 writeLoginGuard({count:0, until:0})
    assert.ok(log.logins.length === 1);
});

// ==================== 注册 ====================

test("注册：未启用鉴权的部署必须拒绝（整站公开时没有「账号」可言）", async () => {
    const { res, log } = await call({ authEnabled: false }, "auth/register", "POST", {
        username: "u",
        password: "p",
        inviteCode: "c",
    });
    assert.equal(res?.status, 400);
    assert.deepEqual(log.registers, [], "不该真的建号");
    const reg = await errorBody(res!);
    assert.equal(reg.code, "bad_request");
    assert.ok(reg.message.includes("无需注册"));
});

test("注册：锁定期内 429，且不真的建号", async () => {
    const { res, log } = await call(
        {
            authEnabled: true,
            guards: { [REGISTER_GUARD_KEY]: { count: 11, until: Date.now() + 60_000 } },
        },
        "auth/register",
        "POST",
        { username: "u", password: "p", inviteCode: "c" }
    );
    assert.equal(res?.status, 429);
    assert.deepEqual(log.registers, [], "锁定期间不能建号");
});

test("注册成功也计一次频 —— 否则「注册→清零→再注册」可以无限刷", async () => {
    const { res, log } = await call({ authEnabled: true }, "auth/register", "POST", {
        username: "u",
        password: "p",
        inviteCode: "c",
    });
    assert.equal(res?.status, 200);
    assert.equal(log.registers.length, 1);
    assert.ok(
        log.audits.some(a => a.action === "auth.register"),
        "注册成功要留审计"
    );
    assert.deepEqual(
        log.configWrites.filter(w => w.key === REGISTER_GUARD_KEY),
        [{ key: REGISTER_GUARD_KEY, count: 1 }],
        "注册成功**也要**计一次：成功要跑十万次 PBKDF2 + 落库，代价不比失败小；\n"
        + "一清零就变成「注册 → 归零 → 继续注册」的无限循环"
    );
});

test("注册失败：写失败审计，且同样计一次频", async () => {
    const { res, log } = await call(
        { authEnabled: true, register: { success: false, message: "邀请码无效" } },
        "auth/register",
        "POST",
        { username: "u", password: "p", inviteCode: "bad" }
    );
    assert.equal(res?.status, 400);
    assert.ok(log.audits.some(a => a.action === "auth.register.failed"));
    assert.deepEqual(
        log.configWrites.filter(w => w.key === REGISTER_GUARD_KEY),
        [{ key: REGISTER_GUARD_KEY, count: 1 }],
        "失败要计次，不然可以无限撞邀请码"
    );
});

test("注册成功直接签令牌（不用回登录页再输一遍）", async () => {
    const { res, log } = await call({ authEnabled: true }, "auth/register", "POST", {
        username: "u",
        password: "p",
        inviteCode: "c",
    });
    assert.ok(res!.headers.getSetCookie().length > 0);
    assert.deepEqual(log.issued, [{ uid: 7, ttl: 24 * 60 * 60 }]);
});

test("注册：请求体不是 JSON 就明确 400（2026-10-24 起不再静默规整成空对象）", async () => {
    const log = emptyLog();
    const api = makeApi(log, { authEnabled: true }, BUCKET);
    const request = new Request(`${HOST}/api/auth/register`, {
        method: "POST",
        body: "not-json",
    });
    // 老行为：catch 成空对象后拿空串继续往下建号 —— 与「没守」无异，
    // 还把「客户端发错了」包装成「服务端处理完了」。现在 readJsonBody 抛
    // ApiError(400)，由入口（worker/index.ts 的 catch-all）翻译成响应。
    let thrown: unknown = null;
    try {
        await handlePublicRoutes(makeCtx(api, request, "auth/register", "POST"));
    } catch (error) {
        thrown = error;
    }
    assert.ok(
        thrown instanceof ApiError && thrown.status === 400,
        `坏 JSON 必须抛 400，实际：${String(thrown)}`
    );
    assert.deepEqual(log.registers, [], "400 之后不该走到建号那一步");
});

test("注册：用户名前后空格要 trim（'  admin  ' 不该建成另一个账号）", async () => {
    const { log } = await call({ authEnabled: true }, "auth/register", "POST", {
        username: "  admin  ",
        password: "p",
        inviteCode: "  CODE  ",
    });
    assert.deepEqual(log.registers, [{ username: "admin", inviteCode: "CODE" }]);
});

// ==================== 密钥恢复 ====================

test("恢复：空令牌直接 400，不去调 redeem", async () => {
    const { res, log } = await call({}, "auth/recover", "POST", { token: "   " });
    assert.equal(res?.status, 400);
    assert.deepEqual(log.redeems, []);
});

test("恢复：锁定期内 429，且不真的去兑令牌", async () => {
    const { res, log } = await call(
        { guards: { [RECOVER_GUARD_KEY]: { count: 11, until: Date.now() + 60_000 } } },
        "auth/recover",
        "POST",
        { token: "abc" }
    );
    assert.equal(res?.status, 429);
    assert.deepEqual(log.redeems, [], "锁定期间不该去验签");
});

test("恢复成功：写成功审计", async () => {
    const { res, log } = await call(
        { recover: { success: true, message: "密码已重置" } },
        "auth/recover",
        "POST",
        { token: "good" }
    );
    assert.equal(res?.status, 200);
    assert.ok(log.audits.some(a => a.action === "auth.recover"));
});

test("恢复失败：写失败审计并累加计数", async () => {
    const { res, log } = await call(
        { recover: { success: false, message: "令牌无效" } },
        "auth/recover",
        "POST",
        { token: "bad" }
    );
    assert.equal(res?.status, 400, "验签失败是 400，不是 401 —— 这里没有「认证」可言");
    assert.ok(log.audits.some(a => a.action === "auth.recover.failed"));
    assert.deepEqual(
        log.configWrites.filter(w => w.key === RECOVER_GUARD_KEY),
        [{ key: RECOVER_GUARD_KEY, count: 1 }],
        "私钥泄露时，限频是最后一道防线 —— 失败必须计数"
    );
});

// ==================== 恢复公钥状态 ====================

test("recovery-status：带令牌时按当前账号回答（公钥是每个账号自己的）", async () => {
    const { res, log } = await call(
        { verify: { valid: true, payload: { uid: 42 } }, hasRecoveryKey: true },
        "auth/recovery-status",
        "GET",
        undefined,
        { Cookie: "navihive_token=good" }
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setUsers, [42], "要先认出是谁，再回答他有没有配过");
    const body = await json(res!);
    assert.equal(body.configured, true);
});

test("recovery-status：不下发公钥本身，只回布尔", async () => {
    const { res } = await call({ hasRecoveryKey: true }, "auth/recovery-status", "GET");
    const raw = await res!.text();
    assert.deepEqual(Object.keys(JSON.parse(raw)), ["configured"]);
    assert.equal(raw.includes("BEGIN"), false, "公钥内容不能出现在响应里");
});

test("recovery-status：没令牌就不绑 uid（新注册账号不能被显示成「已配置」）", async () => {
    const { res, log } = await call({}, "auth/recovery-status", "GET");
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setUsers, [], "没认出身份就不该绑任何 uid");
});

test("recovery-status：令牌验签不过时不绑 uid", async () => {
    const { res, log } = await call(
        { verify: { valid: false } },
        "auth/recovery-status",
        "GET"
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setUsers, [], "验签不过的令牌不能拿来认身份");
});

// ==================== 初始化 ====================

test("init：锁定期内 429", async () => {
    const { res, log } = await call(
        { guards: { [INIT_GUARD_KEY]: { count: 21, until: Date.now() + 30_000 } } },
        "init",
        "GET"
    );
    assert.equal(res?.status, 429);
    assert.equal(log.inits, 0, "锁定期间不该去动数据库");
});

test("init：已初始化与未初始化返回**完全一样**的响应（否则等于告诉扫描器这台是新装的）", async () => {
    const fresh = await call({ initResult: { alreadyInitialized: false } }, "init", "GET");
    const done = await call({ initResult: { alreadyInitialized: true } }, "init", "GET");

    assert.equal(fresh.res?.status, 200);
    assert.equal(done.res?.status, 200);
    const freshBody = await fresh.res!.text();
    const doneBody = await done.res!.text();
    // ⚠️ maintenance 字段（2026-10-12 维护模式）与「初始化没有」无关：它读的是全站
    // 配置 maintenance.enabled，两种初始化状态下取值相同 —— 所以逐字节相等这条
    // 防扫描断言照旧成立，只是期望值里多一个恒定的 false。
    assert.deepEqual(JSON.parse(freshBody), { ok: true, initialized: true, maintenance: false });
    assert.equal(
        freshBody,
        doneBody,
        "两个分支的响应必须逐字节相同，扫描器才分不出来"
    );
});

test("init：已初始化不计次（正常回源探测不该把人锁住）", async () => {
    const done = await call({ initResult: { alreadyInitialized: true } }, "init", "GET");
    assert.equal(done.log.inits, 1);
    assert.deepEqual(
        done.log.configWrites.filter(w => w.key === INIT_GUARD_KEY),
        [],
        "已初始化不该往限频桶里写 —— 否则健康检查式探测几轮就把自己锁了"
    );

    // 反过来：首次真初始化要计上一次
    const fresh = await call({ initResult: { alreadyInitialized: false } }, "init", "GET");
    assert.deepEqual(
        fresh.log.configWrites.filter(w => w.key === INIT_GUARD_KEY),
        [{ key: INIT_GUARD_KEY, count: 1 }],
        "首次初始化要计次，不然扫描器可以无限刷"
    );
});

// ==================== 不认领 ====================

test("不归本模块的路径返回 null（交给下一个模块）", async () => {
    const { res } = await call({}, "unknown-thing", "GET");
    assert.equal(res, null);
});

test("本模块认领的路径但方法不对：不认领（交给鉴权后的路由或 405 兜底）", async () => {
    const { res } = await call({}, "login", "GET");
    assert.equal(res, null);
});

// ==================== 分享口令限速（第七把锁的**路由接线**） ====================
//
// 这里测的不是 guard 本身（那在 shareGuard.test.ts 里），而是「public.ts 真的把它接上了」。
// 分享口令是全站唯一还能被反复试的密码入口，而校验是 PBKDF2（10 万次迭代）——
// 没限速时一条不需要任何凭据的公开端点就能被当成 CPU 放大器。

const SHARE_TOKEN = "a".repeat(64);
const SHARE_BUCKET = shareBucket(
    new Request(`${HOST}/api/x`, { headers: { "CF-Connecting-IP": IP } }),
    SHARE_TOKEN
);

test("分组分享：不带口令的 GET 还是 200 + need-password（公开页靠它弹框），且**不计失败**", async () => {
    const { res, log } = await call({}, `group-shares/${SHARE_TOKEN}`, "GET");
    assert.equal(res?.status, 200, "这一路的契约一直是 200 + status 字段，别改成 401");
    assert.equal((await json(res!)).status, "need-password");
    assert.deepEqual(
        log.configWrites.filter(w => w.key === SHARE_GUARD_KEY),
        [],
        "访客只是打开页面（没带口令），不该被当成一次猜测去计数"
    );
});

test("分组分享：带错口令只计一次，仍回 200 + need-password（未到阈值不锁）", async () => {
    const { res, log } = await call({}, `group-shares/${SHARE_TOKEN}`, "POST", { password: "bad" });
    assert.equal(res?.status, 200);
    assert.equal((await json(res!)).status, "need-password");
    const writes = log.configWrites.filter(w => w.key === SHARE_GUARD_KEY);
    assert.equal(writes.length, 1, "带了口令且错了，必须计一次");
    assert.equal(
        lastCountOf(log, SHARE_GUARD_KEY, SHARE_BUCKET),
        1,
        "这个桶的计数要真的 +1（不是写了个空 store）"
    );
});

test("分组分享：第 6 次错口令 → 429 + Retry-After", async () => {
    const { res } = await call(
        {
            guardBuckets: {
                [SHARE_GUARD_KEY]: { [SHARE_BUCKET]: { count: 5 } },
            },
        },
        `group-shares/${SHARE_TOKEN}`,
        "POST",
        { password: "bad" }
    );
    assert.equal(res?.status, 429, "超过阈值必须锁");
    assert.ok(Number(res?.headers.get("Retry-After")) > 0, "要告诉还要等多久");
});

test("分组分享：锁定期内直接 429，**连 PBKDF2 都不跑**（api 一次都没被调用）", async () => {
    const { res, log } = await call(
        {
            guardBuckets: {
                [SHARE_GUARD_KEY]: { [SHARE_BUCKET]: { count: 9, until: Date.now() + 60_000 } },
            },
        },
        `group-shares/${SHARE_TOKEN}`,
        "POST",
        { password: "bad" }
    );
    assert.equal(res?.status, 429);
    assert.deepEqual(
        log.publicShareReads,
        [],
        "锁定期间不该再去跑一次口令校验 —— 那正是这条限速要省的 CPU"
    );
});

test("笔记分享：带错口令 → 401 + needPassword，并计一次", async () => {
    const { res, log } = await call({}, `note-shares/${SHARE_TOKEN}`, "POST", { password: "bad" });
    assert.equal(res?.status, 401);
    const body = await errorBody(res!);
    assert.equal(body.code, "unauthenticated");
    assert.equal(log.configWrites.filter(w => w.key === SHARE_GUARD_KEY).length, 1);
});

test("笔记分享：锁定期内 429，且不调 api.getPublicNote", async () => {
    const { res, log } = await call(
        {
            guardBuckets: {
                [SHARE_GUARD_KEY]: { [SHARE_BUCKET]: { count: 9, until: Date.now() + 60_000 } },
            },
        },
        `note-shares/${SHARE_TOKEN}`,
        "POST",
        { password: "bad" }
    );
    assert.equal(res?.status, 429);
    assert.deepEqual(log.publicShareReads, [], "锁定期内不该跑哈希");
});

test("笔记分享：口令对就**清零**（之前的手滑不该一直累积）", async () => {
    const { log } = await call(
        {
            publicNote: { status: "ok", note: { title: "t", content: "c" }, views: 1 },
            guardBuckets: {
                [SHARE_GUARD_KEY]: { [SHARE_BUCKET]: { count: 3 } },
            },
        },
        `note-shares/${SHARE_TOKEN}`,
        "POST",
        { password: "good" }
    );
    const writes = log.configWrites.filter(w => w.key === SHARE_GUARD_KEY);
    assert.ok(writes.length > 0, "口令正确要写一次清零");
    assert.equal(
        lastCountOf(log, SHARE_GUARD_KEY, SHARE_BUCKET),
        0,
        "成功之后这个桶的计数必须归零"
    );
});

test("笔记分享：带口令但分享根本不存在（not-found）时不计数（不是猜错，是链接失效）", async () => {
    const { res, log } = await call(
        { publicNote: { status: "not-found" } },
        `note-shares/${SHARE_TOKEN}`,
        "POST",
        { password: "whatever" }
    );
    assert.equal(res?.status, 404);
    assert.deepEqual(
        log.configWrites.filter(w => w.key === SHARE_GUARD_KEY),
        [],
        "失效链接不该消耗访客的尝试次数"
    );
});

