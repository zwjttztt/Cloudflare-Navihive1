// tests/dialogHelperTextWrap.test.ts
// 弹窗帮助文字必须能断词换行。
//
// 起因（docs/dialogs-audit-2026-10-16.md P2-1）：网站设置里「获取图标API URL」的帮助文字
// 带一长串占位符示例 URL，没有空格可断，375 视口下整段伸出输入框 16px。
// 修法两处：dialogShell 的公共正文样式统一断词 + SettingsDialog 那两个字段显式写。
// 这份用例钉住「别被后人简化回去」——纯样式回归，jsdom 量不出来，只能扫源码。
//
// ⚠️ 扫源码前必须剥注释：仓库里有「注释里写正确写法、代码里是错写法」的反面教材，
// 不剥的话守卫会被注释蒙混过关。只剥 /* */ 与整行 //，不动行内 //（字符串里有 URL）。
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

/** 剥掉块注释（星号-斜杠对）与整行行注释（保留行内的行注释，那是字符串里的 URL） */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter(line => !line.trim().startsWith("//"))
        .join("\n");
}

const read = (rel: string) => stripComments(readFileSync(resolve(projectDir(), rel), "utf8"));

const WRAP_RULE = /overflowWrap:\s*["']anywhere["']/;

test("dialogShell 的公共正文样式带断词规则（用外壳的弹窗全都受益）", () => {
    const src = read("src/components/dialogShell.ts");
    assert.ok(
        src.includes("MuiFormHelperText-root"),
        "dialogContentSx 里要能选中帮助文字"
    );
    assert.ok(WRAP_RULE.test(src), "dialogContentSx 里要有 overflowWrap: anywhere");
});

test("SettingsDialog 两个带长 URL 的字段各自带断词规则", () => {
    const src = read("src/components/SettingsDialog.tsx");
    for (const id of ["site-icon-api", "site-thumb-api"]) {
        const at = src.indexOf(id);
        assert.ok(at > 0, `找不到字段 ${id}`);
        // 只看这个字段往后 1100 字符内的 sx：修的是它自己，别拿别处的规则蒙混
        const window = src.slice(at, at + 1100);
        assert.ok(
            WRAP_RULE.test(window),
            `${id} 的帮助文字带长 URL，附近必须有断词规则（否则窄屏会伸出输入框）`
        );
    }
});

test("反向验证：守卫真的能红（把规则删掉就应当找不到）", () => {
    // 这不是在测产品代码，是在测守卫本身——没有这一条，
    // 上面两条可能因为「永远匹配不到任何东西」而假绿。
    const broken = stripComments(`
        // overflowWrap: "anywhere"   ← 只在注释里，必须被剥掉
        const sx = { "& .MuiFormHelperText-root": { wordBreak: "break-word" } };
    `);
    assert.equal(WRAP_RULE.test(broken), false, "剥注释后不该再匹配到规则");
});
