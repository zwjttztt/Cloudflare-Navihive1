// script/lint-warnings-budget.mjs
// CI 门禁：把 `react-hooks/exhaustive-deps` 的警告数**钉死**。
//
// 为什么需要它：这条规则是 `warn` 级别，**不阻断 CI**。于是它攒了整整两年 ——
// 2026-10-24 清点时有 23 条，其中 2 条是真 bug：
//   · useNotes.ts:571 —— runUpdate 的冲突覆盖路径捕获了首渲染的 updateNote；
//   · NotesOverlay.tsx:205 —— 运行时探测 api.updateTag，但没把它列为依赖，
//     后端补上这个方法后 useMemo 不会重算，「设置颜色」入口永远不出现。
// 剩下 21 条是「缺 setXxx」与「unnecessary api」的假阳性，已逐条带理由 disable。
//
// 假阳性很难根除（插件没有「忽略 setState」的选项），所以这里不要求「零警告由插件产出」，
// 而是要求「**净增量为零**」：清零之后任何新增都会让这条门禁红，
// 逼迫作者要么修掉、要么写一条带理由的 disable（disable 本身在 diff 里可见，review 时跑不掉）。
//
// 预算现状（2026-10-24 清零后）：
//   exhaustive-deps = 0
//
// ⚠️ 两个实现细节：
//   1. eslint 有 warning 时**退出码仍是 0**（只有 error 才非 0），所以绝不能靠退出码判断，
//      必须自己解析 `-f json` 的输出。
//   2. 别把 eslint 的 stderr 当结果 —— 那里只有格式化器报错。

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import tseslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 规则 → 允许的条数。加预算必须在这行注释里写清「为什么这条消不掉」。 */
const BUDGET = {
    "react-hooks/exhaustive-deps": 0,
};

const eslint = process.platform === "win32" ? "npx.cmd" : "npx";
const run = spawnSync(eslint, ["eslint", ".", "-f", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    // Windows 上 npx 是 .cmd，必须走 shell 才能执行
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
});

if (run.error) {
    console.error("跑 eslint 失败：", run.error.message);
    process.exit(1);
}

let report;
try {
    report = JSON.parse(run.stdout);
} catch {
    // eslint 自己挂了（配置错误、语法错误）时 stdout 不是 JSON —— 直接把它的输出抛出来，
    // 不要伪装成「预算通过」
    console.error("eslint 没有输出可解析的 JSON，先把 lint 修好再谈预算。");
    console.error((run.stdout || "").slice(0, 2000));
    console.error((run.stderr || "").slice(0, 2000));
    process.exit(1);
}

/** @type {Record<string, { file: string; line: number; message: string }[]>} */
const hits = {};
let errorCount = 0;
for (const file of report) {
    errorCount += file.errorCount ?? 0;
    for (const m of file.messages ?? []) {
        const rule = m.ruleId;
        if (!rule || !(rule in BUDGET)) continue;
        (hits[rule] ??= []).push({
            file: path.relative(ROOT, file.filePath).split(path.sep).join("/"),
            line: m.line ?? 0,
            message: m.message,
        });
    }
}

// error 级别的问题由 `eslint .` 自己兜（它会非零退出），这里只管预算
if (errorCount > 0) {
    console.error(`lint 有 ${errorCount} 个 error，先修掉再跑预算检查。`);
    process.exit(1);
}

const over = [];
for (const [rule, budget] of Object.entries(BUDGET)) {
    const found = hits[rule] ?? [];
    if (found.length > budget) {
        over.push(
            `\n${rule}：预算 ${budget} 条，实际 ${found.length} 条（多了 ${found.length - budget} 条）\n` +
                found
                    .map(h => `  · ${h.file}:${h.line} — ${h.message.slice(0, 110)}`)
                    .join("\n")
        );
    }
}

if (over.length > 0) {
    console.error("lint 警告超出预算：" + over.join("\n"));
    console.error(
        "\n每新增一条都要么修掉根因、要么加一条带理由的 disable：\n" +
            "  // eslint-disable-next-line react-hooks/exhaustive-deps -- 为什么这条是假阳性\n" +
            "理由在 diff 里可见，将来 review 时能重新判断 —— 直接静默关掉整条规则是不允许的。"
    );
    process.exit(1);
}

// ---- 第二道门禁：eslint-disable 必须带理由 ----
// 静默关掉一条规则等于把「为什么关」这件事藏起来，将来 review 也看不到。
// 允许两种写法：① 行内 `-- 理由`；② 紧邻上一行是一条 `//` 注释（理由写在那行）。
// 从现有 TypeScript/TSX 解析器获取真实注释，避免字符串、模板和 JSX 文本误报。
// 只把注释开头的完整指令当作配置；规则列表必须符合 ESLint 规则名语法。
export function findUnreasonedDisables(source, fileName) {
    const { ast } = tseslint.parser.parseForESLint(source, {
        filePath: fileName,
        jsx: fileName.endsWith(".tsx"),
        comment: true,
        loc: true,
        range: true,
    });
    const comments = ast.comments ?? [];
    const issues = [];
    for (const comment of comments) {
        const match = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)([\s\S]*)$/.exec(comment.value);
        if (!match) continue;
        const payload = match[1].trim();
        // Match ESLint's whitespace-delimited justification separator; a rule
        // such as plugin/foo--bar contains no justification separator.
        const separator = /\s-{2,}(?:\s|$)/u.exec(` ${payload}`);
        const splitAt = separator ? Math.max(0, separator.index - 1) : -1;
        const rules = (splitAt < 0 ? payload : payload.slice(0, splitAt)).trim();
        // ESLint's parseListConfig removes matching quotes and ignores empty
        // comma-separated entries, including leading/trailing/repeated commas.
        const ruleNames = rules.split(",")
            .map(rule => rule.trim().replace(/^(['"])(.*)\1$/u, "$2"))
            .filter(rule => rule.length > 0);
        if (rules && ruleNames.some(rule => !/^[\w@./-]+$/u.test(rule))) continue;
        const reasonAt = separator ? separator.index + separator[0].length - 1 : -1;
        const hasInlineReason = reasonAt >= 0 && /\S/.test(payload.slice(reasonAt));
        const hasPreviousComment = comments.some(previous =>
            previous.type === "Line" &&
            previous.loc.end.line === comment.loc.start.line - 1 &&
            previous.value.trim().length > 0 &&
            !/^\s*eslint-(?:disable|enable)\b/.test(previous.value)
        );
        if (!hasInlineReason && !hasPreviousComment) {
            issues.push({ line: comment.loc.start.line, rule: rules || "(all rules)" });
        }
    }
    return issues;
}

const disableIssues = [];
(function scanDisableReasons() {
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
                walk(full);
            } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
                const source = fs.readFileSync(full, "utf8");
                for (const issue of findUnreasonedDisables(source, full)) {
                    disableIssues.push({
                        file: path.relative(ROOT, full).split(path.sep).join("/"),
                        ...issue,
                    });
                }
            }
        }
    };
    walk(path.join(ROOT, "src"));
})();

if (disableIssues.length > 0) {
    console.error("以下 eslint-disable 缺少理由（要么行内加 `-- 理由`，要么紧邻上一行写 `//` 注释）：");
    for (const d of disableIssues) {
        console.error(`  · ${d.file}:${d.line} — ${d.rule}`);
    }
    console.error("\n理由在 diff 里可见，将来 review 时能重新判断 —— 静默关掉整条规则是不允许的。");
    process.exit(1);
}

const summary = Object.entries(BUDGET)
    .map(([rule, budget]) => `${rule} ${hits[rule]?.length ?? 0}/${budget}`)
    .join("，");
console.log(`lint 警告预算通过：${summary}`);
