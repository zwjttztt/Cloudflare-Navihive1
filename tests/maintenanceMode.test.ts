// tests/maintenanceMode.test.ts
// 维护模式中间件（worker/routes/middleware.ts 的 enforceMaintenance）。
//
// 为什么值得单测：这个开关是「把全站写死」的那类功能 —— 判错一条就是两种事故：
//   · 该拦没拦 → 用户往正在迁的库上写，数据错乱；
//   · 不该拦拦了 → owner 把自己锁在外面，连关的地方都没有（GET 也拦的话更糟，
//     用户连「为什么不能写」都看不到）。
// 每条口子都是刻意留的，所以逐条钉死。

import test from "node:test";
import assert from "node:assert/strict";
import { enforceMaintenance } from "../worker/routes/middleware";
import type { RouteCtx } from "../worker/routes/types";

/** 造一个最小 ctx：maintenance 开关 + 当前账号角色可配 */
function ctxOf(opts: {
    method?: string;
    path?: string;
    maintenance?: string | null;
    role?: "owner" | "member" | null;
}): RouteCtx {
    const { method = "POST", path = "sites", maintenance = null, role = null } = opts;
    const uid = role === null ? null : role === "owner" ? 1 : 2;
    const api = {
        getConfig: async (key: string) => (key === "maintenance.enabled" ? maintenance : null),
        getCurrentUserId: () => uid,
        getUserById: async (id: number) =>
            id === 1 ? { id: 1, username: "owner", role: "owner" } : { id: 2, username: "u", role: "member" },
    };
    return {
        request: new Request("https://example.com/api/" + path, { method }),
        env: {} as never,
        url: new URL("https://example.com/api/" + path),
        path,
        method,
        api: api as never,
        ip: "127.0.0.1",
        trustXFF: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    };
}

test("没开维护时一律放行（一个请求都不多拦）", async () => {
    const res = await enforceMaintenance(ctxOf({ maintenance: null }));
    assert.equal(res, null);
    assert.equal(await enforceMaintenance(ctxOf({ maintenance: "0" })), null);
});

test("开着维护：写操作被拦，且是 503 + 机器可读 code", async () => {
    const res = await enforceMaintenance(ctxOf({ maintenance: "1", method: "POST" }));
    assert.ok(res !== null, "POST 该被拦");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "service_unavailable");
    assert.match(body.error.message, /维护中/);
});

test("开着维护：读操作放行（维护中也要能看数据）", async () => {
    assert.equal(await enforceMaintenance(ctxOf({ maintenance: "1", method: "GET" })), null);
    assert.equal(await enforceMaintenance(ctxOf({ maintenance: "1", method: "HEAD" })), null);
});

test("开着维护：认证相关口子放行（不能把人锁在门外）", async () => {
    for (const path of ["auth/credentials", "auth/recover", "auth/logout"]) {
        const res = await enforceMaintenance(ctxOf({ maintenance: "1", method: "POST", path }));
        assert.equal(res, null, `${path} 该放行`);
    }
});

test("开着维护：owner 放行（否则开了维护就没人能关）", async () => {
    const res = await enforceMaintenance(ctxOf({ maintenance: "1", method: "PUT", role: "owner" }));
    assert.equal(res, null, "owner 该放行");
});

test("开着维护：普通账号的写被拦（这条才是维护模式的本体）", async () => {
    const res = await enforceMaintenance(ctxOf({ maintenance: "1", method: "DELETE", role: "member" }));
    assert.ok(res !== null);
    assert.equal(res.status, 503);
});

test("开着维护：未登录的写也被拦", async () => {
    const res = await enforceMaintenance(ctxOf({ maintenance: "1", method: "POST", role: null }));
    assert.ok(res !== null);
    assert.equal(res.status, 503);
});

test("读不到配置时不拦（维护是额外保险，不能因为它自己坏了把全站写死）", async () => {
    const api = {
        getConfig: async () => {
            throw new Error("D1 抽风");
        },
        getCurrentUserId: () => 2,
        getUserById: async () => ({ id: 2, username: "u", role: "member" }),
    };
    const res = await enforceMaintenance({
        ...ctxOf({ maintenance: "1", method: "POST" }),
        api: api as never,
    });
    assert.equal(res, null, "配置读失败要放行");
});
