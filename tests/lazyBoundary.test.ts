// 懒加载边界守卫：钉住「点开了才用得到」的弹窗真的是 lazy chunk。
//
// 为什么非得写个测试：2026-10-03 体检时发现 `OverlayHost.tsx` 里五个弹窗
// （命令面板 / 书签导入 / 标签管理 / AI 建议 / AI 助手）**外面套了 `<Suspense>`、
// import 却是静态的**。Suspense 完全不触发，包照样进首屏 —— 数 `lazy(` 的个数
// 是数不出来的（当时 App.tsx 里数到 9 个，看着很全，实际漏了 5 个）。
// index chunk 因此从 201.73 KB 一路涨到 264.34 KB 没人发现。
//
// 类型检查抓不到这个：静态 import 和 lazy 的组件类型完全一样，TS 不知道体积的事。
// 只有构建产物会说话，但没人天天盯着 chunk 大小看。所以在这里把「引用方式」钉死：
// 谁要是图省事改回静态 import，这条会红。

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 找仓库根：单测会被 esbuild 打包到 script/tmp-tests/ 下再跑，
 * 所以 `import.meta.dirname` 指向的是产物目录、不是 tests/ —— 不能用它拼 src。
 * 往上找到带 package.json 的那一层就是仓库根。
 */
function findRepoRoot(from: string): string {
    let dir = from;
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error("找不到仓库根（一路向上都没有 package.json）");
        dir = up;
    }
}

const SRC = path.join(findRepoRoot(path.resolve(process.argv[1] ?? ".", "..")), "src");

/** 递归收集 src/ 下所有 .ts/.tsx 的绝对路径 */
function walk(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

const FILES = walk(SRC).map(f => ({ path: f, text: fs.readFileSync(f, "utf8") }));

/**
 * 「点开了才用得到」的弹窗清单。新增同类弹窗时**加到这里**，
 * 否则规则管不到它（会悄悄变回首屏负担）。
 */
const MUST_BE_LAZY = [
    "CommandPalette",
    "BookmarkImportDialog",
    "TagManagerDialog",
    "AiSuggestDialog",
    "AiAssistantDialog",
    "AddSiteDialog",
    "EditGroupDialog",
];

interface ImportStmt {
    /** import 后面、from 之前的部分（多行 import 的成员列表也在里头） */
    clause: string;
    /** 模块路径，如 "./TagManagerDialog" */
    module: string;
    /** `import type ...` 或 `import { type X }`：编译期擦除，不算把代码拖进包 */
    typeOnly: boolean;
}

/**
 * 剥掉注释再解析。
 *
 * 不剥会踩一个很隐蔽的坑：注释里只要出现 `import` 字样（比如本文件上面那句
 * 「类型只用得到这几条，单独走 import type」），正则就会从**注释里的**那个 import
 * 起头匹配，把后面一整段注释当成 clause、把真 import 的模块路径认给它，
 * 而 `type ` 前缀落在注释里不会被捕获 —— 于是 type-only 的导入被误判成值导入。
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // 行注释：// 前面不能是引号或冒号，否则 "http://" 这种会被吃掉
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/** 抓所有 `import ... from "..."`（含跨行的成员列表） */
function parseImports(text: string): ImportStmt[] {
    const out: ImportStmt[] = [];
    // clause 里不许出现 `;` / `"`：否则 `lazy(() => import("./Xxx"))` 会一路吃到
    // 后面某条真 import 的 from，把模块路径认成别人的（跨行匹配的经典坑）
    const re = /import\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripComments(text)))) {
        const clause = (m[2] ?? "").trim();
        out.push({
            clause,
            module: m[3] ?? "",
            // `import type {...}` 整条擦除；`import { type X }` 同理（成员全是 type 前缀）
            typeOnly: Boolean(m[1]) || /^\{\s*type\s/.test(clause),
        });
    }
    return out;
}

/** 模块路径指向的就是这个组件（"./Xxx" / "../components/Xxx" 都算） */
function pointsTo(module: string, component: string): boolean {
    const base = module.split("/").pop() ?? "";
    return base === component || base === `${component}.tsx` || base === `${component}.ts`;
}

/** 把组件**本体**静态引进来的文件（会被打进首屏包） */
function staticImportSites(component: string): string[] {
    const hits: string[] = [];
    for (const { path: p, text } of FILES) {
        for (const imp of parseImports(text)) {
            if (imp.typeOnly || !pointsTo(imp.module, component)) continue;
            // 具名导入 `{ Xxx }` 也可能是值导入，但不能冤枉只引了类型的：
            // 形如 `{ type CommandItem }` 已经在 typeOnly 里排掉了，这里只看有没有裸的组件名
            if (imp.clause.startsWith("{") && !new RegExp(`\\b${component}\\b`).test(imp.clause)) {
                continue;
            }
            hits.push(path.relative(SRC, p).replace(/\\/g, "/"));
            break;
        }
    }
    return hits;
}

function lazyImportSites(component: string): string[] {
    const hits: string[] = [];
    const re = new RegExp(`lazy\\(\\(\\)\\s*=>\\s*import\\([^)]*${component}[^)]*\\)\\)`, "m");
    for (const { path: p, text } of FILES) {
        if (re.test(text)) hits.push(path.relative(SRC, p).replace(/\\/g, "/"));
    }
    return hits;
}

test("弹窗必须是 lazy：不允许任何一处静态值导入", () => {
    for (const c of MUST_BE_LAZY) {
        const bad = staticImportSites(c);
        assert.deepEqual(
            bad,
            [],
            `${c} 被静态 import 了（${bad.join(", ")}）—— 它会因此进首屏包。改成 lazy(() => import("..."))`
        );
    }
});

test("弹窗必须真的被 lazy 引用过（防止清单写了但没人引、或名字写错）", () => {
    for (const c of MUST_BE_LAZY) {
        const ok = lazyImportSites(c);
        assert.ok(
            ok.length > 0,
            `${c} 在清单里，但源码里找不到 lazy(() => import(...${c}...))。要么是名字写错了，要么是它已经不用了（那就从清单里删掉）`
        );
    }
});

test("lazy 的弹窗外面得有 Suspense 兜着，否则打开瞬间会报错", () => {
    // 只需要看挂载它们的宿主文件（新增宿主时加到这里）
    const hosts = ["components/OverlayHost.tsx", "App.tsx", "components/GroupCard.tsx"];
    for (const host of hosts) {
        const file = FILES.find(f => f.path.endsWith(host.replace(/\//g, path.sep)));
        assert.ok(file, `找不到 ${host}`);
        assert.ok(
            /<Suspense/.test(file.text),
            `${host} 里有 lazy 组件却没有 <Suspense>，首次打开会因为没兜底而报错`
        );
    }
});

test("守卫自身没跑空：清单里的组件在 src 里都得真实存在", () => {
    for (const c of MUST_BE_LAZY) {
        const exists = FILES.some(f => f.path.endsWith(path.join("components", `${c}.tsx`)));
        assert.ok(exists, `${c} 在清单里，但 src/components/${c}.tsx 不存在（改名了？同步改清单）`);
    }
});
