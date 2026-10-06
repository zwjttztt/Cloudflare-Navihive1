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
        manualChunks(id: string, { getModuleInfo }: { getModuleInfo: (id: string) => { importers: readonly string[]; dynamicImporters: readonly string[] } | null }) {
          if (!id.includes("node_modules")) return;
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
            if (/node_modules[\\/](@mui|@emotion|@popperjs|@floating-ui)[\\/]/.test(id)) return "mui";
            // markdown-it 必须单独成块。它**只**被 utils/markdownToReact 动态 import
            // （见那里的 loadParser），本来不进首屏；但下面这条兜底规则会把所有
            // node_modules 扫进 vendor —— 而 vendor 是首屏 chunk，于是这 ~100KB
            // 就被硬塞进首屏了（实测 +105KB，bundleBudget 立刻判红）。
            // KaTeX 同理（2026-10-05 加公式时踩到）：它 ~254KB，只被 utils/MathNode
            // 动态 import（而 MathNode 挂在 Markdown 预览这棵 lazy 树上）。
            // 不显式分流就会被下面这条兜底扫进首屏 vendor —— 用户一进页面就得下 254KB，
            // 而公式往往一篇笔记里只有一个。连带它自己的字体与 katex.min.css 一起进这个块。
            if (/node_modules[\\/](markdown-it|mdurl|uc\.micro|entities|linkify-it|katex)[\\/]/.test(id)) {
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
