// src/API/apiError.ts
// 客户端侧的 API 错误：解析服务端的错误响应，带上**机器可读的 code**。
//
// 服务端有两种形状并存（迁移期）：
//   旧：{ error: "密码强度不足" } 或 { message: "..." }
//   新：{ error: { code, message, details } }（worker/lib/apiError.ts）
// 两种都要认 —— 读完新的就崩旧的，等于迁移到一半全站报错。
//
// 有了 code，UI 分流就不再拿 message 做 includes 匹配：
// 409 + conflict → 弹冲突框（而不是「保存失败」）；
// 401 + unauthenticated → 跳登录；429 → 提示「太频繁」并给重试按钮。

// 错误码收敛到 shared/（前后端共用一份，见 shared/apiErrorCodes.ts 的说明）。
// 本文件内部不引用这些名字，纯 re-export 即可（保持既有 import 路径不变）。
export { API_ERROR_CODES, type ApiErrorCode } from "../../shared/apiErrorCodes";

export interface ApiErrorInfo {
    code: string;
    message: string;
    status: number;
    details?: unknown;
}

/** 带 code 的错误。extends Error，所以既有 `e.message` 的用法全部照旧工作 */
export class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: unknown;

    constructor(info: ApiErrorInfo) {
        super(info.message);
        this.name = "ApiError";
        this.code = info.code;
        this.status = info.status;
        this.details = info.details;
    }

    /** 是不是某一类错误（比 code === "xxx" 好看一点） */
    is(code: string): boolean {
        return this.code === code;
    }
}

/**
 * 把服务端错误响应体翻成 ApiErrorInfo；认不出形状时回 null（调用方走原来的兜底）。
 *
 * ⚠️ body 是**未信任输入**：可能是 null、可能是数组、可能是 `{error: 42}`。
 * 每一层都要过 typeof，不能假设字段存在。
 */
export function parseApiError(body: unknown, status: number): ApiErrorInfo | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as { error?: unknown; message?: unknown };
    const err = b.error;

    if (err && typeof err === "object" && !Array.isArray(err)) {
        const e = err as { code?: unknown; message?: unknown; details?: unknown };
        return {
            code: typeof e.code === "string" && e.code ? e.code : "unknown",
            message: typeof e.message === "string" ? e.message : "",
            status,
            ...(e.details === undefined ? {} : { details: e.details }),
        };
    }

    const message = typeof err === "string" ? err : typeof b.message === "string" ? b.message : "";
    if (!message) return null;
    return { code: "unknown", message, status };
}
