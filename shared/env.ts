// shared/env.ts
// 环境变量与平台绑定的**唯一真源**：Env / D1 / 附件存储 / 静态资产 / Worker 入口签名
// 全部在这里声明一次，worker 侧与 src 侧都从这里拿。
//
// 为什么单独成一个文件（收口之前是两份各写一份）：
//   src/API/schema.ts 与 worker/types.ts 各有一个 `Env`，各自漂移 —— 实测差异是
//   4 个「加密/明文开关」只在 schema 侧、4 个「附件/资产/COOKIE_SECURE」只在 worker 侧。
//   后果不是类型报错（两边分别编译都能过），而是**静默失效**：
//   src/API/navigationApi.ts:221 读 `env.ALLOW_PLAINTEXT_SECRETS`，可它不在
//   server/entry.ts 的透传白名单里 —— 自托管侧设了完全不生效、日志一行不报。
//   同一份契约写两遍，两份就一定会分叉；所以这里只留一份，其余地方只做再导出。
//
// 为什么放 shared/ 而不是 worker/types.ts：src/API 要引它，而 src 的 tsconfig 不带
// workers-types（见下面 Env.FILES 那段），worker/types.ts 反过来也不该被前端直接引。
// shared/ 就是给「两条产物链共用」准备的目录，代价是**必须零 import**（连相对 import
// 都不许）：tests/q3StrictIsolation.test.ts 靠「shared 内部零相对 import」保证严格层
// 的检查闭包不会漏到 src。所以本文件是纯类型 + 两个 const 数组，不引任何模块。

/* ============================================================================
 * 一、平台绑定（结构化类型，不引 SDK）
 * ==========================================================================*/

// 声明D1数据库类型
export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface D1PreparedStatement {
    // 用 unknown[] 而不是 any[]：bind 只接受标量，但具体的联合类型在别处定义，
    // 这里再放宽也不会有人从它身上读属性
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    // 具体形状按语句不同而不同（changes / last_row_id / rows_written…），
    // 用到处都自己 as 成需要的形状，见 http.ts
    meta?: unknown;
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

/**
 * 静态资产绑定最小能力面（仅用得到 fetch 转发，不引 SDK 类型，理由见 Env.FILES）。
 * 把非 API 的纯前端路由请求转发给它，由资产层按 not_found_handling 回退到 index.html。
 */
export interface AssetsBinding {
    fetch(request: Request): Promise<Response>;
}

/* ============================================================================
 * 二、Env —— 所有环境变量与绑定的并集
 *
 * 取值规则：两份旧声明里出现过的字段**一个不少**，除 DB 外全部可空；
 * 注释也一并合并保留（每条都记着「为什么有这个开关、配错会怎样」）。
 * ==========================================================================*/

export interface Env {
    // ---- 绑定 ----
    DB: D1Database;
    /**
     * 静态资产绑定（wrangler assets 自动注入，绑定名默认 ASSETS）。
     * 仅 Cloudflare 部署有；自托管经 server/entry.ts 的 serveStatic 处理静态资源，
     * worker 侧拿不到也不需要这个绑定。
     * 用途：非 API 路径（/s/<token> 等纯前端路由）转发给它，由
     * assets.not_found_handling=single-page-application 回退到 index.html ——
     * 否则这些路径（fetch / curl / 爬虫 / 探针等非导航请求）会落到本文件的
     * 非 API 分支被当成 404（两环境对照 e2e 实测：home 200、myhp 404）。
     */
    ASSETS?: AssetsBinding;

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

    // ---- 鉴权 ----
    AUTH_ENABLED?: string; // 是否启用身份验证
    AUTH_USERNAME?: string; // 认证用户名
    AUTH_PASSWORD?: string; // 认证密码
    /** JWT 密钥 + 数据加密密钥（两者都没单独配时用它） */
    AUTH_SECRET?: string;
    /**
     * 恢复公钥（SPKI base64url；仅持公钥，私钥离线）；不配则用库里的 recovery.publicKey。
     * ⚠️ 早期脚本导出的 32 字节**裸**公钥仍兼容（crypto.ts 里先按 raw 试、失败再按 SPKI），
     * 但新配置一律用 SPKI —— 两份旧声明里一份写 SPKI、一份写 raw，实测以 SPKI 为准。
     */
    AUTH_RECOVERY_PUBLIC_KEY?: string;
    /**
     * 独立的数据加密密钥。配了之后新写入的密文用它（密文头带 keyId=1），
     * 旧密文仍由 AUTH_SECRET 解 —— 轮换这一个不必动另一个，也不必停机迁移。
     * 不配 = 完全沿用 AUTH_SECRET，行为与升级前逐字节一致。
     */
    DATA_ENCRYPTION_KEY?: string;
    /** 显式允许站点密码明文落库（默认不开）。见 navigationApi.ts 里 plaintext 那个开关的说明 */
    ALLOW_PLAINTEXT_SECRETS?: string;
    /** 独立的 JWT 签名密钥。不配则回退 AUTH_SECRET。 */
    JWT_SECRET?: string;
    /**
     * 轮换 JWT_SECRET 时的旧值，只用于验签兜底（让旧令牌自然过期而不是当场掉线）。
     * 过渡结束后必须删掉：留着它，旧密钥就仍然能验通过。
     */
    JWT_SECRET_OLD?: string;

    // ---- 部署 / 信任模型 ----
    /** 仅当部署在可信反向代理之后、且代理已校验过真实客户端 IP 时才设为 "1"，否则 XFF 一律不信任（防绕过登录限速） */
    NAVIHIVE_TRUST_XFF?: string;
    /**
     * 仅当反代**覆盖写入** `X-Real-IP`（如本仓 Nginx 模板）时才设为 "1"；
     * 与 NAVIHIVE_TRUST_XFF 独立，两个都为 "1" 才读该头 ——
     * 只跟着 XFF 放行的话，Caddy / Traefik（默认不写这条）后面客户端自带的
     * `X-Real-IP` 会原样透传，每请求换一个就是全新限速桶（五类限速同时失效）。
     */
    NAVIHIVE_TRUST_X_REAL_IP?: string;
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
}

/* ============================================================================
 * 三、Worker 入口签名
 *
 * controller 用本地结构化声明而不是全局 ScheduledController：tests 项目
 * （tsconfig.tests.json，types 只有 node）会经 import 链编到本文件，
 * 那边没有 @cloudflare/workers-types 的全局量 —— 与上面 D1Database 同一套路。
 * ==========================================================================*/

export interface ScheduledController {
    readonly scheduledTime: number;
    /** 本次触发命中的 crons 表达式（多触发器时用来分辨是谁叫的） */
    readonly cron: string;
    noRetry(): void;
}

// 声明Cloudflare Workers的执行上下文类型
export interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
}

// 声明ExportedHandler类型
// scheduled 是定时任务入口，由 wrangler.jsonc 的 triggers.crons 触发。
export interface ExportedHandler {
    fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>;
    scheduled?(controller: ScheduledController, env: Env, ctx?: ExecutionContext): void | Promise<void>;
}

/* ============================================================================
 * 四、自托管（server/entry.ts）的变量投递清单
 *
 * 自托管入口不会把整个 process.env 塞给 worker（那会把 PATH 之类无关变量一起
 * 泄进去），而是只挑下面这些名字。**两个清单加起来必须覆盖 Env 里所有非绑定键**，
 * 少一个就是「配了不生效、还不报错」—— 也就是这次收口要修掉的那个 bug。
 * ==========================================================================*/

/**
 * 原样透传：值非空就照搬进 env。
 * ⚠️ 加键别忘了这就是「worker/src 真正会读的键」清单；漏加的后果见文件末尾的编译期断言。
 */
export const PASSTHROUGH_KEYS = [
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "AUTH_SECRET",
    "AUTH_RECOVERY_PUBLIC_KEY",
    "DATA_ENCRYPTION_KEY",
    "JWT_SECRET",
    "JWT_SECRET_OLD",
    "NAVIHIVE_COOKIE_SECURE",
    "NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR",
    // ⚠️ 2026-11 补：navigationApi.ts:221 一直在读它，但它从来没进过白名单 ——
    // 自托管侧设 ALLOW_PLAINTEXT_SECRETS=1 完全不生效，也没有任何报错。
    "ALLOW_PLAINTEXT_SECRETS",
] as const;

/**
 * 由入口**显式赋值**的键（不走上面的照搬循环，因为各有默认值与空串语义）：
 *   AUTH_ENABLED              → 缺省 "true"（空串也当没配，不能把鉴权关掉）
 *   NAVIHIVE_TRUST_XFF        → 缺省 "0"
 *   NAVIHIVE_TRUST_X_REAL_IP  → 缺省 "0"
 * 它们仍然是「必须投递给 worker」的配置键，所以参与下面的完整性断言，
 * 只是投递方式不同（server/entry.ts 里那三行 serverEnv 字面量）。
 */
export const EXPLICIT_ENV_KEYS = [
    "AUTH_ENABLED",
    "NAVIHIVE_TRUST_XFF",
    "NAVIHIVE_TRUST_X_REAL_IP",
] as const;

// ---- 编译期断言：Env 里新增一个配置键却忘了投递，`tsc -b` 直接红 ----
//
// 为什么用类型而不是运行时的 `assert`：这是在**编译期**守住契约，不是等跑到
// 某个用例才发现；而且 shared/ 里没有任何测试会跑（它只被 import）。
// 为什么不用 `const _x: ... = true`：那几个 tsconfig 都开着 noUnusedLocals，
// 未使用的 const 会自己先报一个错，得再套一层导出才消掉；用类型参数约束一行搞定，
// 且完全不产出运行时代码。
type BindingKey = "DB" | "FILES" | "FILES_KV" | "ASSETS";
type EnvConfigKey = Exclude<keyof Env, BindingKey>;
type DeliveredKey = (typeof PASSTHROUGH_KEYS)[number] | (typeof EXPLICIT_ENV_KEYS)[number];
type UnpassedKey = Exclude<EnvConfigKey, DeliveredKey>;

/** T 必须是 true，否则报「'false' 不满足约束 'true'」—— 断言本体 */
type MustBeTrue<T extends true> = T;

/**
 * 有任何一个配置键没进上面两份清单，UnpassedKey 就不是 never，
 * 于是 PassthroughComplete 变成 `false`，这一行直接编译失败。
 * 报错文案只会说「'false' does not satisfy the constraint 'true'」，
 * 顺着 UnpassedKey 看就是漏掉的那个键名。
 */
export type PassthroughComplete = MustBeTrue<UnpassedKey extends never ? true : false>;

/**
 * 反方向的同一个契约：清单里**不许出现 Env 里没有的键**。
 * 拼错一个字母（`NAVIHIVE_TRUST_X_REALPI`）不会报错也不会生效 —— 那份清单就成了摆设，
 * 所以这里一并钉死：UnknownDeliveredKey 非 never 即编译失败。
 */
type UnknownDeliveredKey = Exclude<DeliveredKey, keyof Env>;
export type PassthroughKeysExist = MustBeTrue<UnknownDeliveredKey extends never ? true : false>;
