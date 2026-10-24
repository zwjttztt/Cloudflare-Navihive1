// tests/muiSelectorSpecificity.test.ts
// 守住「index.css / App.css 里不得出现**纯单类 MUI 选择器**」。
//
// 为什么需要它：emotion 的运行时 <style> 注入排在 <link>（index.css）**之后**，
// 同特异性下后注入者赢 → 纯单类选择器（0,1,0）永远输给 MUI 自己生成的那个类。
// 也就是说，在这里写 `.MuiDialog-paper { … }` 等于**什么都没写**。
//
// 真踩过两次：
//   1) 小屏「底部面板」那条规则静默失效整整一年（2026-10 才发现）；
//   2) `index.css:608` 的「弹窗材质基线」同样是死的 —— CDP 实测把它改成 99px，
//      computed border-radius 纹丝不动（仍是 theme 给的 22px），2026-10-24 删除。
//
// ⚠️ 判定必须处理两个坑，否则会**假绿**：
//   · 规则可能嵌在 @media 里（本文件就有 @media print 与 @media 断点段）。
//     用「选择器 + {…}」的简单正则会把嵌套段整段跳过 → 什么都没扫到 → 通过。
//     所以这里写一个带大括号配对的扫描器，@ 开头的块递归进去继续扫。
//   · 带 `!important` 的声明不受注入顺序影响（!important 的胜负由「两边都有
//     !important 时才比特异性」决定，而 emotion 那边不写 !important），
//     所以 `@media print` 里那几条单类规则是**合法的**，必须放过。
//
// 判据：选择器整体恰好是一个 `.Mui*` 类（无祖先前缀 / 无后代 / 无伪类 / 无伪元素）
//       且它的声明块里没有任何 `!important` → 违规。
//
// 豁免：必须写清 reason。当前本项目零豁免（全站扫描后确认没有违规项）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function findProjectDir(): string {
    for (let dir = process.cwd(), i = 0; i < 6; i++) {
        try {
            readFileSync(path.join(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = path.dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const ROOT = findProjectDir();
const CSS_FILES = ["src/index.css", "src/App.css"];

/** 剥掉 CSS 注释：注释里出现的 .Mui* 是说明文字，不是规则（App.css:37 就有一次） */
function stripCssComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 剥掉 TS/TSX 注释，但**保留字符串字面量**里的内容。
 *
 * 为什么需要：theme 文件里刻意留了「以前这里是 rgba(...)」的历史说明，
 * 那是解释「为什么要改」的注释，不是硬编码。不剥的话守卫会被自己的注释绊倒。
 * 字符串里的 `"rgba(255,255,255,0.94)"` 才是要抓的目标，所以不能简单连字符串一起处理。
 */
function stripTsComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            let out = "";
            let quote: string | null = null;
            for (let i = 0; i < line.length; i++) {
                const c = line[i];
                if (quote) {
                    out += c;
                    if (c === "\\") {
                        out += line[i + 1] ?? "";
                        i++;
                        continue;
                    }
                    if (c === quote) quote = null;
                    continue;
                }
                if (c === '"' || c === "'" || c === "`") {
                    quote = c;
                    out += c;
                    continue;
                }
                if (c === "/" && line[i + 1] === "/") break;
                out += c;
            }
            return out;
        })
        .join("\n");
}

/**
 * 从 `open`（一个 `{` 的下标）出发找配对的 `}`。
 * 跳过字符串字面量里的花括号 —— `content: " " attr(href)` 这类还好，
 * 但 CSS 里合法存在 `content: "{"`，不跳就会错位。
 */
function matchBrace(css: string, open: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < css.length; i++) {
        const c = css[i];
        if (quote) {
            if (c === "\\") {
                i++;
                continue;
            }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return css.length; // 括号不配对：切到末尾，宁可多扫也不漏
}

/** 按括号深度切逗号 —— `:not(a, b)` / `:is(.x, .y)` 里的逗号不是选择器分隔符 */
function splitSelectors(selectorText: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of selectorText) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth <= 0) {
            out.push(cur.trim());
            cur = "";
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(Boolean);
}

/** 纯单类 MUI 选择器？（整体恰好一个 .MuiXxx，别的一律不算） */
const BARE_MUI = /^\.Mui[A-Za-z0-9_-]+$/;

type CssRule = {
    selector: string;
    body: string;
    line: number;
};

/**
 * 扫描出全部「叶子规则」（@media / @supports / @keyframes 里的都算），
 * 跳过 at-rule 自己的头（`@media (max-width:600px)` 不是选择器）。
 */
function scanRules(css: string, base = 0, out: CssRule[] = []): CssRule[] {
    let segStart = 0;
    let i = 0;
    while (i < css.length) {
        const ch = css[i];
        if (ch === "{") {
            const prelude = css.slice(segStart, i).trim();
            const close = matchBrace(css, i);
            const body = css.slice(i + 1, close);
            if (prelude.startsWith("@")) {
                // @media / @supports / @keyframes：递归扫里面的规则
                scanRules(body, base + i + 1, out);
            } else if (prelude) {
                out.push({
                    selector: prelude,
                    body,
                    line: css.slice(0, segStart).split("\n").length,
                });
            }
            i = close + 1;
            segStart = i;
            continue;
        }
        i++;
    }
    return out;
}

/** 豁免清单：key 是「相对路径:选择器」，必须写 reason */
const EXEMPT: Record<string, { reason: string }> = {};

test("index.css / App.css 里不得出现不带 !important 的纯单类 MUI 选择器", () => {
    const offenses: string[] = [];
    for (const rel of CSS_FILES) {
        const css = stripCssComments(readFileSync(path.join(ROOT, rel), "utf8"));
        for (const rule of scanRules(css)) {
            // 声明块里有 !important → 不受 emotion 注入顺序影响，合法
            if (/!\s*important/i.test(rule.body)) continue;
            for (const sel of splitSelectors(rule.selector)) {
                if (!BARE_MUI.test(sel)) continue;
                const key = `${rel}:${sel}`;
                const exempt = EXEMPT[key];
                if (!exempt) {
                    offenses.push(
                        `${key}（第 ${rule.line} 行附近）：纯单类 MUI 选择器（0,1,0）永远输给 ` +
                            `emotion 运行时注入 —— 这条规则不会生效。` +
                            `要么加祖先前缀，要么改去 theme 的 styleOverrides，要么加 !important（并说明理由）`
                    );
                    continue;
                }
                assert.ok(exempt.reason.length > 10, `${key} 的豁免必须写清原因`);
            }
        }
    }
    assert.deepEqual(offenses, [], `\n${offenses.join("\n")}`);
});

test("守卫自检：@media 里的规则必须被扫到，带 !important 的要放过", () => {
    // 反向验证扫描器本身 —— 不能只信「没报错就是没问题」。
    // @media print 段里有 5 条纯单类 MUI 选择器（.MuiModal-root 等），
    // 它们的声明块是 `display: none !important`，所以必须被识别且不算违规。
    const css = stripCssComments(readFileSync(path.join(ROOT, "src/index.css"), "utf8"));
    const rules = scanRules(css);
    const printBare = rules.filter(
        r =>
            /!\s*important/i.test(r.body) &&
            splitSelectors(r.selector).some(s => BARE_MUI.test(s))
    );
    assert.ok(
        printBare.length > 0,
        "扫描器没扫到 @media 里那些带 !important 的单类 MUI 选择器 —— " +
            "说明嵌套块的解析是坏的（这正是本守卫最容易假绿的地方）"
    );
    assert.ok(
        printBare.some(r => splitSelectors(r.selector).includes(".MuiModal-root")),
        "扫描器没扫到 .MuiModal-root —— @media print 段的解析有问题"
    );
});

test("弹窗材质底色必须走 --surface-modal，不得再硬编码 rgba", () => {
    // 背景：theme 的 MuiDialog.styleOverrides.paper 曾经写死
    // rgba(255,255,255,0.94) / rgba(23,27,38,0.94)，与 --surface-modal 取值相同，
    // 所以「改 token 弹窗不跟着变」这件事一直没人发现。改 var() 后取值不变，
    // 但从此只有一个真源。
    const theme = stripTsComments(readFileSync(path.join(ROOT, "src/hooks/useThemeController.ts"), "utf8"));
    for (const [label, re] of [
        ["亮色 rgba(255,255,255,0.94)", /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.94\s*\)/],
        ["暗色 rgba(23,27,38,0.94)", /rgba\(\s*23\s*,\s*27\s*,\s*38\s*,\s*0\.94\s*\)/],
    ] as const) {
        assert.ok(
            !re.test(theme),
            `useThemeController.ts 里还有硬编码的弹窗底色（${label}）—— 应改用 var(--surface-modal)`
        );
    }
    // token 必须亮暗各定义一次，否则 var() 会在其中一种主题下取不到值
    const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    const declared = css.match(/--surface-modal\s*:/g) ?? [];
    assert.ok(
        declared.length >= 2,
        `--surface-modal 必须同时在 :root 与 .dark 里定义（当前只找到 ${declared.length} 处）`
    );
});

test("dialogShell 的材质 token 与 theme 的 paper 覆盖取值一致", () => {
    // 两处是「同一个视觉值的两个消费方」：dialogShell 给用外壳的十几个弹窗，
    // theme 给全部 32 个。取值一旦分叉，同一个产品里就会出现两种弹窗材质。
    const shell = readFileSync(path.join(ROOT, "src/components/dialogShell.ts"), "utf8");
    const theme = readFileSync(path.join(ROOT, "src/hooks/useThemeController.ts"), "utf8");
    for (const token of [
        "var(--card-radius)",
        "var(--glass-panel-border)",
        "var(--glass-shadow-hover)",
        "var(--surface-modal)",
    ]) {
        assert.ok(shell.includes(token), `dialogShell.ts 缺少 ${token}`);
        assert.ok(theme.includes(token), `useThemeController.ts 缺少 ${token}`);
    }
});
