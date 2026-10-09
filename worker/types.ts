// worker/types.ts
// Worker 侧共享类型：环境变量绑定、各路由的请求体、入口处理器签名。

// 环境变量接口
export interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string;
    AUTH_USERNAME?: string;
    AUTH_PASSWORD?: string;
    AUTH_SECRET?: string;
    AUTH_RECOVERY_PUBLIC_KEY?: string; // 恢复公钥（SPKI base64url）；不配则用库里的 recovery.publicKey
    /** 仅当部署在可信反向代理之后、且代理已校验过真实客户端 IP 时才设为 "1"，否则 XFF 一律不信任（防绕过登录限速） */
    NAVIHIVE_TRUST_XFF?: string;
    /**
     * 逃生开关：设为 "0" 时登录 cookie 一律不带 Secure。
     * 只有「确实只能通过 http 访问、且反代连 X-Forwarded-Proto 都不传」才用 ——
     * 那种情况下带 Secure 的 cookie 会被浏览器直接丢弃，登录必然掉线。
     * 代价是 http 下令牌明文传输（本来整条链路就是明文）。
     */
    NAVIHIVE_COOKIE_SECURE?: string;
    /**
     * 逃生开关：账号状态查询（users.status）报 DB 异常时改为放行。
     * 默认是 fail-closed（拦下），代价是 D1 一抖就会把站点所有者自己也锁在门外；
     * 真出事时设成 "1" 可以立刻恢复访问。
     */
    NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR?: string;

    // ---- 附件（图片）存储 ----
    //
    // ⚠️ 两个通道是**有主次的**（见 attachments.ts 的 selectAttachmentStorage）：
    //   FILES(R2) 在 → 用 R2；否则 FILES_KV 在 → 用 KV；都没有 → 图片功能禁用。
    // 现在只有 KV（R2 未开通），但接口按两种都在设计 —— 以后开了 R2 只要加一条
    // wrangler 绑定，代码与前端都不用动。
    //
    // ⚠️ 这里**不能**直接写 `FILES?: R2Bucket` —— tsconfig.tests.json 刻意不引
    // @cloudflare/workers-types（它的 fetch/Request 定义与 DOM lib 打架，
    // tsconfig.tests.json:10-12 有注释说明），而那个项目又会编译到本文件，
    // 于是 R2Bucket / KVNamespace 两个全局名解析不到（TS2304）。
    // 实测过把 workers-types 加进 tests：**能编过类型检查，但会把整个
    // src/API/client.ts 打成 200+ 个 'data is of type unknown'** —— 那个冲突是真的。
    //
    // 所以这里只声明**我们真正用到的那几个方法**（结构化类型）。
    // 好处：与具体 SDK 版本解耦、改 SDK 不会连带炸这里；
    // 代价：漏了新方法要自己补（编译会报「属性不存在」，不会静默走错）。
    // ⚠️ 两个通道的 `get` / `put` **签名不一样**（R2 有 R2PutOptions、
    // 返回 R2ObjectBody；KV 只有两个参数），所以不能合成一个接口 ——
    // 否则 attachments.ts 里按分支调用时类型对不上（TS2554 / TS2339）。
    // 这里按各自真实签名分别声明。
    FILES?: R2BucketLike;
    FILES_KV?: KVNamespaceLike;
}

/**
 * 附件存储的**最小能力面**（照我们实际调用的方法声明，不引 SDK 类型，理由见 Env.FILES）。
 * 与具体 SDK 版本解耦：换 SDK 不会连带炸这里；漏了新方法编译就会报「属性不存在」，不会静默走错。
 */
export interface KVNamespaceLike {
    /** 读文本 / 原始值 */
    get(key: string): Promise<string | null>;
    /** 读二进制。附件必须走这个重载 —— 图片不能当文本读（会破坏字节） */
    get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    put(key: string, value: ArrayBuffer | ArrayBufferView | string): Promise<void>;
    delete(key: string): Promise<void>;
}

export interface R2PutOptionsLike {
    httpMetadata?: { contentType?: string; cacheControl?: string };
    customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike {
    arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
    get(key: string): Promise<R2ObjectBodyLike | null>;
    put(key: string, value: ArrayBuffer | ArrayBufferView, options?: R2PutOptionsLike): Promise<unknown>;
    delete(key: string): Promise<void>;
}

// 验证用接口
export interface LoginInput {
    username?: string;
    password?: string;
    /** 勾选「记住我」时签发 30 天令牌 */
    remember?: boolean;
}

export interface GroupInput {
    name?: string;
    order_num?: number;
}

export interface SiteInput {
    group_id?: number;
    name?: string;
    url?: string;
    icon?: string;
    description?: string;
    notes?: string;
    username?: string;
    password?: string;
    order_num?: number;
}

export interface ConfigInput {
    value?: string;
}

// 修改管理员凭据的请求体
export interface AuthCredentialsInput {
    username?: string;
    password?: string;
    currentPassword?: string;
}

// 密钥恢复的请求体
export interface RecoveryInput {
    token?: string;
}

// 保存恢复公钥的请求体（需登录 + 当前密码）
export interface RecoveryKeyInput {
    publicKey?: string;
    currentPassword?: string;
}

// 注册新账号的请求体（公开路由，靠邀请码把关）
export interface RegisterInput {
    username?: string;
    password?: string;
    /** 邀请码：由已登录用户在「更多选项 → 账号管理」生成，30 分钟内有效 */
    inviteCode?: string;
    remember?: boolean;
}
// 声明ExportedHandler类型
// scheduled 是定时任务入口，由 wrangler.jsonc 的 triggers.crons 触发。
// controller 用本地结构化声明而不是全局 ScheduledController：tests 项目
// （tsconfig.tests.json，types 只有 node）会经 import 链编到本文件，
// 那边没有 @cloudflare/workers-types 的全局量 —— 与下面 D1Database 同一套路。
export interface ScheduledController {
    readonly scheduledTime: number;
    /** 本次触发命中的 crons 表达式（多触发器时用来分辨是谁叫的） */
    readonly cron: string;
    noRetry(): void;
}
export interface ExportedHandler {
    fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>;
    scheduled?(controller: ScheduledController, env: Env, ctx?: ExecutionContext): void | Promise<void>;
}

// 声明Cloudflare Workers的执行上下文类型
export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}
// 声明D1数据库类型
interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
    // 用 unknown[] 而不是 any[]：bind 只接受标量，但具体的联合类型在别处定义，
    // 这里再放宽也不会有人从它身上读属性
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    // 具体形状按语句不同而不同（changes / last_row_id / rows_written…），
    // 用到处都自己 as 成需要的形状，见 http.ts
    meta?: unknown;
}
