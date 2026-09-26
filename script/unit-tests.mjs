// 纯函数单测运行器：把 tests/*.test.ts 用 esbuild 打成临时 bundle，再交给 node:test。
//
// 为什么不直接 `node --test tests/`：
// Node 22 能剥掉 TS 类型，但源码里的 import 是**无扩展名**的（`from "./search"`），
// 那是 Vite / TS 的写法，Node 的 ESM 解析器不认。用 esbuild 过一道既解决了扩展名，
// 又顺手把类型导入、路径解析都处理掉了（esbuild 本来就是这套工具链的依赖，不用额外装东西）。
//
// 用法：npm test   （等价于 node script/unit-tests.mjs）
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(HERE, "tmp-tests");

const require = createRequire(`${ROOT}/package.json`);
const esbuild = require("esbuild");

// 浏览器 API 的最小替身：放在 bundle 最前面执行，保证模块初始化时就能拿到。
// 目前只用到 localStorage（失效记录、星标标签都存在那儿）。
const BANNER = `
const __store = new Map();
globalThis.localStorage = {
    getItem: k => (__store.has(k) ? __store.get(k) : null),
    setItem: (k, v) => void __store.set(k, String(v)),
    removeItem: k => void __store.delete(k),
    clear: () => __store.clear(),
    key: i => [...__store.keys()][i] ?? null,
    get length() { return __store.size; },
};
`;

const testsDir = path.join(ROOT, "tests");
const entries = fs.existsSync(testsDir)
    ? fs
          .readdirSync(testsDir)
          .filter(f => f.endsWith(".test.ts"))
          .map(f => path.join(testsDir, f))
    : [];

if (entries.length === 0) {
    console.error("tests/ 下没有 .test.ts");
    process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
await esbuild.build({
    entryPoints: entries,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outdir: OUT_DIR,
    outExtension: { ".js": ".mjs" },
    banner: { js: BANNER },
    logLevel: "error",
});

console.log(`已打包 ${entries.length} 个测试文件，交给 node:test\n`);

// 显式列出产物再交给 --test：直接把目录丢给 --test 时，
// Node 会把它当成模块路径去 require，报 MODULE_NOT_FOUND
const bundles = fs
    .readdirSync(OUT_DIR)
    .filter(f => f.endsWith(".mjs"))
    .map(f => path.join(OUT_DIR, f));

const child = spawn(process.execPath, ["--test", ...bundles], { stdio: "inherit" });
child.on("exit", code => {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    process.exit(code ?? 1);
});
