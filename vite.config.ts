import { defineConfig, type Plugin } from 'vite'
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

            // mui-lazy 也在核心清单里。它是**所有懒加载弹窗共用的 MUI 大块**
            // （见下面 manualChunks 的说明），入口 HTML 本来就会 preload 它 ——
            // 所以加进清单**不会多下一分流量**，换来的是二次确认框的离线可用性：
            // ConfirmDialog 自己进了核心，但它依赖的这整块若不在缓存里，
            // 离线点删除就会卡在「依赖没下载过」上（而删除在离线队列里是允许的）。
            for (const name of chunks.keys()) {
                if (/^mui-lazy-[^/\\]*\.js$/.test(name)) core.add(name);
            }

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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare(), precacheManifest()],
  environments: {
    client: { build: { rollupOptions: { input: { index: "index.html", mermaidSandbox: "mermaid-sandbox.html" } } } },
  },
  // 把构建号烘进前端：src/utils/buildVersion.ts 用它跟服务端的清单对版本号，
  // 对不上就说明 Service Worker 喂的是上一版的外壳（见那个文件头的说明）。
  // 只在 src 里读得到（worker 侧的 tsconfig 不认识这个全局，那边也不该读它）。
  define: {
    __NAVIHIVE_BUILD_VERSION__: JSON.stringify(BUILD_VERSION),
  },
  build: {
    // 分包：react / mui 各自成块，其余依赖归 vendor。
    // 改业务代码时用户不用重新下载体积最大、最稳定的 MUI 那块。
    rollupOptions: {
      output: {
        manualChunks(id: string, { getModuleInfo }: { getModuleInfo: (id: string) => ModuleInfoLike | null }) {
          if (!id.includes("node_modules")) return;

          /**
           * 只沿**静态** import 边向上走，看能不能走到目标模块。
           *
           * 为什么不把 dynamicImporters 也算进来（下面 sandbox 那条老规则是算的）：
           * 这里要问的是「打开页面时这个模块会不会被立刻执行」，而动态 import 的那条边
           * 恰恰意味着「先不加载」——算进来就会把懒加载专用的一堆东西误判成首屏需要。
           */
          const reaches = (startId: string, isGoal: (moduleId: string, info: ModuleInfoLike | null) => boolean) => {
              const seen = new Set<string>();
              const stack: string[] = [startId];
              while (stack.length) {
                  const moduleId = stack.pop()!;
                  if (seen.has(moduleId)) continue;
                  seen.add(moduleId);
                  const info = getModuleInfo(moduleId);
                  if (moduleId !== startId && isGoal(moduleId, info)) return true;
                  for (const parent of info?.importers ?? []) stack.push(parent);
              }
              return false;
          };

          /**
           * 「懒加载边界」：src 下的模块，且**有人动态 import 它**
           * （比如 lazy(() => import("./SettingsDialog")) 里的那个文件）。
           * 走到它就说明：从这个模块往上，至少有一条路径是「用户触发才加载」的。
           *
           * ⚠️ 为什么不反过来判「能不能走到 src/main.tsx」：实测那样会把 485 个
           * MUI 模块全部判成首屏 —— 因为 rolldown 在 manualChunks 回调期间给的
           * `importers` 里混着动态导入者（图还没定型），于是
           * `Slider ← NotesPage ← NotesOverlay ← App(动态) ← main.tsx` 被当成一条
           * 纯静态链。用 `dynamicImporters` 认边界则不受影响：它直接回答
           * 「这个模块是不是某个 lazy() 的目标」。
           */
          const isLazyEntry = (moduleId: string, info: ModuleInfoLike | null) =>
              /src[\\/]/.test(moduleId) && (info?.dynamicImporters?.length ?? 0) > 0;
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
            // ⚠️ 2026-10-12：这一条原来是 `return "mui"` —— 把所有 @mui/@emotion/
            // @popperjs/@floating-ui 强制塞进同一个块。代价是**首屏白下载一大截**：
            // 弹窗 / 抽屉 / 记事本专用的 MUI 组件也在这个块里，而入口 HTML 会
            // modulepreload 整个块，用户一进页面就得把它们全下来并全执行。
            //
            // 实测（同一次构建，只改这一条）：
            //   强制分块：index 225.8KB + preload mui 422.8KB → 首屏 raw 721KB
            //   交回 Rollup：index 348.3KB（首屏真用到的 MUI 直接并进入口块），
            //                弹窗专用的那些自动落进各自的 lazy chunk → 首屏 raw 513KB
            // 全部 js 合计只从 7271.7KB 变到 7289.5KB（+0.24%），
            // 也就是说几乎没有「重复打进多个 lazy 块」的代价。
            //
            // 副作用：index 单文件变大了，所以体积预算（bundleBudget）按新口径
            // 重新定过 —— 见那里的注释。判断首屏该看**总下载字节**，不是单个块。
            if (/node_modules[\\/](@mui|@emotion|@popperjs|@floating-ui)[\\/]/.test(id)) {
                // 够不到任何 lazy 入口 → 首屏就要用，交回 Rollup：
                // 它会自动并进入口块，用户不多发一个请求。
                if (!reaches(id, isLazyEntry)) { return; }

                // 二次确认框是**离线也必须能开**的（删除在离线队列里是允许的），
                // 它走的是 dynamic import，但会被预缓存（见 precacheManifest 的
                // ALWAYS_PRECACHE）。只有**它独占**的 MUI 依赖才单独成块（跟着进
                // 预缓存清单）；被别的弹窗也用到的（Dialog / Modal / Fade …）一律
                // 归下面的 lazy 大块 —— 否则那个块会涨到近 400 KB 还被首屏 preload，
                // 等于把弹窗专用的东西又塞回首屏（实测首屏因此 842 → 950 KB）。
                const isConfirmDialog = (moduleId: string) =>
                    /src[\\/]components[\\/]ConfirmDialog\.tsx$/.test(moduleId);
                const reachesOtherLazyEntry = reaches(
                    id,
                    (moduleId, info) => isLazyEntry(moduleId, info) && !isConfirmDialog(moduleId)
                );
                if (reachesOtherLazyEntry) { return "mui-lazy"; }
                if (reaches(id, isConfirmDialog)) { return "mui-confirm"; }
                return "mui-lazy";
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
