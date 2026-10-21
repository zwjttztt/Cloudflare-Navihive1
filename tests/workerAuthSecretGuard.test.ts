// tests/workerAuthSecretGuard.test.ts
// 质量评估 4.4 的另一半：**Workers 侧漏配 AUTH_SECRET 也要拒绝服务**。
//
// 为什么这条必须钉住：自托管侧早就是「启动即中止」，Workers 侧原先只在登录与换钥
// 两条路上 fail-closed，其余路由照常服务。最容易漏看的是**凭据加密** ——
// `createKeyring` 在没有 AUTH_SECRET 时会注册一把 `PBKDF2("")` 派生的钥匙
// （历史行为，为了不让已有密文突然解不开），于是「加密」等于人人可算。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { missingAuthSecret } from "../worker/index";
import { projectDir } from "./helpers/notesSource";

test("鉴权开启却没配 AUTH_SECRET → 判定为配置缺失", () => {
    assert.equal(missingAuthSecret({ AUTH_ENABLED: "true" }), true);
    assert.equal(missingAuthSecret({ AUTH_ENABLED: "true", AUTH_SECRET: "" }), true);
});

test("配了 AUTH_SECRET 就放行；没开鉴权也放行", () => {
    assert.equal(missingAuthSecret({ AUTH_ENABLED: "true", AUTH_SECRET: "abc123" }), false);
    // 没开鉴权时本来就不需要密钥（本地 demo / 纯静态用法）
    assert.equal(missingAuthSecret({ AUTH_ENABLED: "false" }), false);
    assert.equal(missingAuthSecret({}), false);
});

test("只配 JWT_SECRET 补不上这个洞（凭据加密用的是 AUTH_SECRET）", () => {
    // 这条容易想当然：「能签发 JWT 不就够了吗」—— 不够。keyring 的源密钥是
    // AUTH_SECRET，缺了它落库的密文仍等价于明文。
    assert.equal(missingAuthSecret({ AUTH_ENABLED: "true", JWT_SECRET: "jwt-only" } as never), true);
});

test("入口在交给路由之前就拦下，且返回 503（不是 500/200）", () => {
    // 静态守卫：这条闸必须在 handleRequest **之前**，否则业务代码已经跑过一半了。
    const src = readFileSync(join(projectDir(), "worker/index.ts"), "utf-8");
    const guardAt = src.indexOf("missingAuthSecret(env)");
    const routeAt = src.indexOf("handleRequest(request, env)");
    assert.ok(guardAt > 0, "入口必须调用 missingAuthSecret");
    assert.ok(routeAt > 0, "找不到 handleRequest 调用点，守卫要跟着改");
    assert.ok(guardAt < routeAt, "闸必须在路由之前，不能反过来");
    // 走统一错误出口（worker/ 下不许裸写 Response.json({error})，见 errorCodeMigration 那条守卫）；
    // ApiError.serviceUnavailable 就是 503 + code service_unavailable
    assert.ok(
        src.includes("ApiError.serviceUnavailable"),
        "缺配置要回 503（明确是部署问题，不是代码崩了），且必须走统一错误出口"
    );
    assert.ok(src.includes("AUTH_SECRET"), "提示里要直接点名缺哪个环境变量，别让人去猜");
});
