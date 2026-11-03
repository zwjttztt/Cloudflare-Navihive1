// src/API/httpConstants.ts
// 跨「前端 client ↔ worker」两边共用的 HTTP 头常量。
//
// 为什么单独一份：同一个头名在前端（发请求时挂上）和 worker（读请求时解析）
// 各写一遍的话，改一处忘一处**不会报错** —— 前端照样发 `Idempotency-Key`，
// worker 却在等另一个名字，于是「幂等」静默失效，重试照样建出重复数据。
// 这类常量必须只有一个定义处。
//
// ⚠️ 这个文件**不 import 任何模块**，也不含任何运行时逻辑：
// 前端与 worker 都要引用它，一旦它反过来依赖谁就成环了。

/** 幂等键请求头：worker/idempotency.ts 读它做重放闸门，前端写它做重放标记 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * 限流重试请求头（RFC 9110 §10.2.3）：服务端在 429 上告诉我们「多少秒后再来」。
 *
 * 这一条的方向和上面相反 —— worker 是**写**的一方（loginGuard / routes/public /
 * routes/data 的写守卫在 429 上挂它，值可能是 delta-seconds，也可能是 HTTP-date），
 * 前端是**读**的一方（client.ts 的 429 分支解析后塞进 ApiError.retryAfter）。
 * 同一个头名两端各写一遍同样会静默失效：前端去读 `RetryAfter` 或 `retry-after`
 * 都能"拿到 null"而不报错，界面于是永远退化成「稍后再试」。
 * 头名大小写不敏感（Headers.get 归一化），这里取小写只是与前端读取侧一致。
 */
export const RETRY_AFTER_HEADER = "retry-after";
