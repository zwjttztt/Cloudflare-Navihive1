// tests/healthRoutes.test.ts
// 健康检查两个端点（GET /api/healthz、GET /api/readyz）的契约用例。
//
// 这两个端点是**公开、未鉴权**的，而且是被 Docker HEALTHCHECK / uptime 脚本
// 每 30 秒打一次的常驻请求。三条不能让步的性质：
//
//  1. healthz 零数据库：它只回答「进程还在、HTTP 栈通了」。一旦它开始查库，
//     数据库一慢，编排系统就会杀掉一个其实完全正常的进程。
//  2. readyz 恰好一条 SELECT 1：库打不开 = **503**，不是 200、也不是 500。
//     500 说的是「服务写错了」，503 说的才是「依赖没起来」——Docker 与 upgrader
//     （server/upgradeHealth.ts 用 `State.Health.Status` 做自动回滚判据）都只认这个区别。
//  3. 响应体只有 `ok` 一个键：公开端点带上表名 / 错误信息 / 版本号，就是免费送指纹。
//
// 还有两条容易回退的地方也钉在这里：必须是 no-store（探活结果不能被任何中间层缓存，
// 否则「缓存说健康」能一直骗着编排系统），以及只认 GET（POST 不该有副作用）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePublicRoutes } from "../worker/routes/public";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

/** pingDb 的三种表现：通 / 不通 / 抛异常（第三种只有「实现被改坏」时才会出现） */
type PingMode = "ok" | "false" | "throw";

interface Log {
    /** pingDb 被调用了几次 —— healthz 必须让它保持 0 */
    pings: number;
    /** writeAudit 被调用了几次 —— 探活不许写审计（每 30 秒一行会把表刷爆） */
    audits: number;
    /** migrate 被调用了几次 —— 探活不许触发迁移检查 */
    migrates: number;
}

function emptyLog(): Log {
    return { pings: 0, audits: 0, migrates: 0 };
}

function makeApi(log: Log, mode: PingMode): NavigationAPI {
    const api = {
        pingDb: async (): Promise<boolean> => {
            log.pings++;
            if (mode === "throw") throw new Error("D1_ERROR: database is locked");
            return mode === "ok";
        },
        writeAudit: async (): Promise<void> => {
            log.audits++;
        },
        migrate: async (): Promise<void> => {
            log.migrates++;
        },
        // 其余公开路由分支要用的方法：本文件只打健康检查，走到别处就说明分支顺序错了
        isAuthEnabled: () => false,
        getConfig: async (): Promise<string | null> => null,
        initDB: async (): Promise<{ alreadyInitialized: boolean }> => ({ alreadyInitialized: true }),
    };
    return api as unknown as NavigationAPI;
}

async function call(
    path: string,
    method = "GET",
    mode: PingMode = "ok"
): Promise<{ res: Response | null; log: Log }> {
    const log = emptyLog();
    const request = new Request(`${HOST}/api/${path}`, { method });
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: makeApi(log, mode),
        ip: IP,
        trustXFF: false,
        trustXRealIp: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    return { res: await handlePublicRoutes(ctx), log };
}

// ---- 1. healthz：零数据库 ----

test("healthz：200 + {ok:true}，且一次数据库都没碰", async () => {
    const { res, log } = await call("healthz", "GET", "throw");
    assert.equal(res?.status, 200, "进程活着就该 200 —— 库挂了也不影响这一条");
    assert.deepEqual((await res!.json()) as unknown, { ok: true });
    assert.equal(log.pings, 0, "healthz 必须零 DB：探针每 30 秒一次，查库等于把自己变成负载");
    assert.equal(log.migrates, 0, "healthz 不许触发迁移检查");
});

test("healthz：数据库打不开时仍然是 200（liveness 与 readiness 的分工）", async () => {
    // 同一个「库坏了」的环境下打两个端点，结论必须相反：
    //   healthz → 200（进程还活着，不该被编排系统杀掉重启）
    //   readyz  → 503（不该被挂进负载均衡 / 不该被判健康而跳过回滚）
    const live = await call("healthz", "GET", "throw");
    const ready = await call("readyz", "GET", "throw");
    assert.equal(live.res?.status, 200);
    assert.equal(ready.res?.status, 503);
});

// ---- 2. readyz：一次 SELECT 1 决定 200 / 503 ----

test("readyz：pingDb 通 → 200 + {ok:true}，且只探一次", async () => {
    const { res, log } = await call("readyz", "GET", "ok");
    assert.equal(res?.status, 200);
    assert.deepEqual((await res!.json()) as unknown, { ok: true });
    assert.equal(log.pings, 1, "readyz 只该跑一条 SELECT 1（健康检查每 30 秒一次，读放大要压到 1）");
    assert.equal(log.migrates, 0, "readyz 不许触发迁移检查");
});

test("readyz：pingDb 返回 false → 503（不是 500，也不是 200）", async () => {
    const { res } = await call("readyz", "GET", "false");
    assert.equal(res?.status, 503, "依赖没起来是 503：500 会被读成「服务自己写错了」");
    assert.deepEqual((await res!.json()) as unknown, { ok: false });
});

test("readyz：pingDb 抛异常 → 也是 503，不把异常漏成 500", async () => {
    // pingDb 内部已经 try/catch，这条盯的是「将来有人改坏它」时的兜底：
    // 探针的语义必须是「任何异常 = 依赖没起来」，而不是让上游收到一个分不清原因的 500。
    const { res } = await call("readyz", "GET", "throw");
    assert.equal(res?.status, 503);
    assert.deepEqual((await res!.json()) as unknown, { ok: false });
});

// ---- 3. 响应体不许带细节 ----

test("两个响应都只有 ok 一个键：没有表名 / 错误信息 / 版本号", async () => {
    const cases: Array<[PingMode, number]> = [["ok", 200], ["false", 503], ["throw", 503]];
    for (const [mode, status] of cases) {
        const { res } = await call("readyz", "GET", mode);
        assert.equal(res?.status, status);
        const body = (await res!.json()) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body), ["ok"], `readyz(${mode}) 的响应体只该有 ok 一个键`);
        assert.equal(typeof body.ok, "boolean");
    }
    const live = await call("healthz");
    assert.deepEqual(Object.keys((await live.res!.json()) as Record<string, unknown>), ["ok"]);
});

test("响应体里没有任何内部字样（表名 / SQL / 版本号 / 错误原文）", async () => {
    // 公开未鉴权端点：一个字节的细节都是白送的指纹。这里按「原始文本」比，
    // 不给「以后有人加个 message 字段」留缝。
    const ready = await call("readyz", "GET", "throw");
    const live = await call("healthz");
    const texts = [await ready.res!.text(), await live.res!.text()];
    for (const text of texts) {
        for (const leak of ["D1_ERROR", "database", "SELECT", "configs", "audit_log", "26.0", "migrat"]) {
            assert.ok(!text.includes(leak), `响应体里出现了「${leak}」：${text}`);
        }
    }
    assert.equal(texts[0], '{"ok":false}', "库打不开时响应体就该是这两个字节，不带任何解释");
});

// ---- 4. 探活不许被缓存、不许写审计 ----

test("两个响应都带 Cache-Control: no-store", async () => {
    for (const path of ["healthz", "readyz"]) {
        const { res } = await call(path);
        assert.equal(
            res?.headers.get("Cache-Control"),
            "no-store",
            `${path} 必须 no-store：被缓存住的话「缓存说健康」能一直骗着编排系统`
        );
    }
});

test("探活不写审计（每 30 秒一行会把 audit_log 刷爆）", async () => {
    const live = await call("healthz");
    const ready = await call("readyz");
    assert.equal(live.log.audits, 0);
    assert.equal(ready.log.audits, 0);
});

// ---- 5. 只认 GET，且不认领别的路径 ----

test("POST /healthz、POST /readyz 不认领（探活只读，不许有副作用）", async () => {
    for (const path of ["healthz", "readyz"]) {
        const { res } = await call(path, "POST");
        assert.equal(res, null, `POST /api/${path} 不该被公开路由认领`);
    }
});

test("healthz/readyz 的子路径不被认领（探活端点只有一个层级）", async () => {
    for (const path of ["healthz/x", "readyz/deep"]) {
        const { res } = await call(path);
        assert.equal(res, null, `GET /api/${path} 不该被认领`);
    }
});
