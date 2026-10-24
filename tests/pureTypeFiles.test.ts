// tests/pureTypeFiles.test.ts
// 「被覆盖率排除的文件必须真的是纯类型文件」—— 反过来守排除名单。
//
// 背景：script/coverage.mjs 的 EXCLUDE 里有一批「运行时零产出」的文件，
// 它们不进覆盖率分母。这条豁免是合理的，但有个致命漏洞：**哪天有人往其中一个
// 文件里塞了运行时代码（export const / function / class），它依旧被豁免** ——
// 于是几百行真实逻辑悄悄退出所有覆盖率统计，报表还照样显示 100%。
// 这个用例就是把豁免的前提条件钉死：要么纯类型，要么回到分母里。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ 不能写 join(dirname(import.meta.url), "..")：单测运行器会把用例复制进
// script/tmp-tests/pure/ 再跑，那里的「..」是 tmp-tests 而不是项目根（ENOENT）。
// 向上找带 package.json + src 的目录才稳。
function findRoot(start: string): string {
    let dir = start;
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return process.cwd();
}

const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));

/** 必须与 script/coverage.mjs 的 EXCLUDE 里「纯类型」那几条保持一致 */
const PURE_TYPE_FILES = [
    "src/API/responses.ts",
    "src/API/schema.ts",
    "src/types.ts",
    "worker/types.ts",
    "worker/routes/types.ts",
    "src/components/notes/notesPageCtx.ts",
];

/** 去掉注释与字符串字面量，只看真正会编译成代码的部分 */
function stripNonCode(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

test("被覆盖率排除的纯类型文件：不能出现任何运行时导出", () => {
    // 值导出（const / let / function / class / enum）会真的进 bundle；
    // 只有一个例外都不给 —— 这些文件的立身之本就是「不产出运行时代码」。
    const VALUE_EXPORT = /\bexport\s+(?:declare\s+)?(?:const|let|var|function|class|enum)\b/;
    for (const rel of PURE_TYPE_FILES) {
        const src = stripNonCode(readFileSync(join(ROOT, rel), "utf-8"));
        assert.ok(
            !VALUE_EXPORT.test(src),
            `${rel} 出现了运行时导出，它就不能继续待在覆盖率的排除名单里 —— ` +
                `把它从 script/coverage.mjs 的 EXCLUDE 移除（或把运行时代码挪走）`
        );
    }
});

test("被覆盖率排除的纯类型文件：import 必须全是 import type（否则会把依赖拖进运行时）", () => {
    for (const rel of PURE_TYPE_FILES) {
        const src = stripNonCode(readFileSync(join(ROOT, rel), "utf-8"));
        // 逐条 import 语句判断：不是 `import type` 的值 import 会真的执行被导入模块
        const imports = src.match(/\bimport\s+[^;]*?from\s*['"][^'"]+['"]/g) ?? [];
        for (const stmt of imports) {
            assert.ok(
                /^import\s+type\b/.test(stmt.trim()),
                `${rel} 里有非 type-only 的 import：${stmt.trim()} —— ` +
                    `纯类型文件只允许 \`import type\`，否则导入的模块会被真的求值`
            );
        }
    }
});

test("排除名单与覆盖率脚本同步：脚本里删掉某条后，这里要跟着改", () => {
    // 防止两边各改各的：脚本里已经不排除的文件，这个用例还在盯着（或反过来）。
    const script = readFileSync(join(ROOT, "script", "coverage.mjs"), "utf-8");
    for (const rel of PURE_TYPE_FILES) {
        assert.ok(
            script.includes(`"${rel}"`),
            `script/coverage.mjs 的 EXCLUDE 里找不到 ${rel} —— 两边已经不同步了，` +
                `要么把它加回 EXCLUDE，要么从本用例的 PURE_TYPE_FILES 里删掉`
        );
    }
});
