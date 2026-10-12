// tests/apiError.test.ts
// 统一错误码的两侧基建：
//   - worker/lib/apiError.ts：ApiError + errorResponse（服务端）
//   - src/API/apiError.ts：parseApiError + ApiError（客户端）
//
// 为什么值得单测：这是**迁移期**的代码 —— 新旧两种形状会并存很久。
// 最容易出的错是「只认新形状，老形状直接崩」或反过来，
// 而那会让全站某个错误路径在某次部署后突然失效，且只在真出错时才暴露。

import test from "node:test";
import assert from "node:assert/strict";
// ⚠️ 两侧都叫 ApiError 但构造签名不同（worker 是 (status, code, message)，客户端是
// ({code,message,status})）。不分别起别名的话，new 出来的就是另一个类 ——
// 而且是「编译通过、跑起来 message 是空」这种最难查的错。
import {
    API_ERROR_CODES,
    ApiError as ServerApiError,
    errorResponse,
} from "../worker/lib/apiError";
import { ApiError as ClientApiError, parseApiError } from "../src/API/apiError";

test("errorResponse：ApiError 按 code/status 回，形状是 {error:{code,message}}", async () => {
    const res = errorResponse(ServerApiError.conflict("这条笔记在别处被改过了", { note: { id: 7 } }));
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    assert.equal(body.error.code, "conflict");
    assert.equal(body.error.message, "这条笔记在别处被改过了");
    assert.deepEqual(body.error.details, { note: { id: 7 } });
});

test("errorResponse：未预料到的异常回 500 internal，且不透内部细节", async () => {
    const res = errorResponse(new Error("D1_ERROR: no such table user_configs_xyz"));
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "internal");
    // 堆栈/表名这类内部信息不能透给客户端（给攻击者的线索）
    assert.ok(!body.error.message.includes("user_configs_xyz"), "内部细节不该透出去");
});

test("parseApiError：新形状（迁移后的端点）", () => {
    const parsed = parseApiError(
        { error: { code: "conflict", message: "版本冲突", details: { note: { id: 1 } } } },
        409
    );
    assert.equal(parsed?.code, "conflict");
    assert.equal(parsed?.message, "版本冲突");
    assert.equal(parsed?.status, 409);
    assert.deepEqual(parsed?.details, { note: { id: 1 } });
});

test("parseApiError：旧形状（还没迁移的 80+ 个端点）照样认", () => {
    // {error: "字符串"}
    const a = parseApiError({ error: "密码强度不足" }, 400);
    assert.equal(a?.code, "unknown");
    assert.equal(a?.message, "密码强度不足");
    // {message: "..."}
    const b = parseApiError({ message: "分组名重复" }, 400);
    assert.equal(b?.message, "分组名重复");
    // {error: 字符串, code: "conflict"}（409 的老形状）
    const c = parseApiError({ error: "被改过了", code: "conflict", note: { id: 3 } }, 409);
    assert.equal(c?.code, "unknown");
    assert.equal(c?.message, "被改过了");
});

test("parseApiError：脏输入一律回 null，不能抛", () => {
    assert.equal(parseApiError(null, 500), null);
    assert.equal(parseApiError(undefined, 500), null);
    assert.equal(parseApiError("一段纯文本", 500), null); // 413 的 body 就是纯文本
    assert.equal(parseApiError([1, 2, 3], 500), null);
    assert.equal(parseApiError({ error: 42 }, 500), null);
    assert.equal(parseApiError({ error: { code: 42, message: 7 } }, 500)?.message, "");
    assert.equal(parseApiError({}, 500), null);
});

test("parseApiError：新形状缺 code 时兜底 unknown，不缺 message", () => {
    const parsed = parseApiError({ error: { message: "只说了一半" } }, 400);
    assert.equal(parsed?.code, "unknown");
    assert.equal(parsed?.message, "只说了一半");
});

test("ApiError（客户端）：extends Error，message 用法全部照旧", () => {
    const err = new ClientApiError({ code: "rate_limited", message: "太频繁", status: 429 });
    assert.ok(err instanceof Error);
    assert.equal(err.message, "太频繁");
    assert.equal(err.name, "ApiError");
    assert.equal(err.is("rate_limited"), true);
    assert.equal(err.is("conflict"), false);
});

test("两侧 code 常量一致（改一边忘另一边是最容易出的漂移）", () => {
    assert.equal(API_ERROR_CODES.conflict, "conflict");
    assert.equal(API_ERROR_CODES.unauthenticated, "unauthenticated");
    assert.equal(API_ERROR_CODES.payloadTooLarge, "payload_too_large");
});

test("ApiError 静态工厂：unsupportedMedia 带 415 与机器可读 code（附件类型嗅探拒绝用）", () => {
    const err = ServerApiError.unsupportedMedia("只支持 PNG / JPEG / GIF / WebP / AVIF 图片");
    assert.equal(err.status, 415);
    assert.equal(err.code, API_ERROR_CODES.unsupportedMediaType);
    // errorResponse 出来的形状是结构化的，message 原样透出（客户端按它显示）
    const res = errorResponse(err);
    assert.equal(res.status, 415);
});
