// tests/navigationCenterLazyGuard.test.ts
// 「更多选项」中心的**懒加载边界守卫**（2026-10-29 统一弹窗改造）。
//
// 为什么单独写一条守卫：首屏 gzip 预算只剩约 3% 余量（真实首屏 884.287 KB /
// gzip 289.736 KB，预算 920 / 300 KB，见 tests/bundleBudget.test.ts）。
// 中心是一个**两层**懒加载结构：
//   第一层：中心弹窗本身 —— 由 App 用 lazy(() => import(...)) + ChunkBoundary when 挂载；
//   第二层：九个业务面板 —— 由中心内部按 activeId 分发，只有被选中那一个才下载。
// 任一层被改回静态 import，都会把外壳（以及它那份 MUI Dialog / 面板框架）焊进
// 首屏关键路径 —— 类型检查完全看不出来（lazy 与静态 import 的组件类型一样），
// 只有构建产物会说话，而没人天天盯 chunk 大小。所以在这里把「引用方式」钉死。
//
// 判据分两段：
//   ① 源码段：入口文件（App / HeaderActions / HeaderActionsSlot）不许静态引入
//      中心与面板；中心自己也不许静态引入九个面板（只允许 `import(...)`）；
//   ② 产物段：构建产物里带中心/面板标记的块，不许出现在 index.html 的
//      script / modulepreload 清单里（没有 dist 时退化为只验源码）。
//
// 两段都带**反向验证**：喂一段静态 import 的样例，确认守卫真的会红 ——
// 否则「永远匹配不到」就会变成假绿。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
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

const ROOT = findProjectDir();

/** 剥注释：注释里会写 `import("./X")` 这类示例，不剥就会被当成实现 */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(line => {
            const i = line.indexOf("//");
            if (i < 0) return line;
            return line.slice(0, i).includes("://") ? line : line.slice(0, i);
        })
        .join("\n");
}

interface StaticImport {
    /** import 与 from 之间的部分（多行成员列表也在里头） */
    clause: string;
    /** 模块路径原文，如 "./navigationCenter/panels/StatsPanel" */
    module: string;
    /** `import type …`：编译期擦除，不进产物，不算把代码拖进包 */
    typeOnly: boolean;
}

/**
 * 取出源码里的静态 import。
 * 动态 `import("./X")` 不带 `from`，天然不会被这条正则命中 —— 正是我们要的。
 */
function staticImports(src: string): StaticImport[] {
    const out: StaticImport[] = [];
    const re = /(?:^|[^.\w])import\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
    for (const m of src.matchAll(re)) {
        const clause = m[1] ?? "";
        out.push({
            clause,
            module: m[2] ?? "",
            // `import type` / `import { type X }` 两种写法都算编译期擦除
            typeOnly: /\btype\b/.test(clause),
        });
    }
    return out;
}

/** 模块路径的最后一段（"…/panels/StatsPanel" → "StatsPanel"） */
const basename = (mod: string): string => mod.split("/").pop() ?? mod;

/** 中心外壳与中心弹窗的模块名（不含扩展名） */
const CENTER_MODULES = [
    "NavigationCenterDialog",
    "SettingsWorkspaceDialog",
    "SettingsWorkspaceNav",
    "SettingsWorkspacePanel",
];

/** 九个业务面板的模块名（按顺序，与 model.ts 的 NavCenterPanelId 一致） */
const PANEL_MODULES = [
    "StatsPanel",
    "BackupPanel",
    "RecyclePanel",
    "AuditPanel",
    "ConfigPanel",
    "AiPanel",
    "VaultPanel",
    "AccountPanel",
    "ShortcutsPanel",
];

/** 中心 + 九个面板：这些模块都不许被首屏入口静态引入 */
const CENTER_AND_PANELS = [...CENTER_MODULES, ...PANEL_MODULES];

/** 首屏入口：这些文件一旦静态引入中心，中心就进了 index chunk */
const ENTRY_FILES = [
    "src/App.tsx",
    "src/components/HeaderActions.tsx",
    "src/components/HeaderActionsSlot.tsx",
];

/** 命中「静态引入了 guarded 里的某个模块」的那些 import */
function offendingImports(src: string, guarded: string[]): StaticImport[] {
    return staticImports(stripComments(src)).filter(
        imp => !imp.typeOnly && guarded.includes(basename(imp.module))
    );
}

test("入口文件只用动态 import 引入中心外壳与九个面板", () => {
    const offenders: string[] = [];
    for (const rel of ENTRY_FILES) {
        const src = readFileSync(join(ROOT, rel), "utf8");
        for (const imp of offendingImports(src, CENTER_AND_PANELS)) {
            offenders.push(`${rel} → 静态 import ${imp.module}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        "中心与面板只能走 lazy(() => import(...))：静态 import 会把它们焊进首屏，" +
            "而首屏 gzip 预算只剩约 3% 余量"
    );
});

test("中心弹窗对九个面板只用动态 import（面板是第二层懒加载）", () => {
    const rel = "src/components/NavigationCenterDialog.tsx";
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(PANEL_MODULES.length, 9, `应有 9 个面板模块，实际 ${PANEL_MODULES.length}`);

    const offenders = offendingImports(src, PANEL_MODULES).map(imp => `${rel} → ${imp.module}`);
    assert.deepEqual(offenders, [], "九个面板只能被 lazy(() => import(...)) 引入");

    // 反向的一面：九个面板**必须**真的被动态引用到，否则上面那条会因为
    // 「压根没人引用」而永远绿 —— 少引用一个面板就等于少一块功能。
    const code = stripComments(src);
    for (const name of PANEL_MODULES) {
        assert.match(
            code,
            new RegExp(`import\\("\\./navigationCenter/panels/${name}"\\)`),
            `中心里缺 ${name} 的动态 import`
        );
    }
});

test("App 只在中心打开时挂载它（不许无条件挂载 lazy 组件）", () => {
    // VaultDialog 那个坑（App.tsx 里声明了 lazy 却无条件挂载）会让首屏一上来
    // 就发请求；这里钉住中心是 `when={navCenterOpen}` 的条件挂载。
    const code = stripComments(readFileSync(join(ROOT, "src", "App.tsx"), "utf8"));
    const mount = /<ChunkBoundary when=\{navCenterOpen\}>\s*<NavigationCenterDialog/.exec(code);
    assert.ok(mount, "中心必须挂在 <ChunkBoundary when={navCenterOpen}> 里");
});

test("构建产物里：中心与面板的块不在 index.html 的首屏清单里", t => {
    const htmlPath = join(ROOT, "dist", "client", "index.html");
    if (!existsSync(htmlPath)) {
        t.skip("没有构建产物，退化为本文件里的源码守卫（先跑 npm run build）");
        return;
    }
    const html = readFileSync(htmlPath, "utf8");
    const firstScreen = new Set(
        [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)].map(m => m[1])
    );
    assert.ok(firstScreen.size > 0, "index.html 里没解析到任何产物，解析规则多半失效了");

    const assetsDir = join(ROOT, "dist", "client", "assets");
    const jsFiles = readdirSync(assetsDir).filter(n => n.endsWith(".js"));
    assert.ok(jsFiles.length > 0, "dist/client/assets 下没有 js 产物");

    /**
     * 标记串：外壳与面板各一个，都是 **只可能出现在懒加载块里** 的独有字符串。
     * 用标记而不是模块名，是因为产物里的模块名被压缩掉了、认不出来。
     */
    const markers: { name: string; needle: string; owner: string }[] = [
        {
            name: "设置工作区外壳",
            needle: "data-workspace-panel-body",
            owner: "src/components/settingsWorkspace/SettingsWorkspacePanel.tsx",
        },
    ];

    // ① 标记必须还在源码里 —— 否则「产物里找不到」会被当成 dist 过期而 skip，
    //    改名的人永远看不到红，这条守卫就空了。
    for (const { name, needle, owner } of markers) {
        assert.ok(
            readFileSync(join(ROOT, owner), "utf8").includes(needle),
            `${owner} 里找不到标记 ${needle}（「${name}」）—— 标记改了要同步改本守卫`
        );
    }

    // ② 产物里找不到标记 = dist 不是这份源码编出来的（门禁里 test 跑在 build 之前，
    //    dist 很可能是上一轮的）。这种时候**跳过**而不是判红：判红会把「dist 过期」
    //    报成「中心被静态引入了首屏」，是假警报。
    const holdersOf = (needle: string) =>
        jsFiles.filter(f => readFileSync(join(assetsDir, f), "utf8").includes(needle));
    const resolved = markers.map(m => ({ ...m, holders: holdersOf(m.needle) }));
    if (resolved.some(m => m.holders.length === 0)) {
        t.skip("dist 里没有中心/面板的标记 —— dist 可能是上一轮构建的，先跑 npm run build");
        return;
    }

    for (const { name, holders } of resolved) {
        const inFirstScreen = holders.filter(f => firstScreen.has(f));
        assert.deepEqual(
            inFirstScreen,
            [],
            `「${name}」的块 ${inFirstScreen.join("、")} 出现在 index.html 的 ` +
                `script/modulepreload 清单里 —— 它被静态引入了首屏`
        );
    }
});

test("反向验证：守卫真的能抓到静态 import（换静态写法必须红）", () => {
    const broken = stripComments(`
        import NavigationCenterDialog from "./components/NavigationCenterDialog";
        import StatsPanel from "./navigationCenter/panels/StatsPanel";
        const X = lazy(() => import("./components/SettingsDialog"));
    `);
    const hit = offendingImports(broken, CENTER_AND_PANELS).map(i => i.module);
    assert.deepEqual(
        hit,
        ["./components/NavigationCenterDialog", "./navigationCenter/panels/StatsPanel"],
        "静态引入中心 / 面板必须被抓出来"
    );

    // 动态 import 与 type-only import 都不该被误伤
    const ok = stripComments(`
        const NavigationCenterDialog = lazy(() => import("./components/NavigationCenterDialog"));
        import type { NavCenterPanelProps } from "./navigationCenter/model";
    `);
    assert.deepEqual(
        offendingImports(ok, CENTER_AND_PANELS),
        [],
        "lazy 的动态 import 与 import type 都不算违规"
    );
});
