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

// ---------------------------------------------------------------------------
// 2026-10-13：错误码迁移收尾（data.ts 25 处 / public.ts 5 处 / icon.ts 3 处）
// ---------------------------------------------------------------------------

test("errorResponse 支持附加头：分享与图标那批端点终于能带着自己的头迁移", async () => {
    // 为什么必须有这个能力：那批端点的错误响应要带 `Cache-Control: no-store` /
    // `Referrer-Policy` / `X-Robots-Tag`（错误响应被中间缓存留下来，或者把
    // 「这条分享存在」泄露给搜索引擎，都是实打实的问题）。errorResponse 不支持
    // 附加头时，它们只能继续写裸 Response.json({ error: "..." }) —— 这 33 处
    // 就是这么一直迁不过来的。
    const res = errorResponse(ServerApiError.notFound("附件不存在"), {
        headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "not_found");
});

test("errorResponse 的 extra：顶层额外字段不被 error 对象吞掉（needPassword）", async () => {
    // 公开笔记那个 401 要在**顶层**多带 needPassword —— 客户端读的是
    // `data.error` 之外的字段，塞进 error 对象里就得往下钻一层，而旧形状
    // 本来就在顶层。保持顶层，客户端少改一处。
    const res = errorResponse(
        new ServerApiError(401, API_ERROR_CODES.unauthenticated, "需要访问口令"),
        { headers: { "Cache-Control": "no-store" }, extra: { needPassword: true } }
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as {
        error: { code: string; message: string };
        needPassword?: boolean;
    };
    assert.equal(body.error.code, "unauthenticated");
    assert.equal(body.error.message, "需要访问口令");
    assert.equal(body.needPassword, true);
});

test("405 / 410 / 501 / 502：这四个状态号有对应的 code（分享与附件端点用得到）", () => {
    // 迁移时卡住的正是不在 ApiErrorStatus 联合类型里的那几个状态号 ——
    // 没有对应的 code，就只能继续写裸 Response.json。
    const cases: [ReturnType<typeof ServerApiError.methodNotAllowed>, string][] = [
        [ServerApiError.methodNotAllowed(), "method_not_allowed"],
        [ServerApiError.gone("附件数据已丢失"), "gone"],
        [ServerApiError.notImplemented("服务器未配置附件存储"), "not_implemented"],
        [ServerApiError.badGateway("图片写入存储失败，请稍后重试"), "bad_gateway"],
    ];
    for (const [err, code] of cases) {
        assert.equal(err.code, code, `${code} 的 code 不对`);
        const res = errorResponse(err);
        assert.equal(res.status, err.status);
    }
    assert.equal(ServerApiError.methodNotAllowed().status, 405);
    assert.equal(ServerApiError.gone("x").status, 410);
    assert.equal(ServerApiError.notImplemented("x").status, 501);
    assert.equal(ServerApiError.badGateway("x").status, 502);
});

test("未预料的错误走 500 时也要带上附加头（分享端点那条路径）", async () => {
    // errorResponse 的兜底分支原来写死了 status: 500 且不带 options ——
    // 那么分享端点一旦走到「没预料到的异常」，no-store 就没了。
    const res = errorResponse(new Error("boom"), { headers: { "Cache-Control": "no-store" } });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "internal");
});
