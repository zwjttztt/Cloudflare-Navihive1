import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * 构建时把产物分成两份清单交给 Service Worker：
 *   core —— 打开页面就必须有的（入口 + 它静态引用的块 + CSS），install 阶段预缓存
 *   lazy —— 点开某个弹窗才用得到的懒加载块，**用到时才缓存**
 *
 * 为什么必须分开：早先两份混在一起、install 时一把 cache.addAll，等于把 9 个懒弹窗
 * 在后台全下载一遍 ——「按需加载」只省了解析时间，流量和缓存一点没省，
 * 首屏还多出十几个并发请求跟真正的首屏资源抢带宽。
 * 离线增强（把 lazy 也预下来）改成用户显式开启后才做，见 public/sw.js 的消息处理。
 */
/**
 * 本次构建的构建号。两处共用同一个值，必须同源：
 *   - precache-manifest.json 的 version（Service Worker 用它给缓存命名）
 *   - __NAVIHIVE_BUILD_VERSION__（烘进前端产物，用来判断「我这一版是不是旧的」）
 * 分成两个 Date.now() 的话，「服务端版本」和「本机版本」永远不相等，
 * 页面会每一次加载都判定自己过期。
 */
const BUILD_VERSION = String(Date.now());

/**
 * 对用户可见的部署版本号（右下角徽标，见 components/BuildBadge.tsx）。
 *
 * 形如 `v0.1.0+c49c59f`：语义版本 + commit 短哈希。
 * 每次构建（Cloudflare 从 GitHub 自动部署、VPS 上 docker build）都会重新计算，
 * 所以「每一次部署」天然拿到自己的版本号。
 *
 * ⚠️ Docker 构建上下文刻意不含 .git（.dockerignore），里面 `git rev-parse` 会失败
 * —— 兜底用 BUILD_VERSION（毫秒时间戳，同样每次构建必不同），保证任何构建方式下
 * 版本号都存在且逐次可区分，只是可读性从「commit 哈希」退化为「构建号」。
 */
function gitShortHash(): string {
    try {
        return execSync("git rev-parse --short HEAD", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "";
    }
}

const PKG_VERSION = (
    JSON.parse(readFileSync("./package.json", "utf8")) as { version: string }
).version;
const APP_VERSION = `v${PKG_VERSION}+${gitShortHash() || BUILD_VERSION}`;

/** 本地构建时间（展示用，进徽标的 title 提示；不含时区语义，就是构建机的钟） */
const BUILD_TIME = (() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}`
    );
})();

/**
 * 给 index.html 里的图标链接带上发布版本号（`?v=16.3.1`），让浏览器真的换掉标签页图标。
 *
 * 为什么必须有这一步：浏览器对 favicon 的缓存**不看你给的 Cache-Control**，
 * 它自己在本地存一份长期记录（Chrome 存在 Favicons 库里，键是图标 URL）。
 * 16.3.0 换 logo 时只换了文件内容、URL 没动，于是标签页上还是旧的蓝圆图，
 * 用户看到的结论就是「logo 没变」。URL 一变，缓存键跟着变，想不换都难 ——
 * 而每次发布会 bump package.json 的版本（script/bump-version.mjs），
 * 正好一次发布一个新 URL，不多不少。
 *
 * 替身值也覆盖 public/favicon.ico（2026-09-26 那版旧图，换 logo 时漏了它，
 * 已用 sharp 按新图重建过）。
 */
function versionedIcons(): Plugin {
    return {
        name: "navihive-versioned-icons",
        transformIndexHtml(html) {
            return html.replaceAll("__ICON_V__", PKG_VERSION);
        },
    };
}

function precacheManifest(): Plugin {
    return {
        name: "navihive-precache-manifest",
        apply: "build",
        generateBundle(_options, bundle) {
            const assets = Object.keys(bundle).filter(name => name.startsWith("assets/"));
            const chunks = new Map(
                Object.entries(bundle).filter(([, v]) => v.type === "chunk") as [
                    string,
                    { imports?: string[] },
                ][]
            );

            // 按需加载、但**离线时也必须可用**的块。
            //
            // 现在只有二次确认（ConfirmDialog）：删除在离线队列里是允许的（删完进队列、
            // 联网后重放），不能因为「这个块还没下载到本机」就把用户的删除拦下来 ——
            // 那样离线时点删除会看到「离线状态下这个功能打不开」，而操作本身其实能做。
            // 所以它虽然不走静态 import（为了不占首屏），仍要进预缓存核心清单。
            const ALWAYS_PRECACHE = [/[\\/]components[\\/]ConfirmDialog\.tsx$/];
            const isAlwaysPrecached = (name: string) => {
                const ids =
                    (bundle[name] as { moduleIds?: readonly string[] }).moduleIds ?? [];
                return ids.some(id => ALWAYS_PRECACHE.some(re => re.test(id)));
            };

            // 从入口出发沿静态 import 走一遍：走得到的是「首屏就要用」的，
            // 只有被 dynamic import 指向的才是真正可以等的。
            // ALWAYS_PRECACHE 命中的块也算起点，于是它和它引用的块一起进核心清单。
            const core = new Set<string>();
            const queue = [...chunks.keys()].filter(
                name =>
                    ((bundle[name] as { isEntry?: boolean; name?: string }).isEntry &&
                        (bundle[name] as { name?: string }).name !== "mermaidSandbox") ||
                    isAlwaysPrecached(name)
            );
            while (queue.length) {
                const name = queue.pop()!;
                if (core.has(name)) continue;
                core.add(name);
                for (const dep of chunks.get(name)?.imports ?? []) queue.push(dep);
            }

            // CSS 没有 chunk 图可走，一并算核心：项目里 CSS 很小（MUI 是 CSS-in-JS）
            for (const name of assets) {
                if (name.endsWith(".css")) core.add(name);
            }

            // （2026-10-17）MUI 改为交回 rolldown 自然分包后不再有固定名字的
            // mui-lazy 块。ConfirmDialog 依赖的 MUI 共享块靠上面的 imports 行走
            // 自然进核心清单，不需要再按块名特判 —— 双向对齐由
            // tests/precacheManifest.test.ts 的「清单与磁盘产物双向对齐」守着。

            const toUrl = (name: string) => `/${name}`;
            const coreFiles = [...core].filter(n => n.startsWith("assets/")).map(toUrl);
            const lazyFiles = assets
                .filter(name => name.endsWith(".js") && !core.has(name))
                .map(toUrl);

            if (!coreFiles.length) return;
            this.emitFile({
                type: "asset",
                fileName: "precache-manifest.json",
                source: JSON.stringify({
                    version: BUILD_VERSION,
                    core: coreFiles,
                    lazy: lazyFiles,
                }),
            });
        },
    };
}

/** manualChunks 里 getModuleInfo 返回的模块信息（只取用得上的三个字段） */
type ModuleInfoLike = {
    isEntry?: boolean;
    importers: readonly string[];
    dynamicImporters: readonly string[];
};

/**
 * 首屏 @mui/material 闭包扫描（2026-10-17 性能排查 P2-2）。
 *
 * 为什么不沿 rolldown 的模块图判：manualChunks 回调期拿到的 `importers` 混着
 * 动态导入边（图还没定型），「沿图上溯判首屏」必然误判 —— 上一版就是因此把
 * Button / Typography 这类首屏组件判进 mui-lazy，入口 chunk 静态依赖它，
 * index.html modulepreload 整块 417KB，首屏关键路径白背一大截。
 *
 * 这里改成在**源码层**从 main.tsx 只沿静态 import 走（import/export ... from
 * 与副作用 import "x"；动态 import() 没有这些形态，天然不跟 —— 那正是懒加载
 * 边界）。遇到 @mui/material 就把对应文件连同它的相对依赖闭包**逐文件**记下来
 * （按目录段标会把 tree-shake 掉的兄弟文件也拖进预加载，实测多背 40KB）。
 *
 * 用途只是**归桶**：集合内的并成一个稳定的 mui-core 块（首屏 preload 一发命中、
 * 业务代码改动不失效），集合外的交回 rolldown 自然落到懒加载侧。归错也无害 ——
 * 集合外的首屏模块 rolldown 本来就会并进它的静态导入者（入口侧），
 * 集合内多标的只会多几个 KB 进预加载，不影响正确性。
 */
function scanFirstScreenMui(): { material: Set<string>; icons: Set<string> } {
    // material：@mui/material 包内**文件**的包内相对路径（正斜杠，如 "Button/index.js"）
    const material = new Set<string>();
    const icons = new Set<string>();
    const visited = new Set<string>();
    const srcRoot = path.resolve(process.cwd(), "src");
    const materialRoot = path.resolve(process.cwd(), "node_modules", "@mui", "material");
    const localExts = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];

    const firstExistingFile = (...candidates: string[]): string | null => {
        for (const candidate of candidates) {
            try {
                if (statSync(candidate).isFile()) return candidate;
            } catch {
                // 不存在，试下一个形态
            }
        }
        return null;
    };

    const resolveLocal = (from: string, spec: string): string | null => {
        const base = path.resolve(path.dirname(from), spec);
        // 先试 base 本身（导入常自带扩展名，如 "./App.tsx"），再试补扩展名的形态
        return firstExistingFile(base, ...localExts.map(ext => base + ext));
    };

    /** @mui/material 的子路径 → 真实文件。Vite 走 exports 的 import 条件 →
     *  ESM 的 .mjs 才是真实进 bundle 的形态（.js 是 CJS，require 形态抓不到） */
    const resolveMaterial = (sub: string): string | null => {
        const base = path.join(materialRoot, sub);
        return firstExistingFile(
            path.join(base, "index.mjs"),
            base + ".mjs",
            path.join(base, "index.js"),
            base + ".js"
        );
    };

    const markMaterialFile = (file: string): void => {
        if (!file.startsWith(materialRoot + path.sep)) return;
        material.add(file.slice(materialRoot.length + 1).split(path.sep).join("/"));
    };

    const clauseNames = (clause: string | undefined): string[] => {
        if (!clause || !clause.startsWith("{")) return [];
        return clause
            .slice(1, -1)
            .split(",")
            .map(s => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
            .filter(Boolean);
    };

    // 子句只能是花括号块 / * as x / 单个标识符，花括号内不会嵌套 —— 用惰性匹配防跨语句误捕
    const STATIC_IMPORT_RE =
        /\b(?:import|export)\s+(?:type\s+)?(\{[\s\S]*?\}|\*[\s\S]*?|\w+)(?:\s*,\s*(\{[\s\S]*?\}))?\s*from\s*["']([^"']+)["']/g;
    const SIDE_EFFECT_RE = /(?:^|[;\r\n])\s*import\s*["']([^"']+)["']/g;

    /**
     * barrel（@mui/material）的 name → 来源路径映射。
     * 首屏代码里 `import { useTheme } from "@mui/material"` 这类导出，真实文件
     * 不一定在 @mui/material/<name>/（可能从 styles/ 等子目录转发），直接按名猜
     * 会丢闭包 —— 从包根 index.js 的 re-export 行反查真实来源。
     */
    const barrelSources = (() => {
        const map = new Map<string, string>();
        const barrel = firstExistingFile(
            path.join(materialRoot, "index.mjs"),
            path.join(materialRoot, "index.js")
        );
        if (!barrel) return map;
        let code: string;
        try {
            code = readFileSync(barrel, "utf8");
        } catch {
            return map;
        }
        // 每行形如 `export { default as X } from "./X";` 或 `export * from "./X";`
        for (const line of code.split("\n")) {
            const from = line.match(/from\s*["'](\.[^"']+)["']/);
            if (!from) continue;
            const names = clauseNames(line);
            for (const name of names) map.set(name, from[1]);
        }
        return map;
    })();

    const visitMaterialPath = (sub: string): void => {
        const direct = resolveMaterial(sub);
        if (direct) {
            visitFile(direct);
            return;
        }
        // 按名猜不到 → 查 barrel 转发（如 useTheme 实际在 styles/ 下）
        const forwarded = barrelSources.get(sub.split("/")[0]);
        if (forwarded) {
            const resolved = resolveMaterial(forwarded.replace(/^\.\//, ""));
            if (resolved) visitFile(resolved);
        }
    };

    const handleSpec = (file: string, spec: string, names: string[]): void => {
        if (spec === "@mui/material") {
            for (const name of names) visitMaterialPath(name);
        } else if (spec.startsWith("@mui/material/")) {
            visitMaterialPath(spec.slice("@mui/material/".length));
        } else if (spec.startsWith("@mui/icons-material/")) {
            icons.add(spec.slice("@mui/icons-material/".length).split("/")[0]);
        } else if (spec === "@mui/icons-material") {
            for (const name of names) icons.add(name);
        } else if (spec.startsWith(".")) {
            // node_modules 里的相对导入（MUI 组件间互引）：只追仍在 @mui/material
            // 包内的，这正是「组件 → 内部件」的传递闭包；src 文件的相对导入由
            // walkSrc 自己追（限定在 srcRoot 里）
            if (file.startsWith(materialRoot + path.sep)) {
                const resolved = resolveLocal(file, spec);
                if (resolved && resolved.startsWith(materialRoot)) visitFile(resolved);
            }
        }
        // 其它 bare specifier（react / @emotion / 业务依赖）不追：它们不引出新的
        // src 模块，也不参与 mui-core 归桶（rolldown 会把它们放到正确的共享位置）
    };

    const visitFile = (file: string): void => {
        if (visited.has(file)) return;
        visited.add(file);
        markMaterialFile(file);
        let code: string;
        try {
            code = readFileSync(file, "utf8");
        } catch {
            return;
        }
        // 剥注释：注释里的 `from "./x"` 不是导入（守卫扫源码的老规矩）
        code = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
        for (const re of [STATIC_IMPORT_RE, SIDE_EFFECT_RE]) {
            re.lastIndex = 0;
            for (const m of code.matchAll(re)) {
                const isStatic = re === STATIC_IMPORT_RE;
                const spec = (isStatic ? m[3] : m[1]) as string;
                if (!spec) continue;
                const names = isStatic ? [...clauseNames(m[1]), ...clauseNames(m[2])] : [];
                handleSpec(file, spec, names);
            }
        }
    };

    const walkSrc = (file: string): void => {
        if (visited.has(file)) return;
        visited.add(file);
        let code: string;
        try {
            code = readFileSync(file, "utf8");
        } catch {
            return;
        }
        code = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
        for (const re of [STATIC_IMPORT_RE, SIDE_EFFECT_RE]) {
            re.lastIndex = 0;
            for (const m of code.matchAll(re)) {
                const isStatic = re === STATIC_IMPORT_RE;
                const spec = (isStatic ? m[3] : m[1]) as string;
                if (!spec) continue;
                const names = isStatic ? [...clauseNames(m[1]), ...clauseNames(m[2])] : [];
                handleSpec(file, spec, names);
                if (spec.startsWith(".")) {
                    const resolved = resolveLocal(file, spec);
                    if (resolved && resolved.startsWith(srcRoot)) walkSrc(resolved);
                }
            }
        }
    };

    const mainEntry = path.join(srcRoot, "main.tsx");
    if (existsSync(mainEntry)) walkSrc(mainEntry);
    return { material, icons };
}

const FIRST_SCREEN_MUI = scanFirstScreenMui();

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare(), versionedIcons(), precacheManifest()],
  environments: {
    client: { build: { rollupOptions: { input: { index: "index.html", mermaidSandbox: "mermaid-sandbox.html" } } } },
  },
  // 把构建号烘进前端：src/utils/buildVersion.ts 用它跟服务端的清单对版本号，
  // 对不上就说明 Service Worker 喂的是上一版的外壳（见那个文件头的说明）。
  // 只在 src 里读得到（worker 侧的 tsconfig 不认识这个全局，那边也不该读它）。
  define: {
    __NAVIHIVE_BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
    // 右下角版本徽标用（components/BuildBadge.tsx）；只在 src 里读，worker 侧不该读它
    __NAVIHIVE_APP_VERSION__: JSON.stringify(APP_VERSION),
    __NAVIHIVE_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  build: {
    // 分包：react / mui 各自成块，其余依赖归 vendor。
    // 改业务代码时用户不用重新下载体积最大、最稳定的 MUI 那块。
    rollupOptions: {
      output: {
        manualChunks(id: string, { getModuleInfo }: { getModuleInfo: (id: string) => ModuleInfoLike | null }) {
          if (!id.includes("node_modules")) return;

          /**
           * 「懒加载边界」注：rolldown 在 manualChunks 回调期间给的 `importers`
           * 里混着动态导入者（图还没定型）—— 所以**任何**靠沿 importers 上溯来判
           * 「首屏 / 懒加载」的启发式都不可靠，2026-10-17 已废弃（见下面 MUI 分支
           * 的注释）。现在只在沙箱判定里用 importers / dynamicImporters。
           */
          // 沙箱独占的传递依赖不能被兜底 vendor 拉回首屏。
          const visited = new Set<string>();
          let sandbox = false;
          let main = false;
          const visit = (moduleId: string) => {
              if (visited.has(moduleId)) return;
              visited.add(moduleId);
              if (/src[\\/]mermaidSandbox\.ts$/.test(moduleId)) { sandbox = true; return; }
              if (!moduleId.includes("node_modules") && /src[\\/]/.test(moduleId)) { main = true; return; }
              const info = getModuleInfo(moduleId);
              for (const parent of [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])]) visit(parent);
          };
          visit(id);
          if (sandbox && !main) return;
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
            // ⚠️ 2026-10-12：把 @mui/@emotion/@popperjs/@floating-ui 强制塞进同一个块
            // 的代价是首屏白下载一大截（实测首屏 raw 721 → 513 KB）。
            //
            // ⚠️ 2026-10-17（P2-2 性能排查）：中间态的「reaches 启发式 + 强制命名
            // mui-lazy」也有致命伤 —— rolldown 在回调期给的 importers 混着动态导入边，
            // 凡是「首屏 src 静态用到 + 任意弹窗也用到」的 MUI 组件（Button /
            // Typography 这类）都被误判进 mui-lazy → 入口 chunk 静态依赖它 →
            // index.html modulepreload 整块 417 KB，首屏关键路径白白多背一截。
            //
            // 现在按**源码层扫描出的首屏闭包**（见 scanFirstScreenMui）归桶：
            //   - 首屏真用到的 @mui/material 组件 + 内部件 → mui-core 一块
            //     （preload 一发命中、业务改动不失效、总请求不回弹）；
            //   - 其余（弹窗专用组件、@mui/system、emotion、popper…）交回 rolldown
            //     自然分包：首屏用的并进入口侧，弹窗专用的只被动态 import，
            //     不会再出现在 index.html 的 preload 列表里；
            //   - 每个模块仍只进一个块，总 JS 体积几乎不变（2026-10-12 实测 +0.24%）。
            //
            // ConfirmDialog 的离线可用性不受影响：precacheManifest 从 ConfirmDialog
            // 块沿静态 imports 走，它依赖的 MUI 共享块会自然跟进核心清单（见上面
            // ALWAYS_PRECACHE 的说明），不再需要按块名特判。
            if (/node_modules[\\/]@mui[\\/]material[\\/]/.test(id)) {
                const rest = id.split(/[\\/]@mui[\\/]material[\\/]/)[1] ?? "";
                const rel = rest.split(/[\\/]/).join("/");
                if (rel && FIRST_SCREEN_MUI.material.has(rel)) { return "mui-core"; }
                return; // 懒加载树专用的组件 / 内部件：交回 rolldown 落 lazy 侧
            }
            if (/node_modules[\\/]@mui[\\/]icons-material[\\/]/.test(id)) {
                const seg = (id.split(/[\\/]@mui[\\/]icons-material[\\/]/)[1] ?? "").replace(/\.(m|c)?js$/, "");
                if (seg && FIRST_SCREEN_MUI.icons.has(seg)) { return "mui-core"; }
                return;
            }
            if (/node_modules[\\/](@mui|@emotion|@popperjs|@floating-ui)[\\/]/.test(id)) {
                return;
            }
            // markdown-it 必须单独成块。它**只**被 utils/markdownToReact 动态 import
            // （见那里的 loadParser），本来不进首屏；但下面这条兜底规则会把所有
            // node_modules 扫进 vendor —— 而 vendor 是首屏 chunk，于是这 ~100KB
            // 就被硬塞进首屏了（实测 +105KB，bundleBudget 立刻判红）。
            // KaTeX 同理（2026-10-05 加公式时踩到）：它 ~254KB，只被 utils/MathNode
            // 动态 import（而 MathNode 挂在 Markdown 预览这棵 lazy 树上）。
            // 不显式分流就会被下面这条兜底扫进首屏 vendor —— 用户一进页面就得下 254KB，
            // 而公式往往一篇笔记里只有一个。
            //
            // ⚠️ 2026-10-13：KaTeX 必须**自己成块**，不能混进 markdown 块。
            // 实测 markdown 块 345 KB 里 **234.9 KB（71%）是 katex** —— 混在一起的结果是
            // 「打开任意一篇笔记都要下这 235 KB」，哪怕通篇没有一个公式
            // （MathNode 里那句 import("katex") 只在渲染公式时才跑，但块已经提前下来了）。
            // 拆开后：没公式的笔记少下 235 KB JS + 29 KB CSS，
            // 有公式的笔记多一个请求（换这 264 KB 不必每次都付，很划算）。
            if (/node_modules[\\/]katex[\\/]/.test(id)) return "katex";
            if (/node_modules[\\/](markdown-it|mdurl|uc\.micro|entities|linkify-it)[\\/]/.test(id)) {
                return "markdown";
            }
            if (/node_modules[\\/](@codemirror|@lezer|style-mod|w3c-keyname|crelt)[\\/]/.test(id)) return "note-editor";
            if (/node_modules[\\/]markdown-it-footnote[\\/]/.test(id)) return "markdown";
            return "vendor";
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
