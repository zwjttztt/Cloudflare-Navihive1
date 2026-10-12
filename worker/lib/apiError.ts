// worker/lib/apiError.ts
// 统一的 API 错误出口：状态码 + 机器可读的 code + 人读的 message。
//
// 为什么要有 code：以前各路由自行 `Response.json({ error: "密码强度不足" })`，
// 客户端只能把这句话显示出来 —— 想按错误类型分流（弹冲突框 / 跳登录 / 引导改配置）
// 就只能拿 message 去 includes 匹配，服务端改一个字前端就失效；错误也没法分类统计。
// 有了 code，这两件事都变成查表。
//
// 迁移策略是**增量**的：新端点一律用 ApiError；老端点在下一次改动时顺手改。
// 客户端（src/API/apiError.ts）同时认旧形状（{error: "字符串"}）与新形状，
// 所以迁移到一半也不会红。
//
// 刻意**不**一次改完 84 个端点：那是纯机械劳动，却会把所有路由的现有行为
// 一起换掉，出问题时分不清是迁移错了还是原本就错。

/** 机器可读错误码。新增错误时优先复用这些，确实表达不了再加（加的时候同步前端） */
// 错误码收敛到 shared/（前后端共用一份，见 shared/apiErrorCodes.ts 的说明）。
// 这里 import 引入本地作用域（类静态方法与 errorResponse 都要用），
// 再 re-export：既有 import 路径一行都不用改。
// ⚠️ 单写 `export { X } from "..."` 只转发、不引入本地绑定，文件内引用会 TS2304。
import { API_ERROR_CODES, type ApiErrorCode } from "../../shared/apiErrorCodes";
export { API_ERROR_CODES, type ApiErrorCode };

// 405（方法不对）/ 410（曾经有过、现在没了）/ 501（服务端没配这条能力）/
// 502（上游写失败）是 2026-10-13 迁移分享与附件端点时补的：这几个出口原来只能
// 写裸 Response.json，就因为状态号不在联合类型里、也没有对应的 code。
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 415 | 429 | 500 | 501 | 502 | 503;

/** 路由里抛它，由 errorResponse 统一翻成响应 */
export class ApiError extends Error {
    constructor(
        readonly status: ApiErrorStatus,
        readonly code: ApiErrorCode,
        message: string,
        readonly details?: unknown
    ) {
        super(message);
        this.name = "ApiError";
    }

    static badRequest(message: string, details?: unknown) {
        return new ApiError(400, API_ERROR_CODES.badRequest, message, details);
    }
    static unauthenticated(message = "请先登录") {
        return new ApiError(401, API_ERROR_CODES.unauthenticated, message);
    }
    static forbidden(message = "没有权限") {
        return new ApiError(403, API_ERROR_CODES.forbidden, message);
    }
    static notFound(message = "内容不存在") {
        return new ApiError(404, API_ERROR_CODES.notFound, message);
    }
    /** 路径对、方法不对（比如对分享接口发了 PATCH） */
    static methodNotAllowed(message = "不支持的方法") {
        return new ApiError(405, API_ERROR_CODES.methodNotAllowed, message);
    }
    /** 曾经存在、现在没了（附件数据已丢失）：与 404 区分开，客户端才知道「别重试」 */
    static gone(message: string) {
        return new ApiError(410, API_ERROR_CODES.gone, message);
    }
    /** 服务端没配这条能力（比如没绑 R2/KV 时的附件上传）—— 不是用户的错 */
    static notImplemented(message: string) {
        return new ApiError(501, API_ERROR_CODES.notImplemented, message);
    }
    /** 上游写失败（对象存储没写进去）：重试有机会成，所以不归 500 */
    static badGateway(message: string) {
        return new ApiError(502, API_ERROR_CODES.badGateway, message);
    }
    static conflict(message: string, details?: unknown) {
        return new ApiError(409, API_ERROR_CODES.conflict, message, details);
    }
    static tooLarge(message: string) {
        return new ApiError(413, API_ERROR_CODES.payloadTooLarge, message);
    }
    /** 上传内容类型不被支持（按文件内容判定后拒绝） */
    static unsupportedMedia(message: string) {
        return new ApiError(415, API_ERROR_CODES.unsupportedMediaType, message);
    }
    static rateLimited(message = "操作太频繁，请稍后再试") {
        return new ApiError(429, API_ERROR_CODES.rateLimited, message);
    }
    /** 维护模式：写操作一律拦下，读操作放行（用户还能看数据） */
    static serviceUnavailable(message = "系统维护中，暂时不能修改，请稍后再试") {
        return new ApiError(503, API_ERROR_CODES.serviceUnavailable, message);
    }
}

/**
 * 统一错误响应的可选项。
 *
 * 为什么要 `headers`：分享类端点（`data.ts` 的分享接口、`public.ts` 的公开接口、
 * `icon.ts`）的错误出口也得带 `Cache-Control: no-store` / `Referrer-Policy` /
 * `X-Robots-Tag` 这些头 —— 缺了它们，错误响应会被中间缓存留下来，或者把
 * 「这条分享存在」这件事泄露给搜索引擎。之前带头的出口因此迁不过来
 * （errorResponse 不支持附加头），只能继续写裸 `Response.json({ error: "..." })`。
 *
 * 为什么要 `extra`：个别响应要在**顶层**多带一个字段给客户端分流
 * （目前只有公开笔记那个 `needPassword: true`）。放在 error 对象里客户端就得
 * 往下钻一层，而旧形状本来是顶层的 —— 保持顶层省得客户端为迁移改两处。
 */
export interface ErrorResponseOptions {
    headers?: HeadersInit;
    extra?: Record<string, unknown>;
}

/** 按统一形状造响应体：{ error: { code, message[, details] }, ...extra } */
function errorBody(code: ApiErrorCode, message: string, details?: unknown, extra?: Record<string, unknown>) {
    return {
        error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
        },
        ...(extra ?? {}),
    };
}

/**
 * 统一错误响应。认得出 ApiError 就按它的 code/status 回；
 * 认不出（没预料到的异常）打一行日志 + 回 500 internal ——
 * **不把堆栈/内部细节透给客户端**，那是给攻击者的线索。
 */
export function errorResponse(err: unknown, options?: ErrorResponseOptions): Response {
    const init = { status: 500, ...(options?.headers ? { headers: options.headers } : {}) };
    if (err instanceof ApiError) {
        return Response.json(
            errorBody(err.code, err.message, err.details, options?.extra),
            { ...init, status: err.status }
        );
    }
    console.error("[api] 未处理的错误:", err);
    return Response.json(
        errorBody(API_ERROR_CODES.internal, "服务器内部错误", undefined, options?.extra),
        init
    );
}
