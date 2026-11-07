// tests/headerLayoutStability.test.ts
// 头部「零位移」契约守卫（静态源码检查）。
//
// ## 契约
// **头部盒子高度不随 headerCompact 变化（零位移）；收紧只允许改字形，不允许改盒高。**
//
// ## 为什么必须钉死
// 历史版本把三个间距都写成了三元：`gap: headerCompact ? 1 : 1.5`、
// `mb: headerCompact ? 2.5 : 3.5`、`pt: headerCompact ? 0 : 0.5`。
// 这三处一起收紧时头部盒子矮了约 21px → 整页文档高度少 21px → 滚动位置相对内容
// 整体平移 → 滚动条 thumb 重算、吸顶元素重新吸附、整个列表跳一下。
// 而间距是在**滚动过程中**翻转的，这次平移正好落在用户手指还在滚的时候，
// 用户看到的就是「网页一直在抖」。
//
// F1 给 headerCompact 加了 160/130 双阈值滞回，能防住「临界点逐帧翻面」的抽搐；
// 但滞回防不住那一次性的 21px 位移 —— **不产生位移**永远优于「产生位移再兜住」。
// 所以间距被拍平成常量，位移的源头直接去掉，视觉上的「收紧」由字号承担：
// 字号变化只改字形、行盒由 line-height 撑，盒子高度不变，因此零位移。
//
// ## 五条断言分别防什么
//   1. 三个间距行不得出现 headerCompact（防有人再把三元加回来 → 位移复发）
//   2. 具体数值必须拍在「常态」档（gap 1.5 / mb 3.5 / pt 0.5），
//      防有人「拍平了但拍成收紧档的值」→ 常态下头部白白矮 21px
//   3. 字号三元里的 headerCompact 必须还在（防有人连字号一起拍平 →
//      「收紧」这个视觉行为彻底消失，滚动时头部毫无反馈）
//   4. 死掉的 `transition: margin` 必须已经不在了，而真正还在动的
//      `transition: font-size` 必须还在（防有人保留误导性死声明 / 顺手把活的删了）
//   5. 紧凑态**不再通过 CSS 类表达**：`nav-header-compact` 在组件与 index.css
//      里都不得复活（该类 2026-11 已删，只剩一条 padding/background 死过渡）。
//      唯一表现是标题字号 —— 这是刻意的：盒高恒定是零位移的前提。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

const SOURCE_PATH = resolve(projectDir(), "src/components/SiteListHeader.tsx");
const RAW = readFileSync(SOURCE_PATH, "utf8");

const CSS_PATH = resolve(projectDir(), "src/index.css");
const CSS_RAW = readFileSync(CSS_PATH, "utf8");

/**
 * 把注释抹成等长空白（保留换行与索引/行号）。
 * 注释里举的 `transition: "margin .25s ease"` 这类反例不能被当成真实代码；
 * `.nav-header-compact` 也一样 —— 删除说明是写在注释里的。
 */
function blankComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, m => " ".repeat(m.length));
}

const SRC = blankComments(RAW);
/** 样式表同样先抹注释：留的「已删除」说明里就写着那个类名 */
const CSS = blankComments(CSS_RAW);

/** 从 `openIndex`（必须指向 `{`）开始做括号配对，返回含首尾花括号的整块源码 */
function sliceBraceBlock(src: string, openIndex: number): string {
    assert.strictEqual(src[openIndex], "{", "sliceBraceBlock 必须从花括号开始");
    let depth = 0;
    for (let i = openIndex; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return src.slice(openIndex, i + 1);
        }
    }
    throw new Error("花括号没闭合，源码结构变了？");
}

/** 取出头部容器（第一个 `sx={{ ... }}`）的样式块 */
function headerSxBlock(): string {
    const at = SRC.indexOf("sx={{");
    assert.notStrictEqual(at, -1, "找不到头部容器的 sx={{");
    // `sx={` 之后紧跟着对象字面量的 `{`
    return sliceBraceBlock(SRC, at + 3);
}

const BLOCK = headerSxBlock();
const BLOCK_LINES = BLOCK.split("\n");

/** 取样式块里所有以 gap / mb / pt 开头的属性行 */
const spacingLines = (): string[] => BLOCK_LINES.filter(line => /^\s*(gap|mb|pt):/.test(line));

test("间距三行（gap / mb / pt）都不含 headerCompact：头部盒高不随滚动变化", () => {
    const lines = spacingLines();
    assert.strictEqual(
        lines.length,
        3,
        `头部容器应该有 gap / mb / pt 三行间距属性，实际匹配到 ${lines.length} 行：${JSON.stringify(lines)}`
    );
    for (const line of lines) {
        assert.ok(
            !line.includes("headerCompact"),
            `间距不许跟随 headerCompact（会导致盒高变化 → 整页位移 → 滚动时抖）：${line.trim()}`
        );
    }
});

test("间距拍平在「常态」档的具体数值上（gap 1.5 / mb 3.5 / pt 0.5）", () => {
    const joined = spacingLines()
        .map(line => line.trim())
        .join(" ");
    // 拍平之后剩下的必须是**常态**那一档；拍成收紧档（1 / 2.5 / 0）会让头部常态就矮 21px
    assert.match(joined, /gap:\s*1\.5\b/, `gap 应为常态值 1.5，实际：${joined}`);
    assert.match(joined, /mb:\s*3\.5\b/, `mb 应为常态值 3.5，实际：${joined}`);
    assert.match(joined, /pt:\s*0\.5\b/, `pt 应为常态值 0.5，实际：${joined}`);
    assert.doesNotMatch(joined, /headerCompact/, "间距行整体不得出现 headerCompact");
});

test("字号三元里的 headerCompact 必须保留：收紧的视觉反馈只允许走字形", () => {
    const at = SRC.indexOf("fontSize: headerCompact");
    assert.notStrictEqual(at, -1, "字号那处三元被拍平了：滚动时头部将毫无视觉反馈（「收紧」行为消失）");

    // 把 fontSize 起到该属性结束（下一个 ,\n 之前的 400 字符窗口）截出来看三元是否完整
    const window = SRC.slice(at, at + 400);
    assert.match(window, /\bfontSize:\s*headerCompact/, "fontSize 的判定必须是 headerCompact 三元");
    assert.ok(window.includes("?"), "fontSize 应该是三元表达式（headerCompact ? 收紧档 : 常态档）");
    assert.ok(window.includes(":"), "fontSize 三元缺少「否则」分支");
    // 两档字号都还在：收紧档更小、常态档更大
    assert.match(window, /1\.25rem/, "收紧档字号（1.25rem）不见了");
    assert.match(window, /2rem/, "常态档字号（2rem）不见了");
});

test("死掉的 `transition: margin` 已删除，活的 `transition: font-size` 还在", () => {
    // 间距成了常量之后 margin 不可能再变化，这条过渡是死声明；
    // 留着会让后来人误以为「间距还在动、只是被滞回兜住了」，从而把滞回当成万能药。
    assert.doesNotMatch(
        SRC,
        /transition:\s*["'`]margin/,
        "margin/padding 已是常量，`transition: margin` 是死声明，应删除（注释里可举例，但代码里不许有）"
    );
    // 真正还在过渡的是标题字号：这是现在唯一的「收紧」动效，不能一起删掉
    const fontTransition = RAW.match(/transition:\s*["'`]font-size/);
    assert.ok(fontTransition, "标题的 `transition: font-size .25s ease` 不见了：收紧时会硬跳");
});

test("headerCompact 仍是活参数，且紧凑态不再通过 CSS 类表达", () => {
    // 契约：**紧凑态不再通过 CSS 类表达，唯一表现是标题字号；这是刻意的 ——
    // 盒高恒定是零位移的前提。** 原来的 `.nav-header-compact` 类只剩一条
    // padding/background 的死过渡（间距拍平后 padding 恒定，background 从未被改），
    // 2026-11 连同 `index.css` 里那条规则一起删掉了。谁把类挂回来，这里会红。

    // ① prop 本身没变成死参数：接口声明还在（字号三元由上面第 3 条覆盖）
    assert.match(SRC, /headerCompact:\s*boolean/, "props 接口里的 headerCompact 定义不见了");
    const uses = SRC.split("headerCompact").length - 1;
    assert.ok(uses >= 3, `headerCompact 出现次数过少（${uses}），prop 可能已成死参数`);

    // ② 组件里不许再出现这个类名（防止有人「顺手加个 class 方便调试」把死类挂回来）
    assert.doesNotMatch(
        SRC,
        /nav-header-compact/,
        "SiteListHeader 又挂上了 `nav-header-compact`：该类已删，紧凑态只许走字号"
    );

    // ③ 样式表里也不许再定义它 —— 否则删了组件侧却没删 CSS，死规则会一直躺在包里
    assert.doesNotMatch(
        CSS,
        /\.nav-header-compact\s*\{/,
        "index.css 里又出现了 `.nav-header-compact` 规则：它已是死代码，不该复活"
    );
});
