// tests/cssBaselineGuard.test.ts
// CSS 兼容守卫（P2-2）：`:has()` 只许出现在 `@supports selector(:has(*))` 保护块里。
//
// 为什么这条必须存在：
//   CSS 的**普通选择器列表不是 forgiving 的**。写
//       .a:hover .x,
//       .b:has(:focus-visible) { opacity: 1 }
//   时，凡是认不出 `:has()` 的浏览器会把**整条规则**丢掉 —— 同一组里那条完全兼容的
//   hover 规则也跟着一起没了，功能静默坏掉。
//
//   而基线（package.json 的 browserslist）是 `firefox >= 111`，`:has()` 要到
//   Firefox 121 才默认支持 —— 中间这 10 个版本（含企业长期支持的 ESR115）
//   全都在这个坑里。CI 只有 Chromium，永远发现不了这类回归。
//
// 判据：`:has()` 要么根本不写，要么写进 `@supports selector(:has(*))` 里。
//   · `@supports` 条件为假时整块不生效，老浏览器**不会**去解析块内的选择器；
//   · 同组的兼容选择器写在块外，不受牵连。
//   例外：`@supports not selector(:has(*))` 块里的 `:has()` 也判违规 —— 那个块
//   只在「不支持 :has()」的浏览器里生效，在里面用 `:has()` 是逻辑自相矛盾。
//
// 为什么不扫 .ts/.tsx：emotion 的每个 sx key 会各自生成独立规则，
//   `"&:has(x) {...}"` 与 `"&:hover {...}"` 天然不在一组，不存在连带丢弃，
//   没有可机械验证的判据（扫字符串只会制造噪声）。真正的风险面在 .css 文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function projectDir(): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

/** 把块注释抹成等长空白：注释里写着 `:has()` 的例子不能算违规，同时保持索引/行号不变 */
function blankComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
}

interface SupportsRange {
    /** `@supports` 关键字所在索引 */
    start: number;
    /** 条件之后那个 `{` 的索引 —— `[start, headEnd)` 是条件头部，里面的 `:has()` 不是选择器 */
    headEnd: number;
    /** 匹配的 `}` 所在索引（没闭合就取文件尾） */
    end: number;
    /** 条件文本，如 `selector(:has(*))` 或 `not selector(:has(*))` */
    cond: string;
}

/**
 * 找出所有 `@supports … { … }` 的范围。
 * 不做嵌套 `@supports` 处理 —— 本仓库没有；真出现了这条守卫也只会更严格（判红）。
 */
function supportsRanges(css: string): SupportsRange[] {
    const out: SupportsRange[] = [];
    const re = /@supports\s+([^{]+)\{/g;
    let m: RegExpExecArray | null = re.exec(css);
    while (m !== null) {
        const cond = (m[1] ?? "").trim();
        const headEnd = css.indexOf("{", m.index);
        let depth = 0;
        let end = css.length;
        for (let i = headEnd; i < css.length; i += 1) {
            const ch = css[i];
            if (ch === "{") depth += 1;
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        out.push({ start: m.index, headEnd, end, cond });
        m = re.exec(css);
    }
    return out;
}

/** 条件是否「在支持 :has() 时才生效」（`not selector(:has(*))` 不算） */
function guardsHas(cond: string): boolean {
    return /selector\(\s*:has\(/.test(cond) && !/^not\b/i.test(cond);
}

/** 扫描结果是违规清单（`文件:行: 说明`）；纯函数，方便反向自测 */
function scanCss(css: string, label: string): string[] {
    const src = blankComments(css);
    const ranges = supportsRanges(src);
    const hits: string[] = [];
    const re = /:has\(/g;
    let m: RegExpExecArray | null = re.exec(src);
    while (m !== null) {
        const idx = m.index;
        // `@supports selector(:has(*))` 条件里的 :has() 是特性探测串，不是选择器
        if (ranges.some(r => idx > r.start && idx < r.headEnd)) {
            m = re.exec(src);
            continue;
        }
        const line = src.slice(0, idx).split("\n").length;
        const holder = ranges.find(r => idx > r.headEnd && idx < r.end);
        if (!holder || !guardsHas(holder.cond)) {
            hits.push(
                `${label}:${line}: 裸写 :has() —— 认不出它的浏览器（Firefox 111–120 / ESR115，` +
                    `基线是 firefox >= 111）会把**整条规则**丢掉，同组的兼容选择器一起失效。` +
                    `修法：单独成规则并放进 @supports selector(:has(*))，` +
                    `块外另留一条 :focus-within 兜底。`
            );
        }
        m = re.exec(src);
    }
    return hits;
}

function cssFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === "dist") continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith(".css")) out.push(full);
        }
    };
    walk(resolve(root, "src"));
    return out;
}

test("样式表里的 :has() 全部被 @supports selector(:has(*)) 保护", () => {
    const root = projectDir();
    const files = cssFiles(root);
    assert.ok(
        files.length >= 2,
        `只扫到 ${files.length} 个 css 文件 —— 扫描面配置错了，这条守卫会变成摆设`
    );

    const violations: string[] = [];
    for (const abs of files) {
        const rel = abs.slice(root.length + 1).split("\\").join("/");
        violations.push(...scanCss(readFileSync(abs, "utf8"), rel));
    }

    assert.deepEqual(violations, [], violations.join("\n"));
});

test("守卫真的会红：:has() 裸在普通规则里 / 裸在 @supports not 里都会被抓出来", () => {
    const bare = [
        ".a:hover .x,",
        ".b:has(:focus-visible) {",
        "    opacity: 1;",
        "}",
    ].join("\n");
    const hits = scanCss(bare, "probe.css");
    assert.equal(hits.length, 1, `应当抓到 1 处，实际 ${hits.length}：\n${hits.join("\n")}`);
    assert.ok(hits[0]?.includes("probe.css:2"), `错误应指向第 2 行，实际：${hits[0]}`);

    const inverted = ["@supports not selector(:has(*)) {", "    .b:has(x) { opacity: 1; }", "}"].join("\n");
    assert.equal(
        scanCss(inverted, "probe.css").length,
        1,
        "@supports 条件带 not 时，块内的 :has() 逻辑自相矛盾，必须判违规"
    );
});

test("守卫不会误报：@supports 保护内 / 注释里的 :has() 都不算", () => {
    const ok = [
        "/* 以前写过 .b:has(:focus-visible) 裸在这里，已迁移 */",
        ".a:focus-within {",
        "    outline: 2px solid red;",
        "}",
        "@supports selector(:has(*)) {",
        "    .a:focus-within:not(:has(:focus-visible)) {",
        "        outline: none;",
        "    }",
        "    .a:has(:focus-visible) {",
        "        outline: 2px solid red;",
        "    }",
        "}",
    ].join("\n");
    assert.deepEqual(scanCss(ok, "probe.css"), [], "这些写法都不该被判违规");
});

test("架构文档写明了 :has() / color-mix() 在基线之下的降级策略", () => {
    const root = projectDir();
    const arch = readFileSync(resolve(root, "docs/architecture.md"), "utf8");
    for (const token of [":has()", "color-mix()", "@supports"]) {
        assert.ok(
            arch.includes(token),
            `docs/architecture.md 必须写出 ${token} 的降级策略 —— 否则读文档的人会以为基线下这些特性是安全的`
        );
    }
});
