// src/utils/authFlow.ts
// 登录 / 登出 / 认证检查这条路上几处「判断错了就会出现怪现象」的判定。
//
// 它们原本散在 useAccountSession 里，夹在 await 与 setState 之间，想测就得把整个
// hook 连着 DOM 一起拉起来。搬到这里之后是纯函数：给什么输入、出什么结果，
// 一眼能看完，也能直接写用例钉住。
//
// 这些判定的共同点是**错了不会报错，只会让人对着界面干瞪眼** ——
// 登录成功却立刻弹回登录页、阈值显示 90 天实际跑的是 30 天、被停用的账号看到一片空白。

import {
    INACTIVE_DISABLE_DAYS_DEFAULT,
    INACTIVE_DELETE_GRACE_DAYS_DEFAULT,
} from "../API/http";

/**
 * 沉睡治理阈值：读不到（没配过 / 配成了乱七八糟的值）就回落到服务端默认。
 *
 * 为什么要 > 0 而不是 >= 0：0 天意味着「今天注册明天就停用」，配成 0 基本都是误操作，
 * 按默认处理比照办安全。界面上显示的数字必须和实际生效的一致，否则 owner 会以为改了没用。
 */
export function resolveInactivePolicy(
    disableRaw: string | null | undefined,
    graceRaw: string | null | undefined
): { disableDays: number; graceDays: number } {
    return {
        disableDays: toPositiveDays(disableRaw, INACTIVE_DISABLE_DAYS_DEFAULT),
        graceDays: toPositiveDays(graceRaw, INACTIVE_DELETE_GRACE_DAYS_DEFAULT),
    };
}

function toPositiveDays(raw: string | null | undefined, fallback: number): number {
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

/**
 * 手动扫描沉睡账号的结果。
 *
 * `resOk` 要一起看：服务端也可能在 4xx/5xx 的响应体里带上 success:true，
 * 只看 body 会把一次失败当成成功（界面提示「已扫描」其实什么都没发生）。
 * 两个计数一律补 0 —— 界面上要显示「停用了 N 个」，undefined 会印出 NaN。
 */
export function readSweepResult(
    resOk: boolean,
    data: { success?: boolean; message?: string; disabled?: number; deleted?: number }
): { success: boolean; message?: string; disabled: number; deleted: number } {
    if (!resOk || data.success !== true) {
        return {
            success: false,
            message: data.message || "扫描失败，请稍后再试",
            disabled: 0,
            deleted: 0,
        };
    }
    return {
        success: true,
        ...(data.message === undefined ? {} : { message: data.message }),
        disabled: data.disabled ?? 0,
        deleted: data.deleted ?? 0,
    };
}
