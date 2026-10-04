// 什么时候该「清缓存 + 重载」自救。
//
// 背景见 src/utils/buildVersion.ts 与 src/main.tsx：Service Worker 会把上一版的
// HTML 外壳喂给浏览器，那个外壳引用的懒加载块在新版本里已经没了，取回来是 404，
// 点开弹窗就是一片空白。发现这种故障时的处理是清掉本站缓存与 SW 注册、然后重载一次。
//
// 但同一套动作在**真离线**时是帮倒忙：
// 懒加载块默认不预缓存（precache 只装 core，见 public/sw.js），所以断网状态下点开
// 任何一个弹窗本来就取不到块 —— 那时清缓存 + 重载，等于把一个还能用的离线页面
// 换成一张「无法访问此网站」，比什么都不做糟得多。
// 离线时正确的行为是保持现状：页面还在，用户看得见自己的数据。
//
// 所以「要不要自救」先过这一关，判断清楚了才动手。

export type AssetRecoveryInput = {
    /**
     * navigator.onLine。
     * 不给（undefined）= 这个环境拿不到该值，按在线处理：
     * 拿不准就不作为，会让「旧壳取不到新块」这个本来能自愈的故障一直挂着。
     */
    online?: boolean;
    /** 本次会话已经自救过一次了 —— 网络真不通时不该反复刷新 */
    alreadyTried?: boolean;
};

/**
 * 是否该走一次「清缓存 + 重载」。
 *
 * 只有一种情况明确返回 false：确实离线。其余（在线、或拿不到在线状态）都该试一次 ——
 * 试错的成本是一次重载，不试的成本是用户一直停在一个坏掉的页面上。
 */
export function shouldRecoverAssets({ online, alreadyTried }: AssetRecoveryInput = {}): boolean {
    if (alreadyTried) return false;
    return online !== false;
}
