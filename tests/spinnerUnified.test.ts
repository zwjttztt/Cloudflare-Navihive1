// tests/spinnerUnified.test.ts
// 「全站转圈只有一份定义」的静态守卫（2026-11-06 用户：两个转圈不一样统一一下）。
//
// 背景：启动占位（index.html 的 .bs-spinner）是我们自己画的环，
// 而登录检查态 / 登录页 chunk 兜底 / 列表加载态用的是 MUI 的 <CircularProgress> ——
// 那是另一套弧线（弧长还会伸缩），跟启动占位那个环**完全是两种观感**。
// 两屏一前一后出现，用户看到的就是「同一个等待被换了个动画」。
//
// 第一版的做法是「两份规格（index.html 一份 + src/index.css 一份）+ 一条 deepEqual
// 守卫」，被否掉了，理由是对的：deepEqual 只能**事后**发现漂移，
// 而「同一个类名、只有一处定义」能让漂移**不可能发生**，顺带还把 index.css 的
// 字节还了回去。
//
// ⚠️ 2026-11-06 第二次返工（32.4.0）：环从 **CSS border** 换成 **内联 SVG**。
//    原因不是审美，是首屏 FCP：CI 的「首屏体感审计」实测回访 FCP 148 → 504 ms、
//    冷启动 1904 → 3084 ms，而 LCP 几乎没动（504 = 504）——「早期那次绘制不再被算作
//    内容」的指纹。禁 JS 的受控实验证明：纯 CSS border 环只产生 first-paint、**没有
//    first-contentful-paint**；内联 <svg><circle> 才有。所以这份守卫的几何口径
//    从 border 改成了 SVG（width/height/stroke-width/stroke-opacity/dasharray）。
//    ⚠️ 谁要改回 border，这批断言会红 —— 那是**故意的**，别顺手放宽。
//
// 这份守卫盯的是「结构 + 规格」，不是「两份数值相等」：
//   1. index.html 里作用于 .bs-spinner 的**声明**各恰好一次（不是数规则头 ——
//      现在选择器有 5 个，数规则头会被数字带歪；数声明才咬得住「尾部再追加一条
//      `.bs-spinner{width:60px}` 靠层叠后写赢」这种回归，即旧变异 M13）；
//   2. 规格值不许变（40px 外径 / 3.5 描边 / 0.22 轨道 / 0.9s 匀速 / 弧=周长四分之一）；
//   3. 占位标记与 React 标记是**同一份**（viewBox / r / rotate / 两个 circle）；
//   4. src/index.css 里没有第二份（`nh-spinner`/`nh-spin` 0 命中，也不许定义 `.bs-spinner`）；
//   5. 组件只给 className + data-mode，不自己写样式（内联样式按**属性名位置**拦）；
//   6. 四个主题档位的 --bs-brand 逐档与 React 侧两个值对齐；
//   7. 「减少动效」下同一个 .bs-spinner 停转（不带作用域 ⇒ 两边同时停）；
//   8. LoginScreen 2 / App 1 处 <Spinner />，且都还有 import、都没有 CircularProgress。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const HTML = readProjectFile("index.html");
const CSS = readProjectFile("src/index.css");
const SPINNER_SRC = readProjectFile("src/components/Spinner.tsx");

/**
 * 剥注释：JS/TS 用（`/* … *\/` 与「行首/空白之后的 //」）。
 * 只认空白后面的 // 是有意的 —— `https://` 这类串里的 // 前面是冒号，切掉会让整行消失。
 */
function stripJsComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/gm, "$1");
}

/** 剥 CSS 注释（解析声明之前必须做：注释里出现 `;` / `{` 会把切块带偏） */
function stripCssComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function escapeRe(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从某个 `{` 开始做花括号配对，返回内部文本（不含最外层的一对括号） */
function braceBody(source: string, openIndex: number): string {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(openIndex + 1, i);
        }
    }
    throw new Error("花括号不配对 —— 文件被改坏了");
}

/** 取第一条匹配 `selector {` 的规则体（要求选择器前面是 `}` 或文件开头） */
function ruleBody(source: string, selector: string): { index: number; body: string } {
    const clean = stripCssComments(source);
    const re = new RegExp(`(?:^|\\})\\s*${escapeRe(selector)}\\s*\\{`, "u");
    const match = re.exec(clean);
    assert.ok(match, `找不到规则 \`${selector} {\` —— 这条守卫的前提没了，先确认选择器有没有被改名`);
    return {
        index: match.index,
        body: braceBody(clean, match.index + match[0].length - 1),
    };
}

/** 取所有 `@media (…)` 块的内部文本 */
function mediaBodies(source: string, header: string): string[] {
    const clean = stripCssComments(source);
    const bodies: string[] = [];
    const re = new RegExp(`${escapeRe(header)}\\s*\\{`, "gu");
    let match = re.exec(clean);
    while (match) {
        bodies.push(braceBody(clean, match.index + match[0].length - 1));
        re.lastIndex = match.index + match[0].length;
        match = re.exec(clean);
    }
    return bodies;
}

/** 取一条声明（要求存在）。`prop` 必须整体匹配，所以 `stroke` 不会命中 `stroke-width` */
function decl(body: string, prop: string): string {
    const clean = stripCssComments(body);
    const re = new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:\\s*([^;]+)`, "iu");
    const match = re.exec(clean);
    assert.ok(match, `缺声明 \`${prop}\`（实际声明体：${clean.trim().slice(0, 160)}…）`);
    return match[1].trim().replace(/\s+/gu, " ");
}

/** 取一条声明，不存在返回 null（用于「这里**不该**有这条声明」的断言） */
function tryDecl(body: string, prop: string): string | null {
    const clean = stripCssComments(body);
    const re = new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:\\s*([^;]+)`, "iu");
    const match = re.exec(clean);
    return match ? match[1].trim().replace(/\s+/gu, " ") : null;
}

/** 数一段声明体里某条声明出现几次（`stroke` 不会命中 `stroke-width`） */
function countDecl(body: string, prop: string): number {
    const clean = stripCssComments(body);
    const re = new RegExp(`(?:^|;)\\s*${escapeRe(prop)}\\s*:`, "giu");
    return (clean.match(re) ?? []).length;
}

/**
 * index.html 里**全部**内联 <style> 块拼起来的样式（启动占位靠它同帧画出来）。
 *
 * 为什么是「全部」而不是第一段：浏览器对第二段 <style> 一视同仁，
 * 多出来的 `.bs-spinner{width:60px}` 一样靠层叠后写赢，两枚环当场变 60px。
 * 2026-11-06 变异 M13-c 实测过这个洞：原来只取第一段，往文件尾追加
 * `<style>.bs-spinner{width:60px}</style>` 八条断言全绿 —— 环已经被改了，守卫却说没事。
 * 拼接之后「尾部另起一段 <style>」也无处可藏。
 * （反过来说，直接追加在 `</style>` 之后的纯文本不算 —— 那不在 <style> 里，
 *  浏览器不解析成规则，属于无效变异，被绿是正确行为。）
 */
function bootStyleBlock(): string {
    const blocks = Array.from(HTML.matchAll(/<style>([\s\S]*?)<\/style>/gu), m => m[1]);
    assert.ok(blocks.length > 0, "index.html 里应当还有一段内联 <style> —— 启动占位没有它就只剩白屏");
    return blocks.join("\n");
}

const STYLE = bootStyleBlock();

/**
 * 去掉 `@media (prefers-reduced-motion: reduce)` 这一块之后的样式。
 *
 * 为什么要去：那一块里也有一条 `.bs-spinner { animation: none }`，它会让
 * 「animation 声明恰好一次」这条计数变成 2。它属于「减少动效」的处置，
 * 由单独的用例守（那边要求它存在且**必须**是裸选择器）。
 */
function styleWithoutReduce(): string {
    const clean = stripCssComments(STYLE);
    const re = /@media \(prefers-reduced-motion: reduce\)\s*\{/u;
    const match = re.exec(clean);
    if (!match) return clean;
    const open = match.index + match[0].length - 1;
    const body = braceBody(clean, open);
    return clean.slice(0, match.index) + clean.slice(open + body.length + 2);
}

const SPEC_STYLE = styleWithoutReduce();

/** 所有作用于 .bs-spinner 的规则体（基规则 / circle / track / arc / [data-mode=dark]） */
function spinnerRuleBodies(source: string): string[] {
    return Array.from(
        stripCssComments(source).matchAll(/\.bs-spinner[^{}]*\{([^}]*)\}/gu),
        m => m[1]
    );
}

/** 启动占位那段标记（#boot-skeleton 内部） */
function bootMarkup(): string {
    const match = /<div id="boot-skeleton"[^>]*>([\s\S]*?)<\/div>/u.exec(HTML);
    assert.ok(match, "找不到 #boot-skeleton 里的占位标记 —— 占位结构可能被改了");
    return match[1];
}

/** 占位那个圆的半径（SVG 的 r 只能写在标记里，没有 CSS 等价物） */
function bootRadius(): number {
    const raw = /<circle[^>]*\br="([\d.]+)"/u.exec(bootMarkup())?.[1];
    const r = Number(raw);
    assert.ok(Number.isFinite(r) && r > 0, `占位的 <circle> 缺 r 属性（取到：${raw}）`);
    return r;
}

test("规格只有一处：作用于 .bs-spinner 的每条声明都恰好出现一次（数规则头会被选择器数量带歪）", () => {
    const bodies = spinnerRuleBodies(SPEC_STYLE);
    assert.ok(bodies.length >= 1, "index.html 里找不到任何 .bs-spinner 规则");

    // ⚠️ 2026-11-06 QA 变异 M13：往这段 <style> 尾部再写一条 `.bs-spinner{width:60px}`，
    //    层叠「后写的赢」把全站两枚环都改成 60px，而「定义恰好一条」这种断言数的是
    //    规则头/带 40px 的那条，照样绿。所以改成**数声明**：
    //    任何一条关键声明多出第二处，就说明有人又写了一份规格。
    const critical: Array<[string, number]> = [
        ["width", 1],
        ["height", 1],
        ["display", 1],
        ["animation", 1],
        ["fill", 1],
        ["stroke", 1],
        ["stroke-width", 1],
        ["stroke-opacity", 1],
        ["stroke-dasharray", 1],
    ];
    for (const [prop, expected] of critical) {
        const total = bodies.reduce((sum, body) => sum + countDecl(body, prop), 0);
        assert.equal(
            total,
            expected,
            `⛔ 作用于 .bs-spinner 的 \`${prop}\` 声明有 ${total} 处，应当恰好 ${expected} 处 —— ` +
                "多出来的那处会靠层叠后写赢、静默改掉全站转圈的尺寸/节奏。\n" +
                "（转圈全站只许有这一份定义：React 侧复用同一个类名，不要再写第二份规格）"
        );
    }

    // 不带作用域：`#boot-skeleton .bs-spinner { … }` 这种写法只有启动占位用得上，
    // React 侧就又得自己写一份 —— 那正是被否掉的结构。
    assert.match(
        SPEC_STYLE,
        /(?:^|\})\s*\.bs-spinner\s*\{/u,
        "⛔ .bs-spinner 必须是不带作用域的裸选择器（React 侧要复用它）"
    );
    assert.equal(
        /#boot-skeleton \.bs-spinner\s*\{/u.test(SPEC_STYLE),
        false,
        "⛔ 又写成 `#boot-skeleton .bs-spinner` 了 —— 那样 React 渲染的环拿不到样式"
    );
});

test("规格值不许变：40px 外径 / 3.5 描边 / 0.22 轨道 / 0.9s 匀速 / 弧=周长四分之一", () => {
    const base = ruleBody(STYLE, ".bs-spinner").body;
    const circle = ruleBody(STYLE, ".bs-spinner circle").body;
    const track = ruleBody(STYLE, ".bs-spinner .bs-spinner-track").body;
    const arc = ruleBody(STYLE, ".bs-spinner .bs-spinner-arc").body;

    assert.deepEqual(
        {
            width: decl(base, "width"),
            height: decl(base, "height"),
            display: decl(base, "display"),
            animation: decl(base, "animation"),
        },
        {
            // 外径 40：r=18.25 + stroke 3.5（几何自洽见下一条用例）
            width: "40px",
            height: "40px",
            // React 渲染的是 <svg>（inline 元素），display:block 让它能吃到 width/height
            display: "block",
            animation: "bs-spin 0.9s linear infinite",
        },
        "⛔ 转圈的尺寸/节奏变了（40px / 0.9s 线性无限）—— 改任何一项用户看到的就是另一个环"
    );
    assert.deepEqual(
        {
            fill: decl(circle, "fill"),
            strokeWidth: decl(circle, "stroke-width"),
            stroke: decl(circle, "stroke"),
        },
        {
            // 不填充，只描边；描边色走 --bs-brand（兜底值 = 亮色档）
            fill: "none",
            strokeWidth: "3.5",
            stroke: "var(--bs-brand, #1976d2)",
        },
        "⛔ 描边变了 —— 3.5 是 SVG 用户单位（不再像 border 那样被取整成 3px），" +
            "颜色必须走 var(--bs-brand, #1976d2)，否则 React 侧（继承不到 --bs-brand）没有颜色"
    );
    assert.equal(
        decl(track, "stroke-opacity"),
        "0.22",
        "轨道要 stroke-opacity: 0.22（等价于原来 color-mix 的 22%，别改成 rgba() 硬编码 —— 那样暗色档就断了）"
    );
    // 轨道只靠 opacity 变淡，颜色仍继承同一条 stroke 规则；自己再写一条 stroke 就是第二份来源
    assert.equal(
        tryDecl(track, "stroke"),
        null,
        "⛔ 轨道自己写了 stroke —— 它应该只改 stroke-opacity，颜色跟着 .bs-spinner circle 走"
    );

    // 弧长 = 周长 ÷ 4（正好是原来 border-top 那一段）
    const circumference = 2 * Math.PI * bootRadius();
    const dash = decl(arc, "stroke-dasharray").split(/\s+/u).map(Number);
    assert.equal(dash.length, 2, `stroke-dasharray 应当是「实线段 空白段」两个值，实际：${dash.join(" ")}`);
    assert.ok(
        Math.abs(dash[0]! - circumference / 4) < 0.05,
        `弧长应当是周长的四分之一（2π×18.25/4 ≈ ${(circumference / 4).toFixed(2)}），实际 ${dash[0]}`
    );
    assert.ok(
        Math.abs(dash[1]! - (circumference - circumference / 4)) < 0.05,
        `空白段应当是周长剩下的四分之三（≈ ${(circumference * 0.75).toFixed(2)}），实际 ${dash[1]}`
    );
});

test("占位标记与 React 标记是同一份几何（viewBox / r / rotate 逐项对齐）", () => {
    const markup = bootMarkup();
    const code = stripJsComments(SPINNER_SRC);

    // 两个圆：轨道 + 弧；弧套在 rotate 里
    assert.equal(
        (markup.match(/<circle\b/gu) ?? []).length,
        2,
        "占位里应当恰好两个 <circle>（轨道 + 弧）—— 少一个就只剩半圈或空圈"
    );
    assert.match(markup, /class="bs-spinner-track"/u, "占位缺轨道圆 .bs-spinner-track");
    assert.match(markup, /class="bs-spinner-arc"/u, "占位缺弧圆 .bs-spinner-arc");

    const htmlViewBox = /viewBox="([^"]+)"/u.exec(markup)?.[1];
    const tsxViewBox = /viewBox='([^']+)'/u.exec(code)?.[1];
    assert.equal(htmlViewBox, "0 0 40 40", "占位 SVG 的 viewBox 必须是 0 0 40 40");
    assert.equal(
        tsxViewBox,
        htmlViewBox,
        "⛔ React 侧 viewBox 与占位不一致 —— 两边就不是同一个环了"
    );

    // r：占位写在属性里，React 侧走常数 RADIUS（SVG 的 r 没有 CSS 等价物，只能写在标记里）
    const htmlR = bootRadius();
    const tsxR = Number(/const RADIUS\s*=\s*([\d.]+)/u.exec(code)?.[1]);
    assert.ok(Number.isFinite(tsxR) && tsxR > 0, "Spinner.tsx 里找不到 const RADIUS = <数字>");
    assert.equal(
        tsxR,
        htmlR,
        `⛔ React 侧半径 ${tsxR} 与占位 ${htmlR} 不一致 —— 两个环的粗细/外径会不一样`
    );

    // 几何自洽：外径 = 2r + stroke-width = 40。这是「40px 环」这个不变量的来源，
    // 也是 r=18.25 这么不整的原因（18.25×2 + 3.5 = 40）。
    const strokeWidth = Number(decl(ruleBody(STYLE, ".bs-spinner circle").body, "stroke-width"));
    assert.equal(
        htmlR * 2 + strokeWidth,
        40,
        `⛔ 2×r + stroke-width = ${htmlR * 2 + strokeWidth}，必须等于 40（外径不变）—— ` +
            "改 r 就必须同步改 stroke-width，否则启停两屏的环大小不一样"
    );

    // rotate：不转的话那 90° 弧会停在 3 点钟方向，和原来 border-top（顶部）的位置不同，
    // 减少动效（静态帧）时用户一眼就能看出来
    const htmlRotate = /transform="([^"]+)"/u.exec(markup)?.[1];
    assert.equal(htmlRotate, "rotate(-135 20 20)", "占位的弧必须 rotate(-135 20 20)（让 90° 弧居中在 12 点钟）");
    assert.equal(
        (code.match(/transform='rotate\(-135 20 20\)'/gu) ?? []).length,
        1,
        "⛔ React 侧缺（或重复了）rotate(-135 20 20) —— 两边弧线起点会错开"
    );
});

test("src/index.css 里没有第二份规格（第一版那套 .nh-spinner 已整体删掉）", () => {
    assert.equal(
        /nh-spinner|nh-spin/u.test(CSS),
        false,
        "⛔ src/index.css 里还有 nh-spinner / nh-spin —— 转圈的唯一定义在 index.html，" +
            "这里不许再有第二份（两份规格一出现，漂移只是时间问题，而且白付 gzip）"
    );
    assert.equal(
        /\.bs-spinner\s*\{/u.test(stripCssComments(CSS)),
        false,
        "⛔ src/index.css 里又定义了一遍 .bs-spinner —— 同名两份定义谁赢取决于加载顺序，" +
            "比两份不同名更糟"
    );
});

/**
 * 会改观感的「内联样式属性名」（前缀形态）。
 *
 * 为什么不用裸子串（`code.includes("border:")`）：JSX 对象字面量的键是大驼峰，
 * `borderTopColor:` / `backgroundColor:` / `borderRadius:` 都不含 `border:` 或 `color:`，
 * 裸子串全数漏网（2026-11-06 变异 V1~V4 实测）。
 *
 * 为什么不会误伤：
 *   · 只在**剥过注释**的源码上跑；
 *   · `(?<![-\w])`：前一个字符不能是 `-` 或字母数字 —— `borderTopColor` 里的 `color`
 *     不会再被数一遍，`--bs-brand` 这类自定义属性也不会被当声明；
 *   · 名字后面必须跟 `:`（允许 `'color':` 这种带引号的键），
 *     所以 `viewBox='0 0 40 40'` / `width={40}` / `transform='rotate(…)'` 都不会命中
 *     （它们是属性赋值，不是样式声明）；
 *   · 前缀形态：`border\w*` 覆盖 border / borderTop* / borderColor / borderRadius。
 */
const INLINE_STYLE_PROPS =
    /(?<![-\w])['"]?(color|background\w*|border\w*|width|height|minWidth|minHeight|maxWidth|maxHeight|animation\w*|fontSize|boxShadow|opacity|transform|padding|margin|stroke\w*|fill)\s*['"]?\s*:/u;

test("组件只负责 className + data-mode + 同一份标记，不自己定义样式", () => {
    const code = stripJsComments(SPINNER_SRC);
    assert.match(
        code,
        /SPINNER_CLASS\s*=\s*"bs-spinner"/u,
        'Spinner 渲染的类名必须是 "bs-spinner"（= index.html 里那条唯一定义）'
    );
    assert.match(code, /className=\{/u, "className 要留给调用方透传（拼接，不覆盖）");
    assert.match(
        code,
        /data-mode=\{theme\.palette\.mode\}/u,
        "data-mode 必须来自 theme.palette.mode —— 别改成等 html.dark（那是 commit 之后才挂上的，首帧会闪）"
    );
    assert.match(code, /role='progressbar'/u, "转圈要给 role=progressbar（挂在 <svg> 上是合法的）");
    assert.equal(
        /aria-label/u.test(code),
        false,
        "别自带 aria-label：外层 role=status 已经有可访问名，两个名字会被读屏连念两遍"
    );
    // 必须是 <svg>，不能退回 CSS border 环 —— 那会让首屏 FCP 失去锚点（见文件头）
    assert.match(
        code,
        /component='svg'/u,
        "⛔ Spinner 必须渲染内联 <svg>：CSS border 环不被 Chrome 算作内容绘制，首屏 FCP 会红"
    );
    assert.equal(
        /border\s*:/u.test(code),
        false,
        "⛔ 组件里出现了 border 声明 —— 环必须是 SVG 描边，不是 border（FCP 锚点）"
    );
    // 颜色与尺寸一律不许出现在组件里（出现了就说明又在造第二份规格）
    //
    // 主题色单独拦：走 primary / accent 就会跟着用户在「外观 → 强调色」里挑的颜色漂，
    // 而启动占位那枚环读不到那个颜色（存在 configs 表里，不在 localStorage）——
    // 那正是本次要治的病。
    for (const forbidden of ["primary", "accent"]) {
        assert.equal(
            code.includes(forbidden),
            false,
            `⛔ Spinner.tsx 里出现了 "${forbidden}" —— 颜色只能来自 index.html 的 .bs-spinner`
        );
    }
    // ⚠️ 2026-11-06 QA 补：原来这里是裸子串 `["width:", "border:"]`，挡不住 JSX 里的
    //    对象字面量 —— 那边的属性名是**大驼峰**，实测四种全都能穿过旧黑名单（V1~V4）。
    //    SVG 之后又多了 stroke / fill 这类，一并纳入前缀形态。
    const inlineStyle = INLINE_STYLE_PROPS.exec(code);
    assert.equal(
        inlineStyle,
        null,
        `⛔ Spinner.tsx 里出现了内联样式属性 "${inlineStyle?.[0].trim()}" —— ` +
            "尺寸 / 颜色 / 描边 / 动画只能写在 index.html 的 .bs-spinner 里；" +
            "在组件里补一条就是造第二份规格，下次启动占位一改，两个转圈又不一致了"
    );
});

test("两档颜色：兜底 #1976d2 / data-mode=dark 覆盖 #90caf9，四档逐一对齐", () => {
    // 启动占位那两档（--bs-brand 在默认、@media 深色、data-boot-theme 两套里各写一次）
    const brandTiers = new Set(
        Array.from(STYLE.matchAll(/--bs-brand:\s*(#[0-9a-fA-F]{6})/gu), m => m[1].toLowerCase())
    );
    assert.ok(brandTiers.has("#1976d2"), "启动占位缺亮色档 #1976d2");
    assert.ok(brandTiers.has("#90caf9"), "启动占位缺暗色档 #90caf9");

    const circle = ruleBody(STYLE, ".bs-spinner circle").body;
    // React 侧继承不到 #boot-skeleton 的 --bs-brand，所以兜底值必须写在 var() 里
    const fallbackOf = (prop: string, body: string) => {
        const m = /var\(--bs-brand,\s*(#[0-9a-fA-F]{6})\)/u.exec(decl(body, prop));
        assert.ok(m, `${prop} 里的 var() 兜底色认不出来：${decl(body, prop)}`);
        return m[1].toLowerCase();
    };
    const lightColor = fallbackOf("stroke", circle);
    assert.equal(lightColor, "#1976d2", "亮色档的兜底值必须是 #1976d2");

    const dark = ruleBody(STYLE, '.bs-spinner[data-mode="dark"]').body;
    assert.equal(
        decl(dark, "--bs-brand").toLowerCase(),
        "#90caf9",
        "暗色档必须是 #90caf9（与启动占位的 --bs-brand 暗色同值）"
    );
    // 暗色档只该覆盖颜色：尺寸/描边/动画在这里再写一遍 = 第二份规格的入口
    for (const prop of ["width", "height", "stroke", "stroke-width", "stroke-opacity", "animation"]) {
        assert.equal(
            tryDecl(dark, prop),
            null,
            `⛔ 暗色档里出现了 \`${prop}\` —— 它只该覆盖 --bs-brand，尺寸/描边只有一处定义`
        );
    }
    const darkColor = decl(dark, "--bs-brand").toLowerCase();

    // ⚠️ 2026-11-06 QA 补（变异 M16）：只断言「两个色都出现过」是漏检口径 ——
    //    把 `html[data-boot-theme="light"]` 那档改成 #000000，集合里仍有 #1976d2，
    //    断言照样绿，而「存过亮色」的用户那儿占位已经变成黑环、React 侧还是蓝环。
    //    所以按**档位**逐个与 React 侧的两个值对齐。
    const darkMedia = mediaBodies(STYLE, "@media (prefers-color-scheme: dark)");
    assert.equal(darkMedia.length, 1, "应当恰好一条 @media (prefers-color-scheme: dark)");
    const tiers: [string, string, string][] = [
        ["默认（跟随系统亮色）", ruleBody(STYLE, "#boot-skeleton").body, lightColor],
        ['存过亮色（data-boot-theme="light"）', ruleBody(STYLE, 'html[data-boot-theme="light"] #boot-skeleton').body, lightColor],
        ["系统深色（@media）", ruleBody(darkMedia[0]!, "#boot-skeleton").body, darkColor],
        ['存过深色（data-boot-theme="dark"）', ruleBody(STYLE, 'html[data-boot-theme="dark"] #boot-skeleton').body, darkColor],
    ];
    for (const [label, tierBody, expected] of tiers) {
        assert.equal(
            decl(tierBody, "--bs-brand").toLowerCase(),
            expected,
            `⛔ 启动占位的「${label}」档是 ${decl(tierBody, "--bs-brand")}，React 侧那一档是 ${expected} —— ` +
                "两档不同值就等于「两个转圈不一样」原样复活"
        );
    }
});

test("「减少动效」下两边同时停转（同一个规则，结构保证）", () => {
    const reduce = mediaBodies(STYLE, "@media (prefers-reduced-motion: reduce)");
    assert.ok(reduce.length > 0, "index.html 缺 @media (prefers-reduced-motion: reduce)");
    assert.ok(
        reduce.some(block => /(?:^|[},])\s*\.bs-spinner\s*\{[^}]*animation:\s*none/u.test(block)),
        "减少动效块里要有裸 .bs-spinner { animation: none } —— " +
            "不带作用域才能让启动占位和 React 侧同时停转（一边停一边转会晃到前庭敏感的用户）"
    );
    assert.equal(
        // ⚠️ 用剥过注释的文本：注释里写着「原来那条是按作用域写的」，
        //    不剥的话守卫会被自己的说明判红。
        /#boot-skeleton \.bs-spinner\s*\{[^}]*animation:\s*none/u.test(stripCssComments(STYLE)),
        false,
        "⛔ 又按作用域写了 —— 那样 React 渲染的环在减少动效下照样会转"
    );
});

test("整页级转圈只有一种实现：LoginScreen 与 App 里不再出现 CircularProgress", () => {
    // ⚠️ 两处都有「以前用的是 CircularProgress……」这类历史说明，必须**先剥注释**再断言，
    //    否则守卫会被自己的注释判红（同 tests/copyBlockRemoved.test.ts 的做法）。
    // 每个文件里 <Spinner /> 的**处数**：删掉/换掉任意一处都算回归。
    //   · LoginScreen 2 处：isAuthChecking 的整页检查态 + 登录页 lazy chunk 的 Suspense 兜底
    //   · App 1 处：站点列表 loading 分支
    // ⚠️ 2026-11-06 QA 补（变异 M15）：原来只断言「至少一处」，把登录检查态那枚环整个删掉
    //    （页面变成一片空白）时全部守卫仍是绿的。处数钉死之后，少一处就红。
    const expectedUsage: Record<string, number> = {
        "src/components/LoginScreen.tsx": 2,
        "src/App.tsx": 1,
    };
    for (const rel of ["src/components/LoginScreen.tsx", "src/App.tsx"]) {
        const code = stripJsComments(readProjectFile(rel));
        assert.equal(
            code.includes("CircularProgress"),
            false,
            `⛔ ${rel} 里还有 CircularProgress —— 整页级转圈只能是 components/Spinner ` +
                `（MUI 那套的弧长会伸缩，和启动占位那个环不是一回事）`
        );
        // 反过来钉住「确实换成了 Spinner」，免得有人把两行一起删掉也算通过。
        // 路径允许 ./Spinner（LoginScreen，同目录）与 ./components/Spinner（App，父目录）两种。
        assert.match(
            code,
            /import Spinner from "\.\/(?:components\/)?Spinner"/u,
            `${rel} 应当从 components/Spinner 引入整页级转圈`
        );
        // 调用点不许给整页级转圈传 sx（按屏定制尺寸 / 颜色 = 「两个转圈不一样」的入口）。
        // ⚠️ QA 补（变异 V6）：单独一条断言，不靠处数断言兜 ——
        //    `<Spinner sx={{…}} />` 会让处数掉到 0 从而变红，但处数那条的文案是
        //    「少一处就意味着一整屏加载态没有了转圈」，会把人误导到错方向去查。
        const withSx = /<\s*Spinner\b[^>]*?\bsx\s*=/u.exec(code);
        assert.equal(
            withSx,
            null,
            `⛔ ${rel} 里给整页级转圈传了 sx（${withSx?.[0].replace(/\s+/gu, " ").slice(0, 60)}）—— ` +
                "整页级转圈不许按屏定制尺寸/颜色/间距，那正是「两个转圈不一样」的入口；" +
                "要挪位置就在外面套一层 Box，用那个 Box 的 sx"
        );
        const usages = code.match(/<Spinner\s*\/>/gu) ?? [];
        assert.equal(
            usages.length,
            expectedUsage[rel],
            `⛔ ${rel} 里 <Spinner /> 应当有 ${expectedUsage[rel]} 处，实际 ${usages.length} 处 —— ` +
                "少一处就意味着一整屏加载态没有了转圈（用户看到的是空白），多一处要说明是哪一屏"
        );
    }
});
