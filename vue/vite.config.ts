// Vue 应用的 Vite 配置 —— 与仓库根那份（React 用）互不干扰。
//
// 用法（在仓库根执行）：
//   npx vite --config vue/vite.config.ts          # 开发
//   npx vite build --config vue/vite.config.ts    # 构建，产物在 dist-vue/client
//
// 为什么 root 指到这里、产物却放到 dist-vue：React 版占着 dist/client，
// 两边同时存在时不互相覆盖，迁移期间可以随时来回切换对照。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// 开发时的后端：默认指向本地 wrangler dev。
// 改指向别处用 VUE_API_TARGET=https://xxx npm run vue:dev
const API_TARGET = process.env.VUE_API_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
    plugins: [vue()],
    root: HERE,
    resolve: {
        alias: {
            "@": path.resolve(HERE, "src"),
            // 直接复用 React 侧那套纯 TS 契约（src/API/types.ts 等），
            // 迁移期不复制一份，避免两边数据形状跑偏。
            "@shared": path.resolve(REPO, "src"),
        },
    },
    server: {
        port: 5199,
        // 别名指到了 root（vue/）之外，不放开的话 dev 下这些文件会被 Vite 拒
        fs: { allow: [REPO] },
        proxy: {
            "/api": { target: API_TARGET, changeOrigin: true },
        },
    },
    build: {
        outDir: path.resolve(REPO, "dist-vue/client"),
        emptyOutDir: true,
        chunkSizeWarningLimit: 600,
    },
});
