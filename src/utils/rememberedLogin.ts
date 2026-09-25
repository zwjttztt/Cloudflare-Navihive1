// 登录界面「记住账号密码」的本地存储。
//
// 说明：这里会把账号密码明文保存在浏览器的 localStorage 中，仅用于下次打开页面时自动回填，
// 方便个人设备上免去每次输入。公共场所使用的设备请不要勾选，或在使用后取消勾选并登录一次以清除。

const STORAGE_KEY = "navihive:rememberedLogin";

export interface RememberedLogin {
    username: string;
    password: string;
}

/** 读取已记住的账号密码；没有记录或数据损坏时返回 null */
export function readRememberedLogin(): RememberedLogin | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<RememberedLogin> | null;
        if (parsed && typeof parsed.username === "string" && typeof parsed.password === "string") {
            return { username: parsed.username, password: parsed.password };
        }
    } catch {
        // 数据损坏时忽略，按「未记住」处理
    }
    return null;
}

/** 保存账号密码 */
export function saveRememberedLogin(login: RememberedLogin): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(login));
    } catch {
        // 隐私模式下可能写入失败，忽略即可
    }
}

/** 清除已记住的账号密码 */
export function clearRememberedLogin(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 忽略
    }
}
