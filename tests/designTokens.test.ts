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
 * 取出某个选择器块里的变量声明。
 * 同一个选择器在 index.css 里可能出现多次（比如 :root 先声明滚动条变量，
 * 后面才是设计 tokens），所以要用 mustInclude 定位到真正那一块。
 */
function block(selector: string, mustInclude: string): Map<string, string> {
    // 只匹配「整行开头的选择器」，避免 html.nav-no-glass.dark 被当成 .dark 命中
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
        const start = m.index + m[0].length - 1;
        const end = css.indexOf("}", start);
        const body = css.slice(start + 1, end);
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
