// tests/helpers/apiErrorBody.ts
// 读错误响应体的**文案**：服务端迁移到统一错误码后失败体是
// `{ error: { code, message } }`，迁移前是 `{ message }` 或 `{ error: "字符串" }`。
//
// 为什么测试要两种都认：错误码迁移是分批做的（见 worker/lib/apiError.ts 的文件头
// ——「刻意不一次改完，那是纯机械劳动，却会把所有路由的现有行为一起换掉」），
// 分批期间两种形状并存。测试只认新形状会把没迁到的端点判红，只认旧形状则会在
// 迁完之后失去对 code 的断言能力。
//
// 用法：`assert.match(await errorText(res), /秒后再试/)`。
// 想连 code 一起断言时用 `errorBody(res)`。

export interface ErrorBody {
    code: string;
    message: string;
    status: number;
}

/** 只要文案；形状不认识时回空串（调用方照旧走「匹配不上就红」） */
export async function errorText(res: Response): Promise<string> {
    return (await errorBody(res)).message;
}

/** 文案 + code + 状态码。code 在旧形状下是 "unknown"（客户端 parseApiError 同此约定） */
export async function errorBody(res: Response): Promise<ErrorBody> {
    const raw: unknown = await res.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { code: "unknown", message: "", status: res.status };
    }
    const b = raw as { message?: unknown; error?: unknown };
    const err = b.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
        const e = err as { code?: unknown; message?: unknown };
        return {
            code: typeof e.code === "string" && e.code ? e.code : "unknown",
            message: typeof e.message === "string" ? e.message : "",
            status: res.status,
        };
    }
    if (typeof err === "string") return { code: "unknown", message: err, status: res.status };
    if (typeof b.message === "string") return { code: "unknown", message: b.message, status: res.status };
    return { code: "unknown", message: "", status: res.status };
}
