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
