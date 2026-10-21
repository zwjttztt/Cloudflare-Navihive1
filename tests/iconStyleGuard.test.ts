// tests/iconStyleGuard.test.ts
// A10「图标线性风格」的守卫（2026-10-22）。
//
// 图标风格统一不是「把 332 处全换成 Outlined」—— 有一类图标**天生是一对**：
//   置顶：PushPin(实心=已置顶) / PushPinOutlined(线性=未置顶)
//   收藏：Star(实心) / StarBorder(线性)
// 这两个是**状态**，不是风格：把它们统一成一种，用户就看不出置顶没置顶了。
// 2026-10-22 统一 Delete / NoteAdd / Person / Visibility(+Off) 时就是这么筛的。
//
// 守卫钉两件事：
//   1. 状态对必须两个都还在（哪天有人「顺手统一」了，这条会红）；
//   2. 已统一的图标不许再出现实心变体（防止新代码照着旧文件抄回去）。
//
// ⚠️ 只比字符串：断言失败路径里不放 DOM 元素（node:assert 会 util.inspect 它，
//    2026-10-21 因此把进程堆打爆过）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectDir as findProjectDir } from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);

/** 全仓 src 里某个图标变体被导入的文件集合 */
function filesImporting(variant: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(tsx|ts)$/.test(entry.name)) {
                const src = readFileSync(full, "utf8");
                if (src.includes(`@mui/icons-material/${variant}"`)) out.push(full);
            }
        }
    };
    walk(resolve(projectDir(), "src"));
    return out;
}

test("置顶图标是状态对：实心与线性两个都在", () => {
    const filled = filesImporting("PushPin");
    const outlined = filesImporting("PushPinOutlined");
    assert.ok(filled.length > 0, "PushPin(已置顶) 要还在");
    assert.ok(outlined.length > 0, "PushPinOutlined(未置顶) 要还在 —— 两者是状态不是风格");
});

test("收藏图标是状态对：实心与描边两个都在", () => {
    assert.ok(filesImporting("Star").length > 0, "Star(已收藏) 要还在");
    assert.ok(filesImporting("StarBorder").length > 0, "StarBorder(未收藏) 要还在");
});

test("已统一为线性的图标：不再出现实心变体", () => {
    // 这四个（+VisibilityOff）在 2026-10-22 统一到 Outlined；
    // 实心变体再出现 = 新代码照抄旧文件，风格又开始摇摆。
    for (const variant of ["Delete", "NoteAdd", "Person"]) {
        assert.equal(
            filesImporting(variant).length,
            0,
            `${variant} 已统一到 ${variant}Outlined，不该再出现实心变体`
        );
    }
});

test("密码显隐必须成对同风格：Visibility 与 VisibilityOff 都是线性", () => {
    // ⚠️ 只改一半最扎眼：同一个输入框里「睁眼是线性、闭眼是实心」
    assert.equal(filesImporting("Visibility").length, 0, "Visibility 要用 VisibilityOutlined");
    assert.equal(filesImporting("VisibilityOff").length, 0, "VisibilityOff 要用 VisibilityOffOutlined");
    assert.ok(filesImporting("VisibilityOutlined").length > 0, "VisibilityOutlined 要在用");
    assert.ok(filesImporting("VisibilityOffOutlined").length > 0, "VisibilityOffOutlined 要在用");
});
