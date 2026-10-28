// src/API/transport.ts
// 前端 HTTP 客户端的**传输层**：超时预算、幂等头、错误形状翻译，以及那条
// JS 可读的「已登录」标记 cookie 的读写。
//
// 为什么单独出来（P2-10）：以前这些和 90 个业务方法一起躺在 client.ts 里。
// 业务方法按域搬去 clientMethods/*.ts 之后，它们（登录、导入、WebDAV…）都要用
// 同一套 cookie 与错误翻译 —— 留在类里就得把 private 全放开、跨文件互相看见，
// 抽成纯函数反而更干净：不碰实例状态，单测能直接调。
//
// ⚠️ 这里**没有**任何凭据：真正的令牌在 httpOnly cookie 里，JS 拿不到。
// 这条 `navihive_session` 只是个布尔标记，让刷新后界面立刻知道「已登录」。

import type { Note } from "./http";
import { parseApiError, type ApiErrorInfo } from "./apiError";

/** 普通 API 请求的超时：30 秒。上传/下载/导入导出等慢端点不适用（见 client.ts 的 request） */
/**
 * 域方法体（clientMethods/*.ts）需要的那点 `this`。
 *
 * ⚠️ 刻意**不是** NavigationClient 本身：App / useAccountSession / useBackupController
 * 里两个客户端是联合类型 `NavigationClient | MockNavigationClient`。若把 `this` 写成
 * NavigationClient，TS 会要求 Mock 与真客户端**逐方法**同形 —— 任何一处签名差异
 * （返回类型、是否 async）都会让**所有**调用点一起红，改一个方法要顺带修十个文件。
 * 而「两侧形状是否一致」这件事本身该被盯住，只是不该用编译错误来盯：
 * tests/clientSurface.test.ts 在运行时逐个方法比对，报错只报那一条。
 */
export interface ClientThis {
    baseUrl: string;
    idempotencyKey: string | null;
    request<T = unknown>(
        endpoint: string,
        options?: { signal?: AbortSignal; timeoutMs?: number; [k: string]: unknown }
    ): Promise<T>;
    isLoggedIn(): boolean;
    clearToken(): void;
    setSessionCookie(ttlSeconds: number): void;
    /**
     * 下面三个是**跨域调用**用的：checkAuthStatus 拿 getConfigs 当「会话还活着吗」的探针、
     * compareAndSetConfig 读/写单键配置。它们本不属于传输层，列在这里是因为
     * 域方法体之间确实互相调用，而 `this` 又不能写成完整的 NavigationClient
     * （理由见上面）。Mock 里这三个都有实现，所以联合类型照样成立。
     */
    getConfigs(): Promise<Record<string, string>>;
    getConfig(key: string): Promise<string | null>;
    setConfig(key: string, value: string): Promise<boolean>;
}

/**
 * 「只写一个配置键」的那点能力。
 *
 * usePrefSync / useGroupAccent 只需要 setConfig，参数类型就只该要求 setConfig。
 * ⚠️ 不能写成 `Pick<NavigationClient, "setConfig">`：Pick 会把域方法体上的
 * `this: ClientThis` 一起带过来，于是调用点被迫凑齐整个 ClientThis（baseUrl、
 * request…），而那里传进来的只是个 hook 参数 —— 只想写一个键却要假装成客户端。
 * 这里刻意**不声明 this**，target 不带 this 时 TS 不检查 source 的 this，
 * 真客户端与演示客户端都能直接传进来。
 */
export interface ConfigWriter {
    setConfig(key: string, value: string): Promise<boolean>;
}

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 前端可读的那条「已登录」标记 cookie 的名字。
 *
 * ⚠️ **全站唯一定义点**在 shared/sessionCookie.ts，这里只是再导出：
 * 服务端下发 / 清除 cookie 的 worker/httpUtils.ts 引的是同一个常量。
 * 以前两处各写一个 "navihive_session" 字符串，改了前端忘了服务端（或反过来）就会：
 * 登录接口 200、前端也写了标记，但服务端那条令牌 cookie 的名字对不上 →
 * 下一个请求 401 → 界面刚登录成功就闪回登录页，而且是**全站静默掉线**。
 *
 * （不直接让 worker 引本文件是因为这里有 DOM 全局、worker 那侧没有 DOM lib，
 * 详见 shared/sessionCookie.ts 顶上那段。）
 */
import { SESSION_COOKIE } from "../../shared/sessionCookie";
// 再导出一份：下面几个函数自己也要用，同时保留原本从这里取这个名字的路径
export { SESSION_COOKIE };

/**
 * 本地登录标记要不要带 Secure —— 必须和服务端那条 httpOnly 令牌 cookie 保持一致。
 * 不一致会造出「标记在、令牌不在」的半登录态：isLoggedIn() 为真于是直接渲染主界面，
 * 紧接着第一个接口 401，界面又弹回登录页，看起来就像刚登录成功就闪退。
 * （典型触发：先用 https 登录过，之后改从 http 访问同一个域名。）
 */
export function secureAttr(): string {
    return typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
}

export function hasSessionCookie(): boolean {
    if (typeof document === "undefined") return false;
    return document.cookie
        .split(";")
        .some(part => part.trim().startsWith(`${SESSION_COOKIE}=1`));
}

/**
 * 写登录标记。
 *
 * 必须带上和服务端一致的 Max-Age，否则会把服务端那条持久 cookie 覆盖成会话 cookie，
 * 「记住我」勾选了却在关掉浏览器后被登出。
 */
export function setSessionCookie(ttlSeconds: number): void {
    if (typeof document === "undefined") return;
    document.cookie = `${SESSION_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=${ttlSeconds}${secureAttr()}`;
}

/** 清掉本地登录标记（令牌本身由服务端 /api/logout 清掉） */
export function clearSessionCookie(): void {
    if (typeof document === "undefined") return;
    document.cookie = `${SESSION_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secureAttr()}`;
}

// 旧版本把令牌存在 localStorage，这里一次性清掉遗留值，避免它留在浏览器里
export function purgeLegacyToken(): void {
    try {
        localStorage.removeItem("auth_token");
    } catch {
        // localStorage 不可用时忽略
    }
}

/**
 * 401 的全局广播事件名（命名跟 utils/collapse.ts 的 `navihive:collapsed-changed` 一致）。
 *
 * 为什么需要它：401 不只发生在 bootstrap 上。令牌过期之后，用户点任何按钮拿到的
 * 都是一条 401，而原来「回登录页」只接在 bootstrap 那一条链路上 —— 于是界面上
 * 只会一次次弹出同一句 toast，永远停在原地。
 *
 * 为什么不在 client 里直接跳登录页：client 是纯传输层，它不该知道「登录页」「设置弹窗」
 * 这些 UI 概念。这里只广播一个**无载荷**的事件（Event 而不是 CustomEvent —— 没有
 * 明细要传，服务端的文案和 code 已经裹在抛出的 ApiError 里了），由 App 统一处置。
 */
export const UNAUTHORIZED_EVENT = "navihive:unauthorized";

/** 广播一次「会话不可用了」。SSR / 测试环境没有 window 时安静跳过 */
export function notifyUnauthorized(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

/**
 * 裸 fetch 出口统一取错误文案。
 *
 * 登录 / 注册 / 恢复 / 邀请码 / 注销账号 / 导入这几个端点不走 `request()`
 * （它们要么在登录态外，要么要自己读响应体），迁移前直接读 `data.message`；
 * 服务端迁移到统一错误码后失败体变成 `{ error: { code, message } }`，
 * `data.message` 就没了 —— 界面会显示一句空话。
 *
 * `parseApiError` 同时认新旧两种形状（含旧的 `{ message }` 与 `{ error: "字符串" }`），
 * 所以这里统一走它。与 `PublicNotePage` 那条 401 是同一套处理。
 */
export function rawError(body: unknown, status: number): string {
    return parseApiError(body, status)?.message || "";
}

/**
 * 冲突时服务端回的那一版笔记在哪：旧形状在响应体顶层 `note`，
 * 新形状（ApiError.details）在 `error.details.note`。两种都要认 ——
 * 迁移期内两种形状并存，只认一种会让「冲突弹框显示不出对方的版本」。
 */
export function conflictNoteFrom(body: unknown, parsed: ApiErrorInfo | null): Note | null {
    const fromTop = (body as { note?: unknown } | null)?.note;
    if (fromTop && typeof fromTop === "object") return fromTop as Note;
    const details = parsed?.details as { note?: unknown } | undefined;
    if (details && typeof details.note === "object") return details.note as Note;
    return null;
}
