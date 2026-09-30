// src/API/http.ts
// 前后端共用的 barrel：数据形状、配置键名、键判定，外加几个纯函数。
// 真正的 NavigationAPI 类在 ./navigationApi.ts。
//
// ⚠️ 这个文件必须保持「没有顶层副作用」：前端 30 多处从这里 import 类型和常量，
// 一旦这里（或它 import 的模块）有顶层副作用，Rollup 就摇不掉背后的东西 ——
// 把类留在 http.ts 时那句 Object.assign 就是这么把 126 个方法体（全是 D1 的 SQL）
// 拖进浏览器包的，实测 63 KB / gzip 15.5 KB。所以：
//   - 类放 navigationApi.ts，这里只用 `export type` 把类型再导出（编译期擦掉，无运行时依赖）
//   - 需要类的**值**（new NavigationAPI / createAPI）的，请直接 import ./navigationApi
//
// 类型 / 常量 / 键判定原本全在这个文件里，现已拆到下面三个文件。
// 这里原样再导出一遍，外面（Worker 路由、测试、前端）的 import 不用跟着改。
export * from "./types";
export * from "./configKeys";
export * from "./configGuards";
export {
    resetMigrationCacheForTests,
    stripSiteCredentials,
    sanitizeLocalPrefs,
    sanitizeIconUrl,
} from "./methods/internals";
export { EXPORT_VERSION, normalizeImportData } from "./methods/transfer";
// 类型再导出：只有类型，编译期就擦掉了，不会把 navigationApi.ts 拖进浏览器包
export type { NavigationAPI } from "./navigationApi";
