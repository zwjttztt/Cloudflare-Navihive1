// tests/dialogCloseAffordance.test.ts
// 每个弹窗都得有「看得见的关闭出口」，而且标签必须是中文。
//
// 起因（docs/dialogs-audit-2026-10-23.md G5）：32 个弹窗里 8 个压根没有 ×
// （审计日志 / 注销账号 / 编辑分组 / 文件夹外观 / 分享笔记 / 快捷键 / 回收站 /
// 标签颜色 / 批量打标签），只能按 Esc 或点遮罩退出；有 × 的那批里又有两处
// aria-label='close' —— 代码是英文，读屏念出来就是英文。
//
// 修法：抽一个 DialogCloseButton，全站共用；这两条守卫钉住「以后别再漏」。
//
// ⚠️ 扫源码前必须剥注释：不剥的话，「注释里写着 DialogCloseButton」就能蒙混过关。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

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

/** 剥掉块注释与整行行注释，避免「注释里写正确写法」骗过守卫 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

/** 递归列出 src 下所有 tsx/ts 源文件 */
function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...sourceFiles(full));
        } else if (/\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/** 只挑真正渲染了 MUI <Dialog> 的文件（<DialogTitle> 之类不算） */
function dialogFiles(): { path: string; src: string }[] {
    const root = resolve(projectDir(), "src");
    return sourceFiles(root)
        .map(path => ({ path, src: stripComments(readFileSync(path, "utf8")) }))
        .filter(({ src }) => /<Dialog[\s>]/.test(src));
}

/**
 * 命令面板是唯一合理的例外：它是一个「输入即搜索」的浮层，用户预期就是 Esc / 失焦关闭，
 * 右上角再放一个 × 反而和输入框抢位置。白名单写死在这里，加新例外必须同时改注释。
 */
const NO_CLOSE_ALLOWLIST = new Set([
    "src/components/CommandPalette.tsx",
    "src/components/NotesCommandPalette.tsx",
]);

test("每个渲染 <Dialog> 的文件都有可见的关闭出口", () => {
    const files = dialogFiles();
    assert.ok(files.length >= 20, `扫到的弹窗文件太少（${files.length}），扫描逻辑可能坏了`);

    const missing = files
        .filter(({ path }) => !NO_CLOSE_ALLOWLIST.has(path.replace(/\\/g, "/").replace(resolve(projectDir()).replace(/\\/g, "/") + "/", "")))
        .filter(({ src }) => !src.includes("DialogCloseButton") && !/aria-label=['"][^'"]*关闭/.test(src))
        .map(({ path }) => path);

    assert.deepEqual(
        missing,
        [],
        `这些弹窗没有可见的关闭按钮（Esc 不算）：\n${missing.join("\n")}\n` +
        "接 src/components/DialogCloseButton.tsx，或在白名单里说明理由"
    );
});

test("弹窗里不许出现英文的 aria-label='close'", () => {
    const offenders: string[] = [];
    for (const { path, src } of dialogFiles()) {
        if (/aria-label=['"]close['"]/i.test(src)) offenders.push(path);
    }
    assert.deepEqual(offenders, [], "关闭按钮的 aria-label 要是中文（读屏会念出来）");
});

test("反向验证：守卫真的能红（没有关闭出口的文件必须被抓出来）", () => {
    // 测的是守卫本身：少了这条，上面两条可能因为「永远匹配不到」而假绿。
    const broken = stripComments(`
        <Dialog open>
            <DialogTitle>某某弹窗</DialogTitle>
            <DialogContent>内容</DialogContent>
        </Dialog>
    `);
    assert.equal(broken.includes("DialogCloseButton"), false, "样例里不该有外壳组件");
    assert.equal(/aria-label=['"][^'"]*关闭/.test(broken), false, "样例里不该有中文关闭标签");
});
