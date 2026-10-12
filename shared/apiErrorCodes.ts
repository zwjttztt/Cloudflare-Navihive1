// shared/apiErrorCodes.ts
// 前后端**共用**的机器可读错误码。
//
// 为什么要有这个文件：错误码在 worker/lib/apiError.ts（服务端产出）与
// src/API/apiError.ts（客户端消费）各有一份 —— 两份手动同步的常量，
// 「服务端加了个码、客户端不知道」只会静默失效，测试抓不住（测试只能钉住
// 「两边相等」，钉不住「新增时两边一起加」）。收敛成一份，加码只有一处改动。
//
// 放在仓库根的 shared/ 而不是 src/：worker 的 tsconfig 只 include worker/，
// 但 import 的依赖会被跟随编译，所以 shared/ 两侧都能引（src 同理）。
// 刻意**零依赖**：这个文件会被打進 worker 与首屏两条产物链，别 import 任何东西。

export const API_ERROR_CODES = {
    badRequest: "bad_request",
    unauthenticated: "unauthenticated",
    forbidden: "forbidden",
    notFound: "not_found",
    // 2026-10-13 迁移分享/附件端点时补的四个：405 方法不对、410 曾经有过现在没了、
    // 501 服务端没配这条能力、502 上游（对象存储）写失败。原来这些出口因为
    // 「没有对应的 code」只能继续写裸 Response.json({ error: "..." })。
    methodNotAllowed: "method_not_allowed",
    gone: "gone",
    notImplemented: "not_implemented",
    badGateway: "bad_gateway",
    conflict: "conflict",
    payloadTooLarge: "payload_too_large",
    unsupportedMediaType: "unsupported_media_type",
    rateLimited: "rate_limited",
    quotaExceeded: "quota_exceeded",
    serviceUnavailable: "service_unavailable",
    internal: "internal",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
