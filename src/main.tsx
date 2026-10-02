import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { readRememberedLogin } from "./utils/rememberedLogin";
import { UIPrefsProvider } from "./context/UIPrefsContext";
import ErrorBoundary from "./components/ErrorBoundary";
import { applyInputModeClass } from "./utils/device";
import { setupGlobalHandlers } from "./utils/errorReporter";
// 这里曾经 import 过 @fontsource/roboto 的 400/500/700 三档 latin 子集。
// 2026-09-30 复核后整段删掉：全站字体栈是 index.css 的 --font-sans
// （Inter → Segoe UI → system-ui → PingFang SC → 微软雅黑），
// theme 的 typography.fontFamily 也指向它，**没有任何一条规则引用 "Roboto"**
// （构建产物里 Roboto 只出现在 @font-face 自己的 font-family 声明上）。
// 也就是说那三档字体从来没被下载过一次，只是白白往 dist 里塞了 6 个文件、144 KB，
// 外加三条永远匹配不上的 @font-face。删掉后产物少 144 KB、少一个依赖，渲染零变化。
//
// 顺带纠正两个流传已久的错误结论：
// - 「字体在 precache 里占 127 KB」：precache 清单只有 16 条 JS/CSS，字体不在其中；
// - 「去掉 .woff 能省流量」：省 0 —— 现代浏览器只下 src 列表里靠前的 woff2；
//   而且既然整个字体族都没人用，这两个问题都不存在了。
//
// 真要上 Web 字体的话，正确姿势是**一个**可变字体（@fontsource-variable/*，
// 一档 latin wght 约 43 KB，覆盖 100~900 全字重），而不是三档静态字重。


// 触屏判定要在首帧前落定：卡片浮层在触屏上常显、在鼠标环境里悬停才出，
// 全都看 <html> 上的 .nav-touch（见 utils/device.ts）
applyInputModeClass();
// 即使已有会话不显示登录页，也立即移除旧版明文密码。
readRememberedLogin();

// 接住未捕获的 window.onerror / unhandledrejection，统一上报到 /api/report-error
setupGlobalHandlers();

/**
 * 站点刚更新完最容易撞上的一种白屏：
 * 浏览器里还留着上一版的 Service Worker 缓存，旧页面引用的 JS 块带内容 hash，
 * 新版本里那个文件已经不存在了 —— 取回来是 404，React 根本没机会渲染，页面全白。
 *
 * 这里接住「脚本 / 样式加载失败」和「动态 import 拿不到模块」两类错误，
 * 清掉本站缓存与旧 SW，然后重载一次。只重载一次（用 sessionStorage 记一笔），
 * 否则网络真的不通时会变成无限刷新。
 */
const ASSET_RECOVER_KEY = "navihive:asset-recover";

function recoverFromStaleAssets(reason: string) {
    try {
        if (sessionStorage.getItem(ASSET_RECOVER_KEY)) return;
        sessionStorage.setItem(ASSET_RECOVER_KEY, String(Date.now()));
    } catch {
        // 隐私模式下 sessionStorage 可能不可用，那就直接重载一次
    }
    console.warn("检测到旧版本资源加载失败，清缓存后重试一次：", reason);
    void (async () => {
        try {
            if ("caches" in window) {
                const keys = await caches.keys();
                await Promise.all(
                    keys.filter(k => k.startsWith("navihive-")).map(k => caches.delete(k))
                );
            }
            if ("serviceWorker" in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch {
            // 清理失败也照常重载：只要拿到新 HTML 就能自己恢复
        }
        window.location.reload();
    })();
}

// 捕获阶段才能收到 <script>/<link> 的加载失败（这类错误不冒泡）
window.addEventListener(
    "error",
    event => {
        const target = event.target as HTMLElement | null;
        // 普通脚本运行时错误的 target 是 window（没有 tagName），这里只处理元素加载失败
        if (!target || typeof target.tagName !== "string") return;
        const tag = target.tagName;
        if (tag !== "SCRIPT" && tag !== "LINK") return;
        const src =
            (target as HTMLScriptElement).src || (target as HTMLLinkElement).href || "";
        if (!src.includes("/assets/")) return;
        recoverFromStaleAssets(src);
    },
    true
);

// 懒加载块取不到时，React 抛的是 ChunkLoadError（也可能包装成动态 import 失败）
window.addEventListener("unhandledrejection", event => {
    const reason = event.reason as { name?: string; message?: string } | null;
    const name = reason?.name || "";
    const message = reason?.message || "";
    if (
        name === "ChunkLoadError" ||
        message.includes("Failed to fetch dynamically imported module") ||
        message.includes("Importing a module script failed")
    ) {
        recoverFromStaleAssets(message || name);
    }
});

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
