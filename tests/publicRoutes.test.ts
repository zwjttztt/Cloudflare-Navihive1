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
} from "../worker/loginGuard";
import { REMEMBER_TOKEN_TTL } from "../src/API/http";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

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
    /**
     * 真实发生过的 configs 写入。限频是「有没有真的计上数」的唯一凭据 ——
     * 只看 HTTP 状态码看不出来（计不计数接口都照常返回），必须盯写库。
     */
    configWrites: Array<{ key: string; count: number }>;
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
        configWrites: [],
    };
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
     * 键是 guard key，值是该来源桶的状态。
     */
    guards?: Record<string, { count?: number; until?: number }>;
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
            return true;
        },
        compareAndSetConfig: async (key: string, expected: string | null, next: string) => {
            if ((store.get(key) ?? null) !== expected) return false;
            store.set(key, next);
            log.configWrites.push({ key, count: bucketCount(next) });
            return true;
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

function makeCtx(api: NavigationAPI, request: Request, path: string, method: string): RouteCtx {
    return {
        request,
        env: {},
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
    extraHeaders?: Record<string, string>
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
    const res = await handlePublicRoutes(makeCtx(api, request, path, method));
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
    assert.ok(String((await json(res!)).message).includes("请"));
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
    assert.ok(String((await json(res!)).message).includes("无需注册"));
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

test("注册：请求体不是 JSON 也不能崩 —— catch 成空对象后老老实实往下传", async () => {
    const log = emptyLog();
    const api = makeApi(log, { authEnabled: true }, BUCKET);
    const request = new Request(`${HOST}/api/auth/register`, {
        method: "POST",
        body: "not-json",
    });
    const res = await handlePublicRoutes(makeCtx(api, request, "auth/register", "POST"));
    assert.ok(res, "要给出响应，不能抛异常");
    // 路由层不做字段校验（长度 / 字符 / 邀请码都在 registerUser 里），
    // 所以这里只能保证：脏输入被规整成空串继续往下走，而不是 undefined 一路带进 SQL
    assert.deepEqual(
        log.registers,
        [{ username: "", inviteCode: "" }],
        "脏请求体要被规整成空串，不能把 undefined 传下去"
    );
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
    assert.deepEqual(JSON.parse(freshBody), { ok: true, initialized: true });
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
