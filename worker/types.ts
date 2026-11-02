// worker/types.ts
// Worker 侧的请求体形状：各路由的入参校验用（LoginInput / SiteInput / …）。
//
// 环境变量与绑定类型（Env / D1Database / 附件存储 / AssetsBinding / 入口处理器签名）
// 已收进 `../shared/env.ts`（前后端共用一份），这里只留请求体形状；
// 需要 Env 的地方继续从本文件引也没问题 —— 下面那行再导出保持既有 import 路径不变。
// 为什么要收口：两份独立的 `Env` 声明各自漂移，出现过「代码里读了、自托管白名单里没有」
// 的静默失效（详见 shared/env.ts 文件头）。

export type {
    Env,
    D1Database,
    D1PreparedStatement,
    D1Result,
    KVNamespaceLike,
    R2PutOptionsLike,
    R2ObjectBodyLike,
    R2BucketLike,
    AssetsBinding,
    ScheduledController,
    ExecutionContext,
    ExportedHandler,
} from "../shared/env";

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
