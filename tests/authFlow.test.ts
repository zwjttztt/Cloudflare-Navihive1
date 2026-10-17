// tests/authFlow.test.ts
// 登录 / 登出 / 认证检查这条路上几处「判断错了不报错、只让人干瞪眼」的判定。
//
// 两条主线：
// 1. 认证失败分类 —— 一次网络抖动不能把人踢出登录页，但账号被停用必须踢回去并说明原因；
// 2. cookie 没存上 —— https 和 http 要给不同的指引，指错了方向等于没提示。
// （沉睡治理的阈值回落 / 扫描结果解析 2026-10-17 随功能下线一并删除。）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classifyAuthFailure,
    cookieRejectedMessage,
} from "../src/utils/authFlow";

test("classifyAuthFailure: 令牌失效要退回登录页", () => {
    assert.deepEqual(classifyAuthFailure(new Error("认证已过期")), { backToLogin: true });
});

test("classifyAuthFailure: 账号被停用（403）要把服务端那句话带过去", () => {
    const failure = classifyAuthFailure(new Error("账号已停用，可用恢复密钥找回 (HTTP 403)"));
    assert.equal(failure.backToLogin, true);
    assert.equal(failure.message, "账号已停用，可用恢复密钥找回");
});

test("classifyAuthFailure: 403 的后缀只在末尾才剥，中间出现不算", () => {
    const failure = classifyAuthFailure(new Error("(HTTP 403) 是内部错误码，别外传"));
    assert.equal(failure.message, "(HTTP 403) 是内部错误码，别外传".replace(/\s*\(HTTP 403\)$/, ""));
});

test("classifyAuthFailure: 网络抖动之类的错误不踢人", () => {
    assert.deepEqual(classifyAuthFailure(new Error("fetch failed")), { backToLogin: false });
    assert.deepEqual(classifyAuthFailure(null), { backToLogin: false });
    assert.deepEqual(classifyAuthFailure("boom"), { backToLogin: false });
});

test("cookieRejectedMessage: http 访问时明确指向 HTTPS / localhost", () => {
    const msg = cookieRejectedMessage(false);
    assert.ok(msg.includes("HTTPS"), `http 场景必须点明 HTTPS，实际：${msg}`);
    assert.ok(msg.includes("localhost"));
});

test("cookieRejectedMessage: 已经是 https 时改说 Cookie 被拦", () => {
    const msg = cookieRejectedMessage(true);
    assert.ok(msg.includes("Cookie"));
    assert.equal(msg.includes("HTTPS"), false, "对已经是 https 的人提 HTTPS 是误导");
});
