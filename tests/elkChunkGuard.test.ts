// tests/elkChunkGuard.test.ts
// C2「elk 按图表类型拆包」的守卫（2026-10-22 核实）。
//
// 结论先说：**这条在 mermaid 12 上已经是成立的**，不需要再拆。
// mermaid 12.1.0 把每种图表（以及每个布局引擎）都注册成 lazy loader：
//   registerLayoutLoaders(() => import("./elk-*.js"))   ← elk.stress / elk.force …
//   { id, detector, loader: () => import("./xxxDiagram-*.js") }  ← 每种图表
// 所以普通 `flowchart LR`（dagre 布局）根本不会去下那个 1.46 MB 的 elk 块；
// 只有真写了 `flowchart-elk` / elk.* 布局才会拉它。Vite 把每个 loader 落成独立 chunk，
// 产物里能看到 assets/elk-*.js 与一堆 assets/*Diagram-*.js。
//
// ⚠️ 但「现在是好的」不等于「以后不会坏」：只要有人把 elkjs 或某个图表改成
//    静态 import（或者升级 mermaid 后它改回静态），1.46 MB 就会回到
//    mermaid 沙箱的首屏路径上，而体积预算**拦不住它**（沙箱不在首屏清单里）。
//    所以这里钉两件事：elk 是独立块、且它是被**动态**引入的。
//
// ⚠️ 没构建过（dist 不存在）时跳过 —— 与 bundleBudget 同一口径，单测不该要求先 build。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// ⚠️ 单测会被复制到 script/tmp-tests/ 下再跑，`../dist` 在那里是错的 ——
//    逐级向上找到带 package.json 的那一级才是真身（与 bundleBudget 同一套写法）。
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
const DIST = join(projectDir(), "dist", "client");

function distExists(): boolean {
    return existsSync(join(DIST, "index.html"));
}

/** 找出产物里的 elk 块（mermaid 内部叫 elk-XXXX，Vite 落成 elk-XXXX-HASH.js） */
function elkChunk(): string | null {
    if (!existsSync(join(DIST, "assets"))) return null;
    return readdirSync(join(DIST, "assets")).find(f => /^elk-.*\.js$/.test(f)) ?? null;
}

test("elk 是独立 chunk（不与 mermaid 主块混在一起）", t => {
    if (!distExists()) return t.skip("dist 不存在，跳过");
    const elk = elkChunk();
    assert.ok(elk, "产物里应该有一个独立的 elk-*.js 块");
    const size = readFileSync(join(DIST, "assets", elk!)).length / 1024;
    assert.ok(size > 500, `elk 块应该在 MB 级（实际 ${size.toFixed(0)}KB）—— 它值得单独拆`);
});

test("elk 只被动态引入：不在首屏清单里，也不是沙箱入口的静态依赖", t => {
    if (!distExists()) return t.skip("dist 不存在，跳过");
    const elk = elkChunk();
    assert.ok(elk, "产物里应该有一个独立的 elk-*.js 块");

    // 1) 首屏：index.html 里不许出现它（modulepreload / script 都算）
    const html = readFileSync(join(DIST, "index.html"), "utf8");
    assert.equal(
        html.includes(elk!),
        false,
        "elk 不该进首屏清单 —— 进了就是「打开页面先下 1.46MB」"
    );

    // 2) 沙箱入口：只允许出现在动态 import 的上下文里。
    //    判据是 Vite 的产物形态：静态依赖写成 `import"..."` / `from"..."`，
    //    动态依赖一定经过 __vite__mapDeps 的依赖表 + import(...) 调用。
    //    这里查「有没有被静态 import/export 直接引用」—— 有就是回退了。
    const entry = readdirSync(join(DIST, "assets")).find(f => /^mermaidSandbox-.*\.js$/.test(f));
    assert.ok(entry, "产物里应该有 mermaid 沙箱入口块");
    const code = readFileSync(join(DIST, "assets", entry!), "utf8");
    const staticRef = new RegExp(`(?:import|from)\\s*"[^"]*${elk!.replace(/\./g, "\\.")}"`);
    assert.equal(
        staticRef.test(code),
        false,
        "elk 不该被沙箱入口静态 import —— 静态引用 = 打开笔记就下 1.46MB"
    );
    assert.match(code, /__vite__mapDeps/, "elk 应当走 Vite 的动态 import 依赖表");
});
