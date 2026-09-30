// src/API/http.ts
// NavigationAPI：这个文件只留「字段 + 构造 + 账号作用域」三件套，
// 130 个方法按域搬到了 ./methods/*.ts，由文件末尾的 Object.assign 混回原型。
//
// 为什么要拆：原来 3739 行 / 130 个方法挤在一个类里，改一行要在三千行里翻。
// 怎么拆的：方法体**逐字**搬到 methods/<域>.ts，签名里加 `this: NavigationAPI`
// 让 TS 认得 this，类上用接口合并（interface NavigationAPI extends ...）补回方法声明，
// 对外签名一行没改，调用方完全无感。
//
// ⚠️ 字段与留在类里的几个方法**故意不加 private**：方法体分布在别的文件，
// 跨文件访问 private 成员 TS 不允许。它们是内部实现，外部不要直接碰。
// ⚠️ 别在 methods/*.ts 里 import 这个文件的值（会成环），只 import 类型。

import type { D1Database, Env } from "./schema";
import type { AccountSessionState } from "./types";
import type { MigrationApi } from "./methods/migration";
import type { AuthApi } from "./methods/auth";
import type { RecoveryApi } from "./methods/recovery";
import type { AccountsApi } from "./methods/accounts";
import type { AuditApi } from "./methods/audit";
import type { DataApi } from "./methods/data";
import type { RecycleApi } from "./methods/recycle";
import type { ConfigApi } from "./methods/config";
import type { TransferApi } from "./methods/transfer";
import { migrationImpl } from "./methods/migration";
import { authImpl } from "./methods/auth";
import { recoveryImpl } from "./methods/recovery";
import { accountsImpl } from "./methods/accounts";
import { auditImpl } from "./methods/audit";
import { dataImpl } from "./methods/data";
import { recycleImpl } from "./methods/recycle";
import { configImpl } from "./methods/config";
import { transferImpl } from "./methods/transfer";

// 类型 / 常量 / 键判定原本全在本文件里，现已拆到下面三个文件。
// 这里原样再导出一遍，外面（Worker 路由、测试、前端）的 import 不用跟着改。
export * from "./types";
export * from "./configKeys";
export * from "./configGuards";
export {
    resetMigrationCacheForTests,
    stripSiteCredentials,
    sanitizeLocalPrefs,
    sanitizeIconUrl,
} from "./methods/internals";
export { EXPORT_VERSION, normalizeImportData } from "./methods/transfer";

/**
 * 各域的方法签名在这里合并回类上（interface 与 class 同名会声明合并）。
 * 顺序无关，列出来是为了让 IDE 能跳到对应文件。
 */
// 下面两处的 class / interface 同名合并是刻意的，也是 TS 官方推荐的 mixin 写法。
// no-unsafe-declaration-merging 防的是「拿本地 interface 去改外部（DOM / 第三方库）的
// class」，那个确实危险；这里两个声明都在本文件里、都归我们控制，合并只是为了把
// methods/*.ts 里的方法签名补回类上，让 api.xxx() 有类型、也让漏搬的方法立刻报错。
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface NavigationAPI extends
    MigrationApi,
    AuthApi,
    RecoveryApi,
    AccountsApi,
    AuditApi,
    DataApi,
    RecycleApi,
    ConfigApi,
    TransferApi {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class NavigationAPI {
    db: D1Database;
    authEnabled: boolean;
    // 来自 wrangler vars 的默认账号密码，仅在数据库里还没有凭据时用作种子
    seedUsername: string;
    seedPassword: string;
    secret: string;
    // AUTH_SECRET 是否真正配置：未配置且启用鉴权时 fail-closed（见 verifyToken / generateToken）
    secretConfigured: boolean;
    // 恢复公钥（Ed25519 raw，base64url）：仅持公钥，私钥离线保管
    recoveryPubKey: string;
    // 令牌版本缓存（模块内按 isolate 读一次即可，改密时失效）
    tokenVersionCache: number | null = null;
    /** 每个账号各自的令牌版本缓存，避免每次鉴权都查一次 users 表 */
    accountVersionCache = new Map<number, number>();
    /** users 表里有没有账号：缓存住，决定「能否回落到 configs 老凭据」时每次都要问 */
    anyUserCache: boolean | null = null;
    /**
     * 会话存活状态缓存：uid -> 状态 + 读取时刻。
     *
     * 令牌是 30 天「记住我」签的，账号中途被停用 / 被清除时它并不会失效 ——
     * 光验签通过就放行的话，被清除的账号还能继续写库，数据会挂在一个已经不存在的
     * user_id 上变成孤儿。所以每个请求都要再确认一次账号还在。
     * 但每个请求都查一次 users 表太贵，这里缓存 SESSION_STATE_TTL_MS；
     * 停用 / 清除 / 重新启用这些会翻转结论的操作会主动把缓存清掉。
     */
    sessionStateCache = new Map<number, { state: AccountSessionState; at: number }>();
    /**
     * 当前请求所属账号。由 Worker 在验签之后 setCurrentUser(id) 注入。
     * 为 null 表示「系统级调用」（未启用鉴权、或定时备份这类没有用户上下文的任务），
     * 此时不做数据过滤，保持升级前的行为。
     */
    currentUserId: number | null = null;
    /**
     * 建表 / 迁移是否已经完整跑过一遍。迁移完成前（首个请求、users 表还没建好时）
     * 查账号状态会抛错，那时必须 fail-open（放行），否则整站登不进去；
     * 迁移完成之后若再查出错，就是真·DB 异常，应当 fail-closed（按「不可用」拦下），
     * 避免一个已被停用 / 清除的账号靠旧令牌继续过审。见 getAccountSessionState。
     */
    dbReady = false;
    /**
     * DB 异常时的兜底取向。默认 fail-closed（查不到账号状态就拦下，见 dbReady 的注释）；
     * 但那意味着一次 D1 抖动就能把站点所有者自己也锁在门外，所以留一个开关：
     * 设 NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR=1 可临时恢复访问（出问题时的逃生口）。
     */
    readonly failOpenOnError: boolean;

    /** 绑定当前账号（Worker 验签通过后调用）。传 null 表示系统级调用。 */
    setCurrentUser(id: number | null): void {
        this.currentUserId = id;
    }
    getCurrentUserId(): number | null {
        return this.currentUserId;
    }

    /**
     * 数据隔离：拼出「只属于当前账号」的 SQL 片段。
     * 没有用户上下文时返回空串（系统任务照旧看全量数据）。
     */
    scopeSql(hasWhere: boolean): string {
        if (this.currentUserId === null) return "";
        return `${hasWhere ? " AND " : " WHERE "}user_id = ?`;
    }

    /** 配合 scopeSql：把当前账号 id 追加到绑定参数末尾 */
    scopeParams<T>(params: T[]): (T | number)[] {
        return this.currentUserId === null ? params : [...params, this.currentUserId];
    }
    constructor(env: Env) {
        this.db = env.DB;
        this.authEnabled = env.AUTH_ENABLED === "true";
        this.seedUsername = env.AUTH_USERNAME || "";
        this.seedPassword = env.AUTH_PASSWORD || "";
        // AUTH_SECRET：启用鉴权却没配 → fail-closed（空密钥，令牌签发/校验一律拒绝），
        // 不再降级到公开的硬编码默认密钥；鉴权关闭时安全边界不存在，用固定串签发 guest 令牌。
        if (env.AUTH_SECRET) {
            this.secret = env.AUTH_SECRET;
            this.secretConfigured = true;
        } else if (this.authEnabled) {
            this.secret = "";
            this.secretConfigured = false;
        } else {
            this.secret = "默认密钥，建议在生产环境中设置";
            this.secretConfigured = false;
        }
        this.recoveryPubKey = env.AUTH_RECOVERY_PUBLIC_KEY || "";
        this.failOpenOnError = env.NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR === "1";
    }
}

// 把各域的方法体混回原型。逐个 assign 而不是一次性 Object.assign(原型, a, b, c...)：
// 后者的重载只到三个源，而且一次性混入会让「哪个域没生效」难查。
for (const mixin of [migrationImpl, authImpl, recoveryImpl, accountsImpl, auditImpl, dataImpl, recycleImpl, configImpl, transferImpl]) {
    Object.assign(NavigationAPI.prototype, mixin);
}

// 创建 API 辅助函数
export function createAPI(env: Env): NavigationAPI {
    return new NavigationAPI(env);
}
