import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { UIPrefsProvider } from "./context/UIPrefsContext";
import { OpenQueueProvider } from "./context/OpenQueueContext";
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <UIPrefsProvider>
            <OpenQueueProvider>
                <App />
            </OpenQueueProvider>
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
