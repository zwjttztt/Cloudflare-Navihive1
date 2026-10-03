// 只记账号名；持续登录由服务端 HttpOnly Cookie 管理，绝不保存密码。
const STORAGE_KEY = "navihive:rememberedLogin";
export interface RememberedLogin { username: string }

/** 读取时顺带清除旧版本曾保存的密码。 */
export function readRememberedLogin(): RememberedLogin | null {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch { /* 存储不可用时不回填 */ }
    if (!raw) return null;

    // 解析与读存储要分开 try：读失败是「存储不可用」（隐私模式，正常现象），
    // 解析失败是「这份数据是坏的」（手改过 / 被写脏）。坏数据永远读不出来，
    // 留着只会让人误以为还记着登录名，所以顺手清掉。
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* 隐私模式 */ }
        return null;
    }

    const obj = parsed as Record<string, unknown> | null;
    if (obj && typeof obj.username === "string") {
        const safe = { username: obj.username };
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(safe)); } catch { /* 隐私模式 */ }
        return safe;
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* 隐私模式 */ }
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
