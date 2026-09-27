import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { UIPrefsProvider } from "./context/UIPrefsContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { applyInputModeClass } from "./utils/device";
import { setupGlobalHandlers } from "./utils/errorReporter";
// 只引 latin 子集：全量导入会把 cyrillic/greek/vietnamese/math 等 60 多个 @font-face 也打进 CSS，
// 白白多出 ~70KB 的阻塞样式，而实际只会命中 latin 那几个。
// 字重只留实际在用的 400/500/700（300 全站零使用；600 由浏览器就近取 700 渲染，
// 一直是这个行为）。@fontsource 的 src 列表 woff2 在前，现代浏览器永远只下载 woff2，
// .woff 回退不产生运行时流量，保留。
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";

// 触屏判定要在首帧前落定：卡片浮层在触屏上常显、在鼠标环境里悬停才出，
// 全都看 <html> 上的 .nav-touch（见 utils/device.ts）
applyInputModeClass();

// 接住未捕获的 window.onerror / unhandledrejection，统一上报到 /api/report-error
setupGlobalHandlers();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        {/* 包在所有内容之外：任何组件渲染抛错都被拦成一张可自助恢复的页面，而不是白屏 */}
        <ErrorBoundary>
            <UIPrefsProvider>
                <App />
            </UIPrefsProvider>
        </ErrorBoundary>
    </StrictMode>
);

// PWA：注册 service worker（只在生产构建里注册，避免开发时被缓存干扰）
if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
            // 注册失败不影响正常使用，静默忽略
        });
    });
}
