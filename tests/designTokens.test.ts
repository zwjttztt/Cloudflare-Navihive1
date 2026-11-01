import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 单测会被复制到 script/tmp-tests/ 下再跑，这里逐级向上找真正的 src/index.css
function findCss(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        const candidate = resolve(dir, "src/index.css");
        try {
            return readFileSync(candidate, "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到 src/index.css");
}
const css = findCss();

/**
 * 从块的 `{` 处开始按花括号配对找块尾，跳过 CSS 块注释（斜杠星号 … 星号斜杠）。
 * 返回 `}` 的下标。
 *
 * ⚠️ 这里**不能**写成 `text.indexOf("}", openBraceIndex)`。
 * 注释里常常会写示例代码，一句「例：{ tag: tags.meta }」里的 `}` 会被当成块尾，
 * 把块截断在注释处 —— 截断后的块更短，于是「少了几个 token」的断言变红，
 * 而报错信息指向的是完全无关的另一个缺失项，排查会绕很多路；更糟的是它也可能
 * 反过来掩盖真问题（块短了，断言反而更容易过）。这个坑真踩过一次：:root 的
 * 注释里写了花括号，令牌守卫当场红了 2 条。
 *
 * 只认块注释：CSS 没有行注释，`//` 在 `url(https://…)` 里会出现，
 * 当成注释会把后面的 `}` 一起吃掉。
 */
function matchBlockEnd(text: string, openBraceIndex: number): number {
    if (text[openBraceIndex] !== "{") {
        throw new Error(`matchBlockEnd 的起点必须是 {，实际是 ${JSON.stringify(text[openBraceIndex])}`);
    }
    let depth = 0;
    for (let i = openBraceIndex; i < text.length; i++) {
        const ch = text[i];
        if (ch === "/" && text[i + 1] === "*") {
            const close = text.indexOf("*/", i + 2);
            if (close < 0) throw new Error(`第 ${i} 处注释没有闭合，无法确定块尾`);
            i = close + 1; // 跳过整个注释（循环头还会 +1）
            continue;
        }
        if (ch === "{") depth += 1;
        else if (ch === "}") {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    throw new Error(`从第 ${openBraceIndex} 个字符的 { 开始找不到配对的 }`);
}

/**
 * 取出某个选择器块里的变量声明。
 * 同一个选择器在 index.css 里可能出现多次（比如 :root 先声明滚动条变量，
 * 后面才是设计 tokens），所以要用 mustInclude 定位到真正那一块。
 *
 * `source` 默认就是真实的 index.css；只给回归守卫传自造的 CSS 片段用 ——
 * 守卫不能依赖真实文件的内容（注释哪天被删掉，它就白测了）。
 */
function block(selector: string, mustInclude: string, source: string = css): Map<string, string> {
    // 只匹配「整行开头的选择器」，避免 html.nav-no-glass.dark 被当成 .dark 命中
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
        const start = m.index + m[0].length - 1;
        const end = matchBlockEnd(source, start);
        const body = source.slice(start + 1, end);
        if (body.includes(mustInclude)) {
            const out = new Map<string, string>();
            for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
                out.set(m[1], m[2].trim());
            }
            return out;
        }
    }
    throw new Error(`index.css 里找不到含 ${mustInclude} 的 ${selector} 块`);
}

const TOKENS = [
    // surface
    "--surface-page",
    "--surface-panel",
    "--surface-card",
    "--surface-card-hover",
    "--surface-raised",
    // border
    "--border-hairline",
    "--border-subtle",
    "--border-default",
    // radius
    "--radius-xs",
    "--radius-sm",
    "--radius-md",
    "--radius-lg",
    "--radius-pill",
    // spacing
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-5",
    "--space-6",
    "--touch-min",
    // shadow
    "--shadow-1",
    "--shadow-2",
    "--shadow-3",
    // blur
    "--blur-sm",
    "--blur-md",
    // text
    "--text-primary",
    "--text-secondary",
    "--text-muted",
];

test("设计 tokens：:root 里定义完整的一套语义变量", () => {
    const root = block(":root", "--font-sans");
    for (const t of TOKENS) {
        assert.ok(root.has(t), `:root 缺少 token ${t}`);
        assert.ok(root.get(t)!.length > 0, `${t} 没有取值`);
    }
});

test("设计 tokens：暗色主题覆盖表面/描边/阴影/文字，不只换主色", () => {
    const dark = block(".dark", "--surface-card");
    for (const t of [
        "--surface-panel",
        "--surface-card",
        "--surface-card-hover",
        "--border-default",
        "--shadow-2",
        "--shadow-3",
        "--text-primary",
        "--text-secondary",
        "--text-muted",
    ]) {
        assert.ok(dark.has(t), `.dark 未覆盖 ${t}`);
    }
});

test("设计 tokens：旧 --glass-* 全部指向语义 token，不再自带颜色字面量", () => {
    const root = block(":root", "--font-sans");
    const aliases = [
        "--glass-bg",
        "--glass-bg-hover",
        "--glass-border",
        "--glass-shadow",
        "--glass-shadow-hover",
        "--glass-blur",
        "--glass-panel-bg",
        "--glass-panel-border",
    ];
    for (const a of aliases) {
        const value = root.get(a);
        assert.ok(value, `:root 缺少 ${a}`);
        assert.ok(
            value!.startsWith("var("),
            `${a} 仍在自带取值（${value}），应当指向语义 token`
        );
    }
    // .dark 块里不能再直接改 --glass-*：否则两套来源会打架
    const dark = block(".dark", "--surface-card");
    for (const a of aliases) {
        assert.ok(!dark.has(a), `.dark 不应直接覆盖 ${a}`);
    }
});

test("设计 tokens：关闭毛玻璃时重定义 surface/border，而不是旧别名", () => {
    const noGlass = block("html.nav-no-glass", "--surface-card");
    assert.ok(noGlass.has("--surface-card"), "no-glass 应重定义 --surface-card");
    assert.ok(noGlass.has("--surface-panel"), "no-glass 应重定义 --surface-panel");
    for (const a of ["--glass-bg", "--glass-border"]) {
        assert.ok(!noGlass.has(a), `no-glass 不应直接覆盖 ${a}`);
    }
});

test("分组强调色只用于细线标记：宽度走 token 且不超过 4px", () => {
    const root = block(":root", "--font-sans");
    const width = root.get("--group-accent-width");
    assert.ok(width, "缺少 --group-accent-width");
    const px = Number.parseFloat(width!);
    assert.ok(Number.isFinite(px) && px <= 4, `强调条宽度 ${width} 太宽，会变成整块背景`);
});

// ── 回归守卫：注释里的花括号不能把块截断 ────────────────────────────────────
//
// ⚠️ 样本是**自造的最小 CSS**，刻意不读真实 index.css：
// 这条守卫要钉的是「找块尾」这个算法，一旦依赖真实文件的注释，
// 哪天有人把那段注释删了（很正当的清理），守卫就变成永远绿的摆设。
//
// 反向验证过（2026-11 改这块时实测）：把 block() 里的 matchBlockEnd 换回
// `source.indexOf("}")`，这条用例立刻红，报的是
//   `index.css 里找不到含 --a 的 :root 块`
// —— 因为块被截断在注释里那个 `}` 处，切出来的 body 里只有注释、连 --a 都没有，
// 于是 block() 直接抛「找不到这一块」。注意另外 5 条真实文件的用例**照样全绿**：
// index.css 现存的注释里唯一带花括号的那处在第 818 行，落在 :root / .dark /
// no-glass 三个块之外，所以这次改动不改任何既有断言的结论（只是把算法修对）。
test("守卫：块尾按花括号配对来找，注释里的花括号不会截断块", () => {
    const SAMPLE = [
        ":root {",
        "    /* 示例：{ tag: tags.meta } 这种花括号以前会把块截断 */",
        "    --a: 1px;",
        "    --b: 2px;",
        "}",
    ].join("\n");

    const vars = block(":root", "--a", SAMPLE);
    assert.equal(vars.get("--a"), "1px", "注释之后的第一条变量必须还在块里");
    assert.equal(
        vars.get("--b"),
        "2px",
        "注释里的 `}` 被当成块尾了：块被截断在注释处，--b 落在块外"
    );

    // 反向的另一面：找不到配对时**报错**，不能默默返回 -1 让调用方切出一个空块
    assert.throws(
        () => matchBlockEnd(":root { --a: 1px;", 6),
        /找不到配对的/,
        "块没有闭合时必须抛明确错误，静默返回 -1 会让断言拿到空 Map 而原因不明"
    );
});
