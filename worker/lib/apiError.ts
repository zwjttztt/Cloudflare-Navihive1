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

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503;

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
    static conflict(message: string, details?: unknown) {
        return new ApiError(409, API_ERROR_CODES.conflict, message, details);
    }
    static tooLarge(message: string) {
        return new ApiError(413, API_ERROR_CODES.payloadTooLarge, message);
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
 * 统一错误响应。认得出 ApiError 就按它的 code/status 回；
 * 认不出（没预料到的异常）打一行日志 + 回 500 internal ——
 * **不把堆栈/内部细节透给客户端**，那是给攻击者的线索。
 */
export function errorResponse(err: unknown): Response {
    if (err instanceof ApiError) {
        return Response.json(
            {
                error: {
                    code: err.code,
                    message: err.message,
                    ...(err.details === undefined ? {} : { details: err.details }),
                },
            },
            { status: err.status }
        );
    }
    console.error("[api] 未处理的错误:", err);
    return Response.json(
        { error: { code: API_ERROR_CODES.internal, message: "服务器内部错误" } },
        { status: 500 }
    );
}
