// 判断「我现在跑的这一版，是不是服务端现在那一版」。
//
// 背景是这个项目最容易撞上的一类故障：**版本漂移**。
// Service Worker 为了离线可用，会把上一次成功加载的 HTML 外壳缓存下来；
// 网络不通时导航请求失败，它就把那份外壳喂给浏览器。
// 而外壳引用的 JS 块带内容 hash，新版本一上线旧 hash 的文件就没了 ——
// 于是页面能起来（首屏那几个 core 块是跟外壳同一版、一起被缓存的），
// 但一点开某个懒加载弹窗，动态 import 取回 404，界面卡死或全白。
// 用户看到的是「网站坏了」，实际是「页面停在上一版」。
//
// 只靠「动态 import 失败再补救」是不够的：那份补救代码也在这版产物里，
// 而真正出问题的正是**上一版**产物，它根本没有那段代码。
// 所以得在加载阶段就主动对一次版本号 —— 这一版有，下一版就有，
// 于是从这一版起「停在旧版」这件事能被自己发现并自愈。
//
// 版本号同源很重要：前端烘进去的 __NAVIHIVE_BUILD_VERSION__ 和服务端
// precache-manifest.json 的 version 必须是同一个值（vite.config.ts 里共用一个常量）。
// 两边各取一次 Date.now() 的话它们永远不相等，页面会每次加载都判定自己过期。

/**
 * 构建时由 vite.config.ts 的 define 烘进来的构建号。
 *
 * 声明成**可选**：单测跑在 node 里、开发模式也没有这份替换，那时它就是 undefined，
 * 类型上必须写得出来，否则「没烘进去」这种情况会被类型系统假装不存在。
 *
 * 为什么不放到 vite-env.d.ts 的 declare global：tsconfig 的 moduleDetection 是 force，
 * .d.ts 会被当成模块，declare global 在这个组合下跨文件读不到（实测 Cannot find name）。
 * 放在用到的这个模块里最省事，也顺带把「只有这里会读它」这件事写明白了。
 */
declare const __NAVIHIVE_BUILD_VERSION__: string | undefined;

/** 服务端预缓存清单的地址（跟 public/sw.js 里读的是同一份） */
export const PRECACHE_MANIFEST_URL = "/precache-manifest.json";

/**
 * 本机这一版的构建号。
 * 开发模式 / 单测环境（没有 define）读到的是空串 —— 空串表示「不参与判断」，
 * 这样拿不到构建号时不会误伤正常页面。
 */
export function localBuildVersion(): string {
    return typeof __NAVIHIVE_BUILD_VERSION__ === "string" ? __NAVIHIVE_BUILD_VERSION__ : "";
}

/**
 * 从服务端清单里读出版本号。
 *
 * 清单拿不到、不是对象、version 缺失或不是字符串/数字 —— 一律返回 null。
 * 「不知道服务端是哪一版」时必须什么都不做：宁可让用户先用着旧页面，
 * 也不能因为一次接口抖动就把一个本来正常的页面刷一遍。
 */
export function readServerVersion(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const version = (payload as { version?: unknown }).version;
    if (typeof version === "string") {
        return version.trim() || null;
    }
    // 老版本的清单里 version 是数字（Date.now()），一样认
    if (typeof version === "number" && Number.isFinite(version)) return String(version);
    return null;
}

/** 拉一次服务端清单，只取版本号。任何失败都返回 null：不抛、不刷页面。 */
export async function fetchServerVersion(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
    url: string = PRECACHE_MANIFEST_URL
): Promise<string | null> {
    try {
        const response = await fetchImpl(url, {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        return readServerVersion((await response.json()) as unknown);
    } catch {
        // 网络不通 / 返回的不是 JSON：都当作「不知道」，不触发重载
        return null;
    }
}

/**
 * 本机这一版是否与服务端的不是同一版。
 *
 * 两个方向都算过期：落后（服务端更新了）和领先（服务端回滚了）。
 * 只要不一样，页面上的 JS 块和服务器上的文件就不是一套，迟早取不到。
 */
export function isStaleBuild(local: string, server: string | null): boolean {
    if (!local || !server) return false;
    return local !== server;
}
