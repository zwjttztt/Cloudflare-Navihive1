// tests/mediaBreakpoints.test.ts
// 断点守卫：CSS 里不许再冒出「不在名单里的宽度数字」。
//
// 为什么需要这条守卫：`src/index.css` 读不到 TS 常量（CSS 没有 import），
// 所以真源 `src/theme/mediaQueries.ts` 和 CSS 里的字面量**必然**有两份。
// 这两份曾经漂到 5 个不同的小数尾巴：359.98 / 599.95 / 599.98 / 899.95 / 899.98，
// 其中 899.95 与 899.98 那一对是真 bug —— 「横屏矮屏弹窗高度」按 899.95 判、
// 「底栏出现」按 899.98 判，899.96~899.98 这 0.03px 的带子里，底栏已经出来了，
// 弹窗却还按大屏算高度。这类漂移**没有视觉回归能抓到**（差 0.03px，且只在
// 特定视口宽出现），只能靠对比两边的数字。
//
// 这条用例做三件事：
//   1. 抽出 `src/index.css` 里所有 `max-width` / `min-width` 的 px 字面量，
//      逐个比对 `mediaQueries.ts` 导出的常量集合 —— 多一个就红；
//   2. 断言三条核心档位「确实还在 CSS 里被用着」（防止有人删了 @media 段）；
//   3. 断言 `script/ci-smoke.mjs` 里的 matchMedia 字面量也在同一个集合里
//      （mjs 引不到 TS，只能写字面量，这里替它守门）。
//
// 白名单（允许出现在 CSS / mjs 里的宽度值）及其用途：
//   · 599.95  ← QUERY_BELOW_600        小屏底部面板 / 92dvh / safe-area 让位
//   · 899.98  ← QUERY_BELOW_900        横屏矮屏弹窗高度；mjs 的 qBar 诊断
//   · 359.98  ← QUERY_BELOW_360        超窄屏再收一层内边距
//   · 900     ← QUERY_AT_LEAST_900     与 899.98 互补（mjs 的 qGroups 下界）
//   · 1343.98 ← QUERY_COMPACT_DESKTOP  窄桌面区间上界（mjs 的 qGroups 上界）
//   · 1344    ← QUERY_GROUP_RAIL_MIN   左侧分组栏出现（mjs 的 qRail）
//
// ⚠️ 新增一个合法档位时，**先**往媒体查询真源里加常量，再改 CSS。
// 只是把数字塞进下面的白名单，等于把守卫改成摆设。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    QUERY_BELOW_600,
    QUERY_BELOW_900,
    QUERY_BELOW_360,
    QUERY_AT_LEAST_900,
    QUERY_COMPACT_DESKTOP,
    QUERY_GROUP_RAIL_MIN,
    QUERY_LANDSCAPE_SHORT,
} from "../src/theme/mediaQueries";

/** 单测会被 esbuild 复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
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

const ROOT = findProjectDir();

/** 读文件，读不到返回 null（可选断言用，缺文件不该制造假红） */
function readOptional(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** 宽度字面量：只认 `max-width` / `min-width` 的 px 值（`max-height` / `%` 不算） */
const WIDTH_PX_RE = /(?:max|min)-width\s*:\s*([\d.]+)px/g;

/** 把一段文本里所有宽度 px 字面量抽成去重后的字符串集合（保留字面写法，便于报错） */
function widthLiterals(text: string): Set<string> {
    const found = new Set<string>();
    for (const m of text.matchAll(WIDTH_PX_RE)) {
        const value = m[1];
        if (value !== undefined) found.add(value);
    }
    return found;
}

/** 真源里声明的全部查询串 —— 白名单就是从这里算出来的，不在这里再抄一遍数字 */
const DECLARED_QUERIES: ReadonlyArray<readonly [string, string]> = [
    ["QUERY_BELOW_600", QUERY_BELOW_600],
    ["QUERY_BELOW_900", QUERY_BELOW_900],
    ["QUERY_BELOW_360", QUERY_BELOW_360],
    ["QUERY_AT_LEAST_900", QUERY_AT_LEAST_900],
    ["QUERY_COMPACT_DESKTOP", QUERY_COMPACT_DESKTOP],
    ["QUERY_GROUP_RAIL_MIN", QUERY_GROUP_RAIL_MIN],
];

/** 允许出现的宽度值 → 它对应的常量名（报错时能直接指出该用哪个名字） */
const ALLOWED = new Map<string, string>();
for (const [name, query] of DECLARED_QUERIES) {
    for (const literal of widthLiterals(query)) {
        ALLOWED.set(literal, name);
    }
}

test("index.css 里没有超出媒体的宽度档位", () => {
    const css = readFileSync(resolve(ROOT, "src/index.css"), "utf8");
    const inCss = [...widthLiterals(css)];
    // 至少得抽到东西：正则或文件结构变了要立刻知道，而不是「空对空」绿着
    assert.ok(inCss.length > 0, "没能从 src/index.css 里抽到任何宽度字面量，守卫正则已失效");

    const unknown = inCss.filter(v => !ALLOWED.has(v));
    assert.deepEqual(
        unknown,
        [],
        `src/index.css 出现了不在 src/theme/mediaQueries.ts 里的宽度档位：${unknown.join(", ")}px。\n` +
            `请先把常量加进媒体查询真源，再让 CSS 用它；允许的取值只有：` +
            [...ALLOWED.entries()].map(([v, n]) => `${v}px(${n})`).join(" / ")
    );
});

test("三条核心档位仍然真的被 CSS 用着（防止整段 @media 被误删）", () => {
    const css = readFileSync(resolve(ROOT, "src/index.css"), "utf8");
    const inCss = widthLiterals(css);
    const expected: ReadonlyArray<readonly [string, string]> = [
        ["599.95", "QUERY_BELOW_600（小屏底部面板）"],
        ["899.98", "QUERY_BELOW_900（横屏矮屏弹窗高度）"],
        ["359.98", "QUERY_BELOW_360（超窄屏内边距）"],
    ];
    for (const [literal, purpose] of expected) {
        assert.ok(
            inCss.has(literal),
            `src/index.css 里找不到 ${literal}px —— ${purpose} 那一段是不是被删了或改了值？`
        );
    }
});

test("手写档位与 MUI 边界的关系没被改坏", () => {
    // MUI 的 down('sm') 是 600 − 0.05：`.95` 尾巴不是随便挑的
    assert.equal(QUERY_BELOW_600, "(max-width: 599.95px)");
    // `.98` 那一族的互补上界必须是整数下沿减 0.02（吃掉 899.5 / 1343.5 这类亚像素宽）
    assert.equal(Number((899.98 + 0.02).toFixed(2)), 900);
    assert.equal(Number((1343.98 + 0.02).toFixed(2)), 1344);
    // 三个互补对上界/下界必须逐位相等（否则中间会留一条「两套样式都不生效」的缝）
    assert.equal(QUERY_AT_LEAST_900, "(min-width: 900px)");
    assert.equal(QUERY_GROUP_RAIL_MIN, "(min-width: 1344px)");
    assert.equal(QUERY_COMPACT_DESKTOP, "(min-width: 900px) and (max-width: 1343.98px)");
    // 横屏矮屏段的宽度门槛必须与「底栏出现」同一个值
    // （这条曾经漂成 899.95，899.96~899.98 上底栏出来了但弹窗还按大屏算高度）
    assert.deepEqual(
        [...widthLiterals(QUERY_LANDSCAPE_SHORT)],
        [...widthLiterals(QUERY_BELOW_900)],
        "横屏矮屏段的宽度门槛必须等于 QUERY_BELOW_900"
    );
});

test("ci-smoke 的 matchMedia 字面量与常量一致（读不到就跳过）", () => {
    const smoke = readOptional(resolve(ROOT, "script/ci-smoke.mjs"));
    if (smoke === null) {
        // 脚本被挪走 / 拆分了：不值得让这条守卫制造假红，交给 ci-smoke 自己那几条用例
        return;
    }
    // 只取 matchMedia('...') 里的查询串，避免把注释里的举例算进去
    const queries: string[] = [];
    for (const m of smoke.matchAll(/matchMedia\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const query = m[1];
        if (query !== undefined) queries.push(query);
    }
    assert.ok(queries.length > 0, "没能从 script/ci-smoke.mjs 里抽到任何 matchMedia 查询串");

    const offenders: string[] = [];
    for (const query of queries) {
        for (const literal of widthLiterals(query)) {
            if (!ALLOWED.has(literal)) offenders.push(`${literal}px（来自 ${query}）`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        "script/ci-smoke.mjs 里的断点字面量与 src/theme/mediaQueries.ts 不一致：" +
            offenders.join("; ") +
            `。允许的取值：${[...ALLOWED.keys()].join(", ")}px`
    );
});
