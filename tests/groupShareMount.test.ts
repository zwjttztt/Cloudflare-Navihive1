// 分组分享对话框挂载位置守卫。
//
// 为什么非得写个测试：2026-10-11 GUI 复测发现点「分享分组」永远弹不出对话框，
// 根因是 GroupShareDialog 的挂载 JSX 被误嵌进了 `{showOfflineBanner && <ChunkBoundary>}`
// 里 —— 在线时 showOfflineBanner 恒为 false，整块根本不渲染。类型检查、lint、
// 单测全绿（JSX 嵌套在语法上完全合法），只有真机点击才会暴露。
//
// 类型检查抓不到这个：条件渲染嵌套条件渲染是合法 JSX。所以在这里把「挂载位置」钉死：
// 谁再把这块挪进任何条件渲染里，这条会红。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function findRepoRoot(from: string): string {
    let dir = from;
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error("找不到仓库根（一路向上都没有 package.json）");
        dir = up;
    }
}

const APP = path.join(
    findRepoRoot(path.resolve(process.argv[1] ?? ".", "..")),
    "src",
    "App.tsx"
);

// 2026-11（D6 拆 App.tsx）：顶部那一排浮层整块搬进了 components/app/AppOverlays.tsx，
// GroupShareDialog 的挂载 JSX 跟着挂载点走了。守卫于是跟到新文件 —— 但**同时**要求
// App.tsx 里真的在渲染 <AppOverlays />，否则这几条断言就可能对着一个孤儿文件跑空
// （那才是最坏的情况：守卫还绿着，对话框其实早就不在树上了）。
const OVERLAYS = path.join(
    findRepoRoot(path.resolve(process.argv[1] ?? ".", "..")),
    "src",
    "components",
    "app",
    "AppOverlays.tsx"
);

/** 剥注释（与 lazyBoundary.test.ts 同一纪律：注释里的代码字样不能参与匹配） */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** 读「当前挂着 GroupShareDialog 的那个文件」，顺手确认它还接在 App 的渲染树上 */
function readMountSource(): string {
    const app = stripComments(fs.readFileSync(APP, "utf8"));
    assert.ok(
        app.includes("<AppOverlays"),
        "App.tsx 里没有渲染 <AppOverlays /> —— 挂载块被搬走却没接回去，" +
        "下面几条断言会跑空（对话框其实已经不在树上了）"
    );
    return fs.readFileSync(OVERLAYS, "utf8");
}

test("GroupShareDialog 挂载块不得嵌在 showOfflineBanner 条件渲染里", () => {
    const text = stripComments(readMountSource());

    // 定位 showOfflineBanner 条件块：从 `{showOfflineBanner` 起做花括号配对
    const start = text.indexOf("{showOfflineBanner");
    assert.ok(start >= 0, "AppOverlays.tsx 里找不到 showOfflineBanner 条件（改名了就同步改这里）");
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    assert.ok(end > start, "showOfflineBanner 条件块花括号不配对？");

    const bannerBlock = text.slice(start, end + 1);
    assert.ok(
        !bannerBlock.includes("GroupShareDialog"),
        "GroupShareDialog 的挂载 JSX 被嵌进了 showOfflineBanner 条件渲染里 —— " +
        "在线时横幅不显示，这个对话框就永远弹不出来（2026-10-11 真实事故）。" +
        "把它移到与 showOfflineBanner 平级的位置。"
    );
    assert.ok(
        !bannerBlock.includes("shareGroupId"),
        "shareGroupId 相关渲染逻辑被嵌进了 showOfflineBanner 条件渲染里（同上，移出去）"
    );
});

test("GroupShareDialog 挂载条件仍存在于顶层渲染里（防测试跑空/被删）", () => {
    // readMountSource 会先确认 App.tsx 真的在渲染 <AppOverlays />，再返回挂载块所在文件
    const text = stripComments(readMountSource());
    const start = text.indexOf("{showOfflineBanner");
    let end = start > 0 ? start + text.slice(start).length : text.length;
    if (start >= 0) {
        let d = 0;
        for (let i = start; i < text.length; i++) {
            if (text[i] === "{") d++;
            else if (text[i] === "}") { d--; if (d === 0) { end = i; break; } }
        }
    }
    const outside = text.slice(0, start >= 0 ? start : text.length) +
        text.slice(Math.min(end + 1, text.length));
    assert.ok(
        outside.includes("shareGroupId !== null") && outside.includes("GroupShareDialog"),
        "顶层找不到 GroupShareDialog 挂载条件（shareGroupId !== null）——挂载块被删了或移进别的条件里了"
    );
});
