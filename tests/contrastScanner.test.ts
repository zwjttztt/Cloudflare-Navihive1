// tests/contrastScanner.test.ts
// 对比度扫描器自身的守卫。
//
// 为什么需要它：`script/contrast-audit.mjs` 的 `SCAN` 如果**退化成只取前景 RGB**，
// 审计的表现是「更绿」而不是「更红」—— 它不可能自己发现自己变宽松了。
// 这类「静默放宽」的门禁比任何一处具体缺陷都危险，所以用源码守卫钉住：
// 前景色必须按它自己的 alpha 混到背景上，再拿去算比值。
//
// 背景（2026-11-01）：修之前 `rgba(0,0,0,.38)` 的 text.disabled 被当纯黑，
// 2.66:1 报成 19.89:1 —— 全站半透明文字只要不达 AA 就一律报绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找真正的脚本 */
function findScript(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, "script/contrast-audit.mjs"), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到 script/contrast-audit.mjs");
}
const src = findScript();

test("对比度扫描器：前景色要读它自己的 alpha（不能只取 RGB）", () => {
    assert.ok(
        /alphaOf\(\s*s\.color\s*\)/.test(src),
        "SCAN 里找不到 alphaOf(s.color)：前景色自身的透明度被丢掉了，" +
            "rgba(0,0,0,.38) 会被当成纯黑量出 19.89:1（真实只有 2.66:1）"
    );
});

test("对比度扫描器：alpha 混算必须发生在算比值之前", () => {
    // 只认位置关系，不认具体变量名 —— 顺序错了这条会红，重命名不会误伤
    const mix = src.indexOf("alphaOf(s.color)");
    const ratio = src.indexOf("const cr = ratio(");
    assert.ok(mix > 0, "找不到 alphaOf(s.color)");
    assert.ok(ratio > 0, "找不到 const cr = ratio(");
    assert.ok(
        mix < ratio,
        "前景 alpha 混算排在了算比值之后 —— 等于没混，审计会静默变宽松"
    );
});

test("对比度扫描器：混算时用的是「背景」而不是写死的白/黑", () => {
    // 混 alpha 的表达式必须引用 bg（bgOf(el) 算出来的那层叠色），
    // 否则在深色底上会把前景往白色方向混，比值方向整个反了
    const seg = src.slice(src.indexOf("alphaOf(s.color)"), src.indexOf("const cr = ratio("));
    assert.match(
        seg,
        /bg\[/,
        "混算表达式里没有引用 bg：前景 alpha 必须往真实背景上混，不能往固定色上混"
    );
});
