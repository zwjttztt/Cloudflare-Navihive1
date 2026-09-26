import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * 构建时把产物里的主资源（入口 JS/CSS）写成一份清单，
 * 交给 public/sw.js 在 install 阶段一次性预缓存，二次打开不再走网络。
 */
function precacheManifest(): Plugin {
    return {
        name: "navihive-precache-manifest",
        apply: "build",
        generateBundle(_options, bundle) {
            const files = Object.keys(bundle)
                .filter(name => name.startsWith("assets/") && /\.(js|css)$/.test(name))
                .map(name => `/${name}`);
            if (!files.length) return;
            this.emitFile({
                type: "asset",
                fileName: "precache-manifest.json",
                source: JSON.stringify({ version: Date.now(), files }),
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
