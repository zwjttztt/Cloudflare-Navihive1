// D1 与 Worker 环境变量的最小类型声明。
//
// 从 http.ts 里拆出来的原因：它们是「边界形状」而不是业务逻辑，跟 NavigationAPI
// 的任何一个方法都没有耦合，单独放一份之后两个文件各自清爽。

// 定义D1数据库类型
// 定义D1数据库类型
export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    meta?: unknown;
}

// 定义环境变量接口
export interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string; // 是否启用身份验证
    AUTH_USERNAME?: string; // 认证用户名
    AUTH_PASSWORD?: string; // 认证密码
    AUTH_SECRET?: string; // JWT密钥
    AUTH_RECOVERY_PUBLIC_KEY?: string; // 恢复公钥（Ed25519 raw，base64url）；仅持公钥，私钥离线
    NAVIHIVE_TRUST_XFF?: string; // 仅可信反代之后才设 "1"，否则 XFF 一律不信任（防绕过登录限速）
    NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR?: string; // 逃生开关：账号状态查询报 DB 异常时改为放行（默认 fail-closed）
}
