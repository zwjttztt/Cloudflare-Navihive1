// worker/loginGuard.ts

import type { NavigationAPI } from "../src/API/http";

// ============ 登录失败限速 ============
// 连续输错会越等越久，避免密码被无限次猜。
// 计数存在 configs 表的 auth.loginGuard 里 —— auth. 前缀既不返回给前端、也不进备份文件。
export const LOGIN_GUARD_KEY = "auth.loginGuard";
// 前 5 次给手滑留余地，之后每次等待时间翻倍
export const LOGIN_FREE_ATTEMPTS = 5;
export const LOGIN_BASE_LOCK_MS = 60_000; // 第 6 次起锁 1 分钟
export const LOGIN_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

export interface LoginGuard {
    count: number;
    /** 解锁时刻（毫秒时间戳）；0 表示当前不在锁定期 */
    until: number;
}

export async function readLoginGuard(api: NavigationAPI): Promise<LoginGuard> {
    try {
        const raw = await api.getConfig(LOGIN_GUARD_KEY);
        if (!raw) return { count: 0, until: 0 };
        const parsed = JSON.parse(raw) as Partial<LoginGuard>;
        return {
            count: typeof parsed.count === "number" && parsed.count > 0 ? parsed.count : 0,
            until: typeof parsed.until === "number" && parsed.until > 0 ? parsed.until : 0,
        };
    } catch {
        // 读不出来就当没在锁定期：不能因为存储异常把正常用户挡在门外
        return { count: 0, until: 0 };
    }
}

export async function writeLoginGuard(api: NavigationAPI, guard: LoginGuard): Promise<void> {
    try {
        await api.setConfig(LOGIN_GUARD_KEY, JSON.stringify(guard));
    } catch {
        // 写失败只影响限速强度，不影响登录本身
    }
}
