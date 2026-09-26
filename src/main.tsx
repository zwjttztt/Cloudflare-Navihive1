import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { UIPrefsProvider } from "./context/UIPrefsContext";
// 只引 latin 子集：全量导入会把 cyrillic/greek/vietnamese/math 等 60 多个 @font-face 也打进 CSS，
// 白白多出 ~70KB 的阻塞样式，而实际只会命中 latin 那几个。
import "@fontsource/roboto/latin-300.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <UIPrefsProvider>
            <App />
        </UIPrefsProvider>
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
