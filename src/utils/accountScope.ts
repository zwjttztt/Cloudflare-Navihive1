// src/utils/accountScope.ts
// 浏览器本地数据（离线队列、撤销快照、偏好）的账号边界。
//
// 为什么需要它：这些数据早先一律存在全局键里。同一台浏览器上 A 登出、B 登入之后，
// A 留下的「待同步操作」会在 B 的会话里被重放 —— 等于把一个人的编辑写进另一个人的
// 账号（数据串号），而撤销快照里还可能带着站点密码。
// 所以每条本地数据都要带账号归属：id 变了的那一刻，就得把不属于当前账号的切走。

const ACTIVE_KEY = "navihive:activeAccount";

/**
 * 给存储键加上账号后缀。
 * 未登录 / 取不到 id 时统一归到 `anon` 一档，免得把匿名时期的数据算到某个账号头上。
 */
export function scopedKey(base: string, uid: number | null): string {
    return uid === null ? `${base}:anon` : `${base}:u${uid}`;
}

/** 读出上一次生效的账号（没记录过就是 null） */
export function readActiveAccount(): number | null {
    try {
        const raw = (globalThis.localStorage as Storage | undefined)?.getItem(ACTIVE_KEY);
        if (raw === null || raw === undefined || raw === "") return null;
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * 切换当前账号。
 *
 * 返回 true 表示「换人了」：调用方要顺手清掉内存里的账号相关状态
 * （撤销栈、队列角标、选中的卡片等），否则界面上还会留着上一个账号的痕迹。
 */
export function setActiveAccount(uid: number | null): boolean {
    const prev = readActiveAccount();
    try {
        (globalThis.localStorage as Storage).setItem(
            ACTIVE_KEY,
            uid === null ? "" : String(uid)
        );
    } catch {
        // 隐私模式：写不进去也只是本次会话内不做切换判断
    }
    return prev !== uid;
}

/** 登出：不再有账号归属 */
export function clearActiveAccount(): void {
    try {
        (globalThis.localStorage as Storage).removeItem(ACTIVE_KEY);
    } catch {
        // 忽略
    }
}
