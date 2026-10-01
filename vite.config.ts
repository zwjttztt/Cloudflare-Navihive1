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

            // 从入口出发沿静态 import 走一遍：走得到的是「首屏就要用」的，
            // 只有被 dynamic import 指向的才是真正可以等的。
            const core = new Set<string>();
            const queue = [...chunks.keys()].filter(
                name => (bundle[name] as { isEntry?: boolean }).isEntry
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
                    version: Date.now(),
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
  build: {
    // 分包：react / mui 各自成块，其余依赖归 vendor。
    // 改业务代码时用户不用重新下载体积最大、最稳定的 MUI 那块。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react";
          if (/node_modules[\\/](@mui|@emotion|@popperjs|@floating-ui)[\\/]/.test(id)) return "mui";
          return "vendor";
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
