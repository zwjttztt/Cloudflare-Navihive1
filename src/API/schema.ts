// D1 与 Worker 环境变量类型的最小声明。
//
// 从 http.ts 里拆出来的原因：它们是「边界形状」而不是业务逻辑，跟 NavigationAPI
// 的任何一个方法都没有耦合，单独放一份之后两个文件各自清爽。
//
// 现已统一到 shared/env.ts（前后端共用一份），这里只为保持既有 import 路径：
// 以前 src/API/methods/*.ts 都从本文件取 D1PreparedStatement，worker 侧另有一份
// 独立的 Env —— 两份声明各自漂移，出现了「代码里读了、自托管白名单里没有」的静默
// 失效（详见 shared/env.ts 文件头）。现在这里只剩再导出，改名 / 加键只需改一处。
// ⚠️ 本文件仍在 script/coverage.mjs 的 EXCLUDE 与 tests/pureTypeFiles.test.ts 的
// 「纯类型文件」名单里：**不许**在这里出现任何运行时导出（export const / function…），
// 也**不许**用非 `import type` 的 import，否则那条用例会红。

export type { D1Database, D1PreparedStatement, D1Result, Env } from "../../shared/env";
