// tests/authMiddleware.test.ts
// 鉴权中间件（worker/routes/middleware.ts）的行为用例。
//
// routeCoverage.test.ts 只证明「这个 path/method 有模块认领」，不证明认领之后做了什么。
// 中间件恰恰是那个「做了什么」最要紧的地方 —— 它守着整站的数据边界：
//
// - **缺 uid 的老令牌必须拒**（users 表非空时）：一旦放行，scopeSql 就不带 user_id 条件，
//   这张令牌能看到全站点的数据（含解密后的站点密码），比普通越权严重得多；
// - **账号被停用 / 已清除也必须拒**：令牌是自包含的，「记住我」能活 30 天，
//   不额外查一次账号态，停用就形同虚设；
// - **但 logout 必须放行**：被挡住的人至少要能把自己登出去，否则界面卡死在登录态。

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceAuth, type TokenSession } from "../worker/routes/middleware";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";

interface Log {
    setUser: Array<number | null>;
    touchedActive: number[];
    touchedSession: string[];
    accountStateQueries: number[];
}

interface Options {
    authEnabled?: boolean;
    /** 验签结果；payload 里带不带 uid 决定走「新令牌」还是「遗留令牌」分支 */
    verify?: { valid: boolean; payload?: { uid?: number; jti?: string; exp?: number } };
    /** 账号在库里的状态 */
    accountState?: "active" | "disabled" | "missing";
    /** users 表里是不是已经有账号（决定遗留令牌能不能放行） */
    hasAnyUser?: boolean;
}

function makeApi(log: Log, o: Options): NavigationAPI {
    return {
        isAuthEnabled: () => o.authEnabled ?? true,
        verifyToken: async () => o.verify ?? { valid: true, payload: { uid: 1, jti: "jti-1", exp: 999 } },
        setCurrentUser: (uid: number | null) => {
            log.setUser.push(uid);
        },
        getAccountSessionState: async (uid: number) => {
            log.accountStateQueries.push(uid);
            return o.accountState ?? "active";
        },
        hasAnyUser: async () => o.hasAnyUser ?? true,
        touchLastActive: async (uid: number) => {
            log.touchedActive.push(uid);
        },
        touchSession: async (jti: string) => {
            log.touchedSession.push(jti);
        },
    } as unknown as NavigationAPI;
}

function makeRequest(path: string, init: RequestInit = {}): Request {
    return new Request(`${HOST}/api/${path}`, init);
}

function makeCtx(
    api: NavigationAPI,
    request: Request,
    path: string,
    method: string
): { ctx: RouteCtx; session: TokenSession } {
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
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    return { ctx, session };
}

const cookieHeader = (token: string) => ({ Cookie: `navihive_token=${token}` });

async function call(
    o: Options,
    path = "groups",
    init: RequestInit = {}
): Promise<{ res: Response | null; log: Log; session: TokenSession }> {
    const log: Log = { setUser: [], touchedActive: [], touchedSession: [], accountStateQueries: [] };
    const api = makeApi(log, o);
    const request = makeRequest(path, { method: "GET", ...init });
    const { ctx, session } = makeCtx(api, request, path, init.method ?? "GET");
    const res = await enforceAuth(ctx, session);
    return { res, log, session };
}

test("未启用鉴权的部署：整站公开，直接放行", async () => {
    const { res, log } = await call({ authEnabled: false });
    assert.equal(res, null);
    assert.deepEqual(log.setUser, [], "没开鉴权就没有账号概念，不该绑任何 uid");
});

test("既没 cookie 也没 Authorization：401 并要求 Bearer", async () => {
    const { res } = await call({});
    assert.equal(res?.status, 401);
    assert.equal(res?.headers.get("WWW-Authenticate"), "Bearer");
});

test("Authorization 不是 Bearer（或缺值）：401 说认证信息无效", async () => {
    const bad = await call({}, "groups", { headers: { Authorization: "Basic abc" } });
    assert.equal(bad.res?.status, 401);
    assert.ok((await bad.res!.text()).includes("无效的认证信息"));

    const empty = await call({}, "groups", { headers: { Authorization: "Bearer" } });
    assert.equal(empty.res?.status, 401);
});

test("令牌验签不过：401 提示重新登录", async () => {
    const { res } = await call({ verify: { valid: false } }, "groups", {
        headers: cookieHeader("expired"),
    });
    assert.equal(res?.status, 401);
    assert.ok((await res.text()).includes("重新登录"));
});

test("正常令牌：绑上 uid、记下 jti/exp、刷新活跃时间，然后放行", async () => {
    const { res, log, session } = await call({}, "groups", { headers: cookieHeader("good") });
    assert.equal(res, null);
    assert.deepEqual(log.setUser, [1]);
    assert.equal(session.jti, "jti-1");
    assert.equal(session.exp, 999);
    assert.deepEqual(log.touchedActive, [1]);
    assert.deepEqual(log.touchedSession, ["jti-1"]);
});

test("遗留令牌（没有 uid）且库里已有账号：一律拒绝，绝不降级成「看全部数据」", async () => {
    const { res, log } = await call(
        { verify: { valid: true, payload: { jti: "old", exp: 1 } }, hasAnyUser: true },
        "groups",
        { headers: cookieHeader("legacy") }
    );
    assert.equal(res?.status, 401, "缺 uid 的令牌放行就等于全站数据可见");
    assert.deepEqual(log.setUser, [], "绝不能走到 setCurrentUser(null) 那条路");
});

test("遗留令牌但库里还没有账号（首次部署）：放行并绑为 null", async () => {
    const { res, log } = await call(
        { verify: { valid: true, payload: { jti: "old", exp: 1 } }, hasAnyUser: false },
        "groups",
        { headers: cookieHeader("legacy") }
    );
    assert.equal(res, null);
    assert.deepEqual(log.setUser, [null]);
});

test("账号已被停用：403，并把「可用恢复密钥找回」带过去", async () => {
    const { res } = await call({ accountState: "disabled" }, "groups", {
        headers: cookieHeader("good"),
    });
    assert.equal(res?.status, 403);
    const body = (await res!.json()) as { message: string };
    assert.ok(body.message.includes("恢复密钥"), `被停用的人得知道还能怎么找回，实际：${body.message}`);
});

test("账号已不存在：401（客户端见到 401 会清登录标记退回登录页）", async () => {
    const { res } = await call({ accountState: "missing" }, "groups", {
        headers: cookieHeader("good"),
    });
    assert.equal(res?.status, 401);
    const body = (await res!.json()) as { message: string };
    assert.ok(body.message.includes("不存在"));
});

test("logout 不查账号态：被停用的人也要能把自己登出去", async () => {
    const { res, log } = await call({ accountState: "disabled" }, "logout", {
        method: "POST",
        headers: cookieHeader("good"),
    });
    assert.equal(res, null, "logout 必须放行，否则界面卡在登录态出不去");
    assert.deepEqual(log.accountStateQueries, []);
});

test("写操作跨站（cookie 令牌）：403 拒绝", async () => {
    const { res } = await call({}, "groups", {
        method: "POST",
        headers: { ...cookieHeader("good"), Origin: "https://evil.example.com" },
    });
    assert.equal(res?.status, 403);
    assert.ok((await res!.text()).includes("跨站"));
});

test("读操作跨站：不拦（只读接口本来就被人直接访问）", async () => {
    const { res } = await call({}, "groups", {
        headers: { ...cookieHeader("good"), Origin: "https://evil.example.com" },
    });
    assert.equal(res, null);
});

test("用 Authorization 头带的令牌做写操作：不按 CSRF 拦（脚本客户端没有 Origin 可判）", async () => {
    const { res } = await call({}, "groups", {
        method: "POST",
        headers: { Authorization: "Bearer good" },
    });
    assert.equal(res, null);
});

test("Sec-Fetch-Site: same-origin 的写操作放行", async () => {
    const { res } = await call({}, "groups", {
        method: "POST",
        headers: { ...cookieHeader("good"), "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(res, null);
});

test("HEAD 请求不算写操作，跨站也不拦", async () => {
    const { res } = await call({}, "groups", {
        method: "HEAD",
        headers: { ...cookieHeader("good"), Origin: "https://evil.example.com" },
    });
    assert.equal(res, null);
});
