// tests/notesRadiusTokens.test.ts
// 记事本圆角必须**派生自 --card-radius**（2026-10-25 视觉对齐）。
//
// 为什么要钉：用户能在「外观 → 圆角风格」里选柔和(22) / 标准(14) / 直角(6)。
// 记事本曾经把圆角写死成 12 / 10 / 8px —— 切到直角档后，导航卡是 6px、
// 记事本还是 12px，同一个站点看起来像两个产品。修法是三个派生变量
// （--notes-radius-row / -chip / -block），并在组件里一律走变量。
//
// 这组用例守两件事：
//   1. index.css 里那三行派生定义不能被「清理」掉（删了变量会静默回落到 fallback，
//      不报错、但圆角风格又脱钩了 —— 属于最难发现的那类退化）；
//   2. 记事本组件里不许再出现写死的行/按钮圆角字面量。

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
const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            return i >= 0 && !line.slice(0, i).includes("http") ? line.slice(0, i) : line;
        })
        .join("\n");
}

test("index.css 定义了三个派生圆角变量，且都建立在 --card-radius 上", () => {
    for (const name of ["--notes-radius-row", "--notes-radius-chip", "--notes-radius-block"]) {
        const re = new RegExp(`${name}:\\s*calc\\(\\s*var\\(--card-radius\\)`);
        assert.match(css, re, `${name} 必须是 calc(var(--card-radius) * k)，否则圆角风格又脱钩`);
    }
});

test("--card-radius 本身仍由设置写入的三档决定（22 / 14 / 6）", () => {
    // 三档值在 uiPrefsStore 里，这里只确认变量名没被改名（改名会让所有卡片失去圆角）
    assert.match(css, /--card-radius:\s*22px/, "默认档 22px 的兜底必须留着");
    const store = readFileSync(path.join(ROOT, "src/context/uiPrefsStore.ts"), "utf8");
    for (const px of ["22px", "14px", "6px"]) {
        assert.ok(store.includes(`"${px}"`), `圆角档位里少了 ${px}`);
    }
});

test("记事本组件里不再有写死的行 / 按钮圆角字面量", () => {
    const dir = path.join(ROOT, "src/components/notes");
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
        if (!file.endsWith(".tsx")) continue;
        const src = stripComments(readFileSync(path.join(dir, file), "utf8"));
        // MUI 的 borderRadius: 1.5 / 1.25 = 12px / 10px，曾散落在行与按钮上
        for (const bad of [/borderRadius:\s*1\.5\s*,/, /borderRadius:\s*1\.25\s*,/, /borderRadius:\s*"8px"/]) {
            if (bad.test(src)) offenders.push(`${file} → ${bad}`);
        }
    }
    assert.deepEqual(offenders, [], "写死圆角会绕过 --card-radius，请改用 var(--notes-radius-*)");
});

test("关键容器真的引用了派生变量（行 / 左栏 / 工具按钮 / 正文块）", () => {
    const list = readFileSync(path.join(ROOT, "src/components/notes/NotesListPane.tsx"), "utf8");
    assert.ok(list.includes("var(--notes-radius-row"), "笔记列表行要走 --notes-radius-row");

    const side = readFileSync(path.join(ROOT, "src/components/notes/sidebarSection.tsx"), "utf8");
    assert.ok(side.includes("var(--notes-radius-chip"), "左栏行要走 --notes-radius-chip");

    const bar = readFileSync(path.join(ROOT, "src/components/notes/markdownToolbar.tsx"), "utf8");
    assert.ok(bar.includes("var(--notes-radius-chip"), "格式工具栏按钮要走 --notes-radius-chip");

    const md = readFileSync(path.join(ROOT, "src/utils/markdownToReact.tsx"), "utf8");
    assert.ok(md.includes("var(--notes-radius-block"), "代码块 / 引用 / 内容块要走 --notes-radius-block");
});
