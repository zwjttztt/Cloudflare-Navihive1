// src/API/d1Limits.ts
// D1 的平台上限，以及「按上限切批」的纯函数。
//
// 为什么单独放一个文件：这些数字被**两侧**同时需要 ——
//   · 自托管适配器（server/sqlite-d1.ts）的严格模式拿它当判据，
//     在违反时主动抛错，而不是等线上炸；
//   · 业务代码（批量删除 / 恢复）拿它当切批依据，避免写出线上必炸的 SQL。
// 以前这些数字只活在注释里（「D1 单次 batch 有语句数上限」），于是同一份仓库里
// 出现了两种写法：transfer.ts 正确地分批，data.ts 把 500 个 id 塞进一条 IN。
// 数字必须在代码里，才能被 import、被单测钉住。
//
// ─────────────────────────────────────────────────────────────────────────
// 取值来源（逐条标注，没核实的必须写「未能核实」，不许写看起来权威的假数字）
// ─────────────────────────────────────────────────────────────────────────
// 来源页：<https://developers.cloudflare.com/d1/platform/limits/>（页面标注
// Last updated Oct 24, 2026），校验于 2026-10-30。
//   - "Maximum bound parameters per query 100"                → D1_MAX_BOUND_PARAMS
//   - "Maximum SQL statement length 100,000 bytes (100 KB)"   → D1_MAX_SQL_LENGTH_BYTES
// 该页对 batch 只说了一句可核实的：「单条语句的限制适用于 batch 内的**每一条**语句」，
// 并在 FAQ 里举例「一个含 2000 条语句的 batch 可以在单次 Worker 调用里跑完」——
// **没有给出 batch 语句数上限的数字**。所以下面那条不是平台限制，是本仓的工程保守值，
// 已明确标注；触发它不等于平台会失败，但等于「这里该复查一下是不是忘了分批」。
//
// 绑定参数形态的限制见
// <https://developers.cloudflare.com/d1/worker-api/prepared-statements/#bind>：
// "Currently, D1 only supports Ordered (?NNNN) and Anonymous (?) parameters."
// 也就是说 SQLite 支持的 `:name` / `@name` / `$name` 在 D1 上不认 —— 本机照样能跑，
// 上线才失败。这一条由严格模式在 prepare 后按 SQL 文本检查。

/** 单条 SQL 的绑定参数上限。已核实（limits 页，2026-10-30 校验） */
export const D1_MAX_BOUND_PARAMS = 100;

/** 单条 SQL 的长度上限（字节）。已核实（limits 页，2026-10-30 校验） */
export const D1_MAX_SQL_LENGTH_BYTES = 100_000;

/**
 * **一个 batch 里的语句数上限 —— 未能核实，不是平台限制。**
 *
 * 官方文档没有这个数字（只说明单条语句的限制适用于 batch 内每条语句，并举例 2000 条
 * 的 batch 能跑）。这里取 1000 是本仓的**工程保守值**：触发它不是「平台要炸了」，
 * 而是「这里一次性塞了太多语句，该复查是不是忘了分批」。真要放宽请连同注释一起改，
 * 别只改数字。
 */
export const D1_MAX_BATCH_STATEMENTS = 1000;

/** 严格模式的开关环境变量名（只有自托管适配器读它：Worker 侧没有 process.env） */
export const D1_STRICT_ENV_KEY = "NAVIHIVE_STRICT_D1";

/**
 * 按「单条 SQL 的绑定参数上限」把一串 id 切成多批。
 *
 * `reserved` = 这条 SQL 里除这批 id 之外还占几个参数（比如 scopeSql 追加的
 * `user_id = ?` 占 1 个）。不预留的话，「99 个 id + 1 个 user_id」看着没超 100，
 * 实际绑了 100 个，正好卡在上限上 —— 边界上差一个就是线上失败与本机全绿的差别。
 *
 * ⚠️ 每批至少 1 个（reserved 大到把预算吃光时也不退化成空批导致死循环）。
 */
export function chunkByParamBudget<T>(
    items: T[],
    reservedParams = 0,
    maxParams: number = D1_MAX_BOUND_PARAMS
): T[][] {
    const budget = Math.max(1, maxParams - Math.max(0, reservedParams));
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += budget) {
        out.push(items.slice(i, i + budget));
    }
    return out;
}

/** 按「batch 语句数上限」把一组语句切成多批。空输入返回空数组（不需要发空 batch） */
export function chunkStatements<T>(
    statements: T[],
    maxStatements: number = D1_MAX_BATCH_STATEMENTS
): T[][] {
    const size = Math.max(1, Math.floor(maxStatements));
    const out: T[][] = [];
    for (let i = 0; i < statements.length; i += size) {
        out.push(statements.slice(i, i + size));
    }
    return out;
}
