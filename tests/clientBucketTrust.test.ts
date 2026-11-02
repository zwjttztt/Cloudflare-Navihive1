// tests/clientBucketTrust.test.ts
// 限速分桶键的信任链：X-Real-IP 必须有**独立开关**（2026-11-02）。
//
// 缺陷：`clientBucket(request, trustXFF)` 原先在 trustXFF=true 时**先读** X-Real-IP。
// 但「这个头是不是反代覆盖写的」无法从请求本身判断 —— Caddy / Traefik 默认不写它，
// 于是 TRUST_XFF=1 的部署里客户端自带的 X-Real-IP 会原样透传：每请求换一个值
// 就是一个全新的空桶，登录 / 注册 / 找回 / 分享口令 / 写操作五类限速同时失效，
// 而且每次尝试仍要跑一遍 PBKDF2（CPU 放大），审计日志的来源 IP 同时被污染。
//
// 这里钉死三件事：
//   1) 只开 TRUST_XFF 时，X-Real-IP 一律不读（伪造头换不了桶）；
//   2) TRUST_XFF 与 TRUST_X_REAL_IP 都开时，X-Real-IP 才优先于 XFF 首段；
//   3) 两个都不开时，XFF 同样不读，落到入口注入的 socket 对端那一档。
// 依赖都是模块级常量（X_REAL_IP_HEADER / REAL_IP_HEADER），所以用真实头名构造
// Request，不 mock 任何东西 —— 测的就是线上那套取值顺序。

import { test } from "node:test";
import assert from "node:assert/strict";
import { clientBucket } from "../worker/loginGuard";
import { clientIp, REAL_IP_HEADER } from "../worker/httpUtils";

const URL_LOGIN = "https://nav.example.com/api/login";

function req(headers: Record<string, string>): Request {
    return new Request(URL_LOGIN, { headers });
}

// ---------------- 1. 只开 TRUST_XFF：不读可伪造的 X-Real-IP ----------------

test("clientBucket(trustXFF=true, trustXRealIp=false)：X-Real-IP 不参与分桶", () => {
    const r = req({
        "X-Real-IP": "9.9.9.9",
        [REAL_IP_HEADER]: "1.1.1.1",
    });
    assert.equal(
        clientBucket(r, true, false),
        "1.1.1.1",
        "只开 TRUST_XFF 时，客户端自带的 X-Real-IP 不该成为分桶键"
    );
});

test("clientBucket(trustXFF=true, trustXRealIp=false)：没有入口注入头时回退 XFF 首段，伪造的 X-Real-IP 换不了桶", () => {
    // 攻击者只改 X-Real-IP、XFF 由反代覆盖写：桶必须跟着 XFF 走，与 X-Real-IP 无关
    assert.equal(
        clientBucket(req({ "X-Real-IP": "9.9.9.9", "X-Forwarded-For": "6.6.6.6" }), true, false),
        "6.6.6.6"
    );
    // 连 XFF 都没有（且入口没补 socket 对端）：共用 unknown 桶，换 X-Real-IP 也换不出来
    assert.equal(
        clientBucket(req({ "X-Real-IP": "9.9.9.9" }), true, false),
        "unknown"
    );
});

// ---------------- 2. 两个开关都开：才读反代覆盖写入的 X-Real-IP ----------------

test("clientBucket(trustXFF=true, trustXRealIp=true)：X-Real-IP 优先于 XFF 首段", () => {
    const r = req({
        "X-Real-IP": "9.9.9.9",
        "X-Forwarded-For": "2.2.2.2, 10.0.0.1",
        [REAL_IP_HEADER]: "1.1.1.1",
    });
    assert.equal(r.headers.get("X-Real-IP"), "9.9.9.9");
    assert.equal(
        clientBucket(r, true, true),
        "9.9.9.9",
        "显式开启第二个开关后，覆盖写入的 X-Real-IP 才赢过 XFF 首段"
    );
});

test("clientBucket(trustXFF=true, trustXRealIp=true)：反代没写 X-Real-IP 时仍回退 XFF 首段", () => {
    assert.equal(
        clientBucket(req({ "X-Forwarded-For": "2.2.2.2, 10.0.0.1" }), true, true),
        "2.2.2.2",
        "老部署（只配了 XFF 覆盖写）开启第二个开关也不该退化成 unknown 桶"
    );
});

// ---------------- 3. 两个都不开：XFF 也不读 ----------------

test("clientBucket(trustXFF=false, trustXRealIp=false)：X-Forwarded-For 与 X-Real-IP 都不参与分桶", () => {
    const r = req({
        "X-Forwarded-For": "2.2.2.2",
        "X-Real-IP": "9.9.9.9",
        [REAL_IP_HEADER]: "1.1.1.1",
    });
    assert.equal(
        clientBucket(r, false, false),
        "1.1.1.1",
        "端口直暴部署下只认入口注入的 socket 对端，客户端带的头一律不算数"
    );
});

test("clientBucket：CF-Connecting-IP 仍然最优先（两个开关都不影响它）", () => {
    const r = req({
        "CF-Connecting-IP": "203.0.113.7",
        "X-Real-IP": "9.9.9.9",
        "X-Forwarded-For": "2.2.2.2",
    });
    assert.equal(clientBucket(r, true, false), "203.0.113.7");
    assert.equal(clientBucket(r, true, true), "203.0.113.7");
    assert.equal(clientBucket(r, false, false), "203.0.113.7");
});

// ---------------- 4. clientIp 与 clientBucket 必须同口径 ----------------
// 审计日志里的来源 IP 和限速桶用的是同一套信任链：两边一旦不一致，
// 「审计里看到某个 IP 猛试密码」就不能直接对上「哪个桶被锁」，排查会断链。

test("clientIp 与 clientBucket 取值一致：只开 TRUST_XFF 时都不读 X-Real-IP", () => {
    const r = req({
        "X-Real-IP": "9.9.9.9",
        "X-Forwarded-For": "2.2.2.2",
        [REAL_IP_HEADER]: "1.1.1.1",
    });
    assert.equal(clientIp(r, true, false), "2.2.2.2");
    assert.equal(clientBucket(r, true, false), "2.2.2.2");

    assert.equal(clientIp(r, true, true), "9.9.9.9");
    assert.equal(clientBucket(r, true, true), "9.9.9.9");

    assert.equal(clientIp(r, false, false), "1.1.1.1");
    assert.equal(clientBucket(r, false, false), "1.1.1.1");
});
