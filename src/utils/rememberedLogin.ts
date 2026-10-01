// 只记账号名；持续登录由服务端 HttpOnly Cookie 管理，绝不保存密码。
const STORAGE_KEY = "navihive:rememberedLogin";
export interface RememberedLogin { username: string }

/** 读取时顺带清除旧版本曾保存的密码。 */
export function readRememberedLogin(): RememberedLogin | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (parsed && typeof parsed.username === "string") {
            const safe = { username: parsed.username };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
            return safe;
        }
        localStorage.removeItem(STORAGE_KEY);
    } catch { /* 存储不可用时不回填 */ }
    return null;
}

export function saveRememberedLogin(login: RememberedLogin): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ username: login.username }));
    } catch { /* 隐私模式 */ }
}

export function clearRememberedLogin(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 隐私模式 */ }
}
