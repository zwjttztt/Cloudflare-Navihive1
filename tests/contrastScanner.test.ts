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
    // 混 alpha 的表达式必须往**算出来的**背景上混（bgPainted / behind，2026-11-01
    // 起把「自己画的底」和「身后的底」拆开了，所以不再只有 bg 一个名字）；
    // 往写死的白/黑上混会让深色底上的比值方向整个反掉。
    const seg = src.slice(src.indexOf("alphaOf(s.color)"), src.indexOf("const cr = ratio("));
    assert.match(
        seg,
        /(bgPainted|behind|bg)\[/,
        "混算表达式里没有引用任何算出来的背景：前景 alpha 必须往真实背景上混"
    );
});

// ---------------- 元素 opacity（2026-11-01）----------------
//
// opacity 是**分组**属性：它把整个元素（连同底色和子内容）当一张图混到身后的底上。
// 所以 ① 要看祖先链累乘 ② 文字和底色要**一起**淡化。任何一边算漏，结果都偏乐观：
// 实测笔记编辑器行号 `opacity:.55` + `rgba(0,0,0,.87)` 真实 3.69:1，漏算时报 16:1。

test("对比度扫描器：元素 opacity 要沿祖先链累乘（不是只看自己那一个数）", () => {
    assert.match(src, /const groupAlpha = el =>/, "groupAlpha 被删了：元素 opacity 又回到单层判断");
    const body = src.slice(src.indexOf("const groupAlpha = el =>"), src.indexOf("const ratio = (fg, bg)"));
    assert.match(body, /parentElement/, "groupAlpha 没往上走：外层 wrapper 的 opacity 会被漏掉");
    assert.match(body, /a \*= o|\*= o/, "groupAlpha 没做累乘");
});

test("对比度扫描器：文字和底色要一起按 opacity 淡化（只淡化文字会算得太乐观）", () => {
    // mixDown 必须同时作用在 fg 与 bg 上
    assert.match(src, /const fg = mixDown\(fgPainted\)/, "前景没走 mixDown");
    assert.match(src, /const bg = mixDown\(bgPainted\)/, "背景没走 mixDown —— 底色不会跟着淡，比值虚高");
    // 自己画的那层底要单独算出来，否则「元素自带底色 + opacity」这个组合算不对
    assert.match(src, /const bgPainted =/, "bgPainted 没了：元素自带底色与身后底色混在一起了");
});

test("对比度扫描器：整组近乎不可见时跳过（悬停才出现的工具条不该参与）", () => {
    assert.match(
        src,
        /if \(A <= 0\.02\) continue;/,
        "少了「整组不可见就跳过」：恒为 opacity:0 的悬停工具条会被当成 1:1 全红（实测蹦出 24 条假红）"
    );
});

test("对比度扫描器：停用的控件豁免（WCAG 1.4.3 不对 inactive UI 提要求）", () => {
    assert.match(
        src,
        /closest\('\[disabled\], \.Mui-disabled, \[aria-disabled="true"\]'\)/,
        "停用豁免被删了：MUI 的 text.disabled 会让每颗禁用按钮都变成一条红（实测 1.88:1）"
    );
});

test("对比度扫描器：opacity 字段只在真的被淡化时才输出（其余行输出保持不变）", () => {
    assert.match(
        src,
        /\.\.\.\(A < 0\.999 \? \{ opacity: \+A\.toFixed\(2\) \} : \{\}\)/,
        "opacity 字段变成无条件输出了：所有既有报错行的输出都会变，历史对比失效"
    );
});
