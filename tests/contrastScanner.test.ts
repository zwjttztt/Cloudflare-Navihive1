// tests/contrastScanner.test.ts
// 对比度扫描器自身的守卫。
//
// 为什么需要它：测量代码如果**退化成只取前景 RGB**，审计的表现是「更绿」而不是「更红」
// —— 它不可能自己发现自己变宽松了。这类「静默放宽」的门禁比任何一处具体缺陷都危险，
// 所以用源码守卫钉住：前景色必须按它自己的 alpha 混到背景上，再拿去算比值。
//
// 背景（2026-11-01）：修之前 `rgba(0,0,0,.38)` 的 text.disabled 被当纯黑，
// 2.66:1 报成 19.89:1 —— 全站半透明文字只要不达 AA 就一律报绿。
//
// 2026-11-01 第二轮：测量数学从 `SCAN` 抽到 `auditEnv.mjs` 的 `CONTRAST_CORE`，
// 好让 hover / focus 的单元素扫描复用同一份（两套数学早晚会漂开）。
// 所以下面分两个来源：**数学看 auditEnv.mjs，遍历看 contrast-audit.mjs**。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找真正的脚本 */
function readScript(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

/** 测量数学（CONTRAST_CORE 住在 auditEnv.mjs 里，多个审计共用） */
const math = readScript("script/auditEnv.mjs");
/** 遍历/判定/去重 */
const scan = readScript("script/contrast-audit.mjs");

/**
 * 剥掉注释后的数学源码。用在「某段代码**不许存在**」这类断言上：
 * 注释里通常会写「以前这里是 xxx，已删」把表达式原文抄一遍，不剥就会误判。
 */
const mathCode = math
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map(line => line.replace(/(^|[^:\\])\/\/.*$/, "$1"))
    .join("\n");

test("对比度扫描器：数学核心只有一份（审计脚本引用 auditEnv 的 CONTRAST_CORE）", () => {
    assert.match(
        scan,
        /import \{[^}]*CONTRAST_CORE[^}]*\} from "\.\/auditEnv\.mjs"/s,
        "contrast-audit.mjs 没有从 auditEnv.mjs 引入 CONTRAST_CORE：数学被复制成两份后，" +
            "整页扫描与 hover/focus 单元素扫描会各算一套，早晚漂开"
    );
    assert.match(scan, /NH\.refresh\(\)/, "SCAN 里没有调用 NH.refresh()：opacity 表是空的，整组淡化全部漏算");
    assert.ok(
        scan.indexOf("NH.refresh()") < scan.indexOf("NH.measure("),
        "NH.refresh() 排在了 NH.measure() 之后 —— 用的是上一轮的 opacity 表"
    );
});

test("对比度扫描器：前景色要读它自己的 alpha（不能只取 RGB）", () => {
    assert.ok(
        /alphaOf\(\s*s\.color\s*\)/.test(math),
        "measure 里找不到 alphaOf(s.color)：前景色自身的透明度被丢掉了，" +
            "rgba(0,0,0,.38) 会被当成纯黑量出 19.89:1（真实只有 2.66:1）"
    );
});

test("对比度扫描器：alpha 混算必须发生在算比值之前", () => {
    // 只认位置关系，不认具体变量名 —— 顺序错了这条会红，重命名不会误伤
    const mix = math.indexOf("alphaOf(s.color)");
    const ratio = math.indexOf("ratio(fg, bg)");
    assert.ok(mix > 0, "找不到 alphaOf(s.color)");
    assert.ok(ratio > 0, "找不到 ratio(fg, bg)");
    assert.ok(
        mix < ratio,
        "前景 alpha 混算排在了算比值之后 —— 等于没混，审计会静默变宽松"
    );
});

test("对比度扫描器：混算时用的是「背景」而不是写死的白/黑", () => {
    // 混 alpha 的表达式必须往**算出来的**背景上混（bgPainted / behind，2026-11-01
    // 起把「自己画的底」和「身后的底」拆开了，所以不再只有 bg 一个名字）；
    // 往写死的白/黑上混会让深色底上的比值方向整个反掉。
    const seg = math.slice(math.indexOf("alphaOf(s.color)"), math.indexOf("ratio(fg, bg)"));
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
    assert.match(math, /const groupAlpha = el =>/, "groupAlpha 被删了：元素 opacity 又回到单层判断");
    // 边界取它自己的下一个函数（不是 ratio —— 在 auditEnv.mjs 里 ratio 定义得更早，
    // 用它会切出空串，守卫就变成永远绿）
    const body = math.slice(math.indexOf("const groupAlpha = el =>"), math.indexOf("const measure = el =>"));
    assert.ok(body.length > 40, "groupAlpha 的函数体没截出来，守卫等于空转");
    assert.match(body, /parentElement/, "groupAlpha 没往上走：外层 wrapper 的 opacity 会被漏掉");
    assert.match(body, /a \*= o|\*= o/, "groupAlpha 没做累乘");
});

test("对比度扫描器：文字和底色要一起按 opacity 淡化（只淡化文字会算得太乐观）", () => {
    // mixDown 必须同时作用在 fg 与 bg 上
    assert.match(math, /const fg = mixDown\(fgPainted\)/, "前景没走 mixDown");
    assert.match(math, /const bg = mixDown\(bgPainted\)/, "背景没走 mixDown —— 底色不会跟着淡，比值虚高");
    // 自己画的那层底要单独算出来，否则「元素自带底色 + opacity」这个组合算不对
    assert.match(math, /const bgPainted =/, "bgPainted 没了：元素自带底色与身后底色混在一起了");
});

test("对比度扫描器：整组近乎不可见时跳过（悬停才出现的工具条不该参与）", () => {
    assert.match(
        math,
        /if \(A <= 0\.02\) return null;/,
        "少了「整组不可见就跳过」：恒为 opacity:0 的悬停工具条会被当成 1:1 全红（实测蹦出 24 条假红）"
    );
});

test("对比度扫描器：停用的控件豁免（WCAG 1.4.3 不对 inactive UI 提要求）", () => {
    assert.match(
        math,
        /closest\('\[disabled\], \.Mui-disabled, \[aria-disabled="true"\]'\)/,
        "停用豁免被删了：MUI 的 text.disabled 会让每颗禁用按钮都变成一条红（实测 1.88:1）"
    );
});

test("对比度扫描器：opacity 字段只在真的被淡化时才输出（其余行输出保持不变）", () => {
    assert.match(
        math,
        /\.\.\.\(A < 0\.999 \? \{ opacity: \+A\.toFixed\(2\) \} : \{\}\)/,
        "opacity 字段变成无条件输出了：所有既有报错行的输出都会变，历史对比失效"
    );
});

// ---------------- filter: opacity()（2026-11-01 补洞）----------------
//
// `filter: opacity(x)` 与 `opacity` 完全等效：同样整组淡化、同样建层叠上下文，
// 而且两者**相乘**（外层 filter:.5 套内层 opacity:.5 = 0.25）。
// 以前只读 `cs.opacity`，靠 filter 做的淡化等于完全不透明 —— 又一个静默放宽。

test("对比度扫描器：opacity 与 filter: opacity() 必须走同一条判据（不许对前者提前放弃）", () => {
    // 2026-11-01：以前 measure 里有 `Number(s.opacity) < 0.5 → return null`。
    // 于是同一处「淡化到 30%」的文字，写成 opacity 直接不量、写成 filter: opacity()
    // 却量出 1.5:1 —— 两条路给两个结论，等于判据不同源。实测探针确认过。
    assert.ok(
        !/Number\(s\.opacity\) < 0\.5/.test(mathCode),
        "又出现了「自己 opacity < 0.5 就跳过」：淡化到 30% 的文字会整段不量，而同样的 " +
            "filter: opacity(.3) 却会量出 1.5:1 —— 同一种淡化，两种结论"
    );
});

test("对比度扫描器：filter 里的 opacity() 也必须混算（与 opacity 等效且相乘）", () => {
    assert.match(math, /const filterOpacity = f =>/, "filterOpacity 被删了：filter: opacity(.3) 会当完全不透明");
    const body = math.slice(math.indexOf("const filterOpacity = f =>"), math.indexOf("let opMap"));
    // ⚠️ 别去匹配反斜杠个数：这段代码住在模板字符串里，`\(` 到文件里变成了 `\\(`
    // （转义给页面用）。只认「解析 opacity() 这件事」本身。
    assert.match(body, /matchAll\(\/opacity/, "filterOpacity 没解析 opacity() 函数");
    assert.match(body, /%/, "filterOpacity 不认百分比写法（opacity(30%) 是合法的）");
    // 必须在 refresh 里与 cs.opacity 相乘，而不是只取其一
    assert.match(
        math,
        /Number\(cs\.opacity\) \* filterOpacity\(cs\.filter\)/,
        "refresh 里没有把 cs.opacity 与 filterOpacity(cs.filter) 相乘：两者应当叠乘，不是取其中一个"
    );
});
