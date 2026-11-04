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
    startedAt?: number;
    finishedAt?: number;
}

/** 回滚类终态：只作「显式否决」用，UI 据此给专门文案，不新增 kind 分支 */
export type UpgradeRollbackPhase = "rolled_back" | "rollback_failed";

export type UpgradeWaitResult =
    | { kind: "upgraded" }
    // rollback 是可选判别字段：只有读到回滚终态时才带；普通 failed 的形状保持原样
    | { kind: "failed"; message: string; rollback?: UpgradeRollbackPhase }
    | { kind: "timeout" };

/**
 * 两个「升级已经结束但没成功」的终态，读到就立刻否决，绝不再看版本号。
 *
 * R05 的漏洞正是：容器重建后新静态清单已经可读（版本号先变），健康门禁随后才判定
 * 不健康并回滚。若先判版本号，UI 会先宣布「升级完成」，稍后才被回滚打脸。
 * 现在只要这一跳读到终态，即使同一跳版本号也变了，也一律判失败。
 */
const ROLLBACK_VETO: Record<UpgradeRollbackPhase, string> = {
    rolled_back: "升级失败，已自动回滚到上一版本（新容器健康检查未通过）。请查看服务器 upgrader 日志后再试。",
    rollback_failed: "回滚也失败，请上服务器检查：升级失败且自动回滚未成功，需要人工介入。",
};

export interface RollbackVeto {
    phase: UpgradeRollbackPhase;
    message: string;
}

/** phase → 否决（终态 + 人读文案）；非回滚相位一律返回 null，既有判定一个字节不变 */
export function rollbackVeto(phase: string | undefined): RollbackVeto | null {
    if (phase === "rolled_back") return { phase, message: ROLLBACK_VETO.rolled_back };
    if (phase === "rollback_failed") return { phase, message: ROLLBACK_VETO.rollback_failed };
    return null;
}

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
 *  - `failed`  ：服务端报 failed，或读到 rolled_back / rollback_failed 的显式否决，带上原因
 *  - `timeout` ：等超时了，如实告诉用户「没等到」，而不是假装成功
 *
 * ⚠️ 相位判定必须排在版本号之前：新静态清单可能在回滚发生前就短暂可读，
 *    先判版本号就会「版本已变 → 误报升级成功」（R05）。否决只做显式终态，
 *    不要求「必须有 done 相位才算成功」—— 那样会破坏既有 restart/接口全炸的用例。
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

        // ① 先读服务端自己报的 phase 并判「显式否决」，**再**看版本号 —— 顺序是 R05 的关键。
        //    容器重启中会连不上/变成 502，一律当「还不知道」。
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
        // rolled_back / rollback_failed 一读到就返回失败：即使这一跳版本号已经变了
        // 也不能判 upgraded。仍归到 kind:"failed"（不新增 kind，UpgradeWaitResult 最小改动），
        // 可选的 rollback 字段供 UI 给专门文案与 data-update-rolled-back 锚点。
        const veto = rollbackVeto(status?.phase);
        if (veto) {
            const detail = (status?.error || "").trim();
            const message = detail ? `${veto.message}（服务端：${detail}）` : veto.message;
            return { kind: "failed", message, rollback: veto.phase };
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
