// 懒加载块没取到时，界面上该说什么。
//
// 为什么需要单独一层：弹窗都是 lazy chunk，块取不到时 React.lazy 的 promise 会 reject，
// 渲染期抛错会一路冒到最近的错误边界 —— 而全站**只有**根上那一个（main.tsx）。
// 也就是说：断网时点开一个弹窗，整站会被换成「页面出了点问题」，
// 而实际只是那一个弹窗的代码没下载下来，站点数据一点没丢。
//
// 这里把「该说什么」抽成纯函数，是为了让它能被单测钉住 ——
// 文案写反（离线时让用户重试、在线时说要联网）比没有提示更糟，
// 它会把人引向一个根本没用的操作。

export type ChunkFailureText = {
    /** 一句话说清发生了什么 */
    title: string;
    /** 接下来该做什么 */
    hint: string;
    /** 还要不要给「重试」按钮 */
    retryable: boolean;
};

/**
 * @param offline 断网状态（navigator.onLine === false）
 * @param looksLikeChunkError 抛的确实像「块没取到」，而不是弹窗自己渲染出错
 */
export function describeChunkFailure(offline: boolean, looksLikeChunkError: boolean): ChunkFailureText {
    if (!looksLikeChunkError) {
        return {
            title: "这个功能没能打开",
            hint: "界面里出了个问题，站点数据没有受影响。可以重试一次；一直不行就重新加载页面。",
            retryable: true,
        };
    }
    if (offline) {
        // 懒加载块默认不预缓存（见 public/sw.js），断网时本来就取不到 ——
        // 这时让人「重试」是没用的，得说清楚为什么打不开
        return {
            title: "离线状态下这个功能打不开",
            hint: "它的代码还没下载到本机，联网后自动就能用。已经做过的改动都存好了，联网后会继续同步。",
            retryable: false,
        };
    }
    return {
        title: "这个功能没能加载出来",
        hint: "多半是站点刚更新、你打开的还是上一版页面。点重试会重新取一次；不行的话刷新页面即可。",
        retryable: true,
    };
}

/** 判断一个渲染期异常是不是「块没取到」，而不是业务逻辑抛的错 */
export function looksLikeChunkLoadError(error: Error | null): boolean {
    if (!error) return false;
    if (error.name === "ChunkLoadError") return true;
    const message = error.message || "";
    return (
        message.includes("Failed to fetch dynamically imported module") ||
        message.includes("Importing a module script failed") ||
        message.includes("error loading dynamically imported module")
    );
}
