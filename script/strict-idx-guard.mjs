// Q-3 守卫：`noUncheckedIndexedAccess` 的「只增不减」机械保证。
//
// 用法：node script/strict-idx-guard.mjs          （CI 用，退出码非 0 即红）
//      node script/strict-idx-guard.mjs --list   （只打印当前报错文件，不改任何东西）
//
// 背景：全量给 src/ 打开 `noUncheckedIndexedAccess` 有 357 处报错（60 个文件）。
// 一次性修完必然催生大量 `!` 非空断言，那比不开更糟。所以策略是「先立骨架、只许变好」：
//   - shared/ 已经真开并通过（见 tsconfig.shared.json）；
//   - src/ 全量进**严格层**跑一遍，报错的文件必须在 script/strict-idx-exempt.json 里登记；
//   - 清单**只能变短**：条目数超过基线即失败，`due` 过期未清理也失败。
//
// ⚠️ 为什么不用 `tsconfig` 的 `exclude` 来「排除豁免文件」：
//   TS 的 `exclude` 只影响「哪些文件被当根文件加载」，被 import 进来的文件**照样在程序里、
//   照样报错**。靠 exclude 做隔离的话，守卫永远绿，而豁免清单其实一点约束力都没有 ——
//   它测的是「我有没有把自己列进排除名单」，不是「新代码是不是干净」。
//   现在的做法不排除任何人：整份 src 都跑，然后拿**真实报错文件集合**跟清单比对。
//   于是「新文件默认进严格层」是机械成立的 —— 新文件报错、又不在清单里 → 红。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(`${ROOT}/package.json`);

const TSCONFIG = path.join(ROOT, "tsconfig.strict-idx.json");
const EXEMPT_FILE = path.join(HERE, "strict-idx-exempt.json");
const BASELINE_FILE = path.join(HERE, ".strict-idx-baseline");

const rel = p => path.relative(ROOT, p).split(path.sep).join("/");
const fail = msg => {
    console.error(`\n❌ ${msg}`);
    process.exitCode = 1;
};

// ---------- 1. 读豁免清单 ----------

if (!fs.existsSync(EXEMPT_FILE)) {
    console.error(`缺少豁免清单 ${rel(EXEMPT_FILE)}（格式见脚本顶部说明）`);
    process.exit(1);
}

let entries;
try {
    entries = JSON.parse(fs.readFileSync(EXEMPT_FILE, "utf8")).entries;
} catch (error) {
    console.error(`豁免清单不是合法 JSON：${error.message}`);
    process.exit(1);
}
if (!Array.isArray(entries)) {
    console.error("豁免清单必须有 entries 数组");
    process.exit(1);
}

// 清单本身的结构问题：这几条一旦破，后面的比对就失去意义
const seen = new Set();
const badShape = [];
const today = new Date().toISOString().slice(0, 10);
const expired = [];
for (const e of entries) {
    if (!e || typeof e.path !== "string" || !e.path) badShape.push(JSON.stringify(e));
    else if (seen.has(e.path)) badShape.push(`重复条目 ${e.path}`);
    else {
        seen.add(e.path);
        if (!fs.existsSync(path.join(ROOT, e.path))) badShape.push(`文件不存在 ${e.path}`);
        // 到期日不是装饰：没有它，「待收敛」会变成永远不收敛
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.due ?? ""))) badShape.push(`${e.path} 的 due 不是 YYYY-MM-DD`);
        else if (e.due < today) expired.push(`${e.path}（due ${e.due}）`);
    }
}
if (badShape.length > 0) {
    console.error("\n❌ 豁免清单有条目不合规：");
    for (const b of badShape) console.error("  - " + b);
    process.exit(1);
}
if (expired.length > 0) {
    console.error(`\n❌ 这些豁免已过期（今天 ${today}）却还挂在清单里 —— 要么修掉，要么重新评估后改 due：`);
    for (const e of expired) console.error("  - " + e);
    process.exit(1);
}

// ---------- 2. 跑严格层的 tsc，收集真实报错文件 ----------

let tscBin = null;
try {
    tscBin = require.resolve("typescript/bin/tsc");
} catch {
    tscBin = null;
}
if (!tscBin) {
    console.error("找不到 typescript/bin/tsc —— 先 npm ci");
    process.exit(1);
}

process.stdout.write("跑严格层类型检查（src 全量 + noUncheckedIndexedAccess）… ");
const result = spawnSync(process.execPath, [tscBin, "-p", TSCONFIG, "--noEmit", "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    // 全量 src 在慢机器上也能跑完；超时比 CI job 早一步，好报出「是这一步卡住」
    timeout: 10 * 60 * 1000,
});
console.log("完成");

if (result.error) {
    console.error(`tsc 启动失败：${result.error.message}`);
    process.exit(1);
}
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

// 只认「文件名(行,列): error TSxxxx」这种诊断行；多行消息的续行不算
const errorFiles = new Set();
let errorCount = 0;
for (const line of output.split("\n")) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+:/);
    if (!m) continue;
    errorCount++;
    errorFiles.add(m[1].split(path.sep).join("/"));
}

if (process.argv.includes("--list")) {
    console.log(`\n报错文件（${errorFiles.size} 个 / ${errorCount} 处）：`);
    for (const f of [...errorFiles].sort()) console.log("  " + f);
    console.log(`\n豁免清单条目：${entries.length}`);
    process.exit(0);
}

// tsc 因为别的原因挂掉（配置写错、语法错）时，输出里可能一条诊断都没有 ——
// 那不能当成「零报错」放过去，否则守卫会在最该叫的时候沉默
if (result.status !== 0 && errorCount === 0) {
    console.error("\n❌ tsc 非零退出但没有任何诊断行 —— 大概率是配置或语法错误：");
    console.error(output.slice(0, 4000));
    process.exit(1);
}

// ---------- 3. 清单外的文件报错 = 有人往严格层塞了不干净的代码 ----------

const unlisted = [...errorFiles].filter(f => !seen.has(f)).sort();
if (unlisted.length > 0) {
    console.error("\n❌ 这些文件在严格层报错，但不在 script/strict-idx-exempt.json 里：");
    for (const f of unlisted) console.error("  - " + f);
    console.error(
        "\n新文件默认就要干净（这正是这个守卫存在的理由）。" +
            "\n修法二选一：① 把下标访问判空写对；② 确需暂缓，就把文件登记进豁免清单并写明 owner 与 due。\n" +
            "⚠️ 别用 `!` 掩盖 —— 评审就是在警告这一点：加了断言等于关掉检查，还留下会崩的运行时代码。"
    );
    process.exitCode = 1;
}

// ---------- 4. 单调性：清单只能 shrink ----------

let baseline = null;
try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
} catch {
    baseline = null;
}
const maxEntries = Number(baseline?.maxEntries);
if (!Number.isFinite(maxEntries)) {
    fail(`缺少基线 ${rel(BASELINE_FILE)}（内容是 {"maxEntries": N}），无法判断清单是不是在变长`);
} else if (entries.length > maxEntries) {
    fail(
        `豁免条目从基线 ${maxEntries} 涨到 ${entries.length} —— 这个清单只许变短。` +
            `\n  真需要新增豁免，就在提交信息里说明理由并同步把基线改大（那是一次显式的退让）。`
    );
}

// ---------- 5. 报告 ----------

const graduated = entries.filter(e => !errorFiles.has(e.path)).map(e => e.path);
console.log(
    `\n严格层报错：${errorCount} 处 / ${errorFiles.size} 个文件；` +
        `豁免清单：${entries.length} 条（基线上限 ${Number.isFinite(maxEntries) ? maxEntries : "缺失"}）`
);
if (graduated.length > 0) {
    // 不判失败：允许「先修完再清理清单」的提交节奏。但这句提醒必须打出来 ——
    // 一个已经干净的文件还挂在豁免清单里，等于把「已收敛」的事实藏起来。
    console.log(`\n♻️ 下面 ${graduated.length} 个文件已经没有报错了，可以从豁免清单里删掉（清单该缩短了）：`);
    for (const f of graduated) console.log("  - " + f);
}

if (process.exitCode) {
    console.error("\n❌ Q-3 守卫未通过（详见上方）。");
} else {
    console.log("\n✅ Q-3 守卫通过：严格层没有出现豁免清单之外的文件，清单也没有变长。");
}
