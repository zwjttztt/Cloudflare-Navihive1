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
// 这里 import 引入本地作用域（isAuthError 要用），再 re-export 保持既有 import 路径不变。
// ⚠️ 单写 `export { X } from "..."` 只转发、不引入本地绑定，文件内引用会 TS2304。
import { API_ERROR_CODES, type ApiErrorCode } from "../../shared/apiErrorCodes";
export { API_ERROR_CODES, type ApiErrorCode };

export interface ApiErrorInfo {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    /**
     * 服务端回写的请求 ID（x-request-id，见 shared/requestId.ts）。
     *
     * 有什么用：用户截图只截到「服务器内部错误」时，日志里翻这条 rid 就能找到
     * 同一次请求的那几行（worker 的 500 日志 + audit_log 里的 server-error），
     * errorReporter 上报时也带着它，两边对得上。拿不到就留空
     * （老部署 / 请求根本没到服务端，比如超时）。
     */
    requestId?: string;
}

/** 带 code 的错误。extends Error，所以既有 `e.message` 的用法全部照旧工作 */
export class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: unknown;
    readonly requestId?: string;

    constructor(info: ApiErrorInfo) {
        super(info.message);
        this.name = "ApiError";
        this.code = info.code;
        this.status = info.status;
        this.details = info.details;
        this.requestId = info.requestId;
    }

    /** 是不是某一类错误（比 code === "xxx" 好看一点） */
    is(code: string): boolean {
        return this.code === code;
    }
}

/**
 * 这次失败是不是「会话不可用」—— 该把用户送回登录页、并清掉本地登录标记。
 *
 * 为什么要有这个函数：全站原来有 5 处各自 `message.includes("认证")` /
 * `includes("401")` / `includes("HTTP 403")` 判错。那是拿**服务端文案**当错误码用：
 * 改一个字（或者换一门外语）判据就整体失效，而且是静默失效 —— 界面从此只会弹一句
 * toast，永远不回登录页。判据必须落在 code 上，且只写这一份。
 *
 * ⚠️ 为什么还留一个 `status === 401` 的兜底：服务端还有老形状的错误体（纯文本 /
 * `{error:"字符串"}`），parseApiError 对它们只能给出 "unknown"。HTTP 状态码本身
 * 就是确定的语义，不能因为服务端还没迁到 envelope 就把这类 401 漏掉。
 * （worker/routes/middleware.ts 的 401 已经全部改成 envelope 了，这条兜底防的是别处。）
 */
export function isAuthError(error: unknown): error is ApiError {
    if (!(error instanceof ApiError)) return false;
    return (
        error.is(API_ERROR_CODES.unauthenticated) ||
        error.is(API_ERROR_CODES.forbidden) ||
        error.status === 401
    );
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
