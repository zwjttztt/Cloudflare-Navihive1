// src/components/app/AppOverlays.tsx
// App 顶部那一排「浮层」：滚动进度条 / 维护横幅 / 分组分享 / 断网横幅 /
// 回到顶部 / 读屏播报区 / 限流倒计时 / 提示条 / 背景装饰层。
//
// 为什么能整块搬出来（2026-11 D6）：这九个东西全是 fixed / absolute 定位、
// 脱离文档流，与下面的页面骨架没有布局关系 —— 搬的时候**一个节点都没动**，
// 顺序、条件、key、sx 全部原样，所以渲染结果逐像素不变。
//
// 它们原来夹在四个 Provider 与根 <Box> 之间，改页面骨架每次都跨过这 56 行。
//
// ⚠️ 下面三条纪律是踩过坑留下的，别顺手合并：
//   1. GroupShareDialog 与 OfflineBanner 必须平级，不许把前者嵌进
//      `showOfflineBanner` 条件里（在线时横幅恒不显示，分享就永远弹不出来）；
//   2. RateLimitBanner 始终挂载、内部自订阅，同一条纪律；
//   3. AriaLiveRegion 要先于内容存在，读屏才会念。
import { lazy, Suspense } from "react";
import ScrollProgress from "../ScrollProgress";
// 维护模式横幅：服务端开着 maintenance.enabled 时挂出来（写操作会被 503 拦下）。
//
// ⚠️ 2026-10-13：这里原来是 lazy，实测**白多一次请求**。它必须常驻（要自己每 60 秒
// 轮询维护状态），所以 lazy 省不掉下载 —— 只剩一个 790 字节的独立块，而这条链路上
// 每个请求要另付 1~3 秒固定往返。改回静态 import：+0.9 KB 进 index，换少一次往返。
// （2026-11 D6 移入本文件时同样保持静态 import。）
import MaintenanceBanner from "../MaintenanceBanner";
import BackToTop from "../BackToTop";
// 读屏播报区常驻的理由见下面挂载点，也见组件自己的头注。
import AriaLiveRegion from "../AriaLiveRegion";
// 429 限流的倒计时提示条。同步 import 而不是 lazy：它自身没有任何依赖（只有 MUI 的
// Alert/Button，首屏早就有了），而 lazy 会在「刚被限流」那一刻多一次 chunk 请求 ——
// 限流时最不该做的就是再发请求。组件默认渲染 null，常驻挂载不占位。
import RateLimitBanner from "../RateLimitBanner";
import BackgroundLayers from "../BackgroundLayers";
import ChunkBoundary from "../ChunkBoundary";
import type { useNotify } from "../../hooks/useNotify";
import type { NavigationClient } from "../../API/client";
import type { MockNavigationClient } from "../../API/mock";

/** App 里那个模块级 api 单例的类型（真客户端或 mock，见 App.tsx 顶部） */
export type AppApi = NavigationClient | MockNavigationClient;

/**
 * 提示条那一整套状态：就是 hooks/useNotify 的返回值。
 *
 * 为什么整份传而不是拆成六个 prop：open / message / severity / duration / action /
 * close 这六件事永远一起用，拆开既没多一分表达力，还让首屏包多背一二百字节的
 * 属性名（对象键名压缩不掉，而局部变量能 —— 首屏余量只剩 5%，这里省的是真钱）。
 */
export type SnackbarState = ReturnType<typeof useNotify>;

// 懒加载声明跟着挂载点走（从 App.tsx 搬来，路径与条件一个字没改）：
// 块只在「真的挂上」时才下载。
//
// 断网提示只在断网 / 刚恢复 / 有同步失败项时才看得见，其余时候渲染出来也是 null，
// 没必要占首屏（实测 3.7 KB）。挂不挂由 useOfflineBannerVisible 决定，块按需下载。
const OfflineBanner = lazy(() => import("../OfflineBanner"));
// 顶部提示条：懒加载 + 有提示才挂载（Snackbar 那套不进首屏关键路径，
// 见 docs/site-audit-2026-10-15.md P1）。
const SnackbarHost = lazy(() => import("../SnackbarHost"));
// 分组分享：点「分享分组」才可能用到，块按需下载。
const GroupShareDialog = lazy(() => import("../GroupShareDialog"));

export interface AppOverlaysProps {
    /** 维护横幅的探测 client、分享对话框的 api（还会 use 它上面有没有 createGroupShare） */
    api: AppApi;
    /** 提示条那六件事（open/message/severity/duration/action/close）+ notify + 播报文本 */
    snackbar: SnackbarState;
    /** 背景图 URL（空字符串 = 不用背景图）。派生自 configs["site.backgroundImage"] */
    backgroundImageUrl: string;
    /** 蒙版不透明度 0~1。派生自 configs["site.backgroundMaskOpacity"]（见 utils/backgroundMask） */
    backgroundMaskOpacity: number;
    darkMode: boolean;
    /** 正在分享的分组；null = 对话框不挂载（连块都不下） */
    shareGroupId: number | null;
    shareGroupName: string;
    onCloseGroupShare: () => void;
    /** 断网 / 恢复 / 有同步失败项时挂上断网横幅（判断在 useOfflineBannerVisible） */
    showOfflineBanner: boolean;
}

export default function AppOverlays({
    api,
    snackbar,
    backgroundImageUrl,
    backgroundMaskOpacity,
    darkMode,
    shareGroupId,
    shareGroupName,
    onCloseGroupShare,
    showOfflineBanner,
}: AppOverlaysProps) {
    return (
        <>
            {/* 顶部滚动进度条：固定贴在最上方，纯装饰 */}
            <ScrollProgress />
            {/* 维护模式横幅：服务端维护中时提示「能看不能改」。
                同样与断网横幅平级 —— 别嵌进任何条件渲染里（分享对话框那个坑） */}
            <MaintenanceBanner client={api} />
            {/* 分组分享（2026-10-11 阶段④）：创建/更新/撤销/复制链接。
                ⚠️ 必须与断网横幅平级——2026-10-11 曾被误嵌进 showOfflineBanner
                条件内，导致在线时（横幅恒不显示）点「分享分组」永远弹不出对话框。 */}
            {shareGroupId !== null && typeof api.createGroupShare === "function" && (
                <Suspense fallback={null}>
                    <GroupShareDialog
                        open
                        groupId={shareGroupId}
                        groupName={shareGroupName}
                        onClose={onCloseGroupShare}
                        api={api as never}
                        onNotify={snackbar.notify}
                    />
                </Suspense>
            )}
            {/* 断网 / 恢复的浮动提示：断网或有失败项时才挂上（块按需下载） */}
            {showOfflineBanner && (
                <ChunkBoundary>
                    <OfflineBanner />
                </ChunkBoundary>
            )}

            {/* 回到顶部：滚过一屏才出现 */}
            <BackToTop />

            {/* 读屏播报区常驻：live region 要先于内容存在，读屏才会念出来 */}
            <AriaLiveRegion message={snackbar.liveMessage} />

            {/* 429 限流倒计时：始终挂载，内部自订阅 RATE_LIMITED_EVENT、无事件时渲染 null。
                与断网横幅同一条纪律 —— 别嵌进任何条件渲染里（分享对话框那个坑）。 */}
            <RateLimitBanner />

            {/* 顶部提示条：有提示才挂载，且整块懒加载（Snackbar 不进首屏关键路径） */}
            {snackbar.open && (
                <Suspense fallback={null}>
                    <SnackbarHost
                        open={snackbar.open}
                        message={snackbar.message}
                        severity={snackbar.severity}
                        duration={snackbar.duration}
                        action={snackbar.action}
                        onClose={snackbar.close}
                    />
                </Suspense>
            )}

            <BackgroundLayers
                imageUrl={backgroundImageUrl}
                maskOpacity={backgroundMaskOpacity}
                darkMode={darkMode}
            />
        </>
    );
}
