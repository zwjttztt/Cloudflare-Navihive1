// tests/settingsPaperOpaque.test.ts
// 契约守卫：**设置中心的纸面必须不透明**（2026-11，用户实测「点左侧导航键时右侧
// 内容区边缘出现一圈白色浮框」）。
//
// 为什么这个弹窗要被单独钉住：`components/dialogShell.ts` 的 `dialogPaperTokens`
// （= 全站 32 个弹窗的材质真源）给的是「毛玻璃 + 半透明底 + 22px 圆角」——
// `backdrop-filter: blur(var(--glass-blur)) saturate(1.4)` + `var(--surface-modal)`
// （rgba(255,255,255,.94)）。设置中心是全站**唯一**「左栏常驻 + 右栏整块切换」的
// 弹窗：每次切面板都会让右栏子树整体重绘，浏览器因此要把这块纸面重新提层、
// **重新采样一次背景**；重新采样那一帧里，22px 圆角的抗锯齿带把底下浅色页面漏成
// 一道白边。这不是配色口味问题，是合成层的固有缺陷 —— 只有「这块纸面不做
// backdrop-filter、底色不透明」能根治（不透明底 ⇒ 没有可采样的半透明过渡带）。
//
// 所以这里守卫的是一条**契约**，不是某几行代码的写法：
//   1. 这个弹窗的纸面必须显式关掉模糊（含 -webkit 前缀，Safari / iOS 只认那份），
//      且覆盖必须写在 `...dialogPaperTokens` **之后** —— 写在前面的键会被 token 盖掉，
//      看着改了其实没生效；
//   2. 底色必须来自主题的**不透明**色（`palette.background.paper`：亮 #fff /
//      暗 #121212），既不许写回半透明的 `var(--surface-modal)`，也不许硬编码色值
//      （写死 #fff 会让深色模式变成白底浅字）；
//   3. 别为了修这一个弹窗去改全站真源 —— `dialogPaperTokens` 必须还是毛玻璃。
//
// 分工：本文件是**静态**守卫（读源码，毫秒级、永不 OOM）；「这些样式真的被生成成
// CSS 了、并且真的赢了 theme styleOverrides」由 tests/settingsPaperOpaque.dom.test.tsx
// 挂真组件读样式表来证。两条都要绿才算守住。
import { test } from "node:test";
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
const SHELL = "src/components/settingsWorkspace/SettingsWorkspaceDialog.tsx";
const TOKENS = "src/components/dialogShell.ts";

/**
 * 剥掉注释再断言。
 *
 * 两个理由：注释里会写 `backdrop-filter` / `var(--surface-modal)` 这些 token 本身
 * （说明性文字），不剥会把「解释」当成「实现」；同时下面要按「谁在谁后面」判顺序，
 * 注释里的同名 token 会造成假命中。只剥整行 `//` 与块注释 —— 本文件要判的都是
 * 单行声明，行尾注释里不会出现它们。
 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

/** 取出 paper 的 sx 块：从 `...dialogPaperTokens` 到 `position: \"relative\"` */
function paperSxRegion(): string {
    const src = stripComments(readFileSync(path.join(ROOT, SHELL), "utf8"));
    const start = src.indexOf("...dialogPaperTokens");
    assert.ok(
        start > 0,
        `${SHELL} 里找不到 \`...dialogPaperTokens\`：纸面材质必须继续取自全站真源，别再各抄一份`
    );
    const end = src.indexOf('position: "relative"', start);
    assert.ok(
        end > start,
        `${SHELL} 的 paper sx 里找不到 \`position: "relative"\`（关闭按钮的定位基准）：结构变了，请更新本守卫的锚点`
    );
    return src.slice(start, end);
}

test("设置中心纸面：显式关掉模糊（含 -webkit 前缀），且覆盖写在 dialogPaperTokens 之后", () => {
    const region = paperSxRegion();

    const spreadAt = region.indexOf("...dialogPaperTokens");
    const blurOffAt = region.indexOf('backdropFilter: "none"');
    const webkitOffAt = region.indexOf('WebkitBackdropFilter: "none"');

    assert.ok(
        blurOffAt > 0,
        "设置中心的纸面没有 `backdropFilter: \"none\"`：毛玻璃会在换面板时被反复重新采样，" +
            "22px 圆角的抗锯齿带把底下浅色页面漏成一道白边（用户实测的白框）"
    );
    assert.ok(
        webkitOffAt > 0,
        "没有 `WebkitBackdropFilter: \"none\"`：Safari / iOS 只认带前缀那一份，" +
            "漏了它白框照旧（Chromium 的绿不代表真机没问题）"
    );
    assert.ok(
        blurOffAt > spreadAt,
        "`backdropFilter: \"none\"` 必须写在 `...dialogPaperTokens` **之后**：" +
            "同一份 sx 对象里前面的键会被展开的 token 盖掉 —— 看着改了，其实一点没生效"
    );
    assert.ok(
        webkitOffAt > spreadAt,
        "`WebkitBackdropFilter: \"none\"` 同样必须写在 `...dialogPaperTokens` 之后"
    );
});

test("设置中心纸面：底色不透明且来自主题，不许退回半透明 token / 硬编码色值", () => {
    const region = paperSxRegion();

    assert.ok(
        !region.includes('backgroundColor: "var(--surface-modal)"'),
        "纸面底色又写回了 var(--surface-modal)（rgba(255,255,255,.94)）：" +
            "半透明就是白框的成因本身，写回去等于把缺陷修回来"
    );
    assert.ok(
        region.includes("palette.background.paper"),
        "纸面底色必须取自主题的 `palette.background.paper`（亮 #fff / 暗 #121212，都**不透明**）：" +
            "换成 var() 会拿回半透明底，换成固定色则深色模式下变成白底浅字"
    );
    assert.doesNotMatch(
        region,
        /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/,
        "paper sx 里出现了十六进制色值：底色必须跟着主题走，不许硬编码"
    );
    assert.doesNotMatch(
        region,
        /\brgba?\(/,
        "paper sx 里出现了 rgb()/rgba() 字面量：底色必须跟着主题走，不许硬编码"
    );
});

test("全站真源不许被顺手改掉：dialogPaperTokens 仍是毛玻璃 + 半透明底", () => {
    const tokens = stripComments(readFileSync(path.join(ROOT, TOKENS), "utf8"));

    assert.match(
        tokens,
        /backdropFilter:\s*"blur\(/,
        `${TOKENS} 的 dialogPaperTokens 里 blur 没了：修设置中心不该把全站 32 个弹窗的玻璃一起关掉`
    );
    assert.match(
        tokens,
        /WebkitBackdropFilter:\s*"blur\(/,
        `${TOKENS} 的 dialogPaperTokens 里 -webkit 前缀那份 blur 没了：Safari / iOS 会退回不透明硬边`
    );
    assert.match(
        tokens,
        /backgroundColor:\s*"var\(--surface-modal\)"/,
        `${TOKENS} 的弹窗底色不再是 var(--surface-modal)：它是换肤的唯一开关，改成死值会让「换肤只改一处」失效`
    );

    // 真源里一旦出现 `none`，说明有人图省事在共享 token 上关玻璃 —— 那会连累
    // 所有弹窗，也说明本弹窗的局部覆盖失去了存在意义（守卫会跟着变松）。
    const blurLine = /backdropFilter:\s*"([^"]*)"/.exec(tokens);
    assert.ok(blurLine, "找不到 dialogPaperTokens 的 backdropFilter 取值");
    assert.notEqual(
        blurLine[1],
        "none",
        "dialogPaperTokens 的 backdropFilter 被改成了 none：关玻璃只能发生在设置中心那一个纸面上"
    );
});
