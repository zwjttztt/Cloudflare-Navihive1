// 本机数据的「哪些算本应用」与「怎么清」。
// 单独成文件而不是放在 ErrorBoundary.tsx 里导出，是因为后者是个组件文件：
// 组件文件里再导出普通函数会让 react-refresh 失效（only-export-components）。

/** 本机数据里哪些 key 属于本应用：清理时按前缀 + 几个固定 key 删 */
const NAV_PREFIXES = ["navihive:"];

export function listLocalAppKeys(): string[] {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (NAV_PREFIXES.some(p => k.startsWith(p))) keys.push(k);
    }
    // 几个没有前缀但也是本机状态的 key
    // 注意：不再包含 auth_token —— 令牌已改存 httpOnly cookie，旧值会在启动时清掉，
    // 更不能进错误报告（会被原样上报出去）
    for (const extra of ["theme", "collapsedGroups", "rememberedLogin"]) {
        if (localStorage.getItem(extra) !== null && !keys.includes(extra)) keys.push(extra);
    }
    return keys;
}

/** 清空本机数据；includeAuth=false 时保留登录票据 */
export function clearLocalAppData(includeAuth: boolean) {
    const keys = listLocalAppKeys();
    for (const k of keys) {
        if (!includeAuth && k === "auth_token") continue;
        try {
            localStorage.removeItem(k);
        } catch {
            // 隐私模式下 localStorage 可能不可写，忽略
        }
    }
    if (includeAuth) {
        try {
            localStorage.removeItem("rememberedLogin");
        } catch {
            // 清不掉也不影响，只是让用户下次要重新输账号名
        }
    }
    // 顺手清掉会话级首屏缓存，避免重载后又拿到同一份坏数据
    try {
        sessionStorage.removeItem("navihive:bootstrap");
    } catch {
        // 同上：清不掉顶多重拉一次
    }
}
