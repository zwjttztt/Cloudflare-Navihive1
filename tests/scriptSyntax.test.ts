// tests/scriptSyntax.test.ts
// `script/` 下每个 .mjs 都要能通过 `node --check`。
//
// 为什么需要（2026-11-01，第三次踩同一个坑）：`contrast-audit.mjs` 的扫描逻辑装在
// `const SCAN = \`…\`` 这个模板字符串里，我三次在**注释里**写了裸反引号（`opacity:0`
// 这种），每次都把模板字符串当场截断，报 `SyntaxError: Unexpected identifier`。
// 语法错误发生在「跑审计」那一刻，而审计不在 lint / tsc / 单测的覆盖面上 ——
// 也就是说它能一路绿到 CI 的浏览器审计步骤才炸。
//
// 这个文件**不 import 那些脚本**（import 会连语法错误一起抛给我、但那时已经晚了，
// 而且 import 会执行它们的顶层代码）。这里只对文件跑 `node --check`：
// 纯静态、不执行、不联网、不启动浏览器。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找仓库根 */
function findScriptDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        const candidate = resolve(dir, "script");
        try {
            if (readdirSync(candidate).some(f => f.endsWith(".mjs"))) return candidate;
        } catch {
            /* 继续往上 */
        }
        dir = dirname(dir);
    }
    throw new Error("找不到 script/ 目录");
}

const scriptDir = findScriptDir();
const files = readdirSync(scriptDir)
    .filter(f => f.endsWith(".mjs"))
    .sort();

test("script/ 下至少有一批脚本（守卫别空转）", () => {
    assert.ok(files.length >= 10, `只扫到 ${files.length} 个 .mjs —— 路径找错了，守卫会变成假绿`);
    assert.ok(files.includes("contrast-audit.mjs"), "没扫到 contrast-audit.mjs");
    assert.ok(files.includes("a11y-audit.mjs"), "没扫到 a11y-audit.mjs");
});

for (const f of files) {
    test(`语法检查：script/${f} 能被 node --check 解析`, () => {
        try {
            execFileSync(process.execPath, ["--check", resolve(scriptDir, f)], { stdio: "pipe" });
        } catch (err) {
            const e = err as { stdout?: string; stderr?: string };
            const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
            assert.fail(
                `script/${f} 语法错误：\n${out.trim()}\n\n` +
                    "常见原因：在 `const SCAN = \\`…\\` 这类模板字符串的注释里写了裸反引号，把字符串截断了。"
            );
        }
    });
}
