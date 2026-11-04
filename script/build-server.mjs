// script/build-server.mjs
// 把 server/entry.ts 连同它 import 的 worker/ 与 src/API/ 打成单个 ESM 文件，
// 产物 dist-server/entry.mjs 由 `npm run start:selfhost` 直接 node 跑。
//
// 为什么不像普通脚本那样直接 `node server/entry.ts`：
//   1) Node 剥 TS 类型要求 import 带扩展名（./x.ts），而仓库源码全是 Vite/TS 的无扩展名写法；
//   2) node:sqlite 目前还挂着 ExperimentalWarning，打包后可以用 --disable-warning 精准静音。
// esbuild 本来就是 devDependency（单测运行器 script/unit-tests.mjs 就在用），不新增依赖。
//
// worker/ 与 src/API/ 全仓库零 npm 依赖（import 全是相对路径），所以产物基本自包含 ——
// 除了一个例外：**undici**。
//   · server/egressDispatch.ts 要 `import("undici")` 建 Agent，把出站连接钉在校验过的
//     IP 上（DNS rebinding 闭环，见那个文件的文件头）；
//   · undici **不能**被 esbuild 打进 ESM 单文件：它会 `require("node:assert")` 之类的
//     内建模块，打进去后运行期报 `Dynamic require of "node:assert" is not supported`。
// 所以它必须 external（产物里保持动态 `import("undici")`），由运行阶段提供：
//   - Dockerfile 运行阶段 COPY 了 node_modules/undici；
//   - npm 直跑时 node_modules 本来就在。
// 两者都拿不到时 entry.ts 不会崩：installEgressDispatcher 返回 { installed: false }，
// 服务照常起，只退化成「出站前复核」的缓解模式并在启动日志里告警。

import esbuild from "esbuild";

await esbuild.build({
    entryPoints: ["server/entry.ts"],
    outfile: "dist-server/entry.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // ⚠️ 唯一的运行期外部依赖（理由见文件头）。写错这里会得到
    // 「Dynamic require of "node:assert" is not supported」的启动崩溃。
    external: ["undici"],
    logLevel: "info",
});
