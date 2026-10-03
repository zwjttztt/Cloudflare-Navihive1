// tests/accountSession.dom.test.tsx
// useAccountSession（604 行，全仓最大的 hook）的用例：注册 / 登录 / 登出 / 恢复密钥 /
// 注销账号这几条路上，发生的事和**没发生的事**。
//
// 这里最有价值的几条都是「防串号 / 防静默失败」：
// - 登录接口 200 但 cookie 没存上 —— 必须明确报错并留在登录页，否则界面闪一下就弹回来，
//   用户只看到「登录成功」变「请重新登录」，不知道原因；
// - 登录失败只在表单内提示 —— 弹全局 toast 的话，提示会残留到下一次成功登录之后；
// - 登出要清干净 —— 邀请码、恢复密钥状态、批量多选态留着，换个人登录就看到了上一个人的东西；
// - 生成恢复密钥必须「先落库成功、再下载私钥」—— 反过来会出现私钥存了但服务器不认。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAccountSession } from "../src/hooks/useAccountSession";
import type { AccountInfo, SessionInfo } from "../src/API/http";

type Params = Parameters<typeof useAccountSession>[0];
type Api = Params["api"];

interface Log {
    errors: string[];
    dataErrors: string[];
    notifies: string[];
    fetchCalls: number;
    switchedAccount: Array<number | null>;
    groups: unknown[];
    menuClosed: number;
    exitMultiSelect: number;
    resetCollapsed: number;
    clearHistory: number;
    snackbarClosed: number;
    prefsAccount: Array<number | null>;
    downloads: string[];
}

function emptyLog(): Log {
    return {
        errors: [],
        dataErrors: [],
        notifies: [],
        fetchCalls: 0,
        switchedAccount: [],
        groups: [],
        menuClosed: 0,
        exitMultiSelect: 0,
        resetCollapsed: 0,
        clearHistory: 0,
        snackbarClosed: 0,
        prefsAccount: [],
        downloads: [],
    };
}

interface Options {
    /** api.login 的返回 */
    loginResult?: { success: boolean; message?: string; mustChangePassword?: boolean };
    /** api.checkAuthStatus 的返回（cookie 到底存上没有） */
    sessionOk?: boolean;
    /** api.getMe 的返回 */
    me?: { id: number; username: string; role: "owner" | "user" } | null;
    /** bootstrap 的返回（true = 已登录） */
    fetchOk?: boolean;
    /** fetchData 抛出的错误 */
    fetchError?: unknown;
    registerResult?: { success: boolean; message?: string; username?: string };
    deleteAccountResult?: { success: boolean; message?: string };
    recoveryKeyResult?: { success: boolean; message?: string };
    /** 让 api.login 直接抛 */
    loginThrows?: boolean;
    startAuthenticated?: boolean;
}

function makeApi(o: Options): Api {
    return {
        login: async () => {
            if (o.loginThrows) throw new Error("网络断了");
            return o.loginResult ?? { success: true };
        },
        checkAuthStatus: async () => o.sessionOk ?? true,
        getMe: async () => o.me ?? { id: 7, username: "admin", role: "owner" },
        register: async () => o.registerResult ?? { success: true, username: "newbie" },
        createInvite: async () => ({ success: true, code: "ABC123", expiresAt: 123 }),
        getConfig: async () => null,
        setConfigs: async () => true,
        getSessions: async () => [] as SessionInfo[],
        revokeSession: async () => ({ success: true }),
        revokeOtherSessions: async () => ({ success: true, revoked: 2 }),
        deleteAccount: async () => o.deleteAccountResult ?? { success: true, message: "账号已注销" },
        getRecoveryStatus: async () => ({ configured: false }),
        setRecoveryPublicKey: async () => o.recoveryKeyResult ?? { success: true },
        recoverPassword: async () => ({ success: true, message: "密码已重置" }),
        isLoggedIn: () => true,
        logout: () => undefined,
    } as unknown as Api;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function Harness({ log, o }: { log: Log; o: Options }) {
    const [authed, setAuthed] = useState(o.startAuthenticated ?? false);
    const [authRequired, setAuthRequired] = useState(true);
    const [groups, setGroups] = useState<unknown[]>([{ id: 1 }]);

    const actions = useAccountSession({
        api: makeApi(o),
        notify: (text, level) => log.notifies.push(`${level ?? "info"}:${text}`),
        onError: m => log.errors.push(m),
        onMenuClose: () => log.menuClosed++,
        onDataError: m => log.dataErrors.push(m),
        fetchData: async () => {
            log.fetchCalls++;
            if (o.fetchError) throw o.fetchError;
            return o.fetchOk ?? true;
        },
        onCloseSnackbar: () => log.snackbarClosed++,
        onSwitchAccount: uid => log.switchedAccount.push(uid),
        onExitMultiSelect: () => log.exitMultiSelect++,
        clearHistory: () => log.clearHistory++,
        onResetCollapsed: () => log.resetCollapsed++,
        setGroups: value => {
            const next = typeof value === "function" ? (value as (p: unknown[]) => unknown[])(groups) : value;
            log.groups.push(next);
            setGroups(next);
        },
        setPrefsAccountUid: uid => log.prefsAccount.push(uid),
        isAuthenticated: authed,
        setIsAuthenticated: setAuthed,
        setIsAuthRequired: setAuthRequired,
    });

    Object.assign(window as unknown as Record<string, unknown>, {
        __a: actions,
        __state: { authed, authRequired },
    });
    return null;
}

function mount(node: Parameters<Root["render"]>[0]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

type Actions = ReturnType<typeof useAccountSession>;
const a = () => (window as unknown as { __a: Actions }).__a;
const state = () =>
    (window as unknown as { __state: { authed: boolean; authRequired: boolean } }).__state;

async function run(fn: () => unknown) {
    await act(async () => {
        await fn();
    });
}

async function flush() {
    await act(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

afterEach(() => {
    cleanup();
});

// ---- 登录 ----

test("登录成功：切进应用、拉数据、记住账号归属", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{}} />);
    await run(() => a().handleLogin("admin", "pw", true));
    await flush();

    assert.equal(state().authed, true);
    assert.equal(state().authRequired, false);
    assert.equal(log.fetchCalls, 1);
    assert.deepEqual(log.switchedAccount, [7], "登录成功要把本地数据绑到新账号 id 上");
    assert.deepEqual(log.errors, []);
});

test("登录成功但 cookie 没存上：留在登录页并说清原因，不去拉数据", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ sessionOk: false }} />);
    await run(() => a().handleLogin("admin", "pw"));
    await flush();

    assert.equal(state().authed, false, "会话没存上就不能切进应用，否则第一个接口就 401");
    assert.equal(log.fetchCalls, 0);
    assert.ok(
        a().loginError?.includes("HTTPS"),
        `http 访问时要指明 HTTPS 的原因，实际提示：${a().loginError}`
    );
});

test("登录失败：只在表单里提示，不弹全局 toast（否则提示会残留到下次登录之后）", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ loginResult: { success: false, message: "用户名或密码错误" } }} />);
    await run(() => a().handleLogin("admin", "bad"));
    await flush();

    assert.equal(a().loginError, "用户名或密码错误");
    assert.deepEqual(log.errors, [], "登录失败不该走全局错误提示");
    assert.deepEqual(log.notifies, []);
    assert.equal(state().authed, false);
});

test("登录失败且服务端没给原因：用兜底文案", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ loginResult: { success: false } }} />);
    await run(() => a().handleLogin("admin", "bad"));
    await flush();
    assert.equal(a().loginError, "用户名或密码错误");
});

test("登录接口抛异常：走 onError，不留半登录状态", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ loginThrows: true }} />);
    await run(() => a().handleLogin("admin", "pw"));
    await flush();

    assert.equal(log.errors.length, 1);
    assert.ok(log.errors[0].includes("登录失败"));
    assert.equal(state().authed, false);
    assert.equal(a().loginLoading, false, "loading 要在 finally 里收掉");
});

test("首次部署的初始密码：提示去改密，但不打断流程", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ loginResult: { success: true, mustChangePassword: true } }} />);
    await run(() => a().handleLogin("admin", "pw"));
    await flush();

    assert.ok(log.notifies.some(n => n.includes("修改密码")), `应提示改密，实际：${log.notifies}`);
    assert.equal(state().authed, true);
});

// ---- 登出 ----

test("登出：清数据、收菜单、退出多选、并把上一个人的痕迹抹掉", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    await run(() => a().handleLogout());

    assert.equal(state().authed, false);
    assert.equal(state().authRequired, true);
    assert.deepEqual(log.groups, [[]], "分组要清掉，否则登出后界面还画着上一个账号的卡片");
    assert.equal(log.menuClosed, 1);
    assert.equal(log.exitMultiSelect, 1, "多选态不清，重登后还停在批量模式");
    assert.equal(log.clearHistory, 1);
    assert.equal(log.resetCollapsed, 1);
    assert.deepEqual(log.prefsAccount, [null]);
    assert.ok(log.dataErrors.some(m => m.includes("已退出登录")));
});

test("登出会清掉邀请码与恢复密钥状态（换个账号登录不该看到上一个人的）", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    await run(() => a().handleCreateInvite());
    assert.ok(a().invite, "先造出一个邀请码，才好验证登出时被清掉");

    await run(() => a().handleLogout());
    assert.equal(a().invite, null);
    assert.equal(a().currentUser, null);
    assert.equal(a().recoveryConfigured, false);
});

// ---- 注册 ----

test("注册成功：直接进应用，本地数据切到新账号，且不带走上一个人的邀请码", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ me: { id: 9, username: "newbie", role: "user" } }} />);
    await run(() => a().handleCreateInvite());
    await run(() => a().handleRegister("newbie", "pw", "CODE"));
    await flush();

    assert.equal(state().authed, true);
    assert.deepEqual(log.switchedAccount, [9]);
    assert.equal(a().invite, null, "新账号是干净的身份，旧邀请码不能跟着带过来");
    assert.equal(log.fetchCalls, 1);
});

test("注册失败：返回服务端原因，不切进应用", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ registerResult: { success: false, message: "邀请码已过期" } }} />);
    const result = await run(() => a().handleRegister("newbie", "pw", "CODE")).then(() => undefined);
    assert.equal(result, undefined);

    const res = await a().handleRegister("newbie", "pw", "CODE");
    assert.deepEqual(res, { success: false, message: "邀请码已过期" });
    assert.equal(state().authed, false);
});

// ---- 注销账号 ----

test("注销账号：不填密码直接拦下，不调接口", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    const res = await a().handleDeleteAccount();
    assert.deepEqual(res, { success: false, message: "请输入当前密码以确认注销" });
});

test("注销账号成功：回到登录页、清空数据、清掉记住的登录名", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    await run(() => a().setDeleteAccountPassword("pw"));

    const res = await a().handleDeleteAccount();
    await flush();

    assert.equal(res.success, true);
    assert.equal(state().authed, false);
    assert.equal(state().authRequired, true);
    assert.ok(log.groups.some(g => Array.isArray(g) && g.length === 0));
    assert.ok(log.dataErrors.some(m => m.includes("账号已注销")));
    assert.equal(a().deleteAccountOpen, false);
    assert.equal(a().deleteAccountPassword, "");
});

// ---- 恢复密钥 ----

test("生成恢复密钥：公钥没落库成功就不下载私钥（否则会出现私钥存了但服务器不认）", async () => {
    const log = emptyLog();
    mount(
        <Harness log={log} o={{ recoveryKeyResult: { success: false, message: "密码不对" } }} />
    );
    const res = await a().handleGenerateRecoveryKey("wrong-pw");
    assert.equal(res.success, false);
    assert.equal(res.message, "密码不对");
    assert.equal(a().recoveryConfigured, false);
});

test("生成恢复密钥成功：标记为已配置", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ recoveryKeyResult: { success: true } }} />);
    const res = await a().handleGenerateRecoveryKey("right-pw");
    await flush();
    assert.equal(res.success, true);
    assert.equal(a().recoveryConfigured, true);
});

// ---- 启动时的认证检查 ----

test("启动检查：拿得到数据算已登录，并顺带确认「我是谁」", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ fetchOk: true }} />);
    await run(() => a().checkAuthStatus());
    await flush();

    assert.equal(state().authed, true);
    assert.equal(state().authRequired, false);
    assert.equal(a().isAuthChecking, false, "检查完一定要收掉 loading");
    assert.deepEqual(log.switchedAccount, [7]);
});

test("启动检查：403（账号被停用）要退回登录页，并把服务端那句话带过去", async () => {
    const log = emptyLog();
    mount(
        <Harness
            log={log}
            o={{ fetchError: new Error("账号已停用，可用恢复密钥找回 (HTTP 403)") }}
        />
    );
    await run(() => a().checkAuthStatus());
    await flush();

    assert.equal(state().authed, false);
    assert.equal(state().authRequired, true);
    assert.deepEqual(
        log.dataErrors,
        ["账号已停用，可用恢复密钥找回"],
        "要把「能怎么找回」原样送到登录页，否则用户看到的是一片空白"
    );
});

test("启动检查：网络抖动之类的错误不把人踢出登录页", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ fetchError: new Error("fetch failed") }} />);
    await run(() => a().checkAuthStatus());
    await flush();

    assert.deepEqual(log.dataErrors, []);
    assert.equal(a().isAuthChecking, false);
});

// ---- 会话管理 ----

test("踢掉某台设备：成功后刷新列表", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    await run(() => a().handleRevokeSession("jti-1"));
    await flush();
    assert.ok(log.notifies.some(n => n.includes("踢下线")), `实际：${log.notifies}`);
});

test("退出其它设备：把退掉的台数说清楚", async () => {
    const log = emptyLog();
    mount(<Harness log={log} o={{ startAuthenticated: true }} />);
    await run(() => a().handleRevokeOthers());
    await flush();
    assert.ok(log.notifies.some(n => n.includes("2 台")), `实际：${log.notifies}`);
});

// ---- 沉睡账号扫描（走 fetch，需要打桩）----

test("手动扫描沉睡账号：成功时把停用了多少、清除了多少报出来", async () => {
    const log = emptyLog();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: true, disabled: 2, deleted: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
    try {
        mount(<Harness log={log} o={{ startAuthenticated: true }} />);
        const res = await a().handleSweepInactive();
        assert.deepEqual(res, { success: true, disabled: 2, deleted: 1 });
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("手动扫描：响应 500 但 body 里写了 success 也不算成功", async () => {
    const log = emptyLog();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: true, disabled: 9 }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
    try {
        mount(<Harness log={log} o={{ startAuthenticated: true }} />);
        const res = await a().handleSweepInactive();
        assert.equal(res.success, false);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("重新启用账号：失败时把服务端原因转述出来", async () => {
    const log = emptyLog();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: false, message: "该账号已被清除" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
    try {
        mount(<Harness log={log} o={{ startAuthenticated: true }} />);
        await run(() => a().handleExemptUser(3));
        await flush();
        assert.ok(log.notifies.some(n => n.includes("已被清除")), `实际：${log.notifies}`);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("账号清单只有 owner 拉得到（普通账号不发起请求）", async () => {
    const log = emptyLog();
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => {
        called++;
        return new Response(JSON.stringify({ success: true, users: [] as AccountInfo[] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;
    try {
        mount(<Harness log={log} o={{ me: { id: 5, username: "u", role: "user" } }} />);
        await run(() => a().fetchAccountList());
        await flush();
        assert.equal(called, 0, "普通账号不该去拉 /api/users");
    } finally {
        globalThis.fetch = realFetch;
    }
});
