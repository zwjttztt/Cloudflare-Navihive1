// 覆盖率：让「哪些代码从来没被用例碰到过」变成一张能查、能卡的表。
//
// 用法：npm run coverage      （只出第 1 层，零依赖）
//       npm run check:coverage（同上，但任意层跌破下限会退出码 1，供 CI 当门禁）
//
// 输出两层，从粗到细：
//   1. **触及率（按层，零依赖，秒级）**：用 esbuild 打包所有用例，从 metafile 反推
//      哪些 src/ / worker/ 下的文件被**任何**用例间接引入了。没被引入的 = 零覆盖候选。
//      粒度是「文件」不是「行」—— 一个文件只被 import 了一行也算触及，
//      所以它回答不了「这个文件覆盖了百分之几」，但能回答「哪个模块压根没人碰」。
//      这一层额外按**粗粒度分层**（API / worker / components / hooks / utils / context /
//      其他）汇总每个层的文件触及率，并对每个层设一个下限（防回归门禁）：
//      现在就红没意义，门禁要抓的是「以后往某个层塞了没测的文件」。
//      纯类型声明文件与应用 / 沙箱入口没有运行时逻辑可被用例执行，从统计与门禁里剔除
//      （见下方 EXCLUDE 列表），否则只会逼出一堆无意义的测试。
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
//   - 第 1 层不设行级门槛：文件触及率是「有没有人碰」的粗信号，不当成精确数字考核。
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
    // ⚠️ 字体 / 样式必须给 loader：和 unit-tests.mjs 同一套理由 ——
    // 某些用例会连带引入 katex.min.css，里面 url() 指向十几张 woff2/ttf，
    // esbuild 默认不认这些后缀，一碰就 "No loader is configured for .woff2 files"
    // 把整份覆盖率报告拖死（2026-10-13 实测：60 个 ERROR，脚本完全跑不出来）。
    loader: { ".css": "empty", ".woff": "file", ".woff2": "file", ".ttf": "file" },
});

const touched = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
    const abs = path.resolve(ROOT, input);
    if (abs.startsWith(path.join(ROOT, "src") + path.sep)) touched.add(abs);
    if (abs.startsWith(path.join(ROOT, "worker") + path.sep)) touched.add(abs);
}

const sources = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "worker"))];
const lines = p => fs.readFileSync(p, "utf-8").split("\n").length;

// 这些文件是「纯类型声明」或「应用 / 沙箱入口」，没有运行时逻辑可被用例执行，
// 硬算进门禁只会逼出一堆无意义的测试。从分层统计与门禁里剔除（每条都标注了理由）。
const EXCLUDE = new Set([
    "src/API/responses.ts",   // 端点返回形状的类型表（import type 为主，无运行时）
    "src/API/schema.ts",      // D1 类型声明
    "src/types.ts",           // 共享类型
    "worker/types.ts",        // Env / 运行时类型声明
    "worker/routes/types.ts", // RouteCtx 接口
    "src/main.tsx",           // 应用入口
    "src/mermaidSandbox.ts",  // 流程图沙箱入口
]);

// 粗粒度分层：把零散的 src 顶层文件归到「其他(src 顶层)」，便于一眼看出哪层是短板。
const LAYER_GROUPS = {
    "API": ["src/API"],
    "worker": ["worker"],
    "components": ["src/components"],
    "hooks": ["src/hooks"],
    "utils": ["src/utils"],
    "context": ["src/context"],
    "其他(src 顶层)": ["src"],
};
function layerOf(abs) {
    const x = rel(abs);
    for (const [name, prefixes] of Object.entries(LAYER_GROUPS)) {
        if (prefixes.some(p => x === p || x.startsWith(p + "/"))) return name;
    }
    return "其他(src 顶层)";
}

// 每层文件触及率下限（防回归门禁）。初值取**当前实测值**当地板：
// 现在就红没有任何意义，门禁要抓的是「以后往某个层塞了没测的文件」。
// utils/hooks/context/API/worker/其他 当前逻辑文件 100% 触及，定 1.0；
// components 因 ThemeToggle / notesPageCtx 两处暂未测，定 0.98（再掉一个就红）。
const MIN_TOUCH = {
    "API": 1.0, "worker": 1.0, "components": 0.98,
    "hooks": 1.0, "utils": 1.0, "context": 1.0, "其他(src 顶层)": 1.0,
};

// 按层聚合（仅非排除文件）
const byLayer = {};
for (const s of sources) {
    if (EXCLUDE.has(rel(s))) continue;
    const L = layerOf(s);
    const stat = byLayer[L] || (byLayer[L] = { tot: 0, touch: 0, untouchLines: 0 });
    stat.tot++;
    if (touched.has(s)) stat.touch++;
    else stat.untouchLines += lines(s);
}
const untouch = sources.filter(p => !touched.has(p) && !EXCLUDE.has(rel(p)));
untouch.sort((a, b) => lines(b) - lines(a));

const LAYER_ORDER = ["API", "worker", "components", "hooks", "utils", "context", "其他(src 顶层)"];
let gateFailed = false;
const breaches = [];

console.log("完成\n");
console.log("=== 第 1 层：文件触及率（按层，被任何用例间接引入就算触及）===");
console.log("层 | 文件数 | 已触及 | 未触及 | 未触及行数 | 触及率 | 下限");
for (const L of LAYER_ORDER) {
    const s = byLayer[L];
    if (!s) continue;
    const ratio = s.touch / s.tot;
    const min = MIN_TOUCH[L] ?? 0.9;
    const ok = ratio >= min;
    if (!ok) {
        gateFailed = true;
        breaches.push(`${L} 触及率 ${(ratio * 100).toFixed(1)}% < 下限 ${(min * 100).toFixed(0)}%`);
    }
    console.log(
        `${L.padEnd(16)} | ${String(s.tot).padStart(4)} | ${String(s.touch).padStart(4)} | ` +
            `${String(s.tot - s.touch).padStart(4)} | ${String(s.untouchLines).padStart(5)} | ` +
            `${(ratio * 100).toFixed(1)}% | ${(min * 100).toFixed(0)}%${ok ? "" : "  ❌"}`
    );
}
const total = Object.values(byLayer).reduce(
    (a, s) => ({ tot: a.tot + s.tot, touch: a.touch + s.touch }),
    { tot: 0, touch: 0 }
);
console.log(
    `合计          | ${String(total.tot).padStart(4)} | ${String(total.touch).padStart(4)} | ` +
        `${String(total.tot - total.touch).padStart(4)} | —      | ` +
        `${(total.touch / total.tot * 100).toFixed(1)}% | —`
);

if (untouch.length > 0) {
    console.log("\n未触及的逻辑文件（按行数，这就是「下一个该补测试」的名单）：");
    for (const p of untouch) console.log(`  ${String(lines(p)).padStart(5)} 行  ${rel(p)}`);
} else {
    console.log("\n每个逻辑文件都至少被一个用例引入过。");
}
if (breaches.length) {
    console.log("\n❌ 覆盖率分层门禁未通过：");
    for (const b of breaches) console.log("  - " + b);
} else {
    console.log("\n✅ 覆盖率分层门禁通过（任一层的文件触及率未跌破下限）。");
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
    process.exit(gateFailed ? 1 : 0);
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
    process.exit(gateFailed ? 1 : (code ?? 1));
});
