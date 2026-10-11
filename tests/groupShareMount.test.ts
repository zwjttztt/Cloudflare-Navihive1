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

/** 剥注释（与 lazyBoundary.test.ts 同一纪律：注释里的代码字样不能参与匹配） */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

test("GroupShareDialog 挂载块不得嵌在 showOfflineBanner 条件渲染里", () => {
    const text = stripComments(fs.readFileSync(APP, "utf8"));

    // 定位 showOfflineBanner 条件块：从 `{showOfflineBanner` 起做花括号配对
    const start = text.indexOf("{showOfflineBanner");
    assert.ok(start >= 0, "App.tsx 里找不到 showOfflineBanner 条件（改名了就同步改这里）");
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

test("GroupShareDialog 挂载条件仍存在于 App.tsx 顶层（防测试跑空/被删）", () => {
    const text = stripComments(fs.readFileSync(APP, "utf8"));
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
        "App.tsx 顶层找不到 GroupShareDialog 挂载条件（shareGroupId !== null）——挂载块被删了或移进别的条件里了"
    );
});
