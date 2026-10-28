// tests/dialogConsistency.test.ts
// 弹窗与顶栏控件的一致性守卫（2026-10-25「全站视觉对齐」）。
//
// 为什么要守卫：这一轮把 33 个弹窗的标题/正文/操作区收进了 `components/dialogShell.ts`
// 的四个 sx 常量里，把 4 处 `window.confirm` 换成了站内 ConfirmDialog，
// 把顶栏圆角从写死的 14px 改成 `--header-radius` 派生。
// 前三件事**全都能被一次「顺手加了个新弹窗」悄悄破坏**：
//   · 新弹窗自己写 `sx={{ display: "flex", … }}` → 标题高低又不齐；
//   · 有人图快写 `window.confirm` → 系统弹窗又冒出来（它连主题都不跟）；
//   · 有人把 `borderRadius: "14px"` 写回顶栏 → 切「直角」档时又脱钩。
// 这些都不是功能 bug，测试跑不红、只有用户能看出来 —— 所以用静态守卫钉住。
//
// 判据都刻意用**结构性**特征（引用哪个常量、出现哪个 API），不比较具体像素值：
// 像素会合理变化，结构不该退化。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

/** 剥注释：本文件大量注释里写着「window.confirm」这类字样，不剥就是永远红的假警报 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            if (i < 0) return line;
            // 放过 "https://" 这类
            return line.slice(0, i).includes("://") ? line : line.slice(0, i);
        })
        .join("\n");
}

function tsxFiles(): string[] {
    const out: string[] = [];
    for (const dir of ["src/components", "src/components/notes", "src/hooks"]) {
        const full = path.join(ROOT, dir);
        let names: string[];
        try {
            names = readdirSync(full);
        } catch {
            continue;
        }
        for (const n of names) {
            if (n.endsWith(".tsx") || n.endsWith(".ts")) out.push(path.join(full, n));
        }
    }
    return out;
}

test("src 下不再出现 window.confirm / window.prompt（一律走站内 ConfirmDialog / NamePromptDialog）", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles()) {
        const src = stripComments(readFileSync(file, "utf8"));
        for (const api of ["window.confirm", "window.prompt"]) {
            if (src.includes(api)) offenders.push(`${path.relative(ROOT, file)} → ${api}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        "系统弹窗不跟主题、不能标危险色、说不出影响面；换成 ConfirmDialog（danger + impact）"
    );
});

test("每个 DialogTitle / DialogActions 都走 dialogShell 的公共 sx", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles()) {
        const src = stripComments(readFileSync(file, "utf8"));
        // 取每个标签从 "<DialogTitle" 到它自己的 ">" 之间的那段，检查有没有引用常量
        for (const tag of ["DialogTitle", "DialogActions"]) {
            const re = new RegExp(`<${tag}[\\s\\S]{0,400}?>`, "g");
            for (const m of src.matchAll(re)) {
                if (!m[0].includes(`${tag === "DialogTitle" ? "dialogTitleSx" : "dialogActionsSx"}`)) {
                    offenders.push(`${path.relative(ROOT, file)} → <${tag}> 没用公共 sx`);
                }
            }
        }
    }
    assert.deepEqual(offenders, [], "标题/操作区的内边距与字号必须来自 dialogShell，不再逐文件写");
});

test("弹窗纸面圆角不许写死（会脱离「圆角风格」设置）", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles()) {
        if (file.endsWith("dialogShell.ts")) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        // 只看 <Dialog …> 标签**自身属性**里的 paper 覆盖（Menu / Popover 的 paper 不在此列，
        // 它们的圆角是「浮层」那一档，允许走 --header-radius）
        const tags = src.matchAll(/<Dialog[\s\S]{0,1200}?>/g);
        for (const m of tags) {
            if (!/paper:\s*\{/.test(m[0])) continue;
            // ⚠️ 2026-10-25 补：只匹配「数字 / px 字面量」漏掉了三元写法 ——
            // NoteGraphDialog 曾用 `borderRadius: isNarrow ? 0 : 3` 悄悄绕过这条守卫，
            // 于是它在切圆角档时纹丝不动。现在只要 paper 里出现 borderRadius 且
            // 值里没有 var()，一律算写死。
            const lit = m[0].match(/borderRadius:\s*([^,}\n]+)/);
            if (lit && !/var\(/.test(lit[1])) {
                offenders.push(`${path.relative(ROOT, file)} → borderRadius: ${lit[1].trim()}`);
            }
        }
    }
    assert.deepEqual(offenders, [], "弹窗圆角由 theme 的 --card-radius 统一产出，单个弹窗别再覆盖");
});

test("顶栏控件的圆角走 --header-radius（constants 是唯一出口）", () => {
    const constants = readFileSync(path.join(ROOT, "src/constants.ts"), "utf8");
    assert.match(
        constants,
        /HEADER_RADIUS\s*=\s*"var\(--header-radius/,
        "HEADER_RADIUS 必须是 var(--header-radius, 14px) 派生，写死 14px 会让「直角」档只生效一半"
    );
    const search = readFileSync(path.join(ROOT, "src/components/HeaderSearchBox.tsx"), "utf8");
    assert.ok(
        !/borderRadius:\s*"\d+px"/.test(search),
        "导航页搜索框不许再写死圆角（曾散落 14 / 16 / 12 三个值）"
    );
});

test(":focus-visible 不许改元素圆角", () => {
    const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    const m = css.match(/:focus-visible\s*\{([^}]*)\}/);
    assert.ok(m, "全局焦点环规则必须还在");
    assert.ok(
        !/border-radius/.test(m![1]),
        "在 :focus-visible 里写 border-radius 会在聚焦瞬间把元素圆角改掉（22px 卡片会跳成 6px）"
    );
});

test("弹窗遮罩走 --scrim-modal（与抽屉的 --scrim 分离）", () => {
    const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    assert.match(css, /--scrim-modal:/, "弹窗遮罩要有自己的语义 token");
    const theme = readFileSync(path.join(ROOT, "src/hooks/useThemeController.ts"), "utf8");
    assert.match(
        theme,
        /MuiBackdrop:[\s\S]{0,200}var\(--scrim-modal\)/,
        "MuiBackdrop 必须取 --scrim-modal，否则各弹窗遮罩深度又会各写一套"
    );
});

test("关闭按钮的绝对定位必须在 Tooltip 的直接子元素上", () => {
    // 起因（2026-10-28 用户报「鼠标放到关闭按键时，文字提示位置错误」）：
    // Tooltip 的锚点是它的**直接子元素**。定位原先写在里面的 IconButton 上，
    // 外层 span 是 inline 静态元素，唯一的子元素又被抽出文档流 → span 塌成 0×0
    // 并停在文档流原处（标题文字右边），提示就跑到离按钮几百像素的地方。
    // 所以：定位必须落在 Tooltip 的直接子元素（那层 Box）上，IconButton 保持静态。
    const src = stripComments(
        readFileSync(path.join(ROOT, "src/components/DialogCloseButton.tsx"), "utf8")
    );

    const anchor = /<Tooltip[\s\S]*?<Box([\s\S]*?)>/.exec(src);
    assert.ok(anchor, "Tooltip 的直接子元素应该是那层 Box —— 它就是提示的锚点");
    assert.match(
        anchor![1],
        /position:\s*"absolute"/,
        "绝对定位要写在 Tooltip 的直接子元素上，否则提示会锚到塌陷的空盒子上"
    );

    const iconButton = /<IconButton([\s\S]*?)>/.exec(src);
    assert.ok(iconButton, "关闭按钮里应该有 IconButton");
    assert.ok(
        !/position:\s*"absolute"/.test(iconButton![1]),
        "定位不许写回 IconButton —— 那样 Tooltip 的锚点（外层 span）会塌成 0×0"
    );
});
