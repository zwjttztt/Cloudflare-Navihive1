// src/API/client.ts
// 浏览器侧的 HTTP 客户端：**传输核心 + 从 ./clientMethods/*.ts 混回来的业务方法**。
//
// 拆分的理由（P2-10）：这一个文件里原本塞着传输层（fetch / 超时 / 幂等头 / 错误翻译）
// 与 90 个业务方法，1500 行。想改「笔记附件怎么传」得在里头翻半天，
// 而传输层的一处改动又和业务方法混在同一片代码里，改谁都怕碰到谁。
//
// 范式照抄 src/API/http.ts + methods/*.ts（那套已经跑了很久）：
//   · 各域的方法体在 ./clientMethods/*.ts，用 `this: ClientThis` 声明 this
//     （不是 NavigationClient —— 理由见 transport.ts 里 ClientThis 的注释）；
//   · 这里用 Object.assign 混回原型，签名靠 interface 声明合并补回类上，
//     对外签名一行没改（十余处 import 与测试都不用动）；
//   · tests/clientSurface.test.ts 盯着「某个域忘了混回原型」——那是只有跑起来才会
//     暴露、类型检查抓不到的坑（TS 只信声明合并，不会核实原型上真有这些方法）。
//
// ⚠️ 字段与 request() **故意不加 private**：方法体分布在别的文件，跨文件访问
//    private 成员 TS 不允许。它们是内部实现，外部不要直接碰。
// ⚠️ 别在 clientMethods/*.ts 里 import 本文件的值（会成环），只 import 类型。

import { DEFAULT_TOKEN_TTL } from "./http";
import { IDEMPOTENCY_HEADER } from "./httpConstants";
import { REQUEST_ID_HEADER } from "../../shared/requestId";
import { NoteConflictError } from "../utils/noteConflict";
import { API_ERROR_CODES, ApiError, parseApiError } from "./apiError";
import {
    clearSessionCookie,
    conflictNoteFrom,
    hasSessionCookie,
    notifyUnauthorized,
    purgeLegacyToken,
    REQUEST_TIMEOUT_MS,
    setSessionCookie,
    type ClientThis,
} from "./transport";
import { authImpl } from "./clientMethods/auth";
import { notesImpl } from "./clientMethods/notes";
import { sitesImpl } from "./clientMethods/sites";
import { systemImpl } from "./clientMethods/system";
import { vaultImpl } from "./clientMethods/vault";

/**
 * 各域的方法签名在这里合并回类上（interface 与 class 同名会声明合并）。
 * 用 `typeof 实现对象` 而不是手抄一份 interface：手抄的那份会和实现漂移，
 * 而这正是我们想让编译器替我们盯住的东西。
 * 顺序无关，列出来是为了让 IDE 能跳到对应文件。
 */
export type AuthApi = typeof authImpl;
export type NotesClientApi = typeof notesImpl;
export type SitesClientApi = typeof sitesImpl;
export type SystemClientApi = typeof systemImpl;
export type VaultClientApi = typeof vaultImpl;

// class / interface 同名合并是刻意的，也是 TS 官方推荐的 mixin 写法。
// no-unsafe-declaration-merging 防的是「拿本地 interface 去改外部（DOM / 第三方库）的
// class」；这里两个声明都在本文件里、都归我们控制，合并只是为了把
// clientMethods/*.ts 里的方法签名补回类上，漏搬的方法会立刻报错。
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface NavigationClient extends
    AuthApi,
    NotesClientApi,
    SitesClientApi,
    SystemClientApi,
    VaultClientApi {}

/**
 * 附件上传的专用超时（2026-10-28）。
 *
 * 为什么不能吃默认的 30 秒：单文件上限 25MB（worker/attachments.ts 的
 * ATTACHMENT_MAX_BYTES），25MB / 30s ≈ 830KB/s —— 也就是说**默认超时要求
 * 用户至少 830KB/s 的上行**。手机 4G 上行普遍 200~500KB/s，弱网更差，
 * 于是「传一张 8MB 的截图」必然超时。而超时报出来的是一句
 * 「请求超时（30 秒无响应）」—— 用户会以为是服务器挂了，其实是本地带宽不够。
 *
 * 240 秒的依据：25MB / 240s ≈ 107KB/s，覆盖到 2G/边缘信号的上行；
 * 又不至于「无限等」—— 卡死的连接最终还能自己断开，不会永久占着上传队列。
 *
 * ⚠️ 只给**传文件本体**的那个端点，不要塞进下面的 slow 正则：
 * `notes/attachments/list`（列元数据）、`notes/attachments/<id>`（删除）、
 * 都只是几百字节的 JSON 往返，给它们 4 分钟等一个卡死的请求毫无意义 ——
 * 真卡住了应该 30 秒就让用户重试。这正是「别简单地把 attachment 塞进正则」的理由。
 */
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 240_000;

/**
 * 这个端点的请求该等多久（0 = 不设超时）。抽成纯函数是为了能单测 ——
 * 超时值本身藏在 AbortSignal 里，跑真请求是验不出来的。
 *
 * 判定分两类，理由各不相同：
 *
 * 1. **搬整份数据的慢端点**（不设超时）：走 `upload|download|backup|import|export|
 *    restore|icon` 这一组词。它们的共同点是「耗时由数据量决定，客户端无法预估」——
 *    整库备份上传、ZIP 导出下载、图标代理取远端图，谁都不知道要几秒。
 * 2. **大请求体的单文件上传**（给一个与体量匹配的定值，见
 *    ATTACHMENT_UPLOAD_TIMEOUT_MS）：只有 `POST notes/attachments` 这一个端点。
 *
 * 调用方显式传 timeoutMs 永远优先（它自己知道这一次要多久）。
 */
export function timeoutForEndpoint(endpoint: string, explicit?: number): number {
    if (typeof explicit === "number") return explicit;
    // 附件本体上传：POST notes/attachments?filename=…（query 直接跟在路径后面）
    if (/^notes\/attachments(\?|$)/.test(endpoint)) return ATTACHMENT_UPLOAD_TIMEOUT_MS;
    // 上传 / 下载 / 备份恢复这类端点天然慢，不吃默认超时
    return /upload|download|backup|import|export|restore|icon/i.test(endpoint)
        ? 0
        : REQUEST_TIMEOUT_MS;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- 同名 class/interface 合并是刻意的 mixin 写法，两个声明都在本仓库内、受我们控制
export class NavigationClient implements ClientThis {
    /** 不对外：域方法体在别的文件，跨文件访问 private 成员 TS 不允许（与 NavigationAPI 同样的取舍） */
    baseUrl: string;

    /**
     * 下一次写请求要带的幂等 ID。
     *
     * 只有一处会写它：离线队列重放。那条操作在断网前已经「发生过一次」，
     * 服务端可能做完了也可能没有，重放必须带着同一个 ID 去，
     * 让服务端认出「这一条其实已经做过了」并回放上次结果，而不是再建一个重复站点。
     * 用完即清 —— 用户手动的每一次操作都是新意图，不该被合并掉。
     */

    idempotencyKey: string | null = null;


    constructor(baseUrl = "/api") {
        this.baseUrl = baseUrl;
        purgeLegacyToken();
    }

    setIdempotencyKey(key: string | null): void {
        this.idempotencyKey = key;
    }

    isLoggedIn(): boolean {
        return hasSessionCookie();
    }

    setToken(_token: string): void {
        this.setSessionCookie(DEFAULT_TOKEN_TTL);
    }

    /** 写那条 JS 可读的登录标记（实现在 transport.ts，Mock 与真客户端共用） */
    setSessionCookie(ttlSeconds: number): void {
        setSessionCookie(ttlSeconds);
    }

    clearToken(): void {
        clearSessionCookie();
    }

    async request<T = unknown>(
        endpoint: string,
        options: { signal?: AbortSignal; timeoutMs?: number; [k: string]: unknown } = {}
    ): Promise<T> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };

        // 幂等 ID 只在重放时挂上，发完立刻清掉（options 里显式带头的以显式为准）
        if (this.idempotencyKey) {
            headers[IDEMPOTENCY_HEADER] = this.idempotencyKey;
            this.idempotencyKey = null;
        }

        // 超时分级见 timeoutForEndpoint（为什么附件上传要单独一档、为什么
        // `notes/attachments/list` 不能跟着一起放宽，都写在那里）
        const timeoutMs = timeoutForEndpoint(endpoint, options.timeoutMs);
        // 调用方显式给的 signal 优先（它自己知道要不要取消）；否则用超时 signal
        const signal = options.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
        const { signal: _ignored, timeoutMs: _ignored2, ...rest } = options;

        // 凭据走 httpOnly cookie，由浏览器自动带上（credentials 默认即 same-origin）。
        // 不再手动塞 Authorization —— 令牌根本不留在 JS 里。
        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/${endpoint}`, {
                credentials: "same-origin",
                headers,
                // ⚠️ rest 必须排在 headers **之后**：调用方显式带的头要能覆盖默认值
                // （比如上传时换 Content-Type）。顺序一反就是静默的行为回归。
                ...rest,
                ...(signal ? { signal } : {}),
            });
        } catch (error) {
            // 超时要能和「断网」分开：断网进离线队列等着重放，超时说明网络通但服务端
            // 不响应 —— 那是要告诉用户「稍后再试」，而不是默默排进队列里重试一遍。
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new ApiError({
                    code: "request_timeout",
                    message: `请求超时（${Math.round(timeoutMs / 1000)} 秒无响应），请检查网络后重试`,
                    status: 0,
                });
            }
            throw error;
        }

        if (response.ok) {
            return response.json();
        }

        // 服务端回写的请求 ID：挂到抛出的 ApiError 上，errorReporter 上报时带出去 ——
        // 这一条把「用户看到的报错」和「服务端日志 / audit_log 里的 server-error」
        // 串起来（头名见 shared/requestId.ts，worker 与自托管入口都回写它）。
        // ⚠️ `?.` 不是防御性冗余：`fetch` 一定给 Response，但**替身**不一定 ——
        // 单测里那些 `{ ok: false, status: 401, json: async () => … }` 的假响应没有
        // headers，直读会在这里抛 TypeError，把 7 条「错误文案」用例全变成
        // 「Cannot read properties of undefined」。（真踩过：2026-10-28 这一批）
        const requestId = response.headers?.get(REQUEST_ID_HEADER) || undefined;

        // 非 2xx：优先解析服务端返回的 message/error，让用户看到具体原因（如「密码强度不足」）
        let errorPayload: unknown;
        try {
            errorPayload = await response.json();
        } catch {
            errorPayload = null;
        }
        // 新形状 {error:{code,message,details}} 与旧形状 {error:"字符串"}/{message:"..."} 并存
        const parsed = parseApiError(errorPayload, response.status);
        const reason = parsed?.message || "";

        if (response.status === 401) {
            this.clearToken();
            // 401 不只发生在 bootstrap 上：任何接口拿到 401 都该把用户带回登录页。
            // client 是纯传输层，不该直接知道 UI 状态，所以只广播事件，由 App 统一处置
            // （见 App.tsx 的 handleAuthFailure）。广播必须在 throw 之前：监听器是同步的，
            // 放到 throw 之后就永远执行不到了。
            notifyUnauthorized();
            throw new ApiError({
                code: parsed?.code || API_ERROR_CODES.unauthenticated,
                message: reason ? `认证失败：${reason}` : "认证已过期或无效，请重新登录",
                status: 401,
                ...(parsed?.details === undefined ? {} : { details: parsed.details }),
                ...(requestId ? { requestId } : {}),
            });
        }

        // 413：worker 的 readBoundedBytes 抛的，body 是纯文本（不是 JSON），
        // 所以上面 reason 多半是空的。不给一句人话，用户看到的就是「API错误: 413」
        // —— 上传图片时这就是「传上去了却什么都没有」的另一种面孔。
        // 409 + code:'conflict' = 乐观并发冲突（笔记在别处被改过）。
        // 单独认出来：它不是「保存失败」，是「要先问用户一句」，
        // 而且服务端把库里当前那版一起回给了前端（见 worker/routes/data.ts）。
        if (response.status === 409 && parsed?.code === API_ERROR_CODES.conflict) {
            throw new NoteConflictError(
                reason || "这条笔记在别处被改过了",
                conflictNoteFrom(errorPayload, parsed)
            );
        }

        if (response.status === 413) {
            throw new ApiError({
                code: parsed?.code || API_ERROR_CODES.payloadTooLarge,
                message: reason
                    ? `${reason}（内容过大，服务器拒收）`
                    : "内容太大，服务器拒收（HTTP 413）",
                status: 413,
                ...(requestId ? { requestId } : {}),
            });
        }

        // 其它状态码：message 与历史完全一致（既有 UI 与测试都依赖它），
        // 只是额外带上 code，UI 想分流时不用再 includes 匹配字符串
        throw new ApiError({
            code: parsed?.code || "unknown",
            message: reason ? `${reason} (HTTP ${response.status})` : `API错误: ${response.status}`,
            status: response.status,
            ...(parsed?.details === undefined ? {} : { details: parsed.details }),
            ...(requestId ? { requestId } : {}),
        });
    }

}

// 把各域的方法体混回原型。逐个 assign 而不是一次性 Object.assign(原型, a, b, c...)：
// 后者的重载只到三个源，而且一次性混入会让「哪个域没生效」难查。
for (const mixin of [authImpl, notesImpl, sitesImpl, systemImpl, vaultImpl]) {
    Object.assign(NavigationClient.prototype, mixin);
}
