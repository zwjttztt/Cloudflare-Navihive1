// tests/groupCardLongName.test.ts
// 超长 / 连续无空格的分组名不能把 GroupCard 头部撑出视口。
//
// 起因（2026-10-18 用户报告）：用一长串 X 当分组名后，标题不可断行，
// 整条头部连同右侧「编辑 / 分享」工具条一起被挤出屏幕——「整个分组不能编辑」。
// 纯样式回归，jsdom 量不出来，只能扫源码；剥注释 + 反向验证一次（同 dialogHelperTextWrap）。
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

/** 剥掉块注释与整行行注释（仓库有「注释里写正确写法」的反面教材，不剥会被蒙混） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const read = (rel: string) => stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));
const BREAK = /wordBreak:\s*["']break-all["']/;

test("GroupCard 标题能断行且能收缩（超长分组名不撑破头部）", () => {
    const src = read("src/components/GroupCard.tsx");
    const at = src.indexOf("{group.name}");
    assert.ok(at > 0, "找不到标题渲染点");
    const window = src.slice(Math.max(0, at - 700), at);
    assert.ok(BREAK.test(window), "标题 Typography 附近要有 wordBreak: break-all");
    assert.ok(/minWidth:\s*0/.test(window), "标题要能收缩（minWidth: 0）");
});

test("标题外层容器可收缩，右侧工具条不会再被挤出视口", () => {
    const src = read("src/components/GroupCard.tsx");
    const at = src.indexOf('flex: "1 1 auto"');
    assert.ok(at > 0, "标题外层 Box 要有 flex: 1 1 auto（允许被压缩）");
    const window = src.slice(Math.max(0, at - 300), at + 200);
    assert.ok(/minWidth:\s*0/.test(window), "标题外层 Box 要 minWidth: 0（打破 flex 最小内容宽度）");
});

test("EditGroupDialog 删除确认里的超长分组名也能断行", () => {
    const src = read("src/components/EditGroupDialog.tsx");
    const at = src.indexOf("确定要删除分组");
    assert.ok(at > 0, "找不到删除确认文案");
    const window = src.slice(Math.max(0, at - 300), at + 200);
    assert.ok(BREAK.test(window), "删除确认的分组名要断行，不能撑破弹窗");
});

test("反向验证：守卫真的能红（只在注释里的规则必须被剥掉）", () => {
    const broken = stripComments(`
        // wordBreak: 'break-all'
        // minWidth: 0
        // flex: "1 1 auto"
        const sx = { fontWeight: "600" };
    `);
    assert.equal(BREAK.test(broken), false, "剥注释后不该再匹配到规则");
});
