// tests/accountRoutes.test.ts
// 账号类路由（worker/routes/account.ts，324 行）的行为用例。
//
// routeCoverage 只证明「这些 path/method 有模块认领」，这里钉的是认领之后做的事。
// 这一组的共同风险是**权限判定**：邀请码、账号列表、沉睡扫描、改别人状态都只能 owner 做，
// 判错的后果不是报错，而是「普通账号能拉人进来」或者「owner 页打不开」。
// 另外还有两条很容易被改坏的顺序 / 边界：
//   - `users/sweep` 必须排在 `users/:id/status` 前面（后者会把 "sweep" 当 id 去 parseInt）；
//   - 注销账号必须再验一次密码，且成功后要把当前令牌一起拉黑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAccountRoutes } from "../worker/routes/account";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

interface Log {
    blacklisted: Array<{ jti: string; exp: number }>;
    audits: Array<{ action: string; target: string; detail: string }>;
    invites: number;
    revoked: string[];
    revokedOthers: number;
    statusCalls: Array<{ id: number; status: string }>;
    deleteAccount: number;
    credentials: Array<{ username: string; password: string; currentPassword: string }>;
    recoveryKeys: string[];
}

function emptyLog(): Log {
    return {
        blacklisted: [],
        audits: [],
        invites: 0,
        revoked: [],
        revokedOthers: 0,
        statusCalls: [],
        deleteAccount: 0,
        credentials: [],
        recoveryKeys: [],
    };
}

interface Options {
    /** 当前账号 id；null 表示站点没启用登录 */
    uid?: number | null;
    /** 当前账号角色 */
    role?: "owner" | "user";
    /** getUserById 查不到人（令牌有效但账号已被注销） */
    userMissing?: boolean;
    /** 注销时密码校验的结果 */
    passwordOk?: boolean;
    /** createInvite 的结果 */
    invite?: { success: boolean; code?: string; message?: string };
}

function makeApi(log: Log, o: Options): NavigationAPI {
    const uid = o.uid === undefined ? 1 : o.uid;
    return {
        getCurrentUserId: () => uid,
        getUserById: async () =>
            o.userMissing ? null : { id: uid, username: `u${uid}`, role: o.role ?? "owner" },
        blacklistToken: async (jti: string, exp: number) => {
            log.blacklisted.push({ jti, exp });
        },
        writeAudit: async (action: string, target: string, _ip: string, detail = "") => {
            log.audits.push({ action, target, detail });
        },
        createInvite: async () => {
            log.invites += 1;
            return o.invite ?? { success: true, code: "ABCD1234" };
        },
        listUsers: async () => [{ id: 1, username: "owner", role: "owner" }],
        sweepInactiveUsers: async () => ({ disabled: 2, deleted: 1 }),
        listSessions: async () => [{ jti: "j1", device: "PC" }],
        revokeSession: async (_u: number, jti: string) => {
            log.revoked.push(jti);
            return { success: true, message: "" };
        },
        revokeOtherSessions: async () => {
            log.revokedOthers += 1;
            return { success: true, revoked: 3 };
        },
        setUserStatus: async (id: number, status: string) => {
            log.statusCalls.push({ id, status });
            return { success: true };
        },
        verifyPasswordOfUser: async () => o.passwordOk ?? true,
        deleteAccount: async () => {
            log.deleteAccount += 1;
            return { success: true, message: "" };
        },
        updateCurrentCredentials: async (username: string, password: string, currentPassword: string) => {
            log.credentials.push({ username, password, currentPassword });
            return { success: true, message: "ok" };
        },
        setRecoveryPublicKey: async (publicKey: string) => {
            log.recoveryKeys.push(publicKey);
            return { success: true };
        },
    } as unknown as NavigationAPI;
}

async function call(
    path: string,
    method: string,
    o: Options = {},
    body?: unknown,
    extra?: { currentJti?: string; currentTokenExp?: number }
): Promise<{ res: Response | null; log: Log }> {
    const log = emptyLog();
    const request = new Request(`${HOST}/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: makeApi(log, o),
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: extra?.currentJti ?? "jti-1",
        currentTokenExp: extra?.currentTokenExp ?? 1700000000,
    } as unknown as RouteCtx;
    const res = await handleAccountRoutes(ctx);
    return { res, log };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

// ---------------- logout ----------------

test("logout：把当前令牌拉黑（真正失效）并清掉 cookie，不是只清前端", async () => {
    const { res, log } = await call("logout", "POST");
    assert.equal(res?.status, 200);
    assert.deepEqual(log.blacklisted, [{ jti: "jti-1", exp: 1700000000 }], "不拉黑的话令牌到过期前还能用");
    const setCookie = res?.headers.getSetCookie?.() ?? [];
    assert.ok(setCookie.length > 0, "必须下发清 cookie 的头");
    assert.ok(
        log.audits.some(a => a.action === "logout"),
        `应留一条审计，实际 ${JSON.stringify(log.audits)}`
    );
});

// ---------------- auth/me ----------------

test("auth/me：没启用登录时给一个稳定的 guest 身份（id 0），界面照常工作", async () => {
    const { res } = await call("auth/me", "GET", { uid: null });
    const body = await json(res!);
    assert.deepEqual(body, { id: 0, username: "guest", role: "owner" });
});

test("auth/me：令牌有效但账号已被注销 → 401，不能返回一个空壳身份", async () => {
    const { res } = await call("auth/me", "GET", { userMissing: true });
    assert.equal(res?.status, 401);
});

test("auth/me：带出 id / 账号名 / 角色（本地数据要按 id 分账号边界）", async () => {
    const { res } = await call("auth/me", "GET", { uid: 7, role: "user" });
    assert.deepEqual(await json(res!), { id: 7, username: "u7", role: "user" });
});

// ---------------- 邀请码 / 账号列表 / 沉睡扫描：只 owner ----------------

test("auth/invite：非 owner 生成邀请码 → 403", async () => {
    const { res, log } = await call("auth/invite", "POST", { role: "user" });
    assert.equal(res?.status, 403);
    assert.equal(log.invites, 0, "被拒了就不该真的生成");
});

test("auth/invite：未启用登录 → 400（没有账号概念，谈不上邀请）", async () => {
    const { res } = await call("auth/invite", "POST", { uid: null });
    assert.equal(res?.status, 400);
});

test("auth/invite：owner 生成成功后要审计（谁能拉人进来必须可追溯）", async () => {
    const { res, log } = await call("auth/invite", "POST");
    assert.equal(res?.status, 200);
    assert.ok(log.audits.some(a => a.action === "auth.invite"));
    assert.ok(
        log.audits.some(a => (a.detail || "").includes("ABCD1234")),
        "审计里要带上邀请码，实际 " + JSON.stringify(log.audits)
    );
});

test("users：普通账号看账号列表 → 403（别人的账号名与活跃时间是隐私）", async () => {
    const { res } = await call("users", "GET", { role: "user" });
    assert.equal(res?.status, 403);
});

test("users/sweep：必须排在 users/:id/status 之前，否则会被当成 id 报「路径无效」", async () => {
    // 这条钉的是路由顺序：users/:id/status 那条用 startsWith("users/") 匹配，
    // 谁把它挪到 sweep 前面，"sweep" 就会被 parseInt 成 NaN 然后 400。
    const { res } = await call("users/sweep", "POST");
    const body = await json(res!);
    assert.deepEqual(body, { success: true, disabled: 2, deleted: 1 }, `实际 ${JSON.stringify(body)}`);
});

test("users/sweep：非 owner → 403", async () => {
    const { res } = await call("users/sweep", "POST", { role: "user" });
    assert.equal(res?.status, 403);
});

test("users/:id/status：路径不是数字 → 400 路径无效，不能拿 NaN 去改库", async () => {
    const { res, log } = await call("users/abc/status", "POST", {}, { status: "active" });
    assert.equal(res?.status, 400);
    assert.equal(log.statusCalls.length, 0);
});

test("users/:id/status：owner 改状态，并把状态原样传下去", async () => {
    const { res, log } = await call("users/12/status", "POST", {}, { status: "disabled" });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.statusCalls, [{ id: 12, status: "disabled" }]);
});

test("users/:id/status：非 owner → 403", async () => {
    const { res } = await call("users/12/status", "POST", { role: "user" }, { status: "active" });
    assert.equal(res?.status, 403);
});

// ---------------- 会话（登录设备） ----------------

test("sessions：未启用登录 → 400", async () => {
    const { res } = await call("sessions", "GET", { uid: null });
    assert.equal(res?.status, 400);
});

test("sessions/:jti DELETE：吊销那一台，并把 jti 传给服务端", async () => {
    const { res, log } = await call("sessions/jti%2Fabc", "DELETE");
    assert.equal(res?.status, 200);
    assert.deepEqual(log.revoked, ["jti/abc"], "路径里的 jti 要解码后再传");
    assert.ok(log.audits.some(a => a.action === "auth.session.revoke"));
});

test("sessions/:jti DELETE：jti 为空 → 400", async () => {
    const { res } = await call("sessions/", "DELETE");
    assert.equal(res?.status, 400);
});

test("sessions/revoke-others：吊销除当前这台之外的全部", async () => {
    const { res, log } = await call("sessions/revoke-others", "POST");
    assert.equal(res?.status, 200);
    assert.equal(log.revokedOthers, 1);
    assert.ok(log.audits.some(a => a.action === "auth.session.revokeOthers"));
});

// ---------------- 注销账号 ----------------

test("注销账号：当前密码不对 → 403 且审计失败原因（捡到已登录的电脑不能毁掉账号）", async () => {
    const { res, log } = await call("account", "DELETE", { passwordOk: false }, { currentPassword: "wrong" });
    assert.equal(res?.status, 403);
    assert.equal(log.deleteAccount, 0, "密码不对绝不许继续注销");
    assert.ok(log.audits.some(a => a.action === "auth.deleteAccount.failed"));
});

test("注销账号成功：账号都没了，当前令牌必须一起作废 + 清 cookie", async () => {
    const { res, log } = await call("account", "DELETE", { passwordOk: true }, { currentPassword: "right" });
    assert.equal(res?.status, 200);
    assert.equal(log.deleteAccount, 1);
    assert.equal(log.blacklisted.length, 1, "不拉黑的话账号删了令牌还能用");
    const setCookie = res?.headers.getSetCookie?.() ?? [];
    assert.ok(setCookie.length > 0);
});

test("注销账号：未启用登录 → 400", async () => {
    const { res } = await call("account", "DELETE", { uid: null }, { currentPassword: "x" });
    assert.equal(res?.status, 400);
});

// ---------------- 凭据与恢复密钥 ----------------

test("auth/credentials：既没新账号也没新密码 → 400，不空转一次写库", async () => {
    const { res, log } = await call("auth/credentials", "PUT", {}, { username: "", password: "" });
    assert.equal(res?.status, 400);
    assert.equal(log.credentials.length, 0);
});

test("auth/credentials：写入当前账号的凭据，并留下审计", async () => {
    const { res, log } = await call(
        "auth/credentials",
        "PUT",
        {},
        { username: "admin2", password: "pw", currentPassword: "old" }
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(log.credentials, [{ username: "admin2", password: "pw", currentPassword: "old" }]);
    assert.ok(log.audits.some(a => a.action === "auth.credentials"));
});

test("auth/recovery-key：校验在服务端内部做（这里只负责把公钥与当前密码传下去）", async () => {
    const { res, log } = await call(
        "auth/recovery-key",
        "PUT",
        {},
        { publicKey: "pk-1", currentPassword: "old" }
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(log.recoveryKeys, ["pk-1"]);
});

// ---------------- 不认领的 path ----------------

test("不归本模块的 path 返回 null（交给后面的模块，别把人家的路由吞掉）", async () => {
    const { res } = await call("bootstrap", "GET");
    assert.equal(res, null);
});
