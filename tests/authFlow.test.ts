// tests/authFlow.test.ts
// 登录 / 登出 / 认证检查这条路上几处「判断错了不报错、只让人干瞪眼」的判定。
//
// 两条主线：
// 1. 认证失败分类 —— 一次网络抖动不能把人踢出登录页，但账号被停用必须踢回去并说明原因；
// 2. cookie 没存上 —— https 和 http 要给不同的指引，指错了方向等于没提示。
// （沉睡治理的阈值回落 / 扫描结果解析两个助手 2026-10-17 删除：治理 UI 不再对
// 站点所有者开放后没有任何调用方，留着就是死代码。）

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classifyAuthFailure,
    cookieRejectedMessage,
} from "../src/utils/authFlow";
import { API_ERROR_CODES, ApiError } from "../src/API/apiError";

/** 造一条 request() 会抛出来的那种错误（判据全在 code / status 上，不看文案） */
function apiError(status: number, code: string, message: string): ApiError {
    return new ApiError({ status, code, message });
}

test("classifyAuthFailure: 令牌失效（401 unauthenticated）要退回登录页", () => {
    assert.deepEqual(
        classifyAuthFailure(apiError(401, API_ERROR_CODES.unauthenticated, "认证已过期")),
        { backToLogin: true }
    );
});

test("classifyAuthFailure: 老形状的 401（解析不出 code）也认 —— 状态码本身就是语义", () => {
    // 服务端还有纯文本 / {error:"字符串"} 的错误体，parseApiError 只能给出 "unknown"
    assert.deepEqual(classifyAuthFailure(apiError(401, "unknown", "API错误: 401")), {
        backToLogin: true,
    });
});

test("classifyAuthFailure: 账号被停用（403）要把服务端那句话带过去", () => {
    const failure = classifyAuthFailure(
        apiError(403, API_ERROR_CODES.forbidden, "账号已停用，可用恢复密钥找回 (HTTP 403)")
    );
    assert.equal(failure.backToLogin, true);
    assert.equal(failure.message, "账号已停用，可用恢复密钥找回");
});

test("classifyAuthFailure: 403 的后缀只在末尾才剥，中间出现不算", () => {
    const failure = classifyAuthFailure(
        apiError(403, API_ERROR_CODES.forbidden, "(HTTP 403) 是内部错误码，别外传")
    );
    assert.equal(failure.message, "(HTTP 403) 是内部错误码，别外传".replace(/\s*\(HTTP 403\)$/, ""));
});

test("classifyAuthFailure: 网络抖动之类的错误不踢人", () => {
    assert.deepEqual(classifyAuthFailure(new Error("fetch failed")), { backToLogin: false });
    assert.deepEqual(
        classifyAuthFailure(apiError(500, API_ERROR_CODES.internal, "服务器内部错误")),
        { backToLogin: false }
    );
    assert.deepEqual(classifyAuthFailure(null), { backToLogin: false });
    // ⚠️ 字符串入参不该再被当成认证失败：这是刻意去掉的兜底（原来靠 includes 猜文案）
    assert.deepEqual(classifyAuthFailure("认证已过期"), { backToLogin: false });
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
