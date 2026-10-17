// src/utils/authFlow.ts
// 登录 / 登出 / 认证检查这条路上几处「判断错了就会出现怪现象」的判定。
//
// 它们原本散在 useAccountSession 里，夹在 await 与 setState 之间，想测就得把整个
// hook 连着 DOM 一起拉起来。搬到这里之后是纯函数：给什么输入、出什么结果，
// 一眼能看完，也能直接写用例钉住。
//
// 这些判定的共同点是**错了不会报错，只会让人对着界面干瞪眼** ——
// 登录成功却立刻弹回登录页、被停用的账号看到一片空白。

/** 认证检查失败之后该怎么处置 */
export interface AuthFailure {
    /** 要不要退回登录页 */
    backToLogin: boolean;
    /**
     * 附带转述给用户的话。目前只有「账号被停用 / 已注销」（HTTP 403）会给 ——
     * 服务端带的那句「可以怎么用恢复密钥找回」必须原样送到登录页，
     * 否则用户看到的是一片空白，既不知道为什么也不知道能怎么办。
     */
    message?: string;
}

const DISABLED_SUFFIX = /\s*\(HTTP 403\)$/;

/**
 * 判断一次认证失败要不要把人踢回登录页。
 *
 * 只有两类算：令牌失效 / 未登录（服务端报「认证」开头的错）、账号被停用（403）。
 * 其余（比如网络抖一下）保持原状 —— 一次偶发失败就把人踢出去，比让他多刷一次更糟。
 */
export function classifyAuthFailure(error: unknown): AuthFailure {
    if (!(error instanceof Error)) return { backToLogin: false };
    const message = error.message;
    if (message.includes("HTTP 403")) {
        return { backToLogin: true, message: message.replace(DISABLED_SUFFIX, "") };
    }
    if (message.includes("认证")) return { backToLogin: true };
    return { backToLogin: false };
}

/**
 * 登录接口返回 200，但接下来第一个请求还是 401 —— cookie 没被浏览器存上。
 *
 * 最常见的原因是反代：Worker 看到回源用的是 https 于是下发带 Secure 的 cookie，
 * 而用户当前是 http 访问，浏览器按规范直接丢弃。这两句提示必须分开写，
 * 因为「请改用 HTTPS」对已经是 https 的人毫无意义，只会把他引到「禁用 Cookie」上去查。
 */
export function cookieRejectedMessage(isHttps: boolean): string {
    return isHttps
        ? "登录状态没能保存，请检查浏览器是否禁用了 Cookie 或拦截了本站 Cookie"
        : "登录状态没能保存：当前通过 HTTP 访问，浏览器拒绝保存安全 Cookie。请改用 HTTPS（或 localhost）访问";
}
