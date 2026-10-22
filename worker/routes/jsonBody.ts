// worker/routes/jsonBody.ts
// 写接口的**请求体入口**：解析 JSON，并坚持「必须是个对象」。
//
// 为什么值得单独一个函数：以前各路由直接 `const data = await request.json() as X`
// 然后就去读 `data.title`。HTTP 客户端想发什么就发什么，于是：
//   · body 是 `null`  → `null.title` 抛 TypeError，被入口兜住回 **500**
//     （实测：`POST /api/notes` 带 `-d null` 就是 500。这是服务端自己崩了，
//       和「正确地拒绝」的 4xx 不是一回事 —— 500 会触发告警、也会被客户端当故障重试）
//   · body 是 `"字符串"` / `123` / `true` → 属性访问不抛（会装箱），逐个字段
//     都取到 undefined，于是**静默创建出一条全空的笔记 / 分组**。比 500 更难发现。
//
// 所以这里一次性挡住两类：解析失败（SyntaxError）→ 400；解析出来不是对象 → 400。
// 有这个统一入口之后，路由里就不用再逐个判空，也不会漏。
//
// ⚠️ 数组也拒绝：业务上没有顶层是数组的写接口（排序接口传的是 `{orders:[...]}`），
// 放行数组只会让 `data.orders` 之类的取值继续拿到 undefined。

import { ApiError } from "../lib/apiError";

/**
 * 解析请求体，并保证它是个普通对象。
 * 失败时抛 ApiError（400），由入口的统一错误出口翻译成结构化 JSON。
 */
export async function readJsonBody<T extends object>(request: Request): Promise<T> {
    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        // 空体 / 截断 / 非法字符都是客户端的输入错误
        throw ApiError.badRequest("请求体不是合法的 JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw ApiError.badRequest("请求体必须是 JSON 对象");
    }
    return parsed as T;
}

/**
 * 同上，但要求是个数组（批量删除 / 排序那几条接口顶层就是数组）。
 * 与 readJsonBody 分开是为了让类型一次说清：数组接口拿对象、对象接口拿数组，
 * 都该在入口被挡掉，而不是走进业务里拿到一串 undefined。
 */
/**
 * 同上，但**对象与数组都收**（只挡 null / 字符串 / 数字 / 布尔）。
 *
 * 给 `PUT /api/note-orders` 这类「两种形状都认」的老接口用：它既接受顶层数组
 * `[{id, order_num}]`，也接受 `{orders:[...]}`。这种接口上不能挂 readJsonBody
 * （会把数组形状挡掉，是**把原来能用的请求改成 400**）—— 曾经就改错过一次，
 * 被 tests/noteRoutes.test.ts 的「接受数组或 { orders } 两种形状」当场抓回。
 */
export async function readJsonValue(request: Request): Promise<object> {
    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        throw ApiError.badRequest("请求体不是合法的 JSON");
    }
    if (parsed === null || typeof parsed !== "object") {
        throw ApiError.badRequest("请求体必须是 JSON 对象或数组");
    }
    return parsed;
}

export async function readJsonArray<T>(request: Request): Promise<T[]> {
    let parsed: unknown;
    try {
        parsed = await request.json();
    } catch {
        throw ApiError.badRequest("请求体不是合法的 JSON");
    }
    if (!Array.isArray(parsed)) throw ApiError.badRequest("请求体必须是 JSON 数组");
    return parsed as T[];
}
