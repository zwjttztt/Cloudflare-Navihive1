// tests/notesMarkColor.test.ts
// 笔记编辑器「Markdown 结构记号」（`#` / `-` / `>` 这些语法字符）的颜色守卫（2026-10-31）。
//
// 修的缺陷：`defaultHighlightStyle` 把 `tags.meta` 钉成 `#404740`，而 Markdown 的
// HeaderMark / ListMark 标的是 `tags.processingInstruction` —— 它**是 meta 的子标签**，
// 于是 `#` 和 `-` 也吃这条色。亮色下 #404740 压白纸面 9.4:1 没问题，暗色下压深纸面
// 只剩 1.55:1（对比度审计报的），14px 的记号等于看不见。
//
// 为什么之前一直是「绿」的：审计脚本等笔记列表标题出现就开扫，而编辑器先以源码态挂载、
// 之后才装即时渲染 —— 有一个源码窗口。快机器扫到预览态（绿），CI 落进源码窗口（红）。
// 属于「审计漏扫」造成的假绿，缺陷本身是真的。审计时序的加固是另一件事，不在这里。
//
// 这组用例守三件事（外加 DOM 级证据）：
//   1. 注册顺序 —— 同一 tag「先注册者优先」，自定义样式排在 default 之后等于没生效；
//   2. token 分态 —— --notes-mark 在 :root / .dark 里各一份且取值不同（暗色忘了挑值就红）；
//   3. 对比度 —— 亮/暗两套纸面底色 × 两枚 token 值，自己算 WCAG 相对亮度，断言 ≥ 4.5。
//
// ⚠️ 断言失败信息里**不要**塞 DOM 元素或大对象（node:assert 会 util.inspect，
//    堆直接炸 —— tests/editorCursorGuard.test.ts 里记着同款教训）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectDir as findProjectDir, stripComments } from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = () => findProjectDir(here);
const readRel = (rel: string) => readFileSync(resolve(ROOT(), rel), "utf8");

/** index.css 在 Windows 上是 CRLF；统一成 LF 再切片，否则 `\n` 拼出来的锚点匹配不上 */
const CSS_RAW = () => readRel("src/index.css").replace(/\r\n/g, "\n");
/** 扫声明前先剥注释：注释里写满了 token 名，不剥就会把说明文字当成声明数 */
const CSS = () => stripCssComments(CSS_RAW());

/** 只剥 /* *\/ 块注释：保留花括号（下面要靠花括号定位声明属于哪个块） */
function stripCssComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

// ---------------------------------------------------------------- CSS 解析小工具

/** 定位 index 所在的那个「花括号块」的选择器文本（.dark / :root / html.xxx 之类） */
function blockSelectorAt(css: string, index: number): string {
    const open = css.lastIndexOf("{", index);
    assert.ok(open >= 0, "该声明不在任何花括号块里");
    assert.ok(css.indexOf("}", index) > open, "该声明落在了某个块的闭合括号之后");
    let i = open - 1;
    while (i >= 0 && css[i] !== "}" && css[i] !== "{" && css[i] !== ";") i--;
    return css.slice(i + 1, open).trim();
}

/** 取出某个选择器块的声明表；`mustInclude` 用来在同名选择器里挑出真正那一块 */
function blockDecls(
    css: string,
    selector: string,
    mustInclude: string
): Map<string, string> {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
        const open = css.indexOf("{", m.index);
        // 花括号配对（块里不会有嵌套规则，但成对扫描比找第一个 } 稳）
        let depth = 0;
        let end = -1;
        for (let i = open; i < css.length; i++) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}") {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        assert.ok(end > open, `${selector} 块的括号没闭合`);
        const body = css.slice(open + 1, end);
        if (!body.includes(mustInclude)) continue;
        const out = new Map<string, string>();
        for (const decl of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
            out.set(decl[1], decl[2].trim());
        }
        return out;
    }
    throw new Error(`index.css 里找不到含 ${mustInclude} 的 ${selector} 块`);
}

// ---------------------------------------------------------------- WCAG 计算

type Rgb = [number, number, number];

/** 解析 `#rgb` / `#rrggbb` / `rgb(...)` / `rgba(...)`，返回 0~255 分量 + alpha */
function parseColor(value: string): { rgb: Rgb; alpha: number } {
    const v = value.trim();
    const hex = /^#([0-9a-f]{3,8})$/i.exec(v);
    if (hex) {
        const h = hex[1];
        if (h.length === 3) {
            return {
                rgb: [
                    parseInt(h[0] + h[0], 16),
                    parseInt(h[1] + h[1], 16),
                    parseInt(h[2] + h[2], 16),
                ],
                alpha: 1,
            };
        }
        return {
            rgb: [
                parseInt(h.slice(0, 2), 16),
                parseInt(h.slice(2, 4), 16),
                parseInt(h.slice(4, 6), 16),
            ],
            alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
        };
    }
    const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
    assert.ok(fn, `看不懂的颜色值：${value}`);
    const nums = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    assert.ok(nums.length >= 3, `颜色值分量不足：${value}`);
    return {
        rgb: [nums[0], nums[1], nums[2]],
        alpha: nums.length > 3 ? nums[3] : 1,
    };
}

/** 半透明层按 alpha 混到不透明底上（CSS 的 source-over） */
function composite(base: Rgb, layer: { rgb: Rgb; alpha: number }): Rgb {
    const a = layer.alpha;
    return [
        layer.rgb[0] * a + base[0] * (1 - a),
        layer.rgb[1] * a + base[1] * (1 - a),
        layer.rgb[2] * a + base[2] * (1 - a),
    ];
}

/** WCAG 2.x 相对亮度 */
function luminance([r, g, b]: Rgb): number {
    const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 对比度（1~21） */
function contrastRatio(a: Rgb, b: Rgb): number {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------- 纸面底色

/**
 * MUI 暗色 `palette.background.default`。NotesPageShell 的暗色纸面就是它
 * （`bgcolor: t.palette.mode === "light" ? "#faf8f1" : t.palette.background.default`）。
 * MUI 的暗色默认值是 #121212，这个数字不在本仓源码里，所以硬编码 —— 出处即上面这条。
 */
const DARK_PAPER_BASE = "#121212";

/**
 * 亮色「暖白（纸感）」纸面。出自 src/components/notes/NotesPageShell.tsx 的
 * `t.palette.mode === "light" ? "#faf8f1" : …`（另一个档「纯白」是 background.paper = #fff，
 * 更亮 → 对比度更高，所以拿 #faf8f1 当亮色的最坏档）。下面有一条用例钉住这个字面量还在。
 */
const LIGHT_PAPER_BASE = "#faf8f1";

// ---------------------------------------------------------------- 守卫 1：注册顺序

test("NoteEditor：markHighlight 必须注册在 defaultHighlightStyle 之前（同一 tag 先注册者优先）", () => {
    const src = stripComments(readRel("src/components/NoteEditor.tsx"));
    const custom = src.indexOf("syntaxHighlighting(markHighlight)");
    const fallback = src.indexOf("syntaxHighlighting(defaultHighlightStyle)");

    assert.ok(custom >= 0, "找不到 syntaxHighlighting(markHighlight) —— canvas 覆盖被删了？");
    assert.ok(fallback >= 0, "找不到 syntaxHighlighting(defaultHighlightStyle) —— 默认高亮被删了？");
    assert.ok(
        custom < fallback,
        "同一 tag 先注册者优先：syntaxHighlighting(markHighlight) 必须排在 " +
            "syntaxHighlighting(defaultHighlightStyle) **之前**。排在后面等于没生效 —— " +
            "不报错、不会有任何提示，`#` / `-` 会静默退回 #404740（暗色下 1.55:1）。"
    );
});

test("NoteEditor：markHighlight 覆盖的是 tags.meta，颜色走 var(--notes-mark) 而不是写死色值", () => {
    const src = stripComments(readRel("src/components/NoteEditor.tsx"));
    const at = src.indexOf("const markHighlight");
    assert.ok(at >= 0, "找不到模块级常量 markHighlight");
    const body = src.slice(at, src.indexOf("]);", at) + 3);

    assert.match(body, /tag:\s*t\.meta/, "结构记号命中 tags.meta（processingInstruction 是它的子标签）");
    assert.match(body, /color:\s*"var\(--notes-mark\)"/, "颜色必须走 CSS 变量，不能写死色值");
    assert.equal(
        /#[0-9a-f]{6}/i.test(body),
        false,
        "这里不许出现颜色字面量：写死就又不跟主题走了，等于回到修之前"
    );
});

// ---------------------------------------------------------------- 守卫 2：token 分态

test("index.css：--notes-mark 在 :root 与 .dark 里各声明一次，且两档取值不同", () => {
    const css = CSS();
    const decls = [...css.matchAll(/(--notes-mark)\s*:\s*([^;]+);/g)];
    assert.equal(
        decls.length,
        2,
        `--notes-mark 应该正好声明 2 次（:root + .dark），实际 ${decls.length} 次`
    );

    const scopes = decls.map(d => blockSelectorAt(css, d.index ?? 0));
    assert.deepEqual(scopes, [":root", ".dark"], `两处应该在 :root 与 .dark，实际是 ${scopes.join(" / ")}`);

    const light = decls[0][2].trim();
    const dark = decls[1][2].trim();
    assert.match(light, /^#[0-9a-f]{6}$/i, `亮色值应是 6 位十六进制，实际 ${light}`);
    assert.match(dark, /^#[0-9a-f]{6}$/i, `暗色值应是 6 位十六进制，实际 ${dark}`);
    assert.notEqual(
        dark,
        light,
        "暗色必须单独挑值：沿用亮色的 #404740 压深纸面只有 1.55:1（14px 小字线 4.5）"
    );
});

test("index.css：亮色 --notes-mark 仍是 #404740（从 defaultHighlightStyle 原样搬来的，视觉零变化）", () => {
    const decls = [...CSS().matchAll(/(--notes-mark)\s*:\s*([^;]+);/g)];
    assert.ok(decls.length >= 1, "--notes-mark 没声明");
    assert.equal(
        decls[0][2].trim().toLowerCase(),
        "#404740",
        "亮色这档必须是 #404740：它是 defaultHighlightStyle 的原值，改了亮色外观就变了（这轮不该变）"
    );
});

// ---------------------------------------------------------------- 守卫 3：对比度

test("对比度：两档 --notes-mark 压各自纸面都 ≥ 4.5（WCAG AA 小字线）", () => {
    const css = CSS();
    const light = blockDecls(css, ":root", "--notes-mark");
    const dark = blockDecls(css, ".dark", "--notes-mark");

    const assertToken = (decls: Map<string, string>, name: string) => {
        const raw = decls.get(name);
        assert.ok(raw, `块里没有 ${name}`);
        return parseColor(raw);
    };

    // —— 亮色纸面：#faf8f1（暖白）上叠 --bg-editor 的 72% 白 ——
    const lightPaper = composite(parseColor(LIGHT_PAPER_BASE).rgb, assertToken(light, "--bg-editor"));
    // —— 暗色纸面：#121212 上叠 --bg-editor 的 5.5% 白 ——
    const darkPaper = composite(parseColor(DARK_PAPER_BASE).rgb, assertToken(dark, "--bg-editor"));

    // 激活行那层 --neutral-wash（5% 中灰）会再抬亮一档：暗色下纸面变亮 = 对比度变低，
    // 所以这才是最坏档（审计抓到的那处 `#` 就在激活行里）。
    const wash = assertToken(light, "--neutral-wash");
    const darkPaperActive = composite(darkPaper, wash);
    const lightPaperActive = composite(lightPaper, wash);

    const cases: Array<{ label: string; fg: { rgb: Rgb; alpha: number }; bg: Rgb }> = [
        { label: "亮色·纸面", fg: assertToken(light, "--notes-mark"), bg: lightPaper },
        { label: "亮色·纸面+激活行", fg: assertToken(light, "--notes-mark"), bg: lightPaperActive },
        { label: "暗色·纸面", fg: assertToken(dark, "--notes-mark"), bg: darkPaper },
        { label: "暗色·纸面+激活行", fg: assertToken(dark, "--notes-mark"), bg: darkPaperActive },
    ];

    for (const c of cases) {
        const ratio = contrastRatio(c.fg.rgb, c.bg);
        assert.ok(
            ratio >= 4.5,
            `${c.label}：--notes-mark(${c.fg.rgb.join(",")}) 压 rgb(${c.bg
                .map(v => Math.round(v))
                .join(",")}) 只有 ${ratio.toFixed(2)}:1，小字线是 4.5 —— 换一个更亮的暗色值`
        );
    }

    // 反向验证：守卫真能抓到修之前的组合（否则这条只是一条永远为真的废话）
    const legacy = contrastRatio(parseColor("#404740").rgb, darkPaperActive);
    assert.ok(
        legacy < 4.5,
        `#404740 压暗色纸面+激活行应该是不达标的（实测 ${legacy.toFixed(2)}:1），` +
            "如果这里过了，说明纸面模型取错了、整个守卫都在空转"
    );
});

test("纸面模型：NotesPageShell 的暖白底仍是 #faf8f1（上面硬编码的那个出处）", () => {
    const shell = readRel("src/components/notes/NotesPageShell.tsx");
    assert.ok(
        shell.includes(`"${LIGHT_PAPER_BASE}"`),
        `NotesPageShell 里找不到 ${LIGHT_PAPER_BASE} —— 暖白纸面换值了，` +
            "上面那条对比度用例的纸面模型要跟着改"
    );
    assert.match(
        shell,
        /t\.palette\.mode === "light"/,
        "暖白 / 纯白的分档还在（暗色档走 background.default = #121212）"
    );
});
