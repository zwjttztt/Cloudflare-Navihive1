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
//
// 为什么这里要绕一道 Trusted Types：开了 CSP 的 require-trusted-types-for 之后，Chrome
// 把 register() 的 scriptURL 也当成 sink，直接传字符串会被拦下 —— 实测报
// "requires 'TrustedScriptURL' assignment"，SW 注册静默失败，离线能力就没了。
// 所以建一个只服务于 SW 的策略把这个常量包一下：URL 是硬编码的 "/sw.js"，
// 不是外部输入，恒等放行不存在注入风险。
// 不支持 Trusted Types 的浏览器（Firefox / Safari）走 ?? 分支；它们本来也不执行
// require-trusted-types-for，两边行为一致。
const SW_URL = "/sw.js";

type TrustedPolicyFactory = {
    createPolicy: (
        name: string,
        rules: { createScriptURL: (url: string) => string }
    ) => { createScriptURL: (url: string) => unknown };
};

function swScriptUrl(): unknown {
    const tt = (window as unknown as { trustedTypes?: TrustedPolicyFactory }).trustedTypes;
    if (!tt?.createPolicy) return SW_URL;
    try {
        return tt.createPolicy("navihive-sw", { createScriptURL: (url: string) => url }).createScriptURL(SW_URL);
    } catch {
        // 策略名被占用 / CSP 不允许建策略：回退成字符串，最坏只是没有 TT 保护
        return SW_URL;
    }
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => {
        // 运行时这里可能是 TrustedScriptURL（Chrome 要求的类型），TS 只认 string，故强转
        navigator.serviceWorker.register(swScriptUrl() as string).catch(() => {
            // 注册失败不影响正常使用，静默忽略
        });
    });
}
