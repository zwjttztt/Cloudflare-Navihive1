// tests/settingsPaperOpaque.dom.test.tsx
// 「设置中心纸面不透明」的**运行时**证据（静态契约见 tests/settingsPaperOpaque.test.ts）。
//
// 静态守卫只能证明源码里写了 `backdrop-filter: none` 和主题底色；这条用例把真的
// 设置中心外壳挂起来，读 emotion 注入到 <head> 的样式规则，证明：
//   1. 那条覆盖**真的被生成成 CSS** 了（不是写了个没人用的属性）；
//   2. 它**真的赢了** theme 的 `MuiDialog.styleOverrides.paper`（同一份材质真源，
//      一旦顺序反了，浏览器看到的就是 blur + 半透明底，白框照旧）。
//
// 为什么要算「赢家」而不是直接断言样式文本里有没有 `none`：纸面同时命中两条**同级**
// 单类规则（theme styleOverrides 生成的 `.css-x-MuiDialog-paper` 与 sx 的类），
// 同特异性下**样式表里靠后者赢** —— 只有当 `none` / 不透明底是最后一条声明时才算数。
//
// ⚠️ 不读 getComputedStyle：jsdom 不做布局、不解析 var() 自定义属性，读 computed
//    会拿到空串（见 tests/notesMarkStyle.dom.test.tsx 的注释），那样写出来的「绿」
//    是假的。这里读规则文本自己算级联。
// ⚠️ jsdom 的 CSSOM 会**丢弃未知属性**：`-webkit-backdrop-filter` 解析后被扔掉，
//    读不到 ≠ 没写 —— 前缀那一份由静态守卫兜住，两条一起才算全。
// ⚠️ 不要在这条用例里反复切面板：jsdom 下连切几次会把堆打爆（见
//    tests/navigationCenter.dom.test.tsx「摊平后的面板」那条的注释）。这里只挂
//    **一次**外壳、零面板切换 —— 白框是纸面材质的事，跟切几次无关。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import SettingsWorkspaceDialog from "../src/components/settingsWorkspace/SettingsWorkspaceDialog";
import { dialogPaperTokens } from "../src/components/dialogShell";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/**
 * 复刻线上主题里的弹窗材质：直接取 dialogPaperTokens 铺进
 * `MuiDialog.styleOverrides.paper`，不抄值 —— 抄值的话哪天 token 改了，这条用例
 * 就变成「验一个已经不存在的前提」，永远绿。
 */
function makeTheme() {
    return createTheme({
        components: {
            MuiDialog: {
                styleOverrides: {
                    paper: { ...dialogPaperTokens },
                },
            },
        },
    });
}

async function mountShell() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(
            <ThemeProvider theme={makeTheme()}>
                <SettingsWorkspaceDialog
                    open
                    onClose={() => undefined}
                    title='设置'
                    nav={<div data-workspace-nav='stats'>统计</div>}
                    actions={
                        <button type='button' data-test-action='1'>
                            完成
                        </button>
                    }
                >
                    <div data-workspace-panel='1'>面板内容</div>
                </SettingsWorkspaceDialog>
            </ThemeProvider>
        );
        await new Promise(r => setTimeout(r, 0));
    });
}

async function cleanup() {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    document.body.innerHTML = "";
}

/**
 * 取出注入到 <head> 的全部样式，按注入顺序拼起来。
 *
 * emotion 在测试环境走 speedy 模式（用 insertRule，textContent 是空的），所以主路径
 * 是 CSSOM；非 speedy 时退回 textContent。
 */
function injectedCss(): string {
    const parts: string[] = [];
    for (const tag of [...document.head.querySelectorAll("style")]) {
        const sheet = tag.sheet as CSSStyleSheet | null;
        if (sheet) {
            const rules: string[] = [];
            for (let i = 0; i < sheet.cssRules.length; i++) {
                rules.push(sheet.cssRules[i].cssText);
            }
            if (rules.length) {
                parts.push(rules.join("\n"));
                continue;
            }
        }
        const text = tag.textContent || "";
        if (text.trim()) parts.push(text);
    }
    return parts.join("\n");
}

/**
 * 算出「这个元素最终生效的那几条声明」。
 *
 * 只看命中元素自身类名的规则；同一条规则内同名属性后者覆盖前者，跨规则按样式表
 * 出现顺序覆盖（同级特异性下后者赢）。`@media` 里嵌套的规则会被当成无条件的 ——
 * 这些媒体查询里只有 margin / overflow / box-shadow，不影响本用例断言的两个属性。
 */
function winningDeclarations(css: string, classNames: string[]): Map<string, string> {
    const winners = new Map<string, string>();
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
        const selector = match[1];
        const body = match[2];
        if (!classNames.some(cls => cls && selector.includes(`.${cls}`))) continue;
        for (const decl of body.split(";")) {
            const idx = decl.indexOf(":");
            if (idx < 0) continue;
            const prop = decl.slice(0, idx).trim().toLowerCase();
            const value = decl.slice(idx + 1).trim();
            if (!prop || !value) continue;
            winners.set(prop, value);
        }
    }
    return winners;
}

/** 不透明色判定：hex（3/6 位，或 8 位且 alpha 全 ff）/ rgb() / 无 alpha 的 rgba() */
function isOpaqueColor(value: string): boolean {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    if (v === "transparent" || v === "none" || v === "initial" || v === "inherit") return false;
    // var() 解析不到实际取值：宁可红，也不写一条验不出东西的「绿」
    if (v.includes("var(")) return false;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
    if (hex) return hex[1].length !== 8 || hex[1].slice(6) === "ff";
    const fn = /^rgba?\(([^)]+)\)$/.exec(v);
    if (fn) {
        const parts = fn[1]
            .split(/[,/\s]+/)
            .map(s => s.trim())
            .filter(Boolean);
        if (parts.length === 0) return false;
        return parts.length < 4 || Number(parts[3]) >= 1;
    }
    // hsl / color-mix / 命名色：都不认（要放宽得先能证明它真的不透明）
    return false;
}

test("设置中心纸面：运行时真的没有模糊、底色真的不透明（切面板不再重采样背景）", async t => {
    t.after(cleanup);
    await mountShell();

    const paper = document.querySelector<HTMLElement>(".MuiDialog-paper");
    assert.ok(paper, "设置中心没渲染出 .MuiDialog-paper —— 外壳挂载失败，后面无从断言");

    const css = injectedCss();
    assert.ok(css.length > 0, "emotion 没往 <head> 注入任何样式，读不到材质就断言不了任何事");

    const winners = winningDeclarations(css, [...paper.classList]);
    assert.ok(winners.size > 0, "没有任何规则命中纸面的类名：样式表结构变了，这条用例需要重写");

    // 前提校验：命中的确实是「共享弹窗材质」那条规则（圆角仍取 token）——
    // 否则下面读到的可能是别的元素 / 别的规则，断言就失去意义。
    const radius = winners.get("border-radius") ?? "";
    assert.match(
        radius,
        /var\(--card-radius\)/,
        `纸面没拿到共享材质的圆角（当前 "${radius}"）：命中的规则不是材质那条`
    );

    assert.equal(
        winners.get("backdrop-filter"),
        "none",
        "设置中心纸面的 backdrop-filter 必须真的关成 none：" +
            "只要还留着 blur()，换面板就会触发一次背景重采样，圆角处漏亮色页面（用户实测的白框）"
    );

    const bg = (winners.get("background-color") ?? "").replace(/\s+/g, "");
    assert.ok(
        bg !== "",
        "纸面没有任何 background-color 生效：透明底 + 圆角 = 白框，必须给不透明底色"
    );
    assert.notEqual(
        bg,
        "var(--surface-modal)",
        "底色不许退回 var(--surface-modal)（rgba(255,255,255,.94)）：半透明就是白框的成因本身"
    );
    assert.ok(
        isOpaqueColor(bg),
        `纸面底色必须是不透明色（当前解析到 "${bg}"）：带 alpha 的底色会让圆角边缘继续漏出后面的页面`
    );

    // 这条只改材质：无障碍钩子不许被顺手删掉（aria-labelledby 必须留在 paper 插槽上，
    // 写在 <Dialog> 顶层会落到 Modal 根，读屏拿不到弹窗名字）。
    assert.ok(
        paper.getAttribute("aria-labelledby"),
        "纸面的 aria-labelledby 丢了：改材质不该动无障碍钩子"
    );
    assert.ok(
        document.querySelector("[data-workspace-panel]"),
        "面板内容没渲染：外壳结构被改坏了"
    );
});
