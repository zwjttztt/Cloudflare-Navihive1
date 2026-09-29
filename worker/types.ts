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
// scheduled 是「每周自动备份」的定时入口，由 wrangler.jsonc 的 triggers.crons 触发
// 声明ExportedHandler类型
// scheduled 是「每周自动备份」的定时入口，由 wrangler.jsonc 的 triggers.crons 触发
export interface ExportedHandler {
    fetch(request: Request, env: Env, ctx?: ExecutionContext): Response | Promise<Response>;
    scheduled?(controller: unknown, env: Env, ctx?: ExecutionContext): void | Promise<void>;
}

// 声明Cloudflare Workers的执行上下文类型
export interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
    passThroughOnException(): void;
}
// 声明D1数据库类型
interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
    bind(...values: any[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    meta?: any;
}
