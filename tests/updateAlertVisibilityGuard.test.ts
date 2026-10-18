// tests/updateAlertVisibilityGuard.test.ts
// 弹窗内「操作结果 Alert」可见性兜底的静态守卫（2026-10-18）。
//
// 用户报「网站设置点检查更新后弹出的提示框还要往下移动很不方便，查看其它弹窗
// 是否还存在这种问题并全部修复」——排查结论：站内弹窗的操作结果分两类：
//   1. 走全局 toast（onNotify）的：永远可见，无此类问题（SettingsDialog 维护节
//      的失效检测、各弹窗的保存/删除提示都走这条）；
//   2. 弹窗**内** Alert（带明细、不适合 toast 的）： BackupDialog 的 WebDAV
//      测试结果早有滚动兜底；本次给 VersionUpgradeSection（检查更新）与
//      AiAssistantDialog（AI 测试连接）补上同款。
// 这里把三处滚动兜底钉住，防重构时被删掉（注释里写正确写法不算数，剥注释验）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

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

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const readSrc = (rel: string) =>
    stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

test("VersionUpgradeSection：结果 Alert 与按钮同一行 + 出结果滚进可视区", () => {
    const src = readSrc("src/components/VersionUpgradeSection.tsx");
    // 同一行：结果 Alert 渲染在按钮所在的 flex 容器内（ref={rowRef} 那个 Box）
    assert.match(
        src,
        /data-update-result='latest'/,
        "latest 结果仍要渲染（守卫剥注释后看得到）",
    );
    assert.match(src, /ref=\{rowRef\}/, "按钮行要挂 ref（滚动兜底的锚点）");
    assert.match(
        src,
        /closest\("\.MuiDialogContent-root"\)/,
        "出结果时优先滚 DialogContent 到底（内容折叠线以下的场景）",
    );
    assert.match(src, /scrollIntoView/, "无 DialogContent 时 scrollIntoView 兜底");
});

test("AiAssistantDialog：测试连接结果出现时把按钮行滚进可视区", () => {
    const src = readSrc("src/components/AiAssistantDialog.tsx");
    assert.match(src, /testRowRef/, "测试区要挂 ref");
    assert.match(
        src,
        /closest\("\.MuiDialogContent-root"\)/,
        "出结果时滚 DialogContent 到底",
    );
    // 反向验证：滚动 effect 必须挂在 testResult 上（别的结果不触发）
    assert.match(src, /\}, \[testResult\]\);/, "滚动 effect 依赖 testResult");
});

test("BackupDialog：WebDAV 测试结果的滚动兜底仍在（老三处之一，不许被删）", () => {
    const src = readSrc("src/components/BackupDialog.tsx");
    assert.match(src, /webdavActionsRef/, "WebDAV 按钮行 ref 仍在");
    assert.match(
        src,
        /closest\("\.MuiDialogContent-root"\)/,
        "WebDAV 测试结果的滚动兜底仍在",
    );
});
