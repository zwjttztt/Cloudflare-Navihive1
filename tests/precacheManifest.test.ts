// 构建产物的预缓存清单（dist/client/precache-manifest.json）划分对不对。
//
// 清单由 vite.config.ts 里的自研插件生成：沿静态 import 走一遍，走得到的是 core
// （install 时预缓存），只有被 dynamic import 指向的才是 lazy（用到时才缓存）。
// 这条划分错了不会有任何报错 ——
//   - 该 lazy 的进了 core：首屏多下载一堆用不到的块（就是首屏预算那条守的）；
//   - 该 core 的进了 lazy / 漏出清单：离线时打开页面直接 404，而且是**部分**404，
//     页面起来了一半、某个懒弹窗点开是空白。
//
// 升 vite 8（rollup → rolldown）时这两条是手工验的，这里把它们钉住。

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

function readManifest() {
    const file = join(findProjectDir(), "dist", "client", "precache-manifest.json");
    if (!existsSync(file)) return null;
    return {
        manifest: JSON.parse(readFileSync(file, "utf8")) as { core: string[]; lazy: string[] },
        assets: join(findProjectDir(), "dist", "client", "assets"),
    };
}

/**
 * 只该在用到时才出现的标记 → 属于哪个 lazy 块。
 *
 * 判据**不能**只查块名：把 lazy import 改回静态 import 之后，那个块会被并进
 * index chunk、磁盘上根本不再有单独的 xxx-xxx.js 文件，按名字查 core 反而查不到。
 * 直接看首屏包里有没有这些标记才拦得住 —— 它们一旦出现在 index 里，
 * 就说明对应的组件被拉回首屏了。
 */
const LAZY_ONLY_MARKERS: Array<{ marker: string; of: string }> = [
    { marker: "nav-bulk-bar", of: "BulkActionBar（进入多选才出现）" },
    { marker: "nav-command-palette", of: "CommandPalette（按快捷键才打开）" },
];

/**
 * 弹窗专用 MUI 组件的样式标记（2026-10-17 性能排查 P2-2 守卫）。
 *
 * 这些组件只被懒加载树（NotesOverlay / 各设置弹窗）使用；它们一旦出现在
 * index.html **modulepreload** 的块里，就说明分包把弹窗专用的东西又塞回首屏了
 * ——上一版 mui-lazy 就是这么把整个 417KB 钉回首屏 preload 的。
 * 记 Mui* 类名标记而不是块名：块名随分包策略变，样式标记跟着组件走。
 */
const LAZY_ONLY_MUI_MARKERS: Array<{ marker: string; of: string }> = [
    { marker: "MuiSlider-root", of: "Slider（只在记事本懒加载树里用）" },
    { marker: "MuiModal-root", of: "Modal（只被各弹窗用）" },
    { marker: "MuiPopover-root", of: "Popover（只被菜单 / 弹窗用）" },
];

test("首屏 modulepreload 的块里没有懒加载专用组件的标记", t => {
    const distClient = join(findProjectDir(), "dist", "client");
    let html: string;
    try {
        html = readFileSync(join(distClient, "index.html"), "utf8");
    } catch {
        t.skip("没有构建产物，跳过（先跑 npm run build）");
        return;
    }
    const preloaded = [...html.matchAll(/modulepreload" crossorigin href="(\/assets\/[^"]+\.js)"/g)].map(
        m => m[1].replace(/^\/assets\//, "")
    );
    assert.ok(preloaded.length > 0, "index.html 里居然没有 modulepreload，构建产物不对");
    const leaked: string[] = [];
    for (const name of preloaded) {
        const code = readFileSync(join(distClient, "assets", name), "utf8");
        for (const m of [...LAZY_ONLY_MARKERS, ...LAZY_ONLY_MUI_MARKERS]) {
            if (code.includes(m.marker)) leaked.push(`${m.of} → ${name}`);
        }
    }
    assert.deepEqual(
        leaked,
        [],
        `这些只该在用户触发后才下载的东西出现在了首屏 preload 的块里：${leaked.join("、")}。` +
            `分包把懒加载专用的模块并进了首屏可达的块（参考 vite.config.ts 里 scanFirstScreenMui 的说明）`
    );
});

test("首屏包里没有只该在触发后才出现的标记", t => {
    const assets = join(findProjectDir(), "dist", "client", "assets");
    let hit: string;
    try {
        hit = readdirSync(assets).find(f => /^index-.*\.js$/.test(f)) ?? "";
    } catch {
        t.skip("没有构建产物，跳过（先跑 npm run build）");
        return;
    }
    if (!hit) {
        t.skip("没有 index chunk，跳过");
        return;
    }
    const code = readFileSync(join(assets, hit), "utf8");
    const leaked = LAZY_ONLY_MARKERS.filter(m => code.includes(m.marker)).map(m => m.of);
    assert.deepEqual(
        leaked,
        [],
        `这些组件只该在用到时才下载，它们的标记却出现在首屏包 ${hit} 里：${leaked.join("、")}。` +
            `多半是有人把 lazy(() => import(...)) 改回了静态 import —— 包会静默变大，CI 只有这里会红`
    );
});

test("清单与磁盘产物双向对齐：没有悬空条目，也没有漏登记的块", t => {
    const found = readManifest();
    if (!found) {
        t.skip("没有构建产物，跳过（先跑 npm run build）");
        return;
    }
    const listed = [...found.manifest.core, ...found.manifest.lazy];

    // 清单指向但磁盘上没有 → 预缓存时 cache.addAll 整批失败
    const dangling = listed.filter(u => !existsSync(join(found.assets, u.replace(/^\/assets\//, ""))));
    assert.deepEqual(dangling, [], `清单指向了不存在的文件：${dangling.join("、")}`);

    // 磁盘上有但没进清单 → 离线时打开对应弹窗会 404
    const onDisk = readdirSync(found.assets).filter(f => f.endsWith(".js"));
    const orphans = onDisk.filter(f => !listed.includes(`/assets/${f}`));
    assert.deepEqual(orphans, [], `产物没登记进清单，离线时会 404：${orphans.join("、")}`);
});
