// 覆盖率：让「哪些代码从来没被用例碰到过」变成一张能查、能卡的表。
//
// 用法：npm run coverage      （两层都跑：触及率 + c8 行覆盖率）
//       npm run check:coverage（同上，任意层跌破下限会退出码 1，供 CI 当门禁）
//       node script/coverage.mjs --layer1-only
//                             （只判第 1 层 import 覆盖；第 2 层被**显式**跳过，
//                               且输出里会标注「本轮只判 import 覆盖」。
//                               ⚠️ 两个 npm 命令都不传这个开关 —— 门禁默认是严格的）
//
// ⚠️ 门禁是 fail-closed 的（2026-11-04 审查项 R13 修）：**「量不到」一律算不过。**
//    以前有两条静默放行的路 —— 缺 c8 时 `process.exit(gateFailed ? 1 : 0)`、
//    读不到 coverage-summary.json 时 `return { failed: false }`。门禁在量不到的时候
//    放行等于没有门禁：真出问题的那一轮恰好就是量不到的那一轮。现在：
//      · 缺 c8                → 退出码 1（装依赖后重跑）
//      · summary 不存在        → 退出码 1
//      · summary 不是合法 JSON → 退出码 1
//      · 聚合后 lines.total=0  → 退出码 1（一条行统计都没有 = 没测到）
//    判定逻辑抽到 script/coverageGate.mjs 的纯函数里，由
//    tests/coverageGateFailClosed.test.ts 表驱动钉住 —— 本文件只负责跑与打印。
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
//   2. **行覆盖率**（c8）：c8 拿 sourcemap 把 V8 的覆盖率重映射回源文件，
//      报的是真实的 行 / 分支 / 函数 百分比，再按同一套分层汇总一遍。
//
// ⚠️ 两层经常差得很远，这不是 bug，是这个文件存在的意义：
//    第 1 层的 100% 只是「每个文件都被 import 过一次」。一个 900 行、零用例的组件
//    被别的测试顺手 import 一次，第 1 层就满分，第 2 层才告诉你它其实只跑了 12 行。
//    2026-10-28 之前 c8 从来没被装上，第 2 层一次都没执行过 —— 于是那个 100% 一直是
//    「名字对、量的是别的东西」。现在两层都印出来，差距自己看。
//
// 为什么第 2 层必须靠 c8 而不是 Node 自带的 --experimental-test-coverage：
//   用例是先经 esbuild 打成 bundle 再交给 node:test 的（源码里的 import 不带扩展名，
//   Node 的 ESM 解析器认不了），V8 看到的**全是 bundle 文件**。实测 Node 不会拿
//   sourcemap 做重映射，报出来的是 `script/tmp-tests/pure/xxx.test.mjs 96%` 加一堆
//   无关文件，那个百分比对 src/ 毫无意义。
//
// 刻意不做的事：
//   - 第 1 层不设行级门槛：文件触及率是「有没有人碰」的粗信号，不当成精确数字考核。
//   - 第 2 层的下限是**防回归地板**，取实测值往下留一点余量，不是「应该达到的目标」。
//     想提高数字只能补用例，调低 MIN_L2 只会让门禁变成摆设（改动必须在提交信息里写理由）。
//   - 不上传报告：本项目没有覆盖率平台。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { decideCoverageExit, parseCoverageArgs, LAYER1_ONLY_FLAG } from "./coverageGate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(`${ROOT}/package.json`);
const esbuild = require("esbuild");

// ---------- CLI：只有 --layer1-only 一个开关 ----------
//
// 不认识的 `-x` 直接报错退出：把打错的开关默默忽略，人会以为自己要的模式生效了，
// 实际跑的是另一套（可能多花几分钟），最后拿到一个他没想过的结论。
const cliArgs = parseCoverageArgs(process.argv.slice(2));
if (cliArgs.unknown.length > 0) {
    console.error(
        `未知参数：${cliArgs.unknown.join(" ")}\n` +
            `只认一个开关：${LAYER1_ONLY_FLAG}（只跑第 1 层 import 触及率）。`
    );
    process.exit(1);
}
const layer1Only = cliArgs.layer1Only;

if (layer1Only) {
    console.log(
        `\n⚠️⚠️  第 2 层已按 ${LAYER1_ONLY_FLAG} 跳过，本轮只判 import 覆盖 ` +
            `（文件被 import 过 ≠ 跑过多少行，本轮没有行覆盖率数据）⚠️⚠️\n`
    );
}

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
    // server/ 与 shared/ 以前根本不在统计里 —— 自托管适配层和前后端共享契约
    // 明明有运行时逻辑，却在覆盖率报表上「不存在」（2026-10-24 全站复查发现）。
    if (abs.startsWith(path.join(ROOT, "server") + path.sep)) touched.add(abs);
    if (abs.startsWith(path.join(ROOT, "shared") + path.sep)) touched.add(abs);
}

const sources = [
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, "worker")),
    ...walk(path.join(ROOT, "server")),
    ...walk(path.join(ROOT, "shared")),
];
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
    // 纯类型文件：只有 import type / interface / type，运行时一行都不产生
    //（里面的字段类型是 tsc 从 NotesPage 真实代码导出来的）。硬算进门禁只会逼出
    // 无意义的测试 —— 但「它必须保持纯类型」由 tests/pureTypeFiles.test.ts 守着。
    "src/components/notes/notesPageCtx.ts",
    // 自托管生产入口（node:sqlite + 静态服务 + 升级 spool）：jsdom 单测 import 不了它 ——
    // 硬塞会把 node:sqlite / fs 拖进浏览器侧环境。
    // 它**没有行覆盖**：此前只有 e2e:share-extra 与 probe:edge 通过 spawn
    // dist-server/entry.mjs 间接执行到其中的「非入口功能」（路由、静态守卫、附件），
    // 入口自身那部分（装配 env、选端口、读 spool 目录、优雅退出）一直无人执行。
    // 显式排除的真实理由是它 1400+ 行、永远挂在「未触及名单」第一名，把真正该补测的
    // 小文件挤出视野；**不是**「已经有人守着」。
    // 自本次改动起由 CI 的「自托管冒烟（smoke:selfhost）」一步真起实例守护入口本身。
    "server/entry.ts",
]);

// 粗粒度分层：把零散的 src 顶层文件归到「其他(src 顶层)」，便于一眼看出哪层是短板。
const LAYER_GROUPS = {
    "API": ["src/API"],
    "worker": ["worker"],
    "components": ["src/components"],
    "hooks": ["src/hooks"],
    "utils": ["src/utils"],
    "context": ["src/context"],
    "server": ["server"],
    "shared": ["shared"],
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
// components：ThemeToggle 已补 DOM 用例、notesPageCtx 是纯类型已排除，回到 1.0。
const MIN_TOUCH = { "server": 1.0, "shared": 1.0,
    "API": 1.0, "worker": 1.0, "components": 1.0,
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

const LAYER_ORDER = ["API", "worker", "components", "hooks", "utils", "context", "server", "shared", "其他(src 顶层)"];
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

// ---------- 第 2 层：c8 真行覆盖率 ----------
//
// 这一层会**再跑一遍全量单测**（c8 得包在 node 外面才能收 V8 覆盖率），几分钟。
// 它量的是「行 / 分支 / 函数」，不是「文件被 import 过」—— 两者的差距就是本文件的重点。

/**
 * 第 2 层的防回归地板（百分比）。**不是目标值**，是「别比现在更差」的线。
 *
 * 初值取 2026-10-28 第一次真跑出来的实测值（见下方注释里的数字），往下留了一点余量，
 * 免得并行调度抖动把门禁抖红。往上提只能靠补用例；往下调等于把门禁变成摆设。
 */
// 初值取 2026-10-28 **第一次真跑出来**的实测值：行 87.0% / 分支 87.1% / 函数 68.9%
// （386 个文件、98620 行）。往下各留约 2 个百分点的抖动余量，避免并行调度把门禁抖红。
//
// ⚠️ 为什么这次地板能被填上：在此之前第 2 层从来没执行过（c8 没装），而 unit-tests.mjs
// 打包时带了 `outExtension: {".js": ".mjs"}`，配 external sourcemap 时 esbuild 不写
// `sourceMappingURL` 注释 → c8 找不到 map 就不做重映射，覆盖率全落在 bundle 上、又被
// `--exclude script/**` 排掉，报出来是「386 文件 / 98620 行 / covered 全 0」。
// 改成 inline sourcemap 之后才第一次量到真东西（详见 unit-tests.mjs 的注释）。
// 在这之前，唯一在跑的第 1 层是 100% —— 那个数字只说明「文件被 import 过」。
const MIN_L2 = {
    lines: 85, // 实测 88.2%
    branches: 85, // 实测 87.7%
    // 实测 72.8%（2629/3610 函数）。从 66 抬到 70 靠的是 tests/mockClientSurface.test.ts：
    // 它把 MockNavigationClient 原型上每个方法都真调一遍（演示模式那 133 个函数以前只覆盖
    // 27 个）。抬之前是 69.2% —— **先补测试再抬地板**，不然改完当场红。
    functions: 70,
};

/**
 * 按目录的函数覆盖地板（防回退，不是目标值）。
 *
 * 为什么只给这几个目录设：它们是纯函数 / 服务端逻辑，函数覆盖天然高，锁住能防回退；
 * `src/components`（57%）与 `src/context`（54%）是 React 组件与 context，
 * 大量箭头回调与事件处理器**按设计**就不会全被跑到，一刀切会逼出一堆无意义用例。
 *
 * ⚠️ 每个数字取「floor(实测) − 2」而不是 floor(实测)：QA 独立复核发现，取 floor(实测)
 * 会让 API/methods(93.23) / worker(89.18) / shared(86.67) 三个目录**一个函数都掉不得** ——
 * 以后任何无关改动往 worker 添一个没覆盖的分支函数就红，而那不是回归，只是新代码。
 * 本文件第 2 层总地板（MIN_L2）本来就是「实测往下留约 2 个百分点」，这里沿用同一口径：
 * 地板是**防回归**（拦住整块删测试那种级别的撤退），不是追单个函数的波动。
 * 代价是比实测低 2pt —— 收益是它不会因为无关改动天天红（红了没看 = 门禁等于没有）。
 * 地板必须 ≤ 实测，否则门禁立刻红（本轮方案里原本写的「一律 90」就是这么踩坑的 ——
 * worker 实测 89.2%、shared 实测 86.7%，锁 90 当场失败）。
 */
const MIN_L2_BY_DIR = {
    "src/utils": 90, // 实测 91.8%（698/760），留 1.8pt
    "src/API/methods": 91, // 实测 93.2%（248/266），留 2.2pt
    worker: 87, // 实测 89.2%（173/194），留 2.2pt
    // server 取 88：本轮实测 90.8%，但上一轮是 88.9%，run 间差两个点
    // （server/entry.ts 是否进 c8 统计会变）。地板要能扛住这种波动，取更低值。
    server: 88, // 实测 90.8%（59/65），上一轮 88.9%，留 2.8pt
    shared: 84, // 实测 86.7%（13/15），留 2.7pt
};

const COV_DIR = path.join(ROOT, "coverage");
const SUMMARY_FILE = path.join(COV_DIR, "coverage-summary.json");

let c8Bin = null;
try {
    c8Bin = require.resolve("c8/bin/c8.js");
} catch {
    /* 没装 */
}

const fmtPct = p => (p === null ? "—" : `${p.toFixed(1)}%`);

/**
 * 读 c8 的 json-summary 并按第 1 层同一套分层聚合。
 *
 * ⚠️ 只返回**事实**，不返回结论：判定交给 script/coverageGate.mjs 的纯函数，
 * 这样「读不到 / 读坏 / 一条行统计都没有」这几条 fail-closed 判据才能被用例钉住。
 *
 * 聚合用「covered / total 求和」而不是「各文件百分比求平均」：
 * 平均值会让一个 5 行的小文件和一个 900 行的组件等权，数字好看但没意义。
 *
 * @returns {{ summaryMissing: boolean, summaryReadError: string | null, linesTotal: number, breaches: string[] }}
 */
function reportLayer2() {
    if (!fs.existsSync(SUMMARY_FILE)) {
        console.log(
            "\n❌ coverage/coverage-summary.json 不存在 —— 这一轮没跑出行覆盖率，**门禁不通过**。" +
                "\n   （看上面 c8 的输出，通常是单测本身挂了）"
        );
        return { summaryMissing: true, summaryReadError: null, linesTotal: 0, breaches: [] };
    }

    let raw;
    try {
        raw = fs.readFileSync(SUMMARY_FILE, "utf8");
    } catch (error) {
        const why = error?.code || error?.message || String(error);
        console.log(
            `\n❌ coverage/coverage-summary.json 读不出来（${why}）—— 这一轮没跑出行覆盖率，**门禁不通过**。`
        );
        return { summaryMissing: false, summaryReadError: `读取失败（${why}）`, linesTotal: 0, breaches: [] };
    }

    let summary;
    try {
        summary = JSON.parse(raw);
    } catch (error) {
        const why = error?.message || String(error);
        console.log(
            `\n❌ coverage/coverage-summary.json 不是合法 JSON（${why}）—— **门禁不通过**。` +
                "\n   （产物写了一半就被打断？重跑一次 npm run coverage）"
        );
        return { summaryMissing: false, summaryReadError: `JSON.parse 失败（${why}）`, linesTotal: 0, breaches: [] };
    }

    const zero = () => ({ lines: [0, 0], branches: [0, 0], functions: [0, 0], files: 0 });
    const agg = zero();
    const byLayerL2 = new Map();
    const byDir = new Map();

    for (const [file, data] of Object.entries(summary)) {
        if (file === "total" || !data) continue;
        const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
        const relative = rel(abs);
        // 只统计源码目录：c8 的 --all 偶尔会把 src 之外的东西也带进来
        if (!/^(src|worker|server|shared)\//.test(relative)) continue;

        const layer = layerOf(abs);
        const dir = path.dirname(relative);
        for (const bucket of [
            agg,
            byLayerL2.get(layer) || byLayerL2.set(layer, zero()).get(layer),
            byDir.get(dir) || byDir.set(dir, zero()).get(dir),
        ]) {
            bucket.files++;
            for (const key of ["lines", "branches", "functions"]) {
                bucket[key][0] += data[key]?.covered ?? 0;
                bucket[key][1] += data[key]?.total ?? 0;
            }
        }
    }

    const ratio = ([covered, tot]) => (tot > 0 ? (covered / tot) * 100 : null);

    // fail-closed（R13）：一条行统计都没有 = 这一轮什么都没量到。
    // 不能继续往下判（下面所有地板都会因为「分母是 0」而被跳过 → 静默变绿）。
    const linesTotal = agg.lines[1];
    if (linesTotal === 0) {
        console.log(
            `\n❌ 第 2 层聚合后 lines.total === 0（summary 里有 ${Object.keys(summary).length - 1} 个条目，` +
                "但没有一条落在 src|worker|server|shared 下）—— 等于没测到，**门禁不通过**。"
        );
        return { summaryMissing: false, summaryReadError: null, linesTotal, breaches: [] };
    }

    console.log("\n=== 第 2 层结果：真实覆盖率（按第 1 层同一套分层）===");
    console.log("层 | 文件数 | 行覆盖 | 分支覆盖 | 函数覆盖");
    for (const L of LAYER_ORDER) {
        const s = byLayerL2.get(L);
        if (!s) continue;
        console.log(
            `${L.padEnd(16)} | ${String(s.files).padStart(4)} | ${fmtPct(ratio(s.lines)).padStart(7)} | ` +
                `${fmtPct(ratio(s.branches)).padStart(7)} | ${fmtPct(ratio(s.functions)).padStart(7)}`
        );
    }
    console.log(
        `${"合计".padEnd(16)} | ${String(agg.files).padStart(4)} | ${fmtPct(ratio(agg.lines)).padStart(7)} | ` +
            `${fmtPct(ratio(agg.branches)).padStart(7)} | ${fmtPct(ratio(agg.functions)).padStart(7)}`
    );

    // 两层摆在一起：这就是「触及率 100%」和「真实覆盖率」的差距
    // （total 是第 1 层的合计：tot = 逻辑文件数，touch = 被引入过的文件数）
    const touchPct = total.tot ? (total.touch / total.tot) * 100 : 0;
    const linePct = ratio(agg.lines);
    console.log(
        `\n第 1 层（文件被 import 过）：${fmtPct(touchPct)}（${total.touch}/${total.tot} 个文件）`
    );
    console.log(`第 2 层（真行覆盖率）  ：${fmtPct(linePct)}（${agg.lines[0]}/${agg.lines[1]} 行）`);
    if (linePct !== null) {
        console.log(
            `差距                 ：${(touchPct - linePct).toFixed(1)} 个百分点 —— ` +
                `「被 import 过」和「真的跑到过」是两件事`
        );
    }

    // 拖后腿的目录 / 文件：门禁红的时候先看这两个清单
    const dirRank = [...byDir.entries()]
        .filter(([, s]) => s.lines[1] >= 100)
        .map(([dir, s]) => ({ dir, pct: ratio(s.lines) ?? 0, lines: s.lines[1] }))
        .sort((a, b) => a.pct - b.pct)
        .slice(0, 5);
    if (dirRank.length > 0) {
        console.log("\n行覆盖率最低的 5 个目录（≥100 行）：");
        for (const d of dirRank) {
            console.log(`  ${fmtPct(d.pct).padStart(7)}  ${String(d.lines).padStart(6)} 行  ${d.dir}`);
        }
    }

    const fileRank = Object.entries(summary)
        .filter(([file]) => file !== "total")
        .map(([file, data]) => {
            const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
            const lines = data?.lines ?? { covered: 0, total: 0 };
            return {
                file: rel(abs),
                uncovered: Math.max(0, (lines.total ?? 0) - (lines.covered ?? 0)),
                pct: lines.total > 0 ? (lines.covered / lines.total) * 100 : 100,
            };
        })
        .filter(f => /^(src|worker|server|shared)\//.test(f.file))
        .sort((a, b) => b.uncovered - a.uncovered)
        .slice(0, 5);
    if (fileRank.length > 0) {
        console.log("\n未覆盖行数最多的 5 个文件：");
        for (const f of fileRank) {
            console.log(
                `  ${String(f.uncovered).padStart(5)} 行未覆盖 (${fmtPct(f.pct).padStart(6)})  ${f.file}`
            );
        }
    }

    const breaches2 = [];
    for (const key of ["lines", "branches", "functions"]) {
        const pct = ratio(agg[key]);
        if (pct === null) continue;
        if (pct < MIN_L2[key]) {
            breaches2.push(`${key} ${pct.toFixed(1)}% < 地板 ${MIN_L2[key]}%`);
        }
    }

    // 目录分层地板：全局 70% 掩盖不了「某个纯函数目录掉回 60%」——
    // 全局数字被 1400 个组件函数摊平，掉 10 个只动 0.3 个点，但那个目录自己已经烂了一半。
    // byDir 的键就是 `path.dirname`，与上面「行覆盖率最低的 5 个目录」用的是同一份聚合。
    const dirFloor = Object.entries(MIN_L2_BY_DIR);
    if (dirFloor.length > 0) {
        console.log("\n函数覆盖分层地板（只盯纯函数 / 服务端目录）：");
        for (const [dir, min] of dirFloor) {
            const s = byDir.get(dir);
            if (!s) {
                // 目录整个消失（改名 / 被删）也要报：否则「把文件挪走」就成了绕过门禁的办法
                breaches2.push(`${dir} 不在覆盖率汇总里（目录改名或被删？地板无人可守）`);
                continue;
            }
            const pct = ratio(s.functions);
            if (pct === null) continue;
            const ok = pct >= min;
            if (!ok) breaches2.push(`${dir} 函数覆盖 ${pct.toFixed(1)}% < 地板 ${min}%`);
            console.log(
                `  ${dir.padEnd(18)} ${fmtPct(pct).padStart(7)} | 地板 ${String(min).padStart(3)}%` +
                    `${ok ? "" : "  ❌"}`
            );
        }
    }

    if (breaches2.length > 0) {
        console.log("\n❌ 第 2 层跌破防回归地板：");
        for (const b of breaches2) console.log("  - " + b);
    } else {
        console.log(
            `\n✅ 第 2 层没跌破地板（行 ${MIN_L2.lines}% / 分支 ${MIN_L2.branches}% / 函数 ${MIN_L2.functions}%）` +
                `，各纯函数目录也都在自己的地板上。地板是「别更差」，不是「够好了」。`
        );
    }
    return { summaryMissing: false, summaryReadError: null, linesTotal, breaches: breaches2 };
}

// ---------- 收口：判定 + 汇总 + 退出码 ----------
//
// 所有分支都从这里出去，判定只走 decideCoverageExit 一个入口 ——
// 以前「缺 c8」和「读不到 summary」各自 `return { failed: false }` / `exit(0)`，
// 那两条正是门禁静默放行的地方。

/**
 * 打印最终汇总并退出。
 *
 * @param {{ summaryMissing?: boolean, summaryReadError?: string | null,
 *           linesTotal?: number, breaches?: string[], c8Missing?: boolean,
 *           runnerExitCode?: number }} facts
 */
function finish(facts = {}) {
    const decision = decideCoverageExit({
        l1Failed: gateFailed,
        c8Missing: facts.c8Missing === true,
        summaryMissing: facts.summaryMissing === true,
        summaryReadError: facts.summaryReadError ?? null,
        linesTotal: facts.linesTotal ?? 0,
        l2Breaches: facts.breaches ?? [],
        layer1Only,
    });

    console.log("\n=== 汇总 ===");
    for (const note of decision.notes) console.log(`⚠️  ${note}`);
    if (decision.reasons.length > 0) {
        console.log("❌ 覆盖率门禁不通过（退出码 1）：");
        for (const reason of decision.reasons) console.log("  - " + reason);
    } else if (decision.layer1Only) {
        console.log(
            `✅ 覆盖率门禁通过 —— 但只判了第 1 层：第 2 层已按 ${LAYER1_ONLY_FLAG} 跳过，` +
                "本轮只判 import 覆盖，没有行覆盖率数据。"
        );
    } else {
        console.log("✅ 覆盖率门禁通过（第 1 层 import 触及率 + 第 2 层真行覆盖率两层都过）。");
    }

    if (decision.exitCode !== 0) process.exit(1);
    // 门禁过了：单测本身挂了也要让调用方看见（c8 的退出码一路透传）
    process.exit(facts.runnerExitCode ?? 0);
}

if (layer1Only) {
    // 只判第 1 层：不碰 c8、**也不删** coverage/ 里上一轮的产物
    //（删了等于顺手毁掉别人上一次的报告，而这一轮我根本没打算重跑）
    console.log(
        `\n（第 2 层已按 ${LAYER1_ONLY_FLAG} 跳过：没有跑 c8，coverage/ 里上一轮的产物原样保留。）`
    );
    finish({});
} else if (!c8Bin) {
    console.log(
        "\n❌ 第 2 层（真行覆盖率）没跑：c8 没装。\n" +
            "   → 这一轮**没有行覆盖率数据，门禁不通过**（退出码 1）。\n" +
            "   → 装依赖之后再跑一次：npm i -D c8\n" +
            "   注意上面第 1 层的百分比只说明「文件被 import 过」，不说明「跑过多少行」。"
    );
    finish({ c8Missing: true });
} else {
    console.log("\n=== 第 2 层：行覆盖率（c8 + sourcemap 重映射）===");
    console.log("（要重跑一遍全量单测，几分钟）\n");

    // 先清掉上一轮的产物：残留的 summary 会让「这一轮没跑出来」看起来像「跑出来了」
    fs.rmSync(COV_DIR, { recursive: true, force: true });

    const c8Args = [
        c8Bin,
        // 先按 sourcemap 重映射、再套 exclude 规则：顺序反了会把 src/ 一起排除掉
        "--exclude-after-remap",
        "--all",
        "--src",
        "src",
        "--src",
        "worker",
        // server/ 与 shared/ 在第 1 层里是统计的，这一层不能漏 —— 漏了等于两层口径不同
        "--src",
        "server",
        "--src",
        "shared",
        "--extension",
        ".ts",
        "--extension",
        ".tsx",
        "--reporter",
        "text",
        // 机器可读的汇总：下面按层聚合与门禁都读它，不靠解析 text 报表
        "--reporter",
        "json-summary",
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
        "dist-server/**",
        "--exclude",
        "**/*.d.ts",
        "--exclude",
        "*.config.*",
        process.execPath,
        "script/unit-tests.mjs",
    ];

    const runnerExitCode = await new Promise(resolve => {
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const child = spawn(process.execPath, c8Args, {
            stdio: "inherit",
            cwd: ROOT,
            // 让运行器生成 sourcemap 并保留产物：c8 是在子进程退出之后才去读 .map 做重映射的
            env: { ...process.env, NAVIHIVE_COVERAGE: "1" },
        });
        child.on("exit", code => settle(code ?? 1));
        // 起不来（ENOMEM / ENOENT）也要往 fail-closed 走，不能让进程挂在没有 exit 的 Promise 上
        child.on("error", error => {
            console.error("\n启动 c8 失败:", error);
            settle(1);
        });
    });

    // 产物（含 sourcemap）已经被 c8 用完，可以清掉；coverage/ 留给 lcov 查询。
    //
    // ⚠️ 清理失败**不能**影响退出码：它只是挪走临时文件，跟「覆盖率达不达标」无关。
    // 实测在这台机器上 `fs.rmSync` 会走到环境注入的安全删除 shim，偶尔超时抛错
    // （ETIMEDOUT），整段以一个跟门禁无关的异常崩掉 —— 那一轮明明跑出了数据，
    // 却拿不到任何结论。所以这里吞掉清理异常，只留一句提醒。
    try {
        fs.rmSync(path.join(HERE, "tmp-tests"), { recursive: true, force: true });
    } catch (error) {
        console.log(`\n（临时产物清理失败，不影响本轮结论：${error.code || error.message}）`);
    }

    const l2 = reportLayer2();
    finish({ ...l2, runnerExitCode });
}
