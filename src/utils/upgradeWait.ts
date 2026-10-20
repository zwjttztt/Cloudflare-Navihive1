// src/utils/upgradeWait.ts
// 「点了更新之后到底怎么样了」。
//
// 2026-10-20 用户报：「点击更新长时间无反应，刷新后还是原来版本。」
// 当时的实情是：服务端确实重启了容器，但 restart 不会重新解析 :latest，
// 跑的还是旧镜像（服务端那边已改）。而页面这一侧同样什么都没说 ——
// 点完只挂一句「升级中」，成了就什么也不发生，败了也不说为什么。
//
// 这里补上闭环：轮询两个信号。
//   1) `/api/system/upgrade` 的 phase —— 服务端自己报的失败原因（进程还活着才读得到）；
//   2) `precache-manifest.json` 的 version —— 版本真的换了没有。
//      构建号由 vite 同时烘进产物和清单（同一常量），所以「清单变了」等价于
//      「服务器上的产物换了」，比任何自定义接口都可信。
//
// 为什么不用 location.reload 直接刷：Service Worker 会把上一版的外壳喂回来，
// 刷完还是旧的。所以要清掉本站缓存并注销 SW 再刷 —— 与 main.tsx 里
// recoverFromStaleAssets 同一套动作，区别只是「这里是有意升级，不是出错自救」。

import { PRECACHE_MANIFEST_URL, fetchServerVersion } from "./buildVersion";

/** 服务端 GET /api/system/upgrade 的响应（只声明用得到的字段） */
export interface UpgradeStatusPayload {
    phase?: string;
    error?: string;
    image?: string;
}

export type UpgradeWaitResult =
    | { kind: "upgraded" }
    | { kind: "failed"; message: string }
    | { kind: "timeout" };

export interface UpgradeWaitOptions {
    /** 本机这一版的构建号；空串表示拿不到（开发模式），此时判定不了 */
    localVersion: string;
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/** 轮询默认上限：拉镜像（首次可能几百 MB）+ 重建，两分钟足够，再久就该给结论了 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 2.5s 一跳：容器重启期间会有几秒的 502，太密只是刷失败日志 */
const DEFAULT_INTERVAL_MS = 2500;

/**
 * 等服务端换成新版本。三个出口，绝不死循环：
 *  - `upgraded`：清单里的构建号变了（调用方随后清缓存重载）
 *  - `failed`  ：服务端报 failed，带上它给的原因
 *  - `timeout` ：等超时了，如实告诉用户「没等到」，而不是假装成功
 */
export async function waitForUpgrade(options: UpgradeWaitOptions): Promise<UpgradeWaitResult> {
    const { localVersion } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const doFetch = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + timeoutMs;

    while (now() <= deadline) {
        await sleep(intervalMs);

        // ① 服务端自己报的失败。容器重启中会连不上/变成 502，一律当「还不知道」
        let status: UpgradeStatusPayload | null = null;
        try {
            const res = await doFetch("/api/system/upgrade", {
                cache: "no-store",
                credentials: "same-origin",
            });
            if (res.ok) status = (await res.json()) as UpgradeStatusPayload;
        } catch {
            // 重启窗口内的网络错误：忽略，继续看版本号
        }
        if (status?.phase === "failed") {
            return { kind: "failed", message: (status.error || "").trim() || "服务端未给出原因" };
        }

        // ② 版本号。带时间戳当 query，避开反向代理/CDN 对 .json 的缓存
        const server = await fetchServerVersion(doFetch, `${PRECACHE_MANIFEST_URL}?t=${now()}`);
        if (localVersion && server && server !== localVersion) return { kind: "upgraded" };
    }
    return { kind: "timeout" };
}

/**
 * 清掉本站的 SW 缓存并注销 SW，然后重载。
 * 读不到缓存（隐私模式、无 SW）也照常重载：拿到新 HTML 就能自己恢复。
 */
export async function reloadWithFreshCache(
    reload: () => void = () => window.location.reload(),
): Promise<void> {
    try {
        if (typeof caches !== "undefined") {
            const keys = await caches.keys();
            await Promise.all(keys.filter(k => k.startsWith("navihive-")).map(k => caches.delete(k)));
        }
    } catch {
        // 清理失败不影响重载
    }
    try {
        if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.unregister()));
        }
    } catch {
        // 同上
    }
    reload();
}
