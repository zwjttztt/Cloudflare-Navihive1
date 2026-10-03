// tests/authFlow.test.ts
// 登录 / 登出 / 认证检查这条路上几处「判断错了不报错、只让人干瞪眼」的判定。
//
// 三条主线：
// 1. 阈值回落 —— 界面显示的数字必须和实际生效的一致，不然 owner 以为改了没用；
// 2. 认证失败分类 —— 一次网络抖动不能把人踢出登录页，但账号被停用必须踢回去并说明原因；
// 3. cookie 没存上 —— https 和 http 要给不同的指引，指错了方向等于没提示。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    resolveInactivePolicy,
    classifyAuthFailure,
    cookieRejectedMessage,
    readSweepResult,
} from "../src/utils/authFlow";
import {
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../src/API/http";

test("resolveInactivePolicy: 合法数字原样用", () => {
    assert.deepEqual(resolveInactivePolicy("90", "30"), { disableDays: 90, graceDays: 30 });
});

test("resolveInactivePolicy: 没配过 / 空串 / 乱填都回落到默认值", () => {
    for (const raw of [null, undefined, "", "abc", "-1"]) {
        assert.deepEqual(
            resolveInactivePolicy(raw, raw),
            {
                disableDays: INACTIVE_DISABLE_DAYS_DEFAULT,
                graceDays: INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
            },
            `这段不该被当成合法天数：${String(raw)}`
        );
    }
});

test("resolveInactivePolicy: 0 天按默认处理（今天注册明天停用基本都是误操作）", () => {
    const policy = resolveInactivePolicy("0", "0");
    assert.equal(policy.disableDays, INACTIVE_DISABLE_DAYS_DEFAULT);
    assert.equal(policy.graceDays, INACTIVE_DELETE_GRACE_DAYS_DEFAULT);
});

test("resolveInactivePolicy: 一边合法一边没配，各算各的", () => {
    assert.deepEqual(resolveInactivePolicy("180", null), {
        disableDays: 180,
        graceDays: INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
    });
});

test("resolveInactivePolicy: 带空格的数字也能读（服务端可能存了 ' 90 '）", () => {
    assert.equal(resolveInactivePolicy(" 90 ", "30").disableDays, 90);
});

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

test("readSweepResult: 成功时补出两个计数", () => {
    assert.deepEqual(readSweepResult(true, { success: true }), {
        success: true,
        disabled: 0,
        deleted: 0,
    });
    assert.deepEqual(readSweepResult(true, { success: true, disabled: 2, deleted: 1 }), {
        success: true,
        disabled: 2,
        deleted: 1,
    });
});

test("readSweepResult: 响应不 ok 时，即便 body 里写了 success 也算失败", () => {
    const result = readSweepResult(false, { success: true, disabled: 3 });
    assert.equal(result.success, false, "只看 body 会把一次失败当成成功");
    assert.equal(result.disabled, 0);
});

test("readSweepResult: body 没给 success 也算失败，并给出兜底文案", () => {
    const result = readSweepResult(true, {});
    assert.equal(result.success, false);
    assert.ok(result.message);
});

test("readSweepResult: 服务端带了说明就原样转述", () => {
    assert.equal(readSweepResult(true, { message: "扫描太频繁" }).message, "扫描太频繁");
});
