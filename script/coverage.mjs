// 覆盖率：让「哪些代码从来没被用例碰到过」变成一张能查的表。
//
// 用法：npm run coverage
//
// 输出两层，从粗到细：
//   1. **触及率**（零依赖，秒级）：用 esbuild 打包所有用例，从 metafile 反推
//      哪些 src/ / worker/ 下的文件被**任何**用例间接引入了。没被引入的 = 零覆盖候选。
//      粒度是「文件」不是「行」—— 一个文件只被 import 了一行也算触及，
//      所以它回答不了「这个文件覆盖了百分之几」，但能回答「哪个模块压根没人碰」。
//   2. **行覆盖率**（需 c8）：c8 会拿 sourcemap 把 V8 的覆盖率重映射回源文件。
//      装了 c8 就自动多跑一层，没装就只出第 1 层。
//
// 为什么第 2 层必须靠 c8 而不是 Node 自带的 --experimental-test-coverage：
//   用例是先经 esbuild 打成 bundle 再交给 node:test 的（源码里的 import 不带扩展名，
//   Node 的 ESM 解析器认不了），V8 看到的**全是 bundle 文件**。实测 Node 不会拿
//   sourcemap 做重映射，报出来的是 `script/tmp-tests/pure/xxx.test.mjs 96%` 加一堆
//   无关文件，那个百分比对 src/ 毫无意义。
//
// 刻意不做的事：
//   - 不设门槛、不卡 CI：覆盖率是导航用的，先有数据再谈数字。
//   - 不上传报告：本项目没有覆盖率平台。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(`${ROOT}/package.json`);
const esbuild = require("esbuild");

const SKIP_DIR = new Set(["node_modules", "dist", "coverage", ".workbuddy", ".git"]);

/** 递归收集某个根目录下的 .ts / .tsx（跳过类型声明与测试） */
function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIR.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
    }
    return out;
}

const rel = p => path.relative(ROOT, p).split(path.sep).join("/");

// ---------- 第 1 层：谁被用例碰到了 ----------

const testsDir = path.join(ROOT, "tests");
const all = fs.existsSync(testsDir) ? fs.readdirSync(testsDir) : [];
const entries = all
    .filter(f => f.endsWith(".test.ts") || f.endsWith(".dom.test.tsx"))
    .map(f => path.join(testsDir, f));

if (entries.length === 0) {
    console.error("tests/ 下没有用例");
    process.exit(1);
}

process.stdout.write(`扫描 ${entries.length} 个用例引用了哪些源文件… `);

// write:false —— 只要 metafile，不真落盘，省掉一次全量写文件
const result = await esbuild.build({
    entryPoints: entries,
    bundle: true,
    write: false,
    // 多入口时 esbuild 强制要 outdir，哪怕 write:false 不会真落盘
    outdir: path.join(HERE, "tmp-coverage-scan"),
    metafile: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "error",
    jsx: "automatic",
    external: ["jsdom"],
    // 用例里有顶层 await（DOM 替身要用），esbuild 需要知道目标支持
    supported: { "top-level-await": true },
});

const touched = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
    const abs = path.resolve(ROOT, input);
    if (abs.startsWith(path.join(ROOT, "src") + path.sep)) touched.add(abs);
    if (abs.startsWith(path.join(ROOT, "worker") + path.sep)) touched.add(abs);
}

const sources = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "worker"))];
const untouch = sources.filter(p => !touched.has(p));
const lines = p => fs.readFileSync(p, "utf-8").split("\n").length;

untouch.sort((a, b) => lines(b) - lines(a));

console.log("完成\n");
console.log("=== 第 1 层：文件触及率（被任何用例间接引入就算触及）===");
console.log(`源文件 ${sources.length} 个，被触及 ${sources.length - untouch.length} 个`);
console.log(
    `从未被任何用例引入：${untouch.length} 个` +
        (untouch.length ? `（合计 ${untouch.reduce((n, p) => n + lines(p), 0)} 行）` : "")
);
if (untouch.length > 0) {
    console.log("\n按行数从大到小 —— 这就是「下一个该补谁的测试」的候选名单：");
    for (const p of untouch) console.log(`  ${String(lines(p)).padStart(5)} 行  ${rel(p)}`);
} else {
    console.log("每个文件都至少被一个用例引入过。");
}

// ---------- 第 2 层：装了 c8 就再跑真正的行覆盖率 ----------

let c8Bin = null;
try {
    c8Bin = require.resolve("c8/bin/c8.js");
} catch {
    /* 没装 */
}

if (!c8Bin) {
    console.log(
        "\n（第 2 层行覆盖率需要 c8：npm install --ignore-scripts -D c8；没装也能用上面的清单）"
    );
    process.exit(0);
}

console.log("\n=== 第 2 层：行覆盖率（c8 + sourcemap 重映射）===");
const args = [
    c8Bin,
    // 先按 sourcemap 重映射、再套 exclude 规则：顺序反了会把 src/ 一起排除掉
    "--exclude-after-remap",
    "--all",
    "--src",
    "src",
    "--src",
    "worker",
    "--extension",
    ".ts",
    "--extension",
    ".tsx",
    "--reporter",
    "text",
    "--reporter",
    "lcov",
    "--reports-dir",
    "coverage",
    "--exclude",
    "tests/**",
    "--exclude",
    "script/**",
    "--exclude",
    "coverage/**",
    "--exclude",
    "dist/**",
    "--exclude",
    "*.config.*",
    process.execPath,
    "script/unit-tests.mjs",
];

const child = spawn(process.execPath, args, {
    stdio: "inherit",
    // 让运行器生成 sourcemap 并保留产物：c8 是在本进程退出之后才去读 .map 做重映射的
    env: { ...process.env, NAVIHIVE_COVERAGE: "1" },
});

child.on("exit", code => {
    fs.rmSync(path.join(HERE, "tmp-tests"), { recursive: true, force: true });
    process.exit(code ?? 1);
});
