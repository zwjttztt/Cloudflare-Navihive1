// tests/cardHoverLift.test.ts
// 回归守卫（卡片边缘 hover 抖动修复，2026-11-08）：
//   悬停抬升的 transform 必须作用在内层 .nav-card-lift 上，而不是 .nav-card-in 自身。
//   之前 transform 直接写在 .nav-card-in[data-hover-lift]:hover 上，卡片 hover 时整体位移，
//   把光标移出自身 → :hover 取消 → 回落 → 再 hover，形成「边缘疯狂抖动」死循环。
//   修复后：外层 .nav-card-in 作为静止命中区，内层 .nav-card-lift 承担位移，循环被打断。
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

test("卡片悬停抬升的 transform 作用在内层 .nav-card-lift，而非 .nav-card-in 自身", () => {
    const css = readFileSync(resolve(projectDir(), "src/index.css"), "utf8");

    // 旧写法：.nav-card-in[data-hover-lift]:hover { transform: ... } —— 会触发抖动死循环
    assert.ok(
        !/\.nav-card-in\[data-hover-lift\]:hover\s*\{/.test(css),
        "仍存在把 transform 直接写到 .nav-card-in:hover 上的写法，会复现边缘抖动"
    );

    // 新写法：位移在内层 .nav-card-lift 上，外层作为静止命中区
    assert.ok(
        /\.nav-card-in\[data-hover-lift\]:hover\s+\.nav-card-lift\s*\{[^}]*transform/.test(css),
        "找不到 .nav-card-in[data-hover-lift]:hover .nav-card-lift { transform } 规则"
    );

    // 内层容器必须是相对定位且填满，浮层按钮才会随它一起抬升、锚点正确
    assert.ok(
        /\.nav-card-lift\s*\{[^}]*position:\s*relative/.test(css),
        ".nav-card-lift 必须是 position: relative，否则浮层按钮锚点错位"
    );
});
