// tests/spinnerUnified.test.ts
// 「全站转圈只有一份定义」的静态守卫（2026-11-06 用户：两个转圈不一样统一一下）。
//
// 背景：启动占位（index.html 的 .bs-spinner）是我们自己画的 border 环，
// 而登录检查态 / 登录页 chunk 兜底 / 列表加载态用的是 MUI 的 <CircularProgress> ——
// 那是 SVG 弧线，转的同时弧长还在伸缩，跟启动占位那个环**完全是两种观感**。
// 两屏一前一后出现，用户看到的就是「同一个等待被换了个动画」。
//
// 第一版的做法是「两份规格（index.html 一份 + src/index.css 一份）+ 一条 deepEqual
// 守卫」，被否掉了，理由是对的：deepEqual 只能**事后**发现漂移，
// 而「同一个类名、只有一处定义」能让漂移**不可能发生**，顺带还把 index.css 的
// 字节还了回去（首屏 gzip 那时只剩 5.01% 余量）。
//
// 所以现在这份守卫盯的是**结构**而不是「两份数值相等」：
//   1. index.html 里 .bs-spinner 的**规格定义恰好一条**（且这条不带作用域 ——
//      带作用域就只有启动占位用得上，React 侧又被逼着去写第二份）；
//   2. src/index.css 里根本没有第二份（`nh-spinner` / `nh-spin` 0 命中，
//      也不许偷偷把 `.bs-spinner` 再定义一遍）；
//   3. 组件渲染的 className 就是 `bs-spinner`，并带 data-mode（暗色档的唯一开关）；
//   4. 两档颜色：兜底 `#1976d2`、`[data-mode="dark"]` 的 `#90caf9`，
//      且与 #boot-skeleton 的 --bs-brand 两档一致；
//   5. 「减少动效」下**同一个** .bs-spinner 规则停转（不带作用域 ⇒ 两边同时停）；
//   6. LoginScreen / App 剥注释后不再出现 CircularProgress。
//
// 另外钉住「规格本身不许变」：40px / 3.5px / 22% / 0.9s 线性无限 —— 统一的目标是
// 「同一个环」，谁把其中任何一项改小改快，用户看到的就是另一个东西了。
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

/** 取一条声明（要求存在）。`prop` 必须整体匹配，所以 `border` 不会命中 `border-top-color` */
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

/** index.html 里那段内联 <style>（启动占位靠它同帧画出来） */
function bootStyleBlock(): string {
    const match = /<style>([\s\S]*?)<\/style>/u.exec(HTML);
    assert.ok(match, "index.html 里应当还有一段内联 <style> —— 启动占位没有它就只剩白屏");
    return match[1];
}

const STYLE = bootStyleBlock();

test("index.html 里 .bs-spinner 的规格定义恰好一条，且不带作用域", () => {
    // 「带几何声明的那条」才算规格定义 —— 单纯在选择器组 / 注释里提到类名不算。
    // 这样 `.bs-spinner[data-mode="dark"]`（只覆盖 --bs-brand）不会被误数进来。
    const definitions = Array.from(
        stripCssComments(STYLE).matchAll(/\.bs-spinner\s*\{[^}]*width:\s*40px/gu)
    );
    assert.equal(
        definitions.length,
        1,
        `⛔ 规格定义应当恰好一条，实际 ${definitions.length} 条 —— ` +
            "转圈全站只能有一份定义（React 侧复用同一个类名，不要再写第二份规格）"
    );

    // ⚠️ 2026-11-06 QA 补：上面那条只数「带 width: 40px 的那条」，所以**同名第二条**
    //    只要不带 40px 就完全数不到 —— 往这段 <style> 的尾部再写一条
    //    `.bs-spinner { width: 60px }`，层叠按「后写的赢」把两枚环都改成 60px，
    //    而上面那条断言仍然是绿的（QA 变异测试 M13 实测：全绿）。
    //    那正是本次重构要防的「第二份规格」，所以这里按**规则头**数一遍：
    //    允许的只有两条 —— 规格 1 条 + reduce-motion 块里那条只关动画的。
    //    （`[data-mode="dark"]` 不算：`\s*\{` 要求 `{` 紧跟类名，带属性选择器匹配不上。）
    const ruleHeads = Array.from(
        stripCssComments(STYLE).matchAll(/(?:^|[{}])\s*\.bs-spinner\s*\{/gu)
    );
    assert.equal(
        ruleHeads.length,
        2,
        `⛔ index.html 里 .bs-spinner 规则应当恰好两条（规格 1 条 + reduce-motion 里 1 条），` +
            `实际 ${ruleHeads.length} 条。多出来的那条会靠层叠后写赢、静默改掉全站转圈的尺寸/节奏：\n` +
            ruleHeads.map(m => "  · " + m[0].replace(/\s+/gu, " ")).join("\n")
    );

    // 不带作用域：`#boot-skeleton .bs-spinner { … }` 这种写法只有启动占位用得上，
    // React 侧就又得自己写一份 —— 那正是上一版被否掉的结构。
    // ⚠️ 一律先剥注释再断言：注释里写着「原来写的是 `#boot-skeleton .bs-spinner`」，
    //    不剥的话这条守卫会被自己的说明判红。
    const cleanStyle = stripCssComments(STYLE);
    assert.match(
        cleanStyle,
        /(?:^|\})\s*\.bs-spinner\s*\{/u,
        "⛔ .bs-spinner 必须是不带作用域的裸选择器（React 侧要复用它）"
    );
    assert.equal(
        /#boot-skeleton \.bs-spinner\s*\{/u.test(cleanStyle),
        false,
        "⛔ 又写成 `#boot-skeleton .bs-spinner` 了 —— 那样 React 渲染的环拿不到样式"
    );

    // 规格本身不许变：统一的目标是「同一个环」，这几项一个都不能改
    const { body } = ruleBody(STYLE, ".bs-spinner");
    const border = decl(body, "border");
    const borderWidth = /^([\d.]+px)\s/u.exec(border);
    const borderStyle = /^[\d.]+px\s+(\w+)\s/u.exec(border);
    // 轨道色里的那档淡色：`color-mix(… <pct>%, transparent)`
    const trackMix = /([\d.]+%)\s*,\s*transparent\)/u.exec(border);
    assert.ok(
        borderWidth && borderStyle && trackMix,
        "border 的写法认不出来（期望 `3.5px solid color-mix(… 22%, transparent)`）：" + border
    );
    assert.deepEqual(
        {
            width: decl(body, "width"),
            height: decl(body, "height"),
            display: decl(body, "display"),
            borderRadius: decl(body, "border-radius"),
            boxSizing: decl(body, "box-sizing"),
            borderWidth: borderWidth[1],
            borderStyle: borderStyle[1],
            trackMix: trackMix[1],
            animation: decl(body, "animation"),
        },
        {
            width: "40px",
            height: "40px",
            // span 在 React 侧用（div 本来就是 block，对启动占位无影响）
            display: "block",
            borderRadius: "50%",
            boxSizing: "border-box",
            borderWidth: "3.5px",
            borderStyle: "solid",
            trackMix: "22%",
            animation: "bs-spin 0.9s linear infinite",
        },
        "⛔ 转圈的规格变了（40px / 3.5px / 22% / 0.9s 线性无限）—— " +
            "改任何一项，用户看到的就是另一个环了；要改就得连 index.html 的注释一起改并说明理由"
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
 *     所以 `prefers-color-scheme`、「边框 / 颜色」这类正文与字符串不会被命中；
 *   · 前缀形态：`border\w*` 覆盖 border / borderTop* / borderColor / borderRadius。
 */
const INLINE_STYLE_PROPS =
    /(?<![-\w])['"]?(color|background\w*|border\w*|width|height|minWidth|minHeight|maxWidth|maxHeight|animation\w*|fontSize|boxShadow|opacity|transform|padding|margin)\s*['"]?\s*:/u;

test("组件只负责 className 与 data-mode，不自己定义样式", () => {
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
    assert.match(code, /role='progressbar'/u, "转圈要给 role=progressbar");
    assert.equal(
        /aria-label/u.test(code),
        false,
        "别自带 aria-label：外层 role=status 已经有可访问名，两个名字会被读屏连念两遍"
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
    //    对象字面量 —— 那边的属性名是**大驼峰**：`borderTopColor:` 里没有 `border:`、
    //    `backgroundColor:` 里没有 `color:`、`borderRadius:` 也不含 `border:`。
    //    实测 `sx={{ color }}` / `backgroundColor` / `borderTopColor` / `borderRadius`
    //    四种全都能穿过旧黑名单（变异 V1~V4）。
    //
    // 写法与「为什么不会误伤」：
    //   ① **先剥 JS 注释**（`code` 已经过 stripJsComments）—— 组件注释里写着「border 环」
    //      「颜色故意不吃 primary.main」「别用 sx 改尺寸、边框或颜色」，不剥就是假红；
    //   ② 只认**属性名位置**：`(?<![-\w])` 要求前一个字符不是 `-` / 字母数字
    //      （既不把 `--bs-brand` 这类串算进来，也不会把 `borderTopColor` 里的 `color`
    //      重复数一遍），名字后面必须跟 `:`（允许 `'color':` 这种带引号的键）；
    //      所以 `prefers-color-scheme`、正文里的「边框 / 颜色」都不会被当成声明；
    //   ③ 前缀形态：`border\w*` 一条就覆盖 border / borderTop* / borderColor / borderRadius，
    //      不用把十几个逻辑属性名逐个列。
    const inlineStyle = INLINE_STYLE_PROPS.exec(code);
    assert.equal(
        inlineStyle,
        null,
        `⛔ Spinner.tsx 里出现了内联样式属性 "${inlineStyle?.[0].trim()}" —— ` +
            "尺寸 / 颜色 / 边框 / 动画只能写在 index.html 的 .bs-spinner 里；" +
            "在组件里补一条就是造第二份规格，下次启动占位一改，两个转圈又不一致了"
    );
});

test("两档颜色：兜底 #1976d2 / data-mode=dark 覆盖 #90caf9，与 --bs-brand 一致", () => {
    // 启动占位那两档（--bs-brand 在默认、@media 深色、data-boot-theme 两套里各写一次）
    const brandTiers = new Set(
        Array.from(STYLE.matchAll(/--bs-brand:\s*(#[0-9a-fA-F]{6})/gu), m => m[1].toLowerCase())
    );
    assert.ok(brandTiers.has("#1976d2"), "启动占位缺亮色档 #1976d2");
    assert.ok(brandTiers.has("#90caf9"), "启动占位缺暗色档 #90caf9");

    const { body } = ruleBody(STYLE, ".bs-spinner");
    // React 侧继承不到 #boot-skeleton 的 --bs-brand，所以兜底值必须写在 var() 里
    assert.equal(
        decl(body, "border-top-color").includes("var(--bs-brand, #1976d2)"),
        true,
        "弧色必须是 var(--bs-brand, #1976d2) —— 没有兜底值的话 React 侧根本拿不到颜色"
    );
    assert.equal(
        decl(body, "border").includes("var(--bs-brand, #1976d2)"),
        true,
        "轨道色也必须走同一个变量（否则改了弧色、轨道还留在旧色上）"
    );

    const dark = ruleBody(STYLE, '.bs-spinner[data-mode="dark"]').body;
    assert.equal(
        decl(dark, "--bs-brand").toLowerCase(),
        "#90caf9",
        "暗色档必须是 #90caf9（与启动占位的 --bs-brand 暗色同值）"
    );
    // 暗色档只该覆盖颜色：尺寸/节奏/动画在这里再写一遍 = 第二份规格的入口
    for (const prop of ["width", "height", "border", "animation", "border-top-color"]) {
        assert.equal(
            tryDecl(dark, prop),
            null,
            `⛔ 暗色档里出现了 \`${prop}\` —— 它只该覆盖 --bs-brand，尺寸/节奏只有一处定义`
        );
    }

    // ⚠️ 2026-11-06 QA 补：上面只断言「两个色都出现过」，那是个**漏检**口径 ——
    //    把 `html[data-boot-theme="light"]` 那档的 --bs-brand 改成 #000000，
    //    brandTiers 里仍然有 #1976d2（默认那条给的），断言照样绿，
    //    而启动占位在「存过亮色」的用户那儿已经变成黑环、React 侧却还是 #1976d2 ——
    //    「两个转圈不一样」原样复活。所以这里按**档位**逐个与 React 侧的两个值对齐：
    //    亮档（默认 + 存过亮色）必须 === .bs-spinner 的兜底色，
    //    暗档（系统深色 + 存过深色）必须 === [data-mode="dark"] 的覆盖色。
    const fallbackOf = (prop: string) => {
        const m = /var\(--bs-brand,\s*(#[0-9a-fA-F]{6})\)/u.exec(decl(body, prop));
        assert.ok(m, `${prop} 里的 var() 兜底色认不出来：${decl(body, prop)}`);
        return m[1].toLowerCase();
    };
    const lightColor = fallbackOf("border-top-color");
    const trackColor = fallbackOf("border");
    assert.equal(trackColor, lightColor, "弧色与轨道色的兜底值必须是同一个 —— 否则只改了一边");
    const darkColor = decl(dark, "--bs-brand").toLowerCase();

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
        // ⚠️ 用剥过注释的文本（QA 补）：注释里写着「原来那条是按作用域写的」，
        //    不剥的话守卫会被自己的说明判红 —— 与上面几处口径保持一致。
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
    // ⚠️ 2026-11-06 QA 补：原来这里只断言「至少一处 <Spinner />」，于是把登录检查态那枚
    //    环整个删掉（页面变成一片空白）时全部守卫仍是绿的（变异测试 M15 实测）。
    //    处数钉死之后，少一处就红。改这里说明你确实动了整页加载态。
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
                `（MUI 那套是 SVG 弧线，和启动占位那个 border 环不是一回事）`
        );
        // 反过来钉住「确实换成了 Spinner」，免得有人把两行一起删掉也算通过。
        // 路径允许 ./Spinner（LoginScreen，同目录）与 ./components/Spinner（App，父目录）两种。
        assert.match(
            code,
            /import Spinner from "\.\/(?:components\/)?Spinner"/u,
            `${rel} 应当从 components/Spinner 引入整页级转圈`
        );
        // 调用点不许给整页级转圈传 sx（按屏定制尺寸 / 颜色 = 「两个转圈不一样」的入口）。
        // ⚠️ 2026-11-06 QA 补：单独一条断言，不靠下面的处数断言兜 ——
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
