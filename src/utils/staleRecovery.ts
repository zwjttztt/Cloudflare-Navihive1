// src/utils/staleRecovery.ts
// 「页面停在旧版 / 旧资源取不到」时的自救：清掉本站缓存与 SW 注册，然后重载一次。
//
// 为什么从 main.tsx 抽出来：这套逻辑是**站点升级后不白屏的唯一保障**，而它的特点是
// 「只在版本漂移时才跑、平时完全不出现」—— 最容易被无声改坏的那类。放在入口文件里
// 只能靠真机验证（import 即执行副作用，单测根本够不着），2026-10-20 的评估就把它列成了
// 「9 个从未被用例引入的源文件」之首。抽成独立模块后它有了单测，入口只负责调用。
//
// 行为与原来完全一致（含那两个坑）：
//   - 只重载一次：sessionStorage 记令牌，网络真不通时不反复刷新
//   - 真离线时不动：断网点开弹窗本来就取不到懒加载块，清缓存 + 重载等于把还能用的
//     离线页面换成浏览器错误页（见 utils/assetRecovery.ts 的说明）
//   - 两条触发路径共用同一个 `recovering` 闩：脚本加载失败与版本漂移同时发现问题时
//     只刷一次，不竞态刷两遍

import { shouldRecoverAssets, type AssetRecoveryInput } from "./assetRecovery";

/** 已经在重载了 —— 两条路同时发现问题时只刷一次 */
let recovering = false;

/** 测试用：把模块级闩复位（否则同一文件里第二个用例会被第一个的 true 挡住） */
export function resetRecoveryLatch(): void {
    recovering = false;
}

export interface RecoverOptions extends AssetRecoveryInput {
    /** 触发原因，只进 console，给看控制台的人一条「页面为什么闪了一下」的说明 */
    reason: string;
    /** 一次性令牌的 key。「版本落后」与「资源取不到」是两件事，不该互相顶掉名额 */
    key: string;
}

/**
 * 跑一次自救。返回是否真的重载了 —— 调用方（与测试）能据此判断，不用去猜。
 *
 * 读不到令牌存储（隐私模式）也照常重载：拿到新 HTML 就能自己恢复，代价只是可能多刷一次。
 */
export async function recoverFromStaleAssets(options: RecoverOptions): Promise<boolean> {
    if (recovering) return false;
    // 真离线时不要动（见文件头）
    if (!shouldRecoverAssets({ online: options.online, alreadyTried: options.alreadyTried })) return false;
    recovering = true;
    try {
        if (sessionStorage.getItem(options.key)) return false;
        sessionStorage.setItem(options.key, String(Date.now()));
    } catch {
        // 隐私模式下 sessionStorage 可能不可用，那就直接重载一次
    }
    // 这一处 console 是**故意留的**：它不是错误上报，而是给正在看控制台的人
    // （自己调试、或用户截图过来）一条「页面为什么闪了一下」的说明。
    // 其余浏览器端的 console.error 都已经换成 utils/errorReporter 的 reportError
    // —— 那个会先 sanitize 掉 password / token 再上报。
    console.warn("检测到旧版本资源加载失败，清缓存后重试一次：", options.reason);
    await (async () => {
        try {
            if (typeof caches !== "undefined") {
                const keys = await caches.keys();
                await Promise.all(keys.filter(k => k.startsWith("navihive-")).map(k => caches.delete(k)));
            }
        } catch {
            // 清理失败也照常重载：只要拿到新 HTML 就能自己恢复
        }
        try {
            if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch {
            // 同上
        }
        window.location.reload();
    })();
    return true;
}
