// script/build-server.mjs
// 把 server/entry.ts 连同它 import 的 worker/ 与 src/API/ 打成单个 ESM 文件，
// 产物 dist-server/entry.mjs 由 `npm run start:selfhost` 直接 node 跑。
//
// 为什么不像普通脚本那样直接 `node server/entry.ts`：
//   1) Node 剥 TS 类型要求 import 带扩展名（./x.ts），而仓库源码全是 Vite/TS 的无扩展名写法；
//   2) node:sqlite 目前还挂着 ExperimentalWarning，打包后可以用 --disable-warning 精准静音。
// esbuild 本来就是 devDependency（单测运行器 script/unit-tests.mjs 就在用），不新增依赖。
//
// worker/ 与 src/API/ 全仓库零 npm 依赖（import 全是相对路径），所以产物是自包含的，
// 不需要 external，也不需要 node_modules 在场。

import esbuild from "esbuild";

await esbuild.build({
    entryPoints: ["server/entry.ts"],
    outfile: "dist-server/entry.mjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    logLevel: "info",
});
