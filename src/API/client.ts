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
import { NoteConflictError } from "../utils/noteConflict";
import { API_ERROR_CODES, ApiError, parseApiError } from "./apiError";
import {
    clearSessionCookie,
    conflictNoteFrom,
    hasSessionCookie,
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

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
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

        // 上传 / 下载 / 备份恢复这类端点天然慢，不吃默认超时
        const slow = /upload|download|backup|import|export|restore|icon/i.test(endpoint);
        const timeoutMs = options.timeoutMs ?? (slow ? 0 : REQUEST_TIMEOUT_MS);
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
            throw new ApiError({
                code: parsed?.code || API_ERROR_CODES.unauthenticated,
                message: reason ? `认证失败：${reason}` : "认证已过期或无效，请重新登录",
                status: 401,
                ...(parsed?.details === undefined ? {} : { details: parsed.details }),
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
            });
        }

        // 其它状态码：message 与历史完全一致（既有 UI 与测试都依赖它），
        // 只是额外带上 code，UI 想分流时不用再 includes 匹配字符串
        throw new ApiError({
            code: parsed?.code || "unknown",
            message: reason ? `${reason} (HTTP ${response.status})` : `API错误: ${response.status}`,
            status: response.status,
            ...(parsed?.details === undefined ? {} : { details: parsed.details }),
        });
    }

}

// 把各域的方法体混回原型。逐个 assign 而不是一次性 Object.assign(原型, a, b, c...)：
// 后者的重载只到三个源，而且一次性混入会让「哪个域没生效」难查。
for (const mixin of [authImpl, notesImpl, sitesImpl, systemImpl, vaultImpl]) {
    Object.assign(NavigationClient.prototype, mixin);
}
