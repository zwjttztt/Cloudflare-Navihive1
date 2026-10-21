import { StrictMode, lazy, Suspense } from "react";
// 入口不导出组件；此 lazy 只服务公开页路由，不参与热更新边界。
// eslint-disable-next-line react-refresh/only-export-components
const PublicNotePage = lazy(() => import("./components/PublicNotePage"));
// 公开分组页路径前缀是 /sg/（阶段④）：与 /s/ 同一套 single-page 回退与脱敏响应。
const PublicGroupPage = lazy(() => import("./components/PublicGroupPage"));
// 公开分享页路径前缀是 /s/（见 components/PublicNotePage.tsx 顶部注释 /s/:token）。
// 三处必须一致：这里的路由提取、NoteShareDialog 的分享链接、NotesSettingsDialog 的分享列表链接。
// worker 的 assets 用 single-page-application 回退，/s/<token> 会落到 index.html 再渲染公开页。
const publicToken = /^\/s\/([a-f0-9]{64})$/.exec(location.pathname)?.[1];
const publicGroupToken = /^\/sg\/([a-f0-9]{64})$/.exec(location.pathname)?.[1];
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import BuildBadge from "./components/BuildBadge";
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

import { fetchServerVersion, isStaleBuild, localBuildVersion } from "./utils/buildVersion";
import { recoverFromStaleAssets } from "./utils/staleRecovery";

// 两个令牌分开记：版本漂移与「资源取不到」是两件事，不该互相顶掉名额
const ASSET_RECOVER_KEY = "navihive:asset-recover";
const BUILD_RECOVER_KEY = "navihive:build-recover";

/**
 * 版本漂移的自查：Service Worker 把上一版的 HTML 外壳喂给浏览器时，
 * 页面能起来、但点开任一懒加载弹窗都会 404（旧版引用的 chunk 在新版里已经删了）。
 *
 * 放在**加载阶段主动查**而不是等报错再救，是因为要救的正是**上一版**的产物 ——
 * 那条补救代码也在产物里，上一版根本没有。从这一版起每一版都带这条自查，
 * 于是「停在旧版」能被自己发现：拿服务端清单的版本号跟自己烘进去的对一下，
 * 不一样就清掉 SW 缓存重载一次，直接落到最新版。
 *
 * 只在拿到确切结论时才动作：清单拉不到、版本号读不出来，都当作「不知道」不刷页面；
 * 刷之前先清 SW 缓存并注销 SW，否则重载回来的还是那份缓存里的旧外壳。
 * 清缓存 / 闩锁 / 令牌这些真正会咬人的逻辑在 utils/staleRecovery.ts（有单测）。
 */
async function reloadOnStaleBuild() {
    const local = localBuildVersion();
    // 没有烘进构建号（开发模式 / 老产物）：不做判断
    if (!local) return;
    const server = await fetchServerVersion();
    if (!isStaleBuild(local, server)) return;
    await recoverFromStaleAssets({
        reason: `版本落后（本机 ${local} / 服务端 ${server}）`,
        key: BUILD_RECOVER_KEY,
    });
}

// 与首屏资源并发地发一个几字节的请求：结论出来得越早，越能在用户动手之前刷好。
// 失败静默 —— 网络本来就不通时，下面那两条兜底还在。
void reloadOnStaleBuild();

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
        void recoverFromStaleAssets({ reason: src, key: ASSET_RECOVER_KEY });
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
        void recoverFromStaleAssets({ reason: message || name, key: ASSET_RECOVER_KEY });
    }
});

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        {/* 包在所有内容之外：任何组件渲染抛错都被拦成一张可自助恢复的页面，而不是白屏 */}
        <ErrorBoundary>
            <UIPrefsProvider>
            {publicGroupToken ? (
                <Suspense fallback={<p>正在加载分享…</p>}><PublicGroupPage token={publicGroupToken} /></Suspense>
            ) : publicToken ? <Suspense fallback={<p>正在加载分享…</p>}><PublicNotePage token={publicToken} /></Suspense> : <App />}
            </UIPrefsProvider>
            {/* 部署版本徽标（右下角）：公开分享页仍显示，方便核对「跑的是哪一版」；
                主页面改由 App 内部渲染——记事本页整屏覆盖时隐藏，避免压在正文上。 */}
            {publicGroupToken || publicToken ? <BuildBadge /> : null}
        </ErrorBoundary>
    </StrictMode>
);

/**
 * 拆掉 index.html 里那段内联骨架。
 *
 * React 19 的 createRoot 在首次提交时会清空容器子节点，所以正常路径下这里查到的是
 * null、什么都不做；留着它是为了兜住另外两种可能：
 *   - 将来换成 hydrateRoot（不会清空容器），骨架会永远压在界面下面；
 *   - 挂载抛错被 ErrorBoundary 之外的路径拦下，界面没起来但骨架还在。
 * 放在 rAF 里而不是紧跟 render()：并发渲染的首帧未必已提交，立刻删会在界面出现前
 * 先闪一下底色；等一帧既不影响体感，也保证「骨架 → 界面」是无缝接上的。
 */
requestAnimationFrame(() => document.getElementById("boot-skeleton")?.remove());

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
