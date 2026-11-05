// tests/copyBlockTokens.test.ts
// `> [!COPY]` 方案三新增的那几组配色的**对比度守卫**。
//
// 为什么要单独立一条而不是塞进 audit:contrast：
//   · `script/auditEnv.mjs` 的种子笔记里没有 COPY 块，审计那 18 段根本走不到新配色，
//     「0 处不合格」对这组颜色不构成证据；
//   · 但**不能**往种子里加 COPY 块 —— 同一份种子同时喂 audit:visual，加进去会造出
//     一大片新基线漂移，唯一能变绿的办法是 `audit:visual --update`，那会把观察期里
//     已知的 10 处漂移一起烧进基线（待查清单被清零）。代价远大于收益。
//   · 所以：单测直接量，且量的是**同一份数学、同一份颜色源**。
//
// ⚠️ 数学只有一份：`CONTRAST_CORE` 是 audit:contrast 注入页面的那段源码，返回的
//    NH 对象已经暴露 `ratio`（script/auditEnv.mjs:891）。这里用 `new Function` 把
//    同一份源码求值，**不重写亮度公式** —— 抄一份就等着两天后两个结论打架。
//    模板体在定义时不碰 DOM（只有 `refresh` / `bgBehind` 内部才碰），所以纯函数
//    测试（无 jsdom）也跑得动。先例见 tests/a11yNamedRules.dom.test.tsx。
// ⚠️ 颜色只有一个真源：全部从 src/index.css 的 :root / .dark 块里读变量声明，
//    不硬编码任何十六进制。改了 CSS，这里立刻用新值重算 —— 不会出现「改了样式
//    测试照样绿」。唯二的常量是两档**纸面底色**（见 PAPER 注释），那是审计自己量到的
//    页面背景，不是本次新增的颜色。
//
// 判据（2026-11-05 团队决定，对应 redesign 报告里的两条披露）：
//   · 静止虚线保留 0.28「1px 浅灰虚线」的用户指定视觉，**不调深**。WCAG 1.4.11
//     的 3:1 缺口如实记录：片段与正文不靠颜色区分（等宽字形 + cursor:copy +
//     悬停气泡 + 可访问名「复制：xxx」），不构成「仅靠颜色」。
//     这里钉的是「已经这么淡了，不许再淡」：亮色 ≥1.80、暗色 ≥3.00。
//   · 气泡 / 悬停 / 已复制都是 11px 小字，按 WCAG AA 正文 4.5:1 判，不给大字号豁免。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CONTRAST_CORE } from "../script/auditEnv.mjs";
import { indexCssRules, stripCssComments } from "./helpers/cssRules";

interface NHCore {
    /** 唯一允许的亮度/对比度实现来源 */
    ratio: (fg: number[], bg: number[]) => number;
    /** 解析 rgb()/rgba()/color() 为 0~255 三元组 */
    parse: (color: string) => number[] | null;
    /** 取颜色里的 alpha（没写就是 1） */
    alphaOf: (color: string) => number;
}

// ⚠️ 若这行因为模板转义等原因抛错，**不要**在测试里另写一份公式绕过去 ——
//    那正好毁掉这条用例的全部价值，应当回来改方案（见文件头）。
const NH = new Function(`${CONTRAST_CORE}; return NH;`)() as NHCore;

function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

const css = stripCssComments(readFileSync(resolve(findProjectDir(), "src", "index.css"), "utf-8"));
const RULES = indexCssRules(css);

/** 取某个选择器块里的全部变量声明（同名多次出现时后写的覆盖先写的） */
function varsOf(selector: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const rule of RULES) {
        if (rule.selector !== selector || rule.media !== "") continue;
        for (const hit of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
            out.set(hit[1], hit[2].trim());
        }
    }
    return out;
}

const LIGHT_VARS = varsOf(":root");
const DARK_VARS = new Map([...LIGHT_VARS, ...varsOf(".dark")]);

interface Theme {
    name: string;
    vars: Map<string, string>;
    /** 纸面底色：audit:contrast 自己量到的页面背景（白底 / rgb(18,18,18)） */
    paper: number[];
    /** 静止虚线允许的下限 —— 「不许再淡」 */
    minRule: number;
    /** 静止虚线允许的上限 —— 「也不许擅自调深，用户要的是浅灰」 */
    maxRule: number;
}

const THEMES: readonly Theme[] = [
    { name: "亮色", vars: LIGHT_VARS, paper: [255, 255, 255], minRule: 1.80, maxRule: 2.30 },
    { name: "暗色", vars: DARK_VARS, paper: [18, 18, 18], minRule: 3.00, maxRule: 3.60 },
];

/** 颜色的唯一入口：只认从 index.css 读出来的值 */
function token(theme: Theme, name: string): string {
    const value = theme.vars.get(name);
    assert.ok(value, `index.css 的 ${theme.name} 档里找不到 ${name}（颜色不许硬编码在测试里）`);
    return value!;
}

/**
 * 把十六进制 / rgb() / rgba() 统一成 { rgb, a }。
 * ⚠️ 这里只做**语法**转换，亮度公式一行都没有 —— 唯一的数学在 NH.ratio 里。
 *    为什么还用得上十六进制转换：--md-copy-tip-bg 这类 token 在 index.css 里写成
 *    #1f2937，而 audit 的 NH.parse 只认 rgb()/color() 形式。
 */
function toRgba(value: string): { rgb: number[]; a: number } {
    const raw = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (hex) {
        const full = hex[1].length === 3
            ? hex[1].split("").map(c => c + c).join("")
            : hex[1];
        return {
            rgb: [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16)),
            a: 1,
        };
    }
    const rgb = NH.parse(raw);
    assert.ok(rgb && rgb.length >= 3, `解析不出颜色：${raw}`);
    return { rgb: rgb!.slice(0, 3), a: NH.alphaOf(raw) };
}

/** 把带 alpha 的一层压到底色上（纯合成，不含任何亮度计算） */
function over(color: string, backdrop: number[]): number[] {
    const { rgb, a } = toRgba(color);
    return rgb.map((v, i) => v * a + backdrop[i] * (1 - a));
}

test("对比度数学必须来自 audit:contrast 的同一份 CONTRAST_CORE", () => {
    assert.equal(typeof NH.ratio, "function", "CONTRAST_CORE 没暴露 ratio —— 别在这里另写一份公式，回去改方案");
    // 白 / 黑 = 21:1 是 WCAG 的定义值：钉住「拿到的确实是那份实现」，
    // 而不是一个恰好返回 true 的桩。
    assert.ok(
        Math.abs(NH.ratio([255, 255, 255], [0, 0, 0]) - 21) < 0.01,
        "NH.ratio 的白/黑基准不是 21:1，说明数学来源已经漂了"
    );
    // 颜色也必须是「从 CSS 读出来的」：亮暗两档的气泡底色应当不同（反相），
    // 硬编码一份常量的话这条会先红。
    assert.notEqual(
        token(THEMES[0], "--md-copy-tip-bg"),
        token(THEMES[1], "--md-copy-tip-bg"),
        "亮/暗两档的气泡底色没有分开（.dark 覆盖没读到？）"
    );
});

test("静止虚线：亮色 ≥1.80 / 暗色 ≥3.00，且不许调深成深灰虚线", () => {
    for (const theme of THEMES) {
        const line = over(token(theme, "--md-copy-frag-rule"), theme.paper);
        const ratio = NH.ratio(line, theme.paper);
        assert.ok(
            ratio >= theme.minRule,
            `${theme.name}静止虚线只有 ${ratio.toFixed(2)}:1（下限 ${theme.minRule}）—— ` +
                "0.28 已经是用户指定的「浅灰」下限，再淡就看不见哪一段能复制了"
        );
        assert.ok(
            ratio <= theme.maxRule,
            `${theme.name}静止虚线涨到 ${ratio.toFixed(2)}:1（上限 ${theme.maxRule}）—— ` +
                "别擅自把 alpha 抬到 0.48 去凑 WCAG 1.4.11：那是把用户确认的视觉换成深灰线，需要重新拍板并同步改这条守卫"
        );
    }
});

test("新增视觉面的文字：气泡 / 悬停浅蓝底 / 已复制浅绿底，亮暗两档都 ≥4.5", () => {
    for (const theme of THEMES) {
        const cases: ReadonlyArray<{ name: string; foreground: string; background: string }> = [
            {
                name: "气泡「⧉ 点击复制」（11px）",
                foreground: token(theme, "--md-copy-tip-fg"),
                background: token(theme, "--md-copy-tip-bg"),
            },
            {
                name: "片段悬停浅蓝底上的正文",
                foreground: token(theme, "--text-primary"),
                background: token(theme, "--callout-note-bg"),
            },
            {
                name: "片段已复制浅绿底上的正文",
                foreground: token(theme, "--text-primary"),
                background: token(theme, "--callout-tip-bg"),
            },
        ];
        for (const item of cases) {
            const paintedBg = over(item.background, theme.paper);
            const paintedFg = over(item.foreground, paintedBg);
            const ratio = NH.ratio(paintedFg, paintedBg);
            assert.ok(
                ratio >= 4.5,
                `${theme.name}·${item.name} 只有 ${ratio.toFixed(2)}:1 < 4.5 —— ` +
                    "11px 小字按 AA 正文判，没有大字号豁免档"
            );
        }
    }
});
