// src/api/http.ts
// 不使用外部JWT库，改为内置的crypto API
import { normalizeUrl } from "../utils/url";
import { STARTER_GROUPS } from "./starterData";
import {
    signJwt,
    verifyJwt,
    hashPassword,
    verifyPassword,
    isHashedPassword,
    encryptSecret,
    decryptSecretDeep,
    verifyRecoveryToken,
    isValidRecoveryPublicKey,
    peekRecoveryTokenUsername,
    peekJwtClaim,
    type RecoveryPayload,
} from "./crypto";

// 定义D1数据库类型
interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    meta?: unknown;
}

// 定义环境变量接口
interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string; // 是否启用身份验证
    AUTH_USERNAME?: string; // 认证用户名
    AUTH_PASSWORD?: string; // 认证密码
    AUTH_SECRET?: string; // JWT密钥
    AUTH_RECOVERY_PUBLIC_KEY?: string; // 恢复公钥（Ed25519 raw，base64url）；仅持公钥，私钥离线
}

// 数据类型定义
export interface Group {
    id?: number;
    name: string;
    order_num: number;
    created_at?: string;
    updated_at?: string;
}

export interface Site {
    id?: number;
    group_id: number;
    name: string;
    url: string;
    icon: string;
    description: string;
    notes: string;
    // 站点登录凭据（可选，保存在数据库中，备份时会一起导出）
    username?: string;
    password?: string;
    order_num: number;
    created_at?: string;
    updated_at?: string;
}

// WebDAV 备份配置
export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
    /**
     * 备份文件的加密口令（可选，留空 = 不加密）。
     *
     * 刻意不用 AUTH_SECRET 当备份密钥：AUTH_SECRET 是 JWT 签名密钥，轮换它会让此前
     * 所有备份一起变成解不开的废文件；而备份一旦传到网盘，本来就不在服务端密钥的
     * 保护范围内。用用户自己的口令，换服务端密钥不影响历史备份。
     * 落库时和 webdav.password 一样加密（只是静态保护，密钥本身仍由用户掌握）。
     */
    backupPassword?: string;
    /**
     * 允许 WebDAV 服务器指向内网 / 本机地址（如家里 NAS 的 192.168.x.x、xxx.local）。
     * 默认关闭 —— Worker 代发请求前会挡掉内网地址，防止账号一旦被攻破就把 Basic 凭据
     * 打到内网服务上。只有确认 WebDAV 就在自己内网时才打开。
     */
    allowPrivateNetwork?: boolean;
}

// WebDAV 远端备份文件信息
export interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

/**
 * WebDAV 失败原因代码。
 * 「口令加密」「口令不对」都靠它区分：备份文件是别的账号传的、或本账号没存过备份口令时，
 * 前端要能弹出口令输入框，而不是笼统报一句「下载失败」让人不知道下一步该干嘛。
 */
export type WebDavErrorCode = "encrypted" | "badPassword";

// WebDAV 操作通用返回
export interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
    code?: WebDavErrorCode;
}

// 新增配置接口
export interface Config {
    key: string;
    value: string;
    created_at?: string;
    updated_at?: string;
}

// 只存在浏览器本机、但跟着备份文件一起走的偏好（星标站点 + 站点标签）。
// 它们没有对应的数据库字段，导出/恢复都由前端负责写入 localStorage。
export interface LocalPrefsBackup {
    /** 加了星标的站点 id */
    starred?: number[];
    /** 站点 id -> 标签名数组（JSON 的键一定是字符串） */
    tags?: Record<string, string[]>;
}

// 导出数据接口
export interface ExportData {
    groups: Group[];
    sites: Site[];
    /**
     * 跟着「账号」走的配置（目前没有非敏感的按账号配置，所以这里是空的；
     * webdav.* 属敏感配置，与 auth.* 一样不进备份）。
     */
    configs: Record<string, string>;
    /**
     * 全站共享的配置（标题 / 主题 / 背景…）。
     * 只有「这份备份有权改全站」时才会写进文件（站点所有者，或未启用登录的单账号部署）。
     * 老备份没有这个字段 —— 那时候全站设置混在 configs 里，导入时按同一套归属规则判断。
     */
    sharedConfigs?: Record<string, string>;
    version: string;
    exportDate: string;
    /** 本机偏好（星标 / 标签），老备份文件里没有这个字段 */
    localPrefs?: LocalPrefsBackup;
}

/** 导入结果：成功与否 + 新旧 id 映射（前端的星标 / 标签记的是旧 id，要翻译一遍） */
export interface ImportResult {
    success: boolean;
    message?: string;
    /** 备份里的分组 id -> 库里新分到的 id（JSON 的键一定是字符串） */
    groupIdMap: Record<string, number>;
    /** 备份里的站点 id -> 库里新分到的 id */
    siteIdMap: Record<string, number>;
}

/** 站点元信息（/api/meta 抓回来的：新增卡片时一键补全用） */
export interface SiteMeta {
    title: string;
    description: string;
    image: string;
    icon: string;
}

// 首屏/刷新一次性返回的数据（分组 + 平铺的站点 + 配置）
export interface BootstrapData {
    groups: Group[];
    sites: Site[];
    configs: Record<string, string>;
}

// 新增用户登录接口
export interface LoginRequest {
    username: string;
    password: string;
    /** 勾选「记住我」时签发更长期限的令牌（1 个月），实现免登录 */
    remember?: boolean;
}

export interface LoginResponse {
    success: boolean;
    token?: string;
    message?: string;
    /** 首次部署的种子凭据还没换过：服务端会拦住其它写操作，直到改一次密码 */
    mustChangePassword?: boolean;
    // 多账号后登录响应带上账号身份，前端不必再发一次请求问「我是谁」
    username?: string;
    role?: "owner" | "user";
}

/** 注册结果：成功时顺带把账号信息回给前端，省掉一次 /auth/me */
export interface RegisterResult {
    success: boolean;
    message: string;
    user?: UserRecord;
}

// 数据库迁移只需在每个 Worker isolate 中执行一次。
// 注意：NavigationAPI 是每个请求 new 出来的，实例字段无法跨请求复用，
// 之前迁移挂在实例上导致「每个请求都跑一遍 DDL」，这是接口变慢的主因，所以缓存放在模块作用域。
let migrationPromise: Promise<void> | null = null;

/**
 * 仅供测试：清掉迁移缓存。
 * 生产环境每个 isolate 只应迁移一次（缓存是有意为之），但测试里每个用例都要换一套
 * 全新的内存数据库，不重置的话第二个用例起就永远跑不到建表 / 迁移逻辑。
 */
export function resetMigrationCacheForTests(): void {
    migrationPromise = null;
}

// 邀请码取自「去掉易混字符」的字母表：没有 0/O、1/I，口头转述也不容易错。
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomInviteCode(length = 8): string {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes)
        .map(byte => INVITE_ALPHABET[byte % INVITE_ALPHABET.length])
        .join("");
}

/**
 * 管理员凭据保存在数据库的 configs 表里（键：auth.username / auth.password）。
 * wrangler vars 里的 AUTH_USERNAME / AUTH_PASSWORD 只当作「第一次部署」的默认种子：
 * 首次用到时写入数据库，之后就以数据库为准，
 * 这样反复重新部署（哪怕改了 vars）都不会把已经生效的账号密码改回去。
 */
export const AUTH_USERNAME_KEY = "auth.username";
export const AUTH_PASSWORD_KEY = "auth.password";
// WebDAV 备份配置键的前缀（url / username / password / backupPassword / path / autoBackup …）
export const WEBDAV_CONFIG_PREFIX = "webdav.";
// WebDAV 备份凭据：明文落 D1 风险高，写入前用 AUTH_SECRET 派生密钥加密（见 setConfig/queryConfigs）
export const WEBDAV_PASSWORD_KEY = "webdav.password";
// WebDAV 备份口令：与 AUTH_SECRET 无关的独立口令，落库时同样加密（见 ENCRYPTED_CONFIG_KEYS）
export const WEBDAV_BACKUP_PASSWORD_KEY = "webdav.backupPassword";
// 令牌版本：改密 / 重置后 +1，让所有已签发的令牌立即失效（服务端可吊销）
export const TOKEN_VERSION_KEY = "auth.tokenVersion";
// 单点吊销：退出登录时把该令牌的 jti 拉黑，验签通过后还要再查一次。
// 这里早年是 configs 的 auth.tokenBlacklist（一个 JSON 串），现已换成 token_blacklist 表：
// 「读-改-写」会被并发登出互相覆盖，让注意事项失效 —— 详见 blacklistToken 的注释。
// 首次部署后必须先改一次管理员密码（默认账号/密码来自部署变量，等于半公开）
export const MUST_CHANGE_PASSWORD_KEY = "auth.mustChangePassword";
// 恢复公钥（找回管理员密码用）：网页端生成密钥对后把公钥存这里，私钥只留在用户本地。
// 不用 auth. 前缀——那个前缀的接口一律禁止读写，只能走专用的「校验当前密码」接口。
export const RECOVERY_PUBLIC_KEY_CONFIG = "recovery.publicKey";

// 长期未登录账号治理：阈值（天）存进 configs，owner 可在后台改；读取带默认值。
// disableDays：超过这么久没活跃 -> 置为 disabled（禁止登录，数据保留）。
// deleteGraceDays：disabled 之后再过这么久 -> 硬删（释放 D1 行数）。owner 永不被治理。
export const INACTIVE_DISABLE_DAYS_KEY = "inactive.disableDays";
export const INACTIVE_DELETE_GRACE_DAYS_KEY = "inactive.deleteGraceDays";
export const INACTIVE_DISABLE_DAYS_DEFAULT = 180;
export const INACTIVE_DELETE_GRACE_DAYS_DEFAULT = 30;

/**
 * 会话存活状态：令牌验签通过之后，还要确认账号本身还在不在。
 * missing = 账号已被清除（沉睡治理 / 注销），但手上这张 30 天令牌还没过期。
 */
export type AccountSessionState = "active" | "disabled" | "missing";

/**
 * 会话状态缓存有效期。停用 / 清除是低频操作（每周扫描一次），
 * 缓存 60 秒足以让「刚被停用」最多延迟一分钟生效，同时把每个请求一次 D1 读降到每分钟一次。
 */
const SESSION_STATE_TTL_MS = 60 * 1000;

// 令牌有效期（秒）：普通登录 1 天；勾选「记住账号密码」后 30 天，实现「一个月内免登录」
export const DEFAULT_TOKEN_TTL = 24 * 60 * 60;
export const REMEMBER_TOKEN_TTL = 30 * 24 * 60 * 60;

/**
 * 邀请码有效期：30 分钟。
 * 注册入口是公开的（否则新用户进不来），所以发码必须短命 ——
 * 就算码被截获，半小时后也只是一串废字符。
 */
export const INVITE_TTL_SECONDS = 30 * 60;

/** 账号记录（不含哈希，只给能下发的字段用） */
export interface UserRecord {
    id: number;
    username: string;
    /** owner = 站点所有者（首个账号），user = 被邀请进来的普通账号 */
    role: "owner" | "user";
    created_at?: string;
}

/** 账号列表项（owner 在「账号管理」里看到的那一列，含沉睡治理状态） */
export interface AccountInfo {
    id: number;
    username: string;
    role: "owner" | "user";
    /** active = 正常；disabled = 已因长期未登录被停用（数据仍在，登录会被拒） */
    status: "active" | "disabled";
    /** 最后活跃时间（秒级时间戳；null = 从未登录过，用创建时间当锚点） */
    lastActiveAt: number | null;
    /** 被停用的时间（秒级时间戳） */
    disabledAt: number | null;
    createdAt: number | null;
    /** 按当前阈值推算：active -> 预计被停用的时间；disabled -> 预计被清除的时间 */
    willDisableAt: number | null;
    willDeleteAt: number | null;
}

/**
 * 沉睡治理的时间轴推算（纯函数，便于单测，不碰数据库）。
 * 判定口径：
 *   - active：以「最后活跃时间」为锚点（从没活跃过就退回创建时间），锚点 + 停用阈值；
 *   - disabled：以「被停用时间」为锚点，锚点 + 清除宽限期 -> 预计被清除。
 * 「记住我」静默恢复也会刷新最后活跃时间，所以每天来的人不会被误判沉睡。
 */
export function computeInactiveTimeline(
    base: {
        status: string;
        lastActiveAt: number | null;
        disabledAt: number | null;
        createdAt: number | null;
    },
    disableDays: number,
    graceDays: number
): { willDisableAt: number | null; willDeleteAt: number | null } {
    const day = 24 * 60 * 60;
    if (base.status === "disabled") {
        // 已停用：只关心「什么时候会被清除」
        if (base.disabledAt === null) return { willDisableAt: null, willDeleteAt: null };
        return { willDisableAt: null, willDeleteAt: base.disabledAt + graceDays * day };
    }
    // active：算「什么时候会被停用」
    const anchor = base.lastActiveAt ?? base.createdAt;
    if (anchor === null) return { willDisableAt: null, willDeleteAt: null };
    return { willDisableAt: anchor + disableDays * day, willDeleteAt: null };
}

/** 邀请码信息（生成后返回给前端展示） */
export interface InviteInfo {
    code: string;
    /** 过期时间（秒级时间戳） */
    expiresAt: number;
    /** 有效期秒数，前端用来显示「30 分钟内有效」 */
    ttlSeconds: number;
}

// 敏感配置：不参与备份文件的导入导出（管理员 / WebDAV 凭据）
const SECRET_CONFIG_PREFIXES = ["auth.", "webdav."];

/**
 * 同样不进备份文件、但必须整键匹配的几个配置。
 * 不能写进上面的前缀表：`link.health` 作为前缀会把 `link.healthSync` 一起匹配掉，
 * 那个开关是要跟着备份走的（换了设备也保持原样）。
 *
 * - link.health / pref.starred / pref.tags 都是「服务端镜像」：
 *   星标标签在备份里有专门的 localPrefs 字段承载，重复带一份只会让人看不懂；
 *   失效记录则是可重测的临时数据，没必要让备份文件胖一圈。
 */
const SECRET_CONFIG_KEYS = ["link.health", "pref.starred", "pref.tags"];

/**
 * 「备份文件里要不要带上网站登录凭据」的配置键。
 * 存服务端而不是只放前端，是为了让每周的定时备份（跑在 Worker 的 cron 里）也遵守同一个开关。
 * 默认带上（保持老行为），只有显式写成 "false" 才抹掉。
 */
export const BACKUP_CREDENTIALS_CONFIG = "backup.includeCredentials";

/** 去掉每个站点的账号密码，其它字段原样保留 */
export function stripSiteCredentials(sites: Site[]): Site[] {
    return sites.map(site => ({ ...site, username: "", password: "" }));
}

/**
 * 落库前要用 AUTH_SECRET 派生密钥加密的配置键。
 * 两个 WebDAV 凭据都在这里：明文落 D1，导一份库就等于把网盘账号交出去了。
 * 注意：这里只是「静态保护」，备份口令本身不是 AUTH_SECRET —— 备份文件用它自己的
 * 口令加密，换 AUTH_SECRET 不影响已有备份能不能解开。
 */
const ENCRYPTED_CONFIG_KEYS = [WEBDAV_PASSWORD_KEY, WEBDAV_BACKUP_PASSWORD_KEY];

function isEncryptedConfigKey(key: string): boolean {
    return ENCRYPTED_CONFIG_KEYS.includes(key);
}

/**
 * 每个账号一份的配置，分两类：
 *
 * 1. **严格私有**（webdav.*）：网盘地址 / 账号 / 口令，绝不能让别人看见 ——
 *    存 user_configs 而不是全局 configs，否则 A 填的网盘密码，B 一登录就能在
 *    「数据备份」里看到，等于把别人的网盘凭据摆在页面上。读的时候也不回落全站。
 *
 * 2. **外观**（site.*：标题 / 主题色 / 背景 / 自定义 CSS）：每人一份，但**允许回落全站**。
 *    站点所有者那一份就写在全局 configs 里 —— 它同时是「未登录时的登录页外观」和
 *    其它账号的初始外观（自己没改过就跟着站点走）。普通账号改的是自己那份，
 *    不会把整站长什么样改掉，也不会因为没配任何东西而看到一片空白。
 */
const PRIVATE_USER_CONFIG_PREFIXES = [WEBDAV_CONFIG_PREFIX];
const PER_USER_APPEARANCE_PREFIXES = ["site."];

function isPrivateUserConfigKey(key: string): boolean {
    return PRIVATE_USER_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix));
}

export function isPerUserAppearanceKey(key: string): boolean {
    return PER_USER_APPEARANCE_PREFIXES.some(prefix => key.startsWith(prefix));
}

/**
 * 该键是否「账号自己就能写」—— 路由层用它判断要不要校验站点所有者。
 * 两类都算：写进去的不是全站共享的外观，就是账号自己的私有配置。
 */
export function isUserScopedConfigKey(key: string): boolean {
    return isPrivateUserConfigKey(key) || isPerUserAppearanceKey(key);
}

// 判断某个配置键是否属于敏感信息
export function isSecretConfigKey(key: string): boolean {
    return (
        SECRET_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix)) ||
        SECRET_CONFIG_KEYS.includes(key)
    );
}

// 管理员凭据额外连正常的配置读取都不返回，避免出现「拿到配置就等于拿到密码」。
// 注意：WebDAV 凭据要照常下发，前端「备份」弹窗靠它回填已保存的配置。
export function isAuthConfigKey(key: string): boolean {
    return key.startsWith("auth.");
}

// 去掉敏感配置后再返回（用于写入备份文件）
export function stripSecretConfigs(configs: Record<string, string>): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(configs)) {
        if (!isSecretConfigKey(key)) {
            safe[key] = value;
        }
    }
    return safe;
}

// API 类
export class NavigationAPI {
    private db: D1Database;
    private authEnabled: boolean;
    // 来自 wrangler vars 的默认账号密码，仅在数据库里还没有凭据时用作种子
    private seedUsername: string;
    private seedPassword: string;
    private secret: string;
    // AUTH_SECRET 是否真正配置：未配置且启用鉴权时 fail-closed（见 verifyToken / generateToken）
    private secretConfigured: boolean;
    // 恢复公钥（Ed25519 raw，base64url）：仅持公钥，私钥离线保管
    private recoveryPubKey: string;
    // 令牌版本缓存（模块内按 isolate 读一次即可，改密时失效）
    private tokenVersionCache: number | null = null;
    /** 每个账号各自的令牌版本缓存，避免每次鉴权都查一次 users 表 */
    private accountVersionCache = new Map<number, number>();
    /** users 表里有没有账号：缓存住，决定「能否回落到 configs 老凭据」时每次都要问 */
    private anyUserCache: boolean | null = null;
    /**
     * 会话存活状态缓存：uid -> 状态 + 读取时刻。
     *
     * 令牌是 30 天「记住我」签的，账号中途被停用 / 被清除时它并不会失效 ——
     * 光验签通过就放行的话，被清除的账号还能继续写库，数据会挂在一个已经不存在的
     * user_id 上变成孤儿。所以每个请求都要再确认一次账号还在。
     * 但每个请求都查一次 users 表太贵，这里缓存 SESSION_STATE_TTL_MS；
     * 停用 / 清除 / 重新启用这些会翻转结论的操作会主动把缓存清掉。
     */
    private sessionStateCache = new Map<number, { state: AccountSessionState; at: number }>();
    /**
     * 当前请求所属账号。由 Worker 在验签之后 setCurrentUser(id) 注入。
     * 为 null 表示「系统级调用」（未启用鉴权、或定时备份这类没有用户上下文的任务），
     * 此时不做数据过滤，保持升级前的行为。
     */
    private currentUserId: number | null = null;
    /**
     * 建表 / 迁移是否已经完整跑过一遍。迁移完成前（首个请求、users 表还没建好时）
     * 查账号状态会抛错，那时必须 fail-open（放行），否则整站登不进去；
     * 迁移完成之后若再查出错，就是真·DB 异常，应当 fail-closed（按「不可用」拦下），
     * 避免一个已被停用 / 清除的账号靠旧令牌继续过审。见 getAccountSessionState。
     */
    private dbReady = false;

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
    private scopeSql(hasWhere: boolean): string {
        if (this.currentUserId === null) return "";
        return `${hasWhere ? " AND " : " WHERE "}user_id = ?`;
    }

    /** 配合 scopeSql：把当前账号 id 追加到绑定参数末尾 */
    private scopeParams<T>(params: T[]): (T | number)[] {
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
    }

    // 初始化数据库表
    // 修改initDB方法，将SQL语句分开执行
    async initDB(): Promise<{ success: boolean; alreadyInitialized: boolean }> {
        // 首先检查数据库是否已初始化
        try {
            const isInitialized = await this.getConfig("DB_INITIALIZED");
            if (isInitialized === "true") {
                return { success: true, alreadyInitialized: true };
            }
        } catch {
            // 如果发生错误，可能是配置表不存在，继续初始化
        }

        // 建表并补齐字段（幂等，重复执行无副作用）
        await this.migrate();

        // 设置初始化标志
        await this.setConfig("DB_INITIALIZED", "true");

        return { success: true, alreadyInitialized: false };
    }

    async migrate(): Promise<void> {
        if (!migrationPromise) {
            migrationPromise = this.runMigrations().catch(error => {
                console.error("数据库迁移失败:", error);
                // 失败后清空缓存，允许下一个请求重试，避免一次偶发错误导致表结构永久缺失
                migrationPromise = null;
            });
        }
        return migrationPromise;
    }

    // 建表 SQL（幂等）
    private static readonly CREATE_STATEMENTS = [
        // 保证表结构存在（新建的 D1 库即使没访问过 /api/init 也能直接用）
        `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, icon TEXT, description TEXT, notes TEXT, username TEXT, password TEXT, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE);`,
        `CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        // 审计日志：登录、改密、重置、删除站点、改备份配置等关键动作留痕，事后能溯源。
        // 不返回给前端、不进备份（不属于 configs 表）。
        `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT, ip TEXT, detail TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        // 账号表：从「单管理员」升级为「多账号」。
        // 首个账号（owner）就是升级前那套 configs 里的管理员，历史数据全部挂在它名下，
        // 老部署升上来不会「数据凭空消失」。
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        // 邀请码：已登录用户生成，新用户注册时用掉。时间戳一律存秒，避免 SQLite 时区歧义。
        `CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by INTEGER, used_at INTEGER);`,
        // 每账号一份的配置（WebDAV 备份凭据等）。与 configs 分开存：
        // configs 是全站共享的（标题、背景），塞进去就会被别的账号看到。
        `CREATE TABLE IF NOT EXISTS user_configs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, key));`,
        // 令牌黑名单（退出登录 = 服务端可吊销）。
        // 以前是 configs 里一个 JSON 字符串：两个请求并发登出会互相覆盖（后写的把前一个
        // jti 抹掉，那张令牌就又活了），而且每次校验都要把整份 JSON 读出来解析。
        // 改成一行一条之后插入到 key 冲突时覆盖是幂等的，查也是走主键的单行查询。
        `CREATE TABLE IF NOT EXISTS token_blacklist (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        // 回收站：站点 / 分组删除不再硬删，先原样搬到这里，给「删错了」留后悔药。
        // data 存原始行（站点含密文密码，不解密，避免落回明文）；owner_user_id 做按账号隔离。
        `CREATE TABLE IF NOT EXISTS recycle_bin (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            owner_user_id INTEGER,
            data TEXT NOT NULL,
            deleted_at INTEGER NOT NULL,
            expires_at INTEGER
        );`,
    ];

    private async runMigrations(): Promise<void> {
        // 1) 建表：合并成一次 batch，只花一次 D1 往返（原来是 3 次 exec 串行）
        try {
            await this.db.batch(NavigationAPI.CREATE_STATEMENTS.map(sql => this.db.prepare(sql)));
        } catch (error) {
            // batch 失败时退回逐条执行，保证结构一定可用
            console.error("批量建表失败，回退逐条执行:", error);
            for (const sql of NavigationAPI.CREATE_STATEMENTS) {
                try {
                    await this.db.exec(sql);
                } catch {
                    // 忽略
                }
            }
        }

        // 2) 旧库补齐站点凭据字段：先读表结构，确实缺列时才发 ALTER
        const missingColumns = await this.findMissingSiteColumns();
        if (missingColumns.length > 0) {
            try {
                await this.db.batch(
                    missingColumns.map(column => this.db.prepare(`ALTER TABLE sites ADD COLUMN ${column} TEXT`))
                );
            } catch {
                // 部分列已存在会让整批失败，逐条补一次即可
                for (const column of missingColumns) {
                    try {
                        await this.db.exec(`ALTER TABLE sites ADD COLUMN ${column} TEXT`);
                    } catch {
                        // 列已存在，忽略
                    }
                }
            }
        }

        // 3) 多账号：分组 / 站点挂上归属账号，再把老数据收归首个账号名下
        await this.migrateOwnerColumns();

        // 4) 沉睡账号治理：users 表补上「最后活跃 / 状态 / 停用时间」三列
        await this.migrateInactiveColumns();

        // 5) 账号各自的令牌版本：见 bumpTokenVersion 的注释
        await this.migrateAccountSecurityColumns();

        // 所有迁移步骤跑完，说明表结构已就绪：之后的查询出错就按「异常」处理（fail-closed），
        // 而不是「库还没建好」（fail-open）。
        this.dbReady = true;
    }

    /**
     * users 表补列（幂等）：token_version。
     *
     * 令牌版本原本是全站一份（configs.auth.tokenVersion），于是「任一账号改密 / 密钥恢复 /
     * 注销」都会把所有人的会话一起踢掉 —— 多账号上线后这就成了互相干扰。
     * 改成每个账号一份后，A 改密只作废 A 的令牌；没有账号上下文时（老令牌、单管理员
     * configs 凭据）仍然走全站那份，行为不变。
     */
    private async migrateAccountSecurityColumns(): Promise<void> {
        const wanted: { name: string; type: string }[] = [
            { name: "token_version", type: "INTEGER NOT NULL DEFAULT 0" },
        ];
        for (const column of wanted) {
            if (await this.hasColumn("users", column.name)) continue;
            try {
                await this.db.exec(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`);
            } catch {
                // 并发迁移时列可能已存在，忽略
            }
        }
    }

    /**
     * users 表补列（幂等，按列是否已经存在决定发不发 ALTER）：
     *   last_active_at —— 最后活跃时间（秒），「记住我」静默恢复也会刷新；
     *   status         —— active / disabled，停用的账号登录会被拒但数据保留；
     *   disabledAt     —— 被停用的时间，清除倒计时的锚点。
     */
    private async migrateInactiveColumns(): Promise<void> {
        const wanted: { name: string; type: string }[] = [
            { name: "last_active_at", type: "INTEGER" },
            { name: "status", type: "TEXT NOT NULL DEFAULT 'active'" },
            { name: "disabled_at", type: "INTEGER" },
        ];
        for (const column of wanted) {
            if (await this.hasColumn("users", column.name)) continue;
            try {
                await this.db.exec(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`);
            } catch {
                // 并发迁移时列可能已存在，忽略
            }
        }
    }

    /**
     * 多账号迁移。分三步，全部幂等：
     *   1. groups / sites 补 user_id 列（老库没有这一列）；
     *   2. 把 configs 里那份单管理员凭据搬进 users 表，成为 owner；
     *   3. user_id 为空的历史数据全部归到 owner —— 升级后原账号看到的数据和升级前一模一样。
     */
    private async migrateOwnerColumns(): Promise<void> {
        for (const table of ["groups", "sites"]) {
            if (await this.hasColumn(table, "user_id")) continue;
            try {
                await this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`);
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }

        const ownerId = await this.ensureOwnerUser();
        if (ownerId === null) return;

        const backfill = [
            this.db.prepare("UPDATE groups SET user_id = ? WHERE user_id IS NULL").bind(ownerId),
            this.db.prepare("UPDATE sites SET user_id = ? WHERE user_id IS NULL").bind(ownerId),
        ];
        try {
            await this.db.batch(backfill);
        } catch {
            for (const statement of backfill) {
                try {
                    await statement.run();
                } catch {
                    // 忽略
                }
            }
        }

        // 4) 恢复公钥：老部署里是全站一份，现在改成每个账号一份
        await this.migrateRecoveryKeyToOwner(ownerId);

        // 5) WebDAV 备份配置：老部署里是全站一份，现在改成每个账号一份
        await this.migrateWebdavConfigToOwner(ownerId);
    }

    /**
     * 把 configs 里那份「全站恢复公钥」搬进 owner 账号。
     * 搬成功才删掉全局那份 —— 留着会让新账号显示成「恢复密钥（已配置）」，
     * 可它手里的私钥根本不是自己的，真要找回密码时只会得到「签名不匹配」。
     */
    private async migrateRecoveryKeyToOwner(ownerId: number): Promise<void> {
        try {
            if (!(await this.hasColumn("users", "recovery_public_key"))) {
                await this.db.exec("ALTER TABLE users ADD COLUMN recovery_public_key TEXT");
            }
        } catch {
            // 列已存在（并发迁移）或表不存在，忽略
        }

        try {
            const legacy = ((await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG)) || "").trim();
            if (!legacy) return;

            const row = await this.db
                .prepare("SELECT recovery_public_key FROM users WHERE id = ?")
                .bind(ownerId)
                .first<{ recovery_public_key: string | null }>();
            // 已经搬过，或 owner 后来自己重新生成过 → 以账号里那份为准
            if (row?.recovery_public_key) return;

            const updated = await this.db
                .prepare("UPDATE users SET recovery_public_key = ? WHERE id = ?")
                .bind(legacy, ownerId)
                .run();
            if (updated.success) await this.deleteConfig(RECOVERY_PUBLIC_KEY_CONFIG);
        } catch (error) {
            console.error("迁移恢复公钥失败:", error);
        }
    }

    /**
     * 把 configs 里那份「全站 WebDAV 备份配置」搬进 owner 账号。
     * 不搬的话：老部署里配过网盘的人升级后，新注册的账号一打开「数据备份」就能看到
     * 别人的网盘地址和账号 —— 搬完顺手删掉全局那份，杜绝残留。
     * 值在 configs 里已经是密文（口令类），原样搬，不重复加密。
     */
    private async migrateWebdavConfigToOwner(ownerId: number): Promise<void> {
        try {
            const rows = await this.db
                .prepare("SELECT key, value FROM configs WHERE key LIKE ?")
                .bind(`${WEBDAV_CONFIG_PREFIX}%`)
                .all<{ key: string; value: string }>();
            const list = rows.results || [];
            if (list.length === 0) return;

            const statements = list.map(row =>
                this.db
                    .prepare(
                        `INSERT INTO user_configs (user_id, key, value, updated_at)
                         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(user_id, key) DO NOTHING`
                    )
                    .bind(ownerId, row.key, row.value)
            );
            try {
                await this.db.batch(statements);
            } catch {
                for (const statement of statements) {
                    try {
                        await statement.run();
                    } catch {
                        // 已存在，忽略
                    }
                }
            }

            // 全局那份删掉：留着就等于给所有账号留了一份「默认网盘」
            for (const row of list) {
                try {
                    await this.deleteConfig(row.key);
                } catch {
                    // 忽略
                }
            }
        } catch (error) {
            console.error("迁移 WebDAV 配置失败:", error);
        }
    }

    private async hasColumn(table: string, column: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info(?)")
                .bind(table)
                .all<{ name: string }>();
            return (result.results || []).some(row => row.name === column);
        } catch {
            return false;
        }
    }

    /**
     * users 表为空 = 还没升级过：把 configs 里的管理员凭据搬进来当 owner。
     * 已经搬过就直接返回 owner 的 id。
     */
    private async ensureOwnerUser(): Promise<number | null> {
        try {
            const existing = await this.db
                .prepare("SELECT id, username FROM users ORDER BY id LIMIT 1")
                .first<{ id: number; username: string }>();
            if (existing?.id) return existing.id;

            const creds = await this.readAuthCredentials();
            // 没有凭据说明站点还没初始化（连种子账号都没有），等第一次真正写凭据时再建
            if (!creds.username || !creds.password) return null;

            const hashed = isHashedPassword(creds.password)
                ? creds.password
                : await hashPassword(creds.password);
            const inserted = await this.db
                .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id")
                .bind(creds.username, hashed, "owner")
                .first<{ id: number }>();
            return inserted?.id ?? null;
        } catch (error) {
            console.error("迁移首个账号失败:", error);
            return null;
        }
    }

    // 读取 sites 表已有列，返回缺失的凭据列（无法读取时按「都缺」处理，交给 ALTER 自行兼容）
    private async findMissingSiteColumns(): Promise<string[]> {
        const credentials = ["username", "password"];
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info('sites')")
                .all<{ name: string }>();
            const columns = new Set((result.results || []).map(row => row.name));
            // 表都还不存在时不用 ALTER，建表语句里已经包含这两列
            if (columns.size === 0) return [];
            return credentials.filter(column => !columns.has(column));
        } catch {
            return credentials;
        }
    }

    // 结构异常（缺表 / 缺列）时重跑一次迁移再重试。
    // 迁移结果虽然缓存，但遇到 D1 里结构被回退或首次迁移被跳过的情况仍能自愈，代价只有出错时的一次重试。
    private async withSchemaRetry<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no such (column|table)/i.test(message)) {
                throw error;
            }
            console.warn("检测到数据库结构异常，重新执行迁移后重试:", message);
            migrationPromise = null;
            await this.migrate();
            return await run();
        }
    }

    /**
     * 读取生效中的管理员凭据。
     * 数据库中已存在 → 直接用它（重新部署不再改变）；
     * 数据库中没有 → 说明是第一次部署，把 wrangler vars 里的默认值固化到数据库。
     */
    async getAuthCredentials(): Promise<{ username: string; password: string }> {
        await this.migrate();
        try {
            return await this.withSchemaRetry(() => this.readAuthCredentials());
        } catch (error) {
            console.error("读取管理员凭据失败，回退到环境变量:", error);
            return { username: this.seedUsername, password: this.seedPassword };
        }
    }

    private async readAuthCredentials(): Promise<{ username: string; password: string }> {
        const [userRow, passRow] = await this.db.batch<{ value: string }>([
            this.db.prepare("SELECT value FROM configs WHERE key = ?").bind(AUTH_USERNAME_KEY),
            this.db.prepare("SELECT value FROM configs WHERE key = ?").bind(AUTH_PASSWORD_KEY),
        ]);

        const storedUsername = (userRow.results || [])[0]?.value;
        const storedPassword = (passRow.results || [])[0]?.value;

        // 两个值都在 → 以数据库为准，后续部署不再改动
        if (storedUsername && storedPassword) {
            return { username: storedUsername, password: storedPassword };
        }

        // 没有配置环境变量时不写库（否则会把空账号密码固化下来）
        if (!this.seedUsername && !this.seedPassword) {
            return { username: this.seedUsername, password: this.seedPassword };
        }

        // 第一次部署：把环境变量里的默认值写进数据库，之后就一直用它。
        // 同时置「必须改密」——种子凭据来自部署变量，等同于半公开，必须换掉才算安全。
        await this.updateAuthCredentials(this.seedUsername, this.seedPassword);
        await this.setConfig(MUST_CHANGE_PASSWORD_KEY, "1");
        return { username: this.seedUsername, password: this.seedPassword };
    }

    // ============ 审计日志 ============
    // 关键动作留痕（登录成功/失败、改密、重置、删站点、改备份配置）。
    // 写入失败一律吞掉：审计不能反过来把正常操作搞挂。
    async writeAudit(action: string, actor: string, ip: string, detail = ""): Promise<void> {
        try {
            await this.db
                .prepare(
                    "INSERT INTO audit_log (action, actor, ip, detail) VALUES (?, ?, ?, ?)"
                )
                .bind(action, actor || "", ip || "", detail || "")
                .run();
        } catch (error) {
            console.error("写入审计日志失败:", error);
        }
    }

    /** 读取审计日志（owner 只读视图）。按时间倒序，支持分页与按操作者过滤。 */
    async getAuditLog(opts: { limit?: number; offset?: number; actor?: string } = {}): Promise<
        Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>
    > {
        await this.migrate();
        const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
        const offset = Math.max(opts.offset ?? 0, 0);
        let query = "SELECT id, action, actor, ip, detail, created_at FROM audit_log";
        const params: (string | number)[] = [];
        if (opts.actor) {
            query += " WHERE actor = ?";
            params.push(opts.actor);
        }
        query += " ORDER BY id DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);
        try {
            const result = await this.db.prepare(query).bind(...params).all<{
                id: number;
                action: string;
                actor: string;
                ip: string;
                detail: string;
                created_at: string;
            }>();
            return result.results || [];
        } catch (error) {
            console.error("读取审计日志失败:", error);
            return [];
        }
    }

    // ============ 令牌黑名单（退出登录 = 服务端可吊销） ============
    // JWT 本身无状态，退出登录只能靠「把这张令牌的 jti 拉黑」来实现真正失效。
    // 存一张表而不是 configs 里的一个 JSON：并发登出时「读-改-写」会互相覆盖，
    // 被覆盖掉的那张令牌就能一直用到过期。按 jti 作主键插入则天然幂等。
    // 过期行由每周定时任务清理（见 cleanupExpiredRows）。

    /** 把某张令牌拉黑（退出登录 / 发现令牌泄露时调用） */
    async blacklistToken(jti: string, exp: number): Promise<void> {
        if (!jti) return;
        try {
            await this.db
                .prepare(
                    `INSERT INTO token_blacklist (jti, exp) VALUES (?, ?)
                     ON CONFLICT(jti) DO UPDATE SET exp = ?`
                )
                .bind(jti, exp, exp)
                .run();
        } catch (error) {
            console.error("拉黑令牌失败:", error);
        }
    }

    private async isTokenBlacklisted(jti: string): Promise<boolean> {
        if (!jti) return false;
        try {
            const row = await this.db
                .prepare("SELECT jti FROM token_blacklist WHERE jti = ?")
                .bind(jti)
                .first<{ jti: string }>();
            return !!row;
        } catch {
            // 表还没建好时不能放行任何令牌：宁可让这一张失效，也不能让登出过的令牌复活
            return true;
        }
    }

    // ============ 首次部署强制改密 ============
    // 种子凭据来自部署变量（等同半公开），首次部署后必须改一次才算安全。
    async mustChangePassword(): Promise<boolean> {
        const raw = await this.getConfig(MUST_CHANGE_PASSWORD_KEY);
        return raw === "1";
    }

    private async clearMustChangePassword(): Promise<void> {
        await this.setConfig(MUST_CHANGE_PASSWORD_KEY, "0");
    }

    // 令牌版本：改密 / 重置后 +1，让已签发的令牌立即失效（服务端可吊销）。
    //
    // 多账号之前是全站一份（configs.auth.tokenVersion），于是「任何一个账号改密、注销、
    // 密钥恢复」会把所有人的会话一起踢掉 —— 别人什么都没做就被迫重新登录。
    // 现在按账号记（users.token_version）：
    //   - 有账号上下文 → 认自己那一列，改只作废自己的令牌；
    //   - 没有账号上下文（老令牌 / 还没迁移到 users 的单管理员）→ 仍走全站那份。
    private async getTokenVersion(uid: number | null = null): Promise<number> {
        if (uid === null) {
            if (this.tokenVersionCache !== null) return this.tokenVersionCache;
            const raw = await this.getConfig(TOKEN_VERSION_KEY);
            const v = raw ? Number(raw) : 0;
            this.tokenVersionCache = Number.isFinite(v) ? v : 0;
            return this.tokenVersionCache;
        }
        const cached = this.accountVersionCache.get(uid);
        if (cached !== undefined) return cached;
        try {
            const row = await this.db
                .prepare("SELECT token_version FROM users WHERE id = ?")
                .bind(uid)
                .first<{ token_version: number | null }>();
            const v = Number(row?.token_version ?? 0);
            const safe = Number.isFinite(v) ? v : 0;
            this.accountVersionCache.set(uid, safe);
            return safe;
        } catch {
            // 列还没建好：退回全站那份，别因为迁移时序把所有人卡在门外
            return this.getTokenVersion(null);
        }
    }

    /**
     * 令牌版本 +1。传账号 id 就只作废那一个账号的令牌；传 null（或没传）作废全站。
     */
    private async bumpTokenVersion(uid: number | null = null): Promise<void> {
        if (uid === null) {
            const v = (await this.getTokenVersion(null)) + 1;
            this.tokenVersionCache = v;
            await this.setConfig(TOKEN_VERSION_KEY, String(v));
            return;
        }
        const v = (await this.getTokenVersion(uid)) + 1;
        this.accountVersionCache.set(uid, v);
        try {
            await this.db
                .prepare(
                    "UPDATE users SET token_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                )
                .bind(v, uid)
                .run();
        } catch (error) {
            // 按账号 bump 失败时必须兜底 bump 全站版本 —— 宁可多踢一次，也不能让旧令牌继续有效
            console.error("按账号递增令牌版本失败，退回全局:", error);
            const g = (await this.getTokenVersion(null)) + 1;
            this.tokenVersionCache = g;
            await this.setConfig(TOKEN_VERSION_KEY, String(g));
        }
    }

    // 更新管理员凭据（写入数据库后立即生效）
    async updateAuthCredentials(username: string, password: string): Promise<boolean> {
        // 密码一律哈希存储，绝不落明文
        const hashed = await hashPassword(password);
        const okUser = await this.setConfig(AUTH_USERNAME_KEY, username);
        const okPass = await this.setConfig(AUTH_PASSWORD_KEY, hashed);
        await this.bumpTokenVersion();
        // 已经换成自己的密码了，解除「必须改密」限制
        await this.clearMustChangePassword();
        return okUser && okPass;
    }

    // ============ 密钥恢复（非对称，公钥在服务器、私钥离线） ============
    // 用私钥签名的 JWS 令牌重置管理员密码。服务器只验签、不持有私钥，
    // 因此这个公网入口无法被暴力猜解（没有私钥造不出合法 token）。
    /**
     * 取当前生效的恢复公钥：优先部署变量（wrangler secret），没有再用当前账号自己的。
     * 之所以支持库里存：网页端生成密钥对后要把公钥交给服务器，而 secret 只能命令行改。
     *
     * 多账号下公钥是每个账号一份，**不回落到全站那一份**：
     * 否则新账号会显示「已配置」，但它根本拿不到对应的私钥。
     */
    async getRecoveryPublicKey(): Promise<string> {
        if (this.recoveryPubKey) return this.recoveryPubKey;
        const uid = this.currentUserId;
        if (uid !== null) return this.getRecoveryPublicKeyOfUser(uid);
        const stored = await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG);
        return stored || "";
    }

    /** 读某个账号自己的恢复公钥（列还没建好时当「没配」处理） */
    private async getRecoveryPublicKeyOfUser(userId: number): Promise<string> {
        try {
            const row = await this.db
                .prepare("SELECT recovery_public_key FROM users WHERE id = ?")
                .bind(userId)
                .first<{ recovery_public_key: string | null }>();
            return (row?.recovery_public_key || "").trim();
        } catch {
            return "";
        }
    }

    /** 写某个账号自己的恢复公钥（传空串 = 停用） */
    private async setRecoveryPublicKeyOfUser(userId: number, key: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare(
                    "UPDATE users SET recovery_public_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                )
                .bind(key, userId)
                .run();
            return result.success;
        } catch (error) {
            console.error("保存恢复公钥失败:", error);
            return false;
        }
    }

    /**
     * 解除停用：状态恢复 active、清掉停用时间，并把活跃时间刷成现在。
     * 活跃时间必须刷 —— 沉睡扫描每周都跑，不刷的话下周还会被判成沉睡账号。
     */
    private async reactivateUser(userId: number): Promise<void> {
        try {
            await this.db
                .prepare(
                    `UPDATE users SET "status" = 'active', disabled_at = NULL, last_active_at = ? WHERE id = ?`
                )
                .bind(Math.floor(Date.now() / 1000), userId)
                .run();
        } catch {
            // 列还没建好（迁移未跑）时静默跳过：主流程是恢复访问，不该被这一句带崩
        }
    }

    /**
     * 收集所有可用于验签的恢复公钥（连同它属于哪个账号）。
     *
     * 为什么不「只挑账号名指定的那一把」：找回密码的常见情形恰恰是**连账号名都忘了**，
     * 手里只剩一份私钥文件。此时若死板地按令牌里的账号名找公钥，找不到就回落到
     * 站点所有者那把 —— 验签必然失败，用户会被自己手里的私钥挡在门外
     * （报错正是「恢复令牌无效或签名不匹配」）。
     *
     * 所以这里把全站已配置的公钥都收上来挨个试：谁的公钥验得过，就说明这份私钥是给谁的，
     * 重置的也就是那个账号。安全性没有变化 —— 能走到这一步的前提仍然是「握有私钥」。
     *
     * @param username 令牌里填的账号名（可能为空 / 拼错），只用来把最可能的那把排在前面
     */
    private async collectRecoveryCandidates(
        username: string
    ): Promise<{ userId: number | null; publicKey: string }[]> {
        // 部署变量优先：配了它就只有这一把生效
        if (this.recoveryPubKey) {
            return [{ userId: null, publicKey: this.recoveryPubKey }];
        }

        const list: { userId: number | null; publicKey: string }[] = [];
        const seen = new Set<string>();
        const push = (userId: number | null, key: string) => {
            const trimmed = (key || "").trim();
            if (!trimmed || seen.has(trimmed)) return;
            seen.add(trimmed);
            list.push({ userId, publicKey: trimmed });
        };

        // 令牌里写了账号名就先试它自己的那把：命中率最高，也省掉一轮遍历
        const name = (username || "").trim();
        if (name) {
            const user = await this.findUserByUsername(name);
            if (user) push(user.id, await this.getRecoveryPublicKeyOfUser(user.id));
        }

        try {
            const rows = await this.db
                .prepare(
                    "SELECT id, recovery_public_key FROM users WHERE recovery_public_key IS NOT NULL AND recovery_public_key <> ''"
                )
                .all<{ id: number; recovery_public_key: string | null }>();
            for (const row of rows.results || []) {
                push(row.id, row.recovery_public_key || "");
            }
        } catch {
            // 列还没建好（迁移未跑）：只剩全局那份能用
        }

        // 最后才是 configs 里那份全站一份时代的遗留物
        push(null, (await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG)) || "");
        return list;
    }

    async hasRecoveryKey(): Promise<boolean> {
        if (this.recoveryPubKey) return true;
        const uid = this.currentUserId;
        if (uid !== null) return (await this.getRecoveryPublicKeyOfUser(uid)).length > 0;
        // 登录页还没身份，只回答「这个站点有没有人配过」，不暴露是谁配的
        try {
            const row = await this.db
                .prepare(
                    "SELECT COUNT(*) AS total FROM users WHERE recovery_public_key IS NOT NULL AND recovery_public_key <> ''"
                )
                .first<{ total: number }>();
            if ((row?.total ?? 0) > 0) return true;
        } catch {
            // 列还没建好（迁移未跑），退回全局配置
        }
        return ((await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG)) || "").length > 0;
    }

    /**
     * 保存 / 更换恢复公钥（网页端「生成并下载私钥」时调用）。
     * 必须校验当前密码：否则拿到管理员会话的人可以把自己的公钥塞进来，
     * 即使管理员改了密码也仍能凭自己的私钥重置 —— 一个持久后门。
     */
    async setRecoveryPublicKey(
        publicKey: string,
        currentPassword: string,
        clientKey: string = "unknown"
    ): Promise<{ success: boolean; message: string }> {
        const key = (publicKey || "").trim();
        const uid = this.currentUserId;

        // 留空 = 停用密钥恢复
        if (!key) {
            if (uid !== null) {
                await this.setRecoveryPublicKeyOfUser(uid, "");
            } else {
                await this.deleteConfig(RECOVERY_PUBLIC_KEY_CONFIG);
            }
            await this.writeAudit("auth.recoveryKey", "", clientKey, "停用恢复密钥");
            return { success: true, message: "已停用密钥恢复" };
        }

        // 部署变量里配了公钥时，库里的值不会生效，改了也是白改
        if (this.recoveryPubKey) {
            return {
                success: false,
                message: "已通过部署变量 AUTH_RECOVERY_PUBLIC_KEY 配置公钥，如需改用网页生成的密钥请先删除该变量",
            };
        }

        // 必须校验当前密码：否则拿到会话的人可以把自己的公钥塞进来留后门。
        // 多账号下比的是「当前账号」自己的哈希；没有用户上下文时（旧令牌）才退回全局凭据
        if (uid !== null) {
            if (!(await this.verifyPasswordOfUser(uid, currentPassword))) {
                await this.writeAudit("auth.recoveryKey.failed", "", clientKey, "当前密码不正确");
                return { success: false, message: "当前密码不正确" };
            }
        } else if (this.authEnabled) {
            const creds = await this.getAuthCredentials();
            const ok = await verifyPassword(currentPassword, creds.password);
            if (!ok) {
                await this.writeAudit("auth.recoveryKey.failed", "", clientKey, "当前密码不正确");
                return { success: false, message: "当前密码不正确" };
            }
        }

        // 写入前先试着导入一遍：别把一段乱码存进库，等真要找回密码才发现用不了
        if (!(await isValidRecoveryPublicKey(key))) {
            return { success: false, message: "恢复公钥格式不合法，请重新生成" };
        }

        // 公钥归属当前账号：别人的私钥签不出自己账号能用的令牌
        const ok =
            uid !== null
                ? await this.setRecoveryPublicKeyOfUser(uid, key)
                : await this.setConfig(RECOVERY_PUBLIC_KEY_CONFIG, key);
        if (!ok) return { success: false, message: "保存恢复公钥失败，请重试" };

        await this.writeAudit("auth.recoveryKey", "", clientKey, "更新恢复公钥");
        return { success: true, message: "恢复公钥已保存，请妥善保管下载的私钥文件" };
    }

    async redeemRecoveryToken(
        token: string,
        clientKey: string = "unknown"
    ): Promise<{ success: boolean; message: string }> {
        // 多账号：每个账号有自己的公钥，先把「可能是给谁的」都收上来挨个试，
        // 验得过才算数 —— 这样连账号名都忘了的人，单凭私钥也能找回自己的账号。
        const tokenUsername = peekRecoveryTokenUsername(token);
        const candidates = await this.collectRecoveryCandidates(tokenUsername);
        if (candidates.length === 0) {
            return {
                success: false,
                message: tokenUsername
                    ? `账号「${tokenUsername}」尚未配置恢复公钥，无法用密钥恢复`
                    : "本站点尚未配置恢复公钥，无法用密钥恢复",
            };
        }

        // 挨个试：谁的公钥验得过，这份私钥就是给谁的
        let holder: { userId: number | null } | null = null;
        let verified: { payload: RecoveryPayload } | null = null;
        for (const candidate of candidates) {
            const result = await verifyRecoveryToken(token, candidate.publicKey);
            if (result.valid && result.payload) {
                holder = candidate;
                verified = result as { payload: RecoveryPayload };
                break;
            }
        }
        if (!holder || !verified) {
            await this.writeAudit("auth.recover.failed", "", clientKey, "签名校验失败");
            return { success: false, message: "恢复令牌无效或签名不匹配" };
        }

        const { username, passwordHash, exp, jti } = verified.payload;

        // 过期（token 自带 exp，不依赖外部状态）
        if (typeof exp === "number" && exp < Math.floor(Date.now() / 1000)) {
            return { success: false, message: "恢复令牌已过期，请重新生成" };
        }

        // 一次性：jti 已用过则拒绝（防重放）
        const usedKey = `auth.recoveryJti.${jti}`;
        if (await this.getConfig(usedKey)) {
            return { success: false, message: "恢复令牌已被使用过" };
        }

        // 令牌里带的必须是哈希，不接受明文：
        // 否则一份被别人捡到的私钥文件能把管理员密码设成弱口令，绕过强度策略
        if (!isHashedPassword(passwordHash)) {
            return { success: false, message: "恢复令牌中的密码格式不合法" };
        }

        // 目标账号 = 私钥所属的那个账号（不再靠账号名去猜）：
        // 只有当命中的是单账号时代遗留的全局公钥（userId 为 null）时，才回落到 owner / configs。
        const name = (username || "").trim();
        const target =
            holder.userId !== null
                ? await this.getUserById(holder.userId)
                : await this.findOwnerUser();

        let okUser = true;
        let okPass = true;
        if (target) {
            // 账号名可以和密码一起改：连账号名都忘了的人填一个新名字即可，
            // 留空表示只重置密码、账号名不动。改名前先查重，别把别人的名字占了。
            if (name && name !== target.username) {
                const clash = await this.findUserByUsername(name);
                if (clash && clash.id !== target.id) {
                    return { success: false, message: `账号名「${name}」已被占用，请换一个` };
                }
                okUser = await this.db
                    .prepare("UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(name, target.id)
                    .run()
                    .then(r => r.success);
            }
            okPass = await this.db
                .prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(passwordHash, target.id)
                .run()
                .then(r => r.success);
            // 能用私钥签出合法令牌的就是本人，顺手解除「长期未登录」的停用状态：
            // 否则会卡成一个死循环 —— 登录页提示「已被停用，请联系所有者」，
            // 而找回密码这条路走完仍然登不进去。
            await this.reactivateUser(target.id);
            this.invalidateSessionState(target.id);
        } else {
            // 老部署：users 表里还没有账号，凭据仍在 configs
            okUser = name ? await this.setConfig(AUTH_USERNAME_KEY, name) : true;
            okPass = await this.setConfig(AUTH_PASSWORD_KEY, passwordHash);
        }
        // 作废 configs 里的旧凭据（用户名一并改掉时尤其重要，见 disableLegacyCredentials）
        if (target) await this.disableLegacyCredentials();
        await this.bumpTokenVersion(target?.id ?? null);
        await this.clearMustChangePassword();
        // 记下 jti，过期时间作为兜底清理依据（旧条目不自动删除，但体量极小）
        await this.setConfig(usedKey, String(exp));

        await this.writeAudit("auth.recover", name || target?.username || "", clientKey, "密钥恢复成功");
        if (!okUser || !okPass) {
            return { success: false, message: "恢复成功但写入凭据失败，请重试" };
        }
        // 把最终账号名回给用户：忘了账号名的人正是靠这一句知道自己该用哪个账号登录
        const finalName = name || target?.username || "管理员";
        return {
            success: true,
            message: `账号「${finalName}」的密码已重置，请用新密码登录`,
        };
    }

    // 验证用户登录（多账号：优先查 users 表，查不到再退回旧的单管理员凭据）
    async login(loginRequest: LoginRequest): Promise<LoginResponse> {
        // 令牌有效期：普通登录 1 天；勾选「记住我」则是 30 天，实现「一个月内免登录」
        const ttlSeconds = loginRequest.remember ? REMEMBER_TOKEN_TTL : DEFAULT_TOKEN_TTL;

        // 如果未启用身份验证，直接返回成功
        if (!this.authEnabled) {
            return {
                success: true,
                token: await this.generateToken({ username: "guest" }, ttlSeconds),
                message: "身份验证未启用，默认登录成功",
            };
        }

        // H1 fail-closed：启用鉴权却没配 AUTH_SECRET，登录无法签发令牌
        if (this.authEnabled && !this.secretConfigured) {
            return {
                success: false,
                message: "服务器未配置 AUTH_SECRET，无法签发登录令牌，请联系管理员",
            };
        }

        await this.migrate();

        const user = await this.findUserByUsername(loginRequest.username);
        if (user) {
            // 验证用户名 + 密码哈希（定时间比较；存量明文会在首次登录后自动升级为哈希）
            const ok = await verifyPassword(loginRequest.password, user.passwordHash);
            if (!ok) {
                return { success: false, message: "用户名或密码错误" };
            }
            // 长期未登录被停用的账号不再放行：数据一条没删，
            // 等 owner 在「账号管理」里重新启用，或本人用恢复密钥找回（那条路走 recover，不受影响）
            if (user.status === "disabled") {
                return {
                    success: false,
                    message: "该账号因长期未登录已被停用，请联系站点所有者启用",
                };
            }
            // 存量明文迁移：登录成功就把明文换成哈希落库
            if (!isHashedPassword(user.passwordHash)) {
                await this.setUserPassword(user.id, loginRequest.password);
            }
            // 显式登录 = 确定在用：无条件刷新活跃时间（沉睡治理的锚点）
            await this.recordActiveLogin(user.id);
            const token = await this.generateToken(
                { username: user.username, uid: user.id, role: user.role },
                ttlSeconds
            );
            return {
                success: true,
                token,
                message: "登录成功",
                username: user.username,
                role: user.role,
            };
        }

        /**
         * 兼容：users 表里还没有这个账号时用 configs 里那份单管理员凭据再验一次。
         *
         * ⚠️ 这条回落过去有两个大坑，现在都被堵上：
         *   1. 回落签出的令牌只带 `{username}`，**没有 uid**。鉴权中间件看到没有 uid 就
         *      `setCurrentUser(null)`，而 scopeSql 在 null 时是不加条件的 —— 等于一张令牌
         *      能看到**所有账号**的站点与解密后的密码。
         *      现在只要 users 表里有账号就一律不回落；真回落时也必须绑到同名账号的 uid 上。
         *   2. configs 里那份凭据从不跟着 users 侧改密走：owner 改了账号名 / 改了密码之后，
         *      旧账号名 + 部署时的种子密码仍然登得进来（种子凭据来自部署变量，等同半公开）。
         *      现在改密 / 改名会同步把 configs 那份作废（见 disableLegacyCredentials）。
         */
        if (await this.hasAnyUser()) {
            return { success: false, message: "用户名或密码错误" };
        }

        const credentials = await this.getAuthCredentials();
        const passwordOk = await verifyPassword(loginRequest.password, credentials.password);
        if (loginRequest.username === credentials.username && passwordOk) {
            if (!isHashedPassword(credentials.password)) {
                await this.updateAuthCredentials(credentials.username, loginRequest.password);
            }
            // 即便 users 表为空也再找一次同名账号：万一存在，令牌必须带上它的 uid
            const legacyUser = await this.findUserByUsername(credentials.username);
            if (legacyUser) {
                await this.recordActiveLogin(legacyUser.id);
                return {
                    success: true,
                    token: await this.generateToken(
                        {
                            username: legacyUser.username,
                            uid: legacyUser.id,
                            role: legacyUser.role,
                        },
                        ttlSeconds
                    ),
                    message: "登录成功",
                    username: legacyUser.username,
                    role: legacyUser.role,
                };
            }
            return {
                success: true,
                token: await this.generateToken({ username: credentials.username }, ttlSeconds),
                message: "登录成功",
                username: credentials.username,
            };
        }

        return {
            success: false,
            message: "用户名或密码错误",
        };
    }

    /** users 表里有没有账号：有则不允许再落到 configs 那份老凭据上（见 login 里的注释） */
    async hasAnyUser(): Promise<boolean> {
        if (this.anyUserCache !== null) return this.anyUserCache;
        try {
            const row = await this.db
                .prepare("SELECT COUNT(*) AS total FROM users")
                .first<{ total: number }>();
            const has = (row?.total ?? 0) > 0;
            // 只在「有账号」时缓存：注册第一个账号之前要允许反复查
            if (has) this.anyUserCache = true;
            return has;
        } catch {
            // 表还没建好 = 还没迁移 = 确实没有账号
            return false;
        }
    }

    /**
     * 把 configs 里那份单管理员凭据作废。
     *
     * 多账号之后改密改的是 users 表，configs 里那份（部署种子凭据）会一直留着；
     * 只要它还在，旧账号名 + 旧密码就仍然是一条能登进来的旁路。每次成功改密 / 改名
     * 都把它删掉，让「改了密码」这件事真正生效。
     */
    private async disableLegacyCredentials(): Promise<void> {
        try {
            await this.deleteConfig(AUTH_USERNAME_KEY);
            await this.deleteConfig(AUTH_PASSWORD_KEY);
            this.anyUserCache = true; // 走到这一步 users 表里肯定有账号
        } catch (error) {
            console.error("清理旧管理员凭据失败:", error);
        }
    }

    // ============ 多账号：用户与邀请码 ============
    /** 按账号名查用户（含哈希，只在服务端内部用） */
    private async findUserByUsername(
        username: string
    ): Promise<{
        id: number;
        username: string;
        passwordHash: string;
        role: "owner" | "user";
        status: string | null;
    } | null> {
        try {
            const row = await this.db
                .prepare(
                    "SELECT id, username, password_hash, role, \"status\" FROM users WHERE username = ?"
                )
                .bind(username)
                .first<{
                    id: number;
                    username: string;
                    password_hash: string;
                    role: string;
                    status: string | null;
                }>();
            if (!row) return null;
            return {
                id: row.id,
                username: row.username,
                passwordHash: row.password_hash,
                role: row.role === "owner" ? "owner" : "user",
                status: row.status,
            };
        } catch {
            return null;
        }
    }

    /** 取首个 owner（恢复密钥默认重置它） */
    private async findOwnerUser(): Promise<{ id: number; username: string } | null> {
        try {
            return await this.db
                .prepare("SELECT id, username FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
                .first<{ id: number; username: string }>();
        } catch {
            return null;
        }
    }

    /** 给指定账号签一张令牌（注册成功后直接登录，省得再回登录页输一遍） */
    async issueTokenForUser(
        uid: number,
        username: string,
        ttlSeconds: number = DEFAULT_TOKEN_TTL
    ): Promise<string> {
        return this.generateToken({ username, uid }, ttlSeconds);
    }

    async getUserById(id: number): Promise<UserRecord | null> {
        try {
            const row = await this.db
                .prepare("SELECT id, username, role, created_at FROM users WHERE id = ?")
                .bind(id)
                .first<UserRecord>();
            return row ?? null;
        } catch {
            return null;
        }
    }

    /**
     * 刷新「最后活跃时间」——限频为每天最多写一次，避免每个请求都往 D1 落一行。
     *
     * 只要令牌验过（含「记住我」的静默恢复）就算活跃：一个每天来、只是 cookie 还有效
     * 的人，不该被判成沉睡账号。SQL 里带上 last_active_at 过期条件，没到一天就 0 行变更。
     */
    async touchLastActive(uid: number): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const threshold = now - 24 * 60 * 60;
        try {
            await this.db
                .prepare(
                    `UPDATE users SET last_active_at = ? WHERE id = ? AND (last_active_at IS NULL OR last_active_at < ?)`
                )
                .bind(now, uid, threshold)
                .run();
        } catch {
            // 列缺失 / 表异常都不该影响主流程
        }
    }

    /**
     * 令牌验签通过之后，再确认一次账号还在不在、有没有被停用。
     *
     * JWT 是自包含的，账号被停用或清除时它并不会失效 —— 「记住我」那张能活 30 天。
     * 只验签就放行的话：被停用的账号照样能改数据（等于停用形同虚设），
     * 被清除的账号写出来的行会挂在一个已不存在的 user_id 上变成孤儿数据。
     * 所以每个请求都要补这一问，用短缓存压掉查库开销（见 sessionStateCache）。
     */
    async getAccountSessionState(uid: number): Promise<AccountSessionState> {
        const now = Date.now();
        const cached = this.sessionStateCache.get(uid);
        if (cached && now - cached.at < SESSION_STATE_TTL_MS) return cached.state;

        let state: AccountSessionState = "missing";
        try {
            const row = await this.db
                .prepare(`SELECT "status" FROM users WHERE id = ?`)
                .bind(uid)
                .first<{ status: string | null }>();
            if (!row) state = "missing";
            else state = row.status === "disabled" ? "disabled" : "active";
        } catch {
            // 迁移未跑完（首请求、users 表 / status 列还没建好）时 fail-open，放行以免整站登不进；
            // 迁移跑完之后若还查出错，按「账号不可用」fail-closed，拦下已被停用 / 清除的旧令牌。
            state = this.dbReady ? "missing" : "active";
        }
        this.sessionStateCache.set(uid, { state, at: now });
        return state;
    }

    /** 停用 / 清除 / 重新启用之后调一下：缓存里那条结论已经不成立了 */
    private invalidateSessionState(uid: number): void {
        this.sessionStateCache.delete(uid);
    }

    /** 显式登录成功：无条件刷新活跃时间（不受每天的限频影响） */
    private async recordActiveLogin(uid: number): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        try {
            await this.db
                .prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`)
                .bind(now, uid)
                .run();
        } catch {
            // 忽略
        }
    }

    /** 账号列表（owner 视角）：含停用状态、最后活跃、距停用/清除的推算时间 */
    async listUsers(): Promise<AccountInfo[]> {
        const disableDays = await this.getInactiveDisableDays();
        const graceDays = await this.getInactiveGraceDays();
        try {
            const result = await this.db
                .prepare(
                    `SELECT id, username, role, "status", last_active_at, disabled_at, created_at FROM users ORDER BY id`
                )
                .all<{
                    id: number;
                    username: string;
                    role: string;
                    status: string | null;
                    last_active_at: number | null;
                    disabled_at: number | null;
                    created_at: string | null;
                }>();
            const rows = result.results || [];
            return rows.map(row => {
                const status: AccountInfo["status"] = row.status === "disabled" ? "disabled" : "active";
                // created_at 是 SQLite TIMESTAMP 字符串，换算成秒级时间戳才好看倒计时
                const parsed = row.created_at ? Date.parse(row.created_at) : NaN;
                const createdAt = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
                const timeline = computeInactiveTimeline(
                    {
                        status,
                        lastActiveAt: row.last_active_at,
                        disabledAt: row.disabled_at,
                        createdAt,
                    },
                    disableDays,
                    graceDays
                );
                return {
                    id: row.id,
                    username: row.username,
                    role: row.role === "owner" ? "owner" : "user",
                    status,
                    lastActiveAt: row.last_active_at,
                    disabledAt: row.disabled_at,
                    createdAt,
                    willDisableAt: timeline.willDisableAt,
                    willDeleteAt: timeline.willDeleteAt,
                };
            });
        } catch {
            return [];
        }
    }

    /**
     * owner 手动改某个账号的状态：
     *   - active   = 豁免：清掉停用时间、并把活跃时间刷成现在（否则立刻又会被判沉睡）；
     *   - disabled = 手动停用。
     * 只有 owner 能调；自己不能在这里把自己停用（走「注销账号」那条路）。
     */
    async setUserStatus(
        targetUid: number,
        status: "active" | "disabled",
        actorUid: number
    ): Promise<{ success: boolean; message?: string }> {
        const actor = await this.findUserByIdWithRole(actorUid);
        if (!actor || actor.role !== "owner") {
            return { success: false, message: "仅站点所有者可以管理账号" };
        }
        if (targetUid === actorUid && status === "disabled") {
            return { success: false, message: "不能在这里停用自己的账号，请用「注销账号」" };
        }
        const target = await this.findUserByIdWithRole(targetUid);
        if (!target) {
            return { success: false, message: "目标账号不存在" };
        }
        const now = Math.floor(Date.now() / 1000);
        try {
            if (status === "active") {
                await this.db
                    .prepare(
                        `UPDATE users SET "status" = 'active', disabled_at = NULL, last_active_at = ? WHERE id = ?`
                    )
                    .bind(now, targetUid)
                    .run();
            } else {
                await this.db
                    .prepare(`UPDATE users SET "status" = 'disabled', disabled_at = ? WHERE id = ?`)
                    .bind(now, targetUid)
                    .run();
            }
            await this.writeAudit(
                `auth.userStatus.${status}`,
                actor.username,
                "",
                `账号 ${target.username} 置为 ${status}`
            );
            this.invalidateSessionState(targetUid);
            return { success: true };
        } catch (error) {
            return {
                success: false,
                message: "更新失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    }

    /**
     * 沉睡账号扫描（每周定时任务调用）。两步，都排除 owner（否则站点可能无人可管）：
     *   1. 停用：active 且「最后活跃（没有就用创建时间）」早于停用阈值 -> 置 disabled；
     *   2. 清除：disabled 且停用时间早于宽限期阈值 -> 硬删账号及其全部数据
     *      （user_configs / 它发的或用掉的邀请码 / 它名下的分组与卡片），真正释放 D1 行数。
     */
    async sweepInactiveUsers(): Promise<{ disabled: number; deleted: number }> {
        const disableDays = await this.getInactiveDisableDays();
        const graceDays = await this.getInactiveGraceDays();
        const now = Math.floor(Date.now() / 1000);
        const disableThreshold = now - disableDays * 24 * 60 * 60;
        const deleteThreshold = now - graceDays * 24 * 60 * 60;
        let disabled = 0;
        let deleted = 0;

        try {
            // 1) 先挑出要停用的 id（顺带拿到精确计数，UPDATE 的返回值拿不到变更行数）
            const candidates = await this.db
                .prepare(
                    `SELECT id FROM users
                     WHERE role != 'owner' AND "status" = 'active'
                       AND COALESCE(last_active_at, CAST(strftime('%s', created_at) AS INTEGER)) < ?`
                )
                .bind(disableThreshold)
                .all<{ id: number }>();
            const ids = candidates.results || [];

            if (ids.length > 0) {
                const update = await this.db
                    .prepare(
                        `UPDATE users
                         SET "status" = 'disabled', disabled_at = ?
                         WHERE role != 'owner' AND "status" = 'active'
                           AND COALESCE(last_active_at, CAST(strftime('%s', created_at) AS INTEGER)) < ?`
                    )
                    .bind(now, disableThreshold)
                    .run();
                disabled = update.success ? ids.length : 0;
                for (const { id } of ids) {
                    this.invalidateSessionState(id);
                    await this.writeAudit("auth.inactive.disable", String(id), "", "长期未登录，已停用");
                }
            }

            // 2) 宽限期满的直接清除
            const expired = await this.db
                .prepare(
                    `SELECT id FROM users
                     WHERE role != 'owner' AND "status" = 'disabled'
                       AND disabled_at IS NOT NULL AND disabled_at < ?`
                )
                .bind(deleteThreshold)
                .all<{ id: number }>();

            for (const { id } of expired.results || []) {
                const statements = [
                    this.db.prepare(`DELETE FROM user_configs WHERE user_id = ?`).bind(id),
                    this.db.prepare(`DELETE FROM invites WHERE created_by = ? OR used_by = ?`).bind(id, id),
                    this.db.prepare(`DELETE FROM sites WHERE user_id = ?`).bind(id),
                    this.db.prepare(`DELETE FROM groups WHERE user_id = ?`).bind(id),
                    this.db.prepare(`DELETE FROM users WHERE id = ?`).bind(id),
                ];
                await this.db.batch(statements);
                deleted++;
                this.invalidateSessionState(id);
                await this.writeAudit("auth.inactive.delete", String(id), "", "停用宽限期满，已清除");
            }
        } catch (error) {
            console.error("沉睡账号扫描失败:", error);
        }

        return { disabled, deleted };
    }

    /** 停用阈值（天）：configs 里没有就用默认 180 */
    private async getInactiveDisableDays(): Promise<number> {
        const raw = parseInt((await this.getConfig(INACTIVE_DISABLE_DAYS_KEY)) || "", 10);
        return Number.isFinite(raw) && raw > 0 ? raw : INACTIVE_DISABLE_DAYS_DEFAULT;
    }

    /** 清除宽限期（天）：configs 里没有就用默认 30 */
    private async getInactiveGraceDays(): Promise<number> {
        const raw = parseInt((await this.getConfig(INACTIVE_DELETE_GRACE_DAYS_KEY)) || "", 10);
        return Number.isFinite(raw) && raw > 0 ? raw : INACTIVE_DELETE_GRACE_DAYS_DEFAULT;
    }

    /** 按 id 查账号（带 role，用于 owner 权限判断） */
    private async findUserByIdWithRole(
        uid: number
    ): Promise<{ id: number; username: string; role: "owner" | "user" } | null> {
        try {
            const row = await this.db
                .prepare("SELECT id, username, role FROM users WHERE id = ?")
                .bind(uid)
                .first<{ id: number; username: string; role: string }>();
            if (!row) return null;
            return {
                id: row.id,
                username: row.username,
                role: row.role === "owner" ? "owner" : "user",
            };
        } catch {
            return null;
        }
    }

    /** 校验某个账号的密码是否正确（注销账号这类高危操作前再确认一次身份） */
    async verifyPasswordOfUser(userId: number, plain: string): Promise<boolean> {
        const user = await this.findUserByIdWithHash(userId);
        if (!user) return false;
        return verifyPassword(plain, user.passwordHash);
    }

    /** 写入账号密码（一律哈希，绝不落明文） */
    private async setUserPassword(userId: number, plain: string): Promise<boolean> {
        const hashed = await hashPassword(plain);
        const result = await this.db
            .prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(hashed, userId)
            .run();
        return result.success;
    }

    /** 还剩几个 owner：最后一个 owner 不允许注销，否则站点无人可管 */
    private async countOwners(): Promise<number> {
        try {
            const row = await this.db
                .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner'")
                .first<{ total: number }>();
            return row?.total ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * 注册新账号。必须带一枚有效邀请码 —— 注册入口是公开的，
     * 没有邀请码就等于任何人都能建号（邀请码是唯一的准入门槛）。
     */
    async registerUser(
        username: string,
        password: string,
        inviteCode: string
    ): Promise<RegisterResult> {
        await this.migrate();

        const name = (username || "").trim();
        if (name.length < 2 || name.length > 32) {
            return { success: false, message: "账号名长度需在 2 - 32 个字符之间" };
        }
        // 账号名不允许斜杠等会干扰展示的字符；空格一律挡掉，避免前后缀混淆
        if (!/^[^/\s]+$/.test(name)) {
            return { success: false, message: "账号名不能包含空格或斜杠" };
        }
        if (!password || password.length < 6) {
            return { success: false, message: "密码至少 6 位" };
        }

        const invite = await this.checkInvite((inviteCode || "").trim().toUpperCase());
        if (!invite.ok) return { success: false, message: invite.message };

        if (await this.findUserByUsername(name)) {
            return { success: false, message: "该账号名已被占用" };
        }

        const hashed = await hashPassword(password);
        let created: UserRecord | null = null;
        try {
            const row = await this.db
                .prepare(
                    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id, username, role, created_at"
                )
                .bind(name, hashed, "user")
                .first<UserRecord>();
            created = row ?? null;
        } catch (error) {
            console.error("创建账号失败:", error);
            return { success: false, message: "创建账号失败，请重试" };
        }
        if (!created) return { success: false, message: "创建账号失败，请重试" };

        // 默认起手数据放到建号成功之后、消耗邀请码之前：
        // 就算写数据失败也只是「空账号」，不会把一个用掉的邀请码换来的账号丢掉
        await this.seedStarterData(created.id);

        // 邀请码一次性：并发下靠 used_at IS NULL 保证只有一个请求能标记成功
        const claimed = await this.db
            .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_at IS NULL")
            .bind(created.id, Math.floor(Date.now() / 1000), invite.code)
            .run();

        // 极端并发下码被抢走：账号已建出来，回滚掉更干净
        const changes = (claimed.meta as { changes?: number } | undefined)?.changes;
        if (!claimed.success || changes === 0) {
            await this.db.prepare("DELETE FROM users WHERE id = ?").bind(created.id).run();
            return { success: false, message: "邀请码已被使用" };
        }

        return { success: true, message: "注册成功", user: created };
    }

    /**
     * 给刚注册的账号塞一套默认分组与卡片。
     * 失败一律吞掉：起手数据只是「不至于空荡荡」，不能反过来让注册失败
     *（邀请码已经用掉了，这时候报错等于白白损失一个名额）。
     */
    private async seedStarterData(userId: number): Promise<void> {
        try {
            const statements: D1PreparedStatement[] = [];

            for (let gi = 0; gi < STARTER_GROUPS.length; gi++) {
                const group = STARTER_GROUPS[gi];
                const inserted = await this.db
                    .prepare(
                        "INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id"
                    )
                    .bind(group.name, gi + 1, userId)
                    .all<{ id: number }>();
                const groupId = (inserted.results || [])[0]?.id;
                if (!groupId) continue;

                for (let si = 0; si < group.sites.length; si++) {
                    const site = group.sites[si];
                    statements.push(
                        this.db
                            .prepare(
                                `INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num, user_id)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            )
                            .bind(
                                groupId,
                                site.name,
                                site.url,
                                "",
                                site.description,
                                "",
                                "",
                                "",
                                si + 1,
                                userId
                            )
                    );
                }
            }

            if (statements.length > 0) await this.db.batch(statements);
        } catch (error) {
            console.error("写入新账号默认数据失败:", error);
        }
    }

    /** 校验邀请码是否还能用（不消耗） */
    private async checkInvite(code: string): Promise<{ ok: boolean; message: string; code: string }> {
        if (!code) return { ok: false, message: "请填写邀请码", code };
        try {
            const row = await this.db
                .prepare("SELECT code, expires_at, used_at FROM invites WHERE code = ?")
                .bind(code)
                .first<{ code: string; expires_at: number; used_at: number | null }>();
            if (!row) return { ok: false, message: "邀请码无效", code };
            if (row.used_at) return { ok: false, message: "邀请码已被使用", code };
            if (row.expires_at < Math.floor(Date.now() / 1000)) {
                return { ok: false, message: "邀请码已过期（有效期 30 分钟，请重新生成）", code };
            }
            return { ok: true, message: "", code: row.code };
        } catch {
            return { ok: false, message: "邀请码校验失败，请重试", code };
        }
    }

    /** 生成一枚邀请码（已登录用户调用），30 分钟有效 */
    async createInvite(createdBy: number): Promise<
        { success: boolean; message: string } & Partial<InviteInfo>
    > {
        await this.migrate();
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + INVITE_TTL_SECONDS;

        // 撞码概率极低，但仍留 5 次重试，撞上就换一串
        for (let i = 0; i < 5; i++) {
            const code = randomInviteCode();
            try {
                await this.db
                    .prepare(
                        "INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)"
                    )
                    .bind(code, createdBy, now, expiresAt)
                    .run();
                return { success: true, message: "邀请码已生成", code, expiresAt, ttlSeconds: INVITE_TTL_SECONDS };
            } catch {
                // 撞主键，换一串再来
            }
        }
        return { success: false, message: "生成邀请码失败，请重试" };
    }

    /**
     * 注销账号：分组、站点、账号记录全部删除，不留任何残留。
     * 最后一个 owner 不让注销 —— 否则站点变成没人能管的孤儿。
     */
    async deleteAccount(userId: number): Promise<{ success: boolean; message: string }> {
        const user = await this.getUserById(userId);
        if (!user) return { success: false, message: "账号不存在" };

        if (user.role === "owner" && (await this.countOwners()) <= 1) {
            return {
                success: false,
                message: "这是最后一个管理员账号，注销后将无人能管理站点；请先用邀请码注册一个新账号再注销",
            };
        }

        try {
            // 站点有 group_id 外键级联，但显式先删更保险（级联依赖 D1 的 foreign_keys 开关）
            await this.db.batch([
                this.db.prepare("DELETE FROM sites WHERE user_id = ?").bind(userId),
                this.db.prepare("DELETE FROM groups WHERE user_id = ?").bind(userId),
                this.db.prepare("DELETE FROM invites WHERE created_by = ?").bind(userId),
                this.db.prepare("DELETE FROM invites WHERE used_by = ?").bind(userId),
                // 账号自己的配置（WebDAV 网盘地址 / 账号 / 口令）一并清掉，不留残留
                this.db.prepare("DELETE FROM user_configs WHERE user_id = ?").bind(userId),
                this.db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
            ]);
        } catch (error) {
            console.error("注销账号失败:", error);
            return { success: false, message: "注销账号失败，请重试" };
        }

        // 令牌版本 +1：账号都没了，已签发的令牌必须一起失效
        await this.bumpTokenVersion();
        this.invalidateSessionState(userId);
        return { success: true, message: "账号已注销，相关数据已全部删除" };
    }

    /**
     * 修改当前账号的账号名 / 密码。必须校验当前密码 ——
     * 否则拿到会话的人可以顺手改掉密码把主人锁在门外。
     * 没有用户上下文时（旧令牌 / 未升级）退回 configs 的单管理员逻辑。
     */
    async updateCurrentCredentials(
        username: string,
        password: string,
        currentPassword: string
    ): Promise<{ success: boolean; message: string }> {
        const uid = this.currentUserId;

        if (uid === null) {
            const current = await this.getAuthCredentials();
            if (!(await verifyPassword(currentPassword, current.password))) {
                return { success: false, message: "当前密码不正确" };
            }
            const ok = await this.updateAuthCredentials(
                username || current.username,
                password || current.password
            );
            return { success: ok, message: ok ? "管理员凭据已更新，请牢记新账号密码" : "保存管理员凭据失败" };
        }

        const user = await this.findUserByIdWithHash(uid);
        if (!user) return { success: false, message: "账号不存在" };
        if (!(await verifyPassword(currentPassword, user.passwordHash))) {
            return { success: false, message: "当前密码不正确" };
        }

        if (username && username !== user.username) {
            if (await this.findUserByUsername(username)) {
                return { success: false, message: "该账号名已被占用" };
            }
            const ok = await this.db
                .prepare("UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(username, uid)
                .run();
            if (!ok.success) return { success: false, message: "保存新账号名失败" };
        }
        if (password) await this.setUserPassword(uid, password);

        // 作废 configs 里那份旧凭据：只要它还留着，部署时的种子账号名 + 种子密码
        // 就始终是一条绕过多账号体系、直 admin 的旁路（详见 login 里的回落注释）
        await this.disableLegacyCredentials();
        // 只作废这个账号自己的会话，别把同站点其它账号一起踢下线
        await this.bumpTokenVersion(uid);
        await this.clearMustChangePassword();
        return { success: true, message: "凭据已更新" };
    }

    private async findUserByIdWithHash(
        id: number
    ): Promise<{ id: number; username: string; passwordHash: string; role: "owner" | "user" } | null> {
        try {
            const row = await this.db
                .prepare("SELECT id, username, password_hash, role FROM users WHERE id = ?")
                .bind(id)
                .first<{ id: number; username: string; password_hash: string; role: string }>();
            if (!row) return null;
            return {
                id: row.id,
                username: row.username,
                passwordHash: row.password_hash,
                role: row.role === "owner" ? "owner" : "user",
            };
        } catch {
            return null;
        }
    }

    // 验证令牌有效性
    async verifyToken(
        token: string
    ): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
        if (!this.authEnabled) {
            return { valid: true };
        }
        // H1 fail-closed：启用鉴权但 AUTH_SECRET 缺失，拒绝一切令牌（避免被公开默认密钥伪造）
        if (!this.secretConfigured) {
            return { valid: false };
        }
        // 现在会真正验签（HMAC-SHA256）+ 校验过期 + 校验令牌版本，
        // 伪造的 token 直接被拒，改密后旧 token 也立即失效。
        //
        // 版本号按「令牌里的账号」来取：先看 payload 里的 uid —— 未验签的 payload 只读uid
        // 这一个字段，不做任何信任判断，安全仍然由下面的 verifyJwt 全权负责。
        const uidFromToken = peekJwtClaim(token, "uid");
        const tv = await this.getTokenVersion(
            typeof uidFromToken === "number" ? uidFromToken : null
        );
        const result = await verifyJwt(token, this.secret, { tokenVersion: tv });

        // 验签通过还要再查一次黑名单：退出登录过的令牌不能复活
        if (result.valid) {
            const jti = typeof result.payload?.jti === "string" ? result.payload.jti : "";
            if (await this.isTokenBlacklisted(jti)) {
                return { valid: false };
            }
        }
        return result;
    }

    // 生成JWT令牌
    private async generateToken(
        payload: Record<string, unknown>,
        ttlSeconds: number = DEFAULT_TOKEN_TTL
    ): Promise<string> {
        // H1 fail-closed：启用鉴权却没配 AUTH_SECRET，拒绝签发令牌
        if (this.authEnabled && !this.secretConfigured) {
            throw new Error("AUTH_SECRET 未配置，拒绝签发令牌");
        }
        // 嵌入令牌版本：改密后所有旧 token（版本偏低）在 verifyToken 处被拒。
        // jti 是这张令牌的唯一编号，退出登录时按它拉黑 —— 让「登出」真的能让令牌失效。
        // 版本认「这张令牌属于哪个账号」的那一列，别人改密不会连坐。
        const tokenUid = typeof payload.uid === "number" ? payload.uid : null;
        const tv = await this.getTokenVersion(tokenUid);
        const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
        const tokenPayload = {
            ...payload,
            tv,
            jti: crypto.randomUUID(),
            exp,
            iat: Math.floor(Date.now() / 1000),
        };
        return signJwt(tokenPayload, this.secret);
    }

    // 校验「当前密码」是否正确（auth/credentials 改密时用，避免明文比对）
    async verifyCurrentPassword(plain: string): Promise<boolean> {
        const creds = await this.getAuthCredentials();
        return verifyPassword(plain, creds.password);
    }

    // 检查认证是否启用
    isAuthEnabled(): boolean {
        return this.authEnabled;
    }

    // 分组相关 API
    async getGroups(): Promise<Group[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryGroups());
    }

    private async queryGroups(): Promise<Group[]> {
        // 多账号：只看自己的分组（系统级调用不带上用户上下文，照旧看全量）
        const result = await this.db
            .prepare(
                `SELECT id, name, order_num, created_at, updated_at FROM groups${this.scopeSql(
                    false
                )} ORDER BY order_num`
            )
            .bind(...this.scopeParams([]))
            .all<Group>();
        return result.results || [];
    }

    // 首屏 / 刷新：一次请求取回全部分组、站点与配置。
    // 用 db.batch 把 3 条查询合并为一次 D1 往返，替代原先「1 次分组 + 每个分组一次站点」的 N+1 请求。
    async getBootstrap(): Promise<BootstrapData> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryBootstrap());
    }

    private async queryBootstrap(): Promise<BootstrapData> {
        const [groupsResult, sitesResult, configsResult] = await this.db.batch<unknown>([
            this.db
                .prepare(
                    `SELECT id, name, order_num, created_at, updated_at FROM groups${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db
                .prepare(
                    `SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db.prepare("SELECT key, value FROM configs"),
        ]);

        const configs: Record<string, string> = {};
        for (const row of (configsResult.results || []) as Config[]) {
            // 管理员凭据不下发到浏览器，避免出现「拿到配置就等于拿到密码」
            if (isAuthConfigKey(row.key)) continue;
            // 严格私有的那批（WebDAV）只认自己那份：全局里有同键（迁移残留）一律不采纳。
            // 外观键（site.*）保留全站那份当底稿，下面再用账号自己的覆盖 ——
            // 自己没改过标题/背景的话，看到的就是站点所有者定的样子。
            if (this.currentUserId !== null && isPrivateUserConfigKey(row.key)) continue;
            // webdav.password / webdav.backupPassword 落库是密文，这里必须和
            // queryConfigs / getConfig 一样解密还原：
            // 否则刷新后前端拿到的是 enc$... 密文，回填进密码框，用户再保存一次就变成
            // 「密文的密文」（测试连接也就永远认证失败，备份也永远解不开）
            configs[row.key] = isEncryptedConfigKey(row.key)
                ? await decryptSecretDeep(row.value, this.secret)
                : row.value;
        }

        // 覆盖上当前账号自己的那份（WebDAV 备份配置 + 自己的外观）
        if (this.currentUserId !== null) {
            const own = await this.queryUserConfigs(this.currentUserId);
            for (const [key, value] of Object.entries(own)) configs[key] = value;
        }

        return {
            groups: (groupsResult.results || []) as Group[],
            // 站点密码同样是密文落库，首屏必须和 querySites / querySite 一样解密还原：
            // 不解密的话刷新后「复制密码」复制出去的是 enc$...，改站点再保存就变双重加密
            sites: await this.decryptSitePasswords((sitesResult.results || []) as Site[]),
            configs,
        };
    }

    async getGroup(id: number): Promise<Group | null> {
        const result = await this.db
            .prepare(
                `SELECT id, name, order_num, created_at, updated_at FROM groups WHERE id = ?${this.scopeSql(
                    true
                )}`
            )
            .bind(...this.scopeParams([id]))
            .first<Group>();
        return result;
    }

    async createGroup(group: Group): Promise<Group> {
        const result = await this.db
            .prepare(
                "INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id, name, order_num, created_at, updated_at"
            )
            .bind(group.name, group.order_num, this.currentUserId)
            .all<Group>();
        if (!result.results || result.results.length === 0) {
            throw new Error("创建分组失败");
        }
        return result.results[0];
    }

    async updateGroup(id: number, group: Partial<Group>): Promise<Group | null> {
        // 使用参数化查询，避免SQL注入
        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: (string | number)[] = [];

        // 安全地添加字段
        if (group.name !== undefined) {
            updates.push("name = ?");
            params.push(group.name);
        }

        if (group.order_num !== undefined) {
            updates.push("order_num = ?");
            params.push(group.order_num);
        }

        // 构建安全的参数化查询（带上归属账号：改不了别人的分组）
        const query = `UPDATE groups SET ${updates.join(
            ", "
        )} WHERE id = ?${this.scopeSql(
            true
        )} RETURNING id, name, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Group>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        return result.results[0];
    }

    /**
     * 删除分组：先连同它的站点一起搬进回收站（软删除），再真正删除。
     * 返回 recycleId 供前端「撤销」时精确还原，避免本地重建产生重复副本。
     */
    async deleteGroup(id: number): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const group = await this.db
                .prepare(`SELECT * FROM groups WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!group) return { success: false };
            const sitesResult = await this.db
                .prepare(`SELECT * FROM sites WHERE group_id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .all<Record<string, unknown>>();
            const recycleId = await this.pushToRecycle(
                "group",
                JSON.stringify({ group, sites: sitesResult.results || [] })
            );
            const result = await this.db
                .prepare(`DELETE FROM groups WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success, recycleId: result.success ? recycleId : undefined };
        });
    }

    /** 把一条记录塞进回收站，返回新插入的行 id（失败返回 undefined） */
    private async pushToRecycle(kind: string, data: string): Promise<number | undefined> {
        const result = await this.db
            .prepare(
                `INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)`
            )
            .bind(kind, this.currentUserId, data, Math.floor(Date.now() / 1000))
            .run();
        const meta = result.meta as { last_row_id?: number } | undefined;
        return typeof meta?.last_row_id === "number" ? meta.last_row_id : undefined;
    }

    // 网站相关 API
    async getSites(groupId?: number): Promise<Site[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySites(groupId));
    }

    /**
     * 站点密码在库里是密文，读出来统一解密还原给调用方。
     * 历史明文（没有 enc$ 前缀）会原样返回，升级过程无感。
     */
    private async decryptSitePassword(site: Site): Promise<Site> {
        if (!site || !site.password) return site;
        // 用 Deep 版：已被套成多重加密的历史脏值也能解回明文（首屏拿到密文再保存就会套一层）
        return { ...site, password: await decryptSecretDeep(site.password, this.secret) };
    }

    private async decryptSitePasswords(sites: Site[]): Promise<Site[]> {
        return Promise.all(sites.map(site => this.decryptSitePassword(site)));
    }

    private async querySites(groupId?: number): Promise<Site[]> {
        let query =
            "SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites";
        const params: (string | number)[] = [];

        if (groupId !== undefined) {
            query += " WHERE group_id = ?";
            params.push(groupId);
        }

        // 只取属于自己的卡片：否则 A 账号能看到 B 账号的链接与登录凭据
        query += this.scopeSql(groupId !== undefined);

        query += " ORDER BY order_num";

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Site>();
        return this.decryptSitePasswords(result.results || []);
    }

    async getSite(id: number): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySite(id));
    }

    private async querySite(id: number): Promise<Site | null> {
        const result = await this.db
            .prepare(
                `SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites WHERE id = ?${this.scopeSql(
                    true
                )}`
            )
            .bind(...this.scopeParams([id]))
            .first<Site>();
        return result ? this.decryptSitePassword(result) : result;
    }

    async createSite(site: Site): Promise<Site> {
        await this.migrate();
        return this.withSchemaRetry(() => this.insertSite(site));
    }

    private async insertSite(site: Site): Promise<Site> {
        const result = await this.db
            .prepare(
                `
      INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num, user_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
      RETURNING id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at
    `
            )
            .bind(
                site.group_id,
                site.name,
                site.url,
                site.icon || "",
                site.description || "",
                site.notes || "",
                site.username || "",
                // 站点登录凭据落库即加密（读出来时解密）
                await encryptSecret(site.password || "", this.secret),
                site.order_num,
                this.currentUserId
            )
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            throw new Error("创建站点失败");
        }
        // RETURNING 取回的是库里的密文，解密后再返回给前端
        return this.decryptSitePassword(result.results[0]);
    }

    async updateSite(id: number, site: Partial<Site>): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.updateSiteRow(id, site));
    }

    private async updateSiteRow(id: number, site: Partial<Site>): Promise<Site | null> {
        // 使用参数化查询，避免SQL注入
        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: (string | number)[] = [];

        // 安全地添加字段
        if (site.group_id !== undefined) {
            updates.push("group_id = ?");
            params.push(site.group_id);
        }

        if (site.name !== undefined) {
            updates.push("name = ?");
            params.push(site.name);
        }

        if (site.url !== undefined) {
            updates.push("url = ?");
            params.push(site.url);
        }

        if (site.icon !== undefined) {
            updates.push("icon = ?");
            params.push(site.icon);
        }

        if (site.description !== undefined) {
            updates.push("description = ?");
            params.push(site.description);
        }

        if (site.notes !== undefined) {
            updates.push("notes = ?");
            params.push(site.notes);
        }

        if (site.username !== undefined) {
            updates.push("username = ?");
            params.push(site.username);
        }

        if (site.password !== undefined) {
            updates.push("password = ?");
            // 站点登录凭据落库即加密（读出来时解密），D1 导出/备份泄露也解不出明文
            params.push(await encryptSecret(site.password, this.secret));
        }

        if (site.order_num !== undefined) {
            updates.push("order_num = ?");
            params.push(site.order_num);
        }

        // 构建安全的参数化查询（带上归属账号，避免改到别人的卡片）
        const query = `UPDATE sites SET ${updates.join(
            ", "
        )} WHERE id = ?${this.scopeSql(
            true
        )} RETURNING id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        // RETURNING 取回的是库里的密文，解密后再返回给前端
        return this.decryptSitePassword(result.results[0]);
    }

    /**
     * 删除站点：先搬进回收站（软删除，原样保留含密文密码的原始行），再真正删除。
     * 返回 recycleId 供前端「撤销」精确还原。
     */
    async deleteSite(id: number): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT * FROM sites WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!row) return { success: false };
            const recycleId = await this.pushToRecycle("site", JSON.stringify(row));
            const result = await this.db
                .prepare(`DELETE FROM sites WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success, recycleId: result.success ? recycleId : undefined };
        });
    }

    // ============ 回收站（软删除的兜底恢复） ============
    /** 当前账号在回收站里的条目（owner 看到自己删的；普通账号只看自己的） */
    async listRecycleBin(): Promise<
        Array<{ id: number; kind: "site" | "group"; name: string; deletedAt: number }>
    > {
        await this.migrate();
        try {
            const result = await this.db
                .prepare(
                    `SELECT id, kind, data, deleted_at FROM recycle_bin WHERE owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"} ORDER BY id DESC`
                )
                .bind(...(this.currentUserId === null ? [] : [this.currentUserId]))
                .all<{ id: number; kind: string; data: string; deleted_at: number }>();
            return (result.results || []).map(r => {
                let name = "";
                try {
                    const parsed = JSON.parse(r.data) as { group?: { name?: string }; sites?: unknown[]; name?: string };
                    name =
                        typeof parsed.name === "string"
                            ? parsed.name
                            : typeof parsed.group?.name === "string"
                              ? parsed.group.name
                              : r.kind === "group"
                                ? "分组"
                                : "站点";
                    if (r.kind === "group" && Array.isArray(parsed.sites)) {
                        name += `（含 ${parsed.sites.length} 张卡片）`;
                    }
                } catch {
                    name = r.kind === "group" ? "分组" : "站点";
                }
                return { id: r.id, kind: r.kind === "group" ? "group" : "site", name, deletedAt: r.deleted_at };
            });
        } catch (error) {
            console.error("读取回收站失败:", error);
            return [];
        }
    }

    /** 从回收站还原一条（按原始 id 重新插入，含其站点）。返回是否成功。 */
    async restoreRecycleItem(id: number): Promise<boolean> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT kind, data FROM recycle_bin WHERE id = ? AND owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`)
                .bind(...(this.currentUserId === null ? [id] : [id, this.currentUserId]))
                .first<{ kind: string; data: string }>();
            if (!row) return false;
            let parsed: unknown;
            try {
                parsed = JSON.parse(row.data);
            } catch {
                return false;
            }
            if (row.kind === "site") {
                await this.reinsertSite(parsed as Record<string, unknown>);
            } else {
                const g = parsed as { group?: Record<string, unknown>; sites?: Record<string, unknown>[] };
                await this.reinsertGroup(g.group || {}, g.sites || []);
            }
            await this.db.prepare(`DELETE FROM recycle_bin WHERE id = ?`).bind(id).run();
            return true;
        });
    }

    /** 永久删除一条回收站记录（数据不可恢复） */
    async purgeRecycleItem(id: number): Promise<boolean> {
        await this.migrate();
        const result = await this.db
            .prepare(
                `DELETE FROM recycle_bin WHERE id = ? AND owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`
            )
            .bind(...(this.currentUserId === null ? [id] : [id, this.currentUserId]))
            .run();
        return result.success;
    }

    /** 清空当前账号的回收站 */
    async emptyRecycleBin(): Promise<boolean> {
        await this.migrate();
        const result = await this.db
            .prepare(
                `DELETE FROM recycle_bin WHERE owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`
            )
            .bind(...(this.currentUserId === null ? [] : [this.currentUserId]))
            .run();
        return result.success;
    }

    // 还原时的兜底字段：只在读不到表结构（pragma 不可用）时才用，
    // 正常情况下按回收站里那份原始行的列来插，避免写死清单跟表结构脱节。
    private static readonly SITE_RESTORE_COLUMNS = [
        "id", "group_id", "name", "url", "icon", "description", "notes",
        "username", "password", "order_num", "created_at", "updated_at", "user_id",
    ];
    private static readonly GROUP_RESTORE_COLUMNS = [
        "id", "name", "order_num", "created_at", "updated_at", "user_id",
    ];

    /** 表的真实列集合；读不到（表不存在 / pragma 不支持）返回 null */
    private async tableColumns(table: string): Promise<Set<string> | null> {
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info(?)")
                .bind(table)
                .all<{ name: string }>();
            const names = (result.results || []).map(row => row.name);
            return names.length > 0 ? new Set(names) : null;
        } catch {
            return null;
        }
    }

    /**
     * 把一条原始行按原 id 插回（密码仍是原密文，不解密）。
     *
     * 用原始行自带的列，而不是写死的字段清单：站点/分组是按 user_id 做账号隔离的，
     * 清单漏掉 user_id 会让还原出来的行 user_id 为 NULL，立刻被 scopeSql 的
     * "user_id = ?" 过滤掉 —— 用户看到的就是「点了还原，什么也没发生」。
     */
    private async reinsertRow(
        table: "sites" | "groups",
        row: Record<string, unknown>,
        fallbackColumns: string[]
    ): Promise<void> {
        const known = await this.tableColumns(table);
        let data = row;

        // 归属兜底：多账号上线之前删的条目里没有 user_id，还原时归给当前账号
        // （否则插回去是 NULL，照样看不见）。鉴权关闭时 currentUserId 为 null，保持原样。
        if (!known || known.has("user_id")) {
            if (data.user_id === undefined || data.user_id === null) {
                data = { ...data, user_id: this.currentUserId };
            }
        }

        let cols = Object.keys(data).filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
        cols = known ? cols.filter(c => known.has(c)) : cols.filter(c => fallbackColumns.includes(c));
        if (cols.length === 0) return;

        const placeholders = cols.map(() => "?").join(", ");
        const vals = cols.map(c => (data[c] === undefined ? null : data[c]));
        await this.db
            .prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`)
            .bind(...vals)
            .run();
    }

    private async reinsertSite(site: Record<string, unknown>): Promise<void> {
        await this.reinsertRow("sites", site, NavigationAPI.SITE_RESTORE_COLUMNS);
    }

    /** 把分组原始行按原 id 插回，再插回其站点（站点 group_id 指向原分组 id） */
    private async reinsertGroup(group: Record<string, unknown>, sites: Record<string, unknown>[]): Promise<void> {
        await this.reinsertRow("groups", group, NavigationAPI.GROUP_RESTORE_COLUMNS);
        for (const site of sites) {
            await this.reinsertSite(site);
        }
    }

    // 配置相关API
    async getConfigs(): Promise<Record<string, string>> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryConfigs());
    }

    private async queryConfigs(): Promise<Record<string, string>> {
        const uid = this.currentUserId;
        const result = await this.db.prepare("SELECT key, value FROM configs").all<Config>();

        // 将结果转换为键值对对象（管理员凭据永远不返回）
        const configs: Record<string, string> = {};
        for (const config of result.results || []) {
            if (isAuthConfigKey(config.key)) continue;
            // 已登录时，严格私有的那批（WebDAV）只认自己那份：
            // 全站 configs 里若还有同键（迁移残留），一律不采纳，否则会串号。
            // 外观键不在这里剔除 —— 它是「自己没配就回落全站」的，
            // 全站那份正是站点所有者定的基调（也是新账号的初始外观）。
            if (uid !== null && isPrivateUserConfigKey(config.key)) continue;
            // webdav.password / webdav.backupPassword 落库是密文，读出来解密还原给
            // 调用方（含首屏 bootstrap）
            configs[config.key] = isEncryptedConfigKey(config.key)
                ? await decryptSecretDeep(config.value, this.secret)
                : config.value;
        }

        // 覆盖上当前账号自己的那份
        if (uid !== null) {
            const own = await this.queryUserConfigs(uid);
            for (const [key, value] of Object.entries(own)) configs[key] = value;
        }

        return configs;
    }

    // ============ 每账号一份的配置（user_configs） ============
    /** 取某个账号自己的全部私有配置（口令类已解密） */
    private async queryUserConfigs(userId: number): Promise<Record<string, string>> {
        try {
            const result = await this.db
                .prepare("SELECT key, value FROM user_configs WHERE user_id = ?")
                .bind(userId)
                .all<{ key: string; value: string }>();
            const configs: Record<string, string> = {};
            for (const row of result.results || []) {
                configs[row.key] = isEncryptedConfigKey(row.key)
                    ? await decryptSecretDeep(row.value, this.secret)
                    : row.value;
            }
            return configs;
        } catch {
            return {};
        }
    }

    private async getUserConfig(userId: number, key: string): Promise<string | null> {
        try {
            const row = await this.db
                .prepare("SELECT value FROM user_configs WHERE user_id = ? AND key = ?")
                .bind(userId, key)
                .first<{ value: string }>();
            if (!row) return null;
            return isEncryptedConfigKey(key)
                ? await decryptSecretDeep(row.value, this.secret)
                : row.value;
        } catch {
            return null;
        }
    }

    private async setUserConfig(userId: number, key: string, value: string): Promise<boolean> {
        try {
            const stored = isEncryptedConfigKey(key)
                ? await encryptSecret(value, this.secret)
                : value;
            const result = await this.db
                .prepare(
                    `INSERT INTO user_configs (user_id, key, value, updated_at)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(user_id, key)
                     DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(userId, key, stored, stored)
                .run();
            return result.success;
        } catch (error) {
            console.error("设置账号配置失败:", error);
            return false;
        }
    }

    private async deleteUserConfig(userId: number, key: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare("DELETE FROM user_configs WHERE user_id = ? AND key = ?")
                .bind(userId, key)
                .run();
            return result.success;
        } catch {
            return false;
        }
    }

    /**
     * 这个 key 该存哪儿：返回账号 id = 写进该账号自己的 user_configs；null = 写全站 configs。
     *
     * 严格私有的（webdav.*）永远跟账号走。外观键（site.*）要分人：
     * 站点所有者写在全站 configs —— 登录页还没有账号上下文，读的正是这份；
     * 其它账号写在自己那份，读不到才回落全站（见 getConfig / queryConfigs）。
     */
    private async scopeFor(key: string): Promise<number | null> {
        const uid = this.currentUserId;
        if (uid === null) return null;
        if (isPrivateUserConfigKey(key)) return uid;
        if (isPerUserAppearanceKey(key)) {
            return (await this.canManageSharedConfigs()) ? null : uid;
        }
        return null;
    }

    async getConfig(key: string): Promise<string | null> {
        const uid = await this.scopeFor(key);
        if (uid !== null) {
            const own = await this.getUserConfig(uid, key);
            // 外观键没配过就回落全站那份（站点所有者写的），
            // 免得新账号标题空白、背景也没了 —— 私有键（webdav.*）不回落，那是凭据。
            if (own !== null) return own;
            if (isPrivateUserConfigKey(key)) return null;
        }

        const result = await this.db
            .prepare("SELECT value FROM configs WHERE key = ?")
            .bind(key)
            .first<{ value: string }>();
        if (!result) return null;
        // webdav.password / webdav.backupPassword 落库前已加密，读取时解密还原
        if (isEncryptedConfigKey(key)) {
            return await decryptSecretDeep(result.value, this.secret);
        }
        return result.value;
    }

    /**
     * 当前身份能不能写这个 key。
     *
     * 全站共享配置（标题 / 主题 / 背景…）是全站所有人共用的，过去只靠前端藏起来
     * —— 服务端没管，普通账号直接 PUT /api/configs/<key> 就能改全站外观。
     * 现在和导出 / 导入走同一套判据（canManageSharedConfigs），服务端这边也把住：
     *   - user-scoped（webdav.* 这类每人一份的）永远允许，那是自己的东西；
     *   - auth.* 是服务端内部记账（初始化标记、限速计数、必须改密标记…），
     *     路由层已禁止外部访问，这里不再重复判角色，免得把自身逻辑卡死；
     *   - 其余共享键：只有 owner（或未启用登录的单账号部署）能动。
     */
    private async canWriteConfigKey(key: string): Promise<boolean> {
        if (isUserScopedConfigKey(key)) return true;
        if (isAuthConfigKey(key)) return true;
        const uid = this.currentUserId;
        if (uid === null) return true;
        return this.canManageSharedConfigs();
    }

    async setConfig(key: string, value: string): Promise<boolean> {
        if (!(await this.canWriteConfigKey(key))) {
            console.warn(`拒绝非所有者改写全站配置: ${key}`);
            return false;
        }
        const uid = await this.scopeFor(key);
        if (uid !== null) return this.setUserConfig(uid, key, value);

        try {
            // webdav.password / webdav.backupPassword 明文落库风险高，写入前用
            // AUTH_SECRET 派生密钥加密（无 secret 时原样存）
            const stored = isEncryptedConfigKey(key) ? await encryptSecret(value, this.secret) : value;
            // 使用UPSERT语法（SQLite支持）
            const result = await this.db
                .prepare(
                    `INSERT INTO configs (key, value, updated_at) 
                    VALUES (?, ?, CURRENT_TIMESTAMP) 
                    ON CONFLICT(key) 
                    DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(key, stored, stored)
                .run();

            return result.success;
        } catch (error) {
            console.error("设置配置失败:", error);
            return false;
        }
    }

    /**
     * 批量写入配置：保存网站设置时可能一次改十几项，
     * 逐条写就是十几个网络往返 + 十几次 D1 调用，这里用 batch 一次做完。
     */
    async setConfigs(entries: Record<string, string>): Promise<boolean> {
        try {
            const list = Object.entries(entries).filter(([, value]) => value !== undefined);
            if (list.length === 0) return true;

            // 按账号隔离的那部分单独写 user_configs，其余照旧进 configs。
            // 归谁由 scopeFor 说了算（外观键对所有者来说就是全站那份），
            // 不能简单按前缀切 —— 否则所有者改标题只会改到自己的私有副本上，
            // 登录页和其它新账号看到的还是旧标题。
            const mine: { key: string; value: string; uid: number }[] = [];
            const shared: [string, string][] = [];
            for (const [key, value] of list) {
                const uid = await this.scopeFor(key);
                if (uid !== null) mine.push({ key, value, uid });
                else shared.push([key, value]);
            }

            // 全站共享配置只有 owner 能动（理由见 canWriteConfigKey）。整批一次判，
            // 别写下半句才失败 —— 那会留下「改了一半」的状态。
            for (const [key] of shared) {
                if (!(await this.canWriteConfigKey(key))) {
                    console.warn(`拒绝非所有者批量改写全站配置: ${key}`);
                    return false;
                }
            }

            let ok = true;
            if (shared.length > 0) {
                // M2：与单键 setConfig 一致，口令类配置入库前加密，避免认证用户走批写路由把明文落库
                const statements: D1PreparedStatement[] = [];
                for (const [key, value] of shared) {
                    const stored = isEncryptedConfigKey(key)
                        ? await encryptSecret(value, this.secret)
                        : value;
                    statements.push(
                        this.db
                            .prepare(
                                `INSERT INTO configs (key, value, updated_at)
                                VALUES (?, ?, CURRENT_TIMESTAMP)
                                ON CONFLICT(key)
                                DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
                            )
                            .bind(key, stored, stored)
                    );
                }
                const results = await this.db.batch<unknown>(statements);
                ok = results.every(result => result.success);
            }

            for (const { key, value, uid } of mine) {
                // 口令类要在 setUserConfig 里加密，这里不能走批量那条路
                if (!(await this.setUserConfig(uid, key, value))) ok = false;
            }

            return ok;
        } catch (error) {
            console.error("批量设置配置失败:", error);
            return false;
        }
    }

    async deleteConfig(key: string): Promise<boolean> {
        if (!(await this.canWriteConfigKey(key))) {
            console.warn(`拒绝非所有者删除全站配置: ${key}`);
            return false;
        }
        const uid = await this.scopeFor(key);
        if (uid !== null) return this.deleteUserConfig(uid, key);

        const result = await this.db.prepare("DELETE FROM configs WHERE key = ?").bind(key).run();

        return result.success;
    }

    // 批量更新排序
    async updateGroupOrder(groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        if (groupOrders.length === 0) return true;
        // 使用事务确保所有更新一起成功或失败
        return await this.db
            .batch(
                groupOrders.map(item =>
                    this.db
                        .prepare(
                            `UPDATE groups SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${this.scopeSql(
                                true
                            )}`
                        )
                        .bind(...this.scopeParams([item.order_num, item.id]))
                )
            )
            .then(() => true)
            .catch(() => false);
    }

    /**
     * 批量更新站点排序。
     * item 里带 group_id 时同时把卡片移动到新分组 —— 这样「排序 + 跨组移动」
     * 只需要一次请求、一次 D1 batch 就能写完，不必逐张卡片发请求。
     */
    async updateSiteOrder(
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<boolean> {
        if (siteOrders.length === 0) return true;
        await this.migrate();

        // 跨组移动要先确认「目标分组也是自己的」：
        // 以前只给 sites 加了 user_id 条件，group_id 却任意填 —— 拖拽时能把卡片塞进
        // 别人的分组（那之后它既不在自己能看到的分组里，自己也就找不回来了）。
        // 校验不通过的项只更新排序、不改所属分组。
        const wantedGroupIds = [
            ...new Set(
                siteOrders
                    .map(item => item.group_id)
                    .filter((id): id is number => typeof id === "number")
            ),
        ];
        const allowed = await this.filterOwnedGroupIds(wantedGroupIds);

        const buildStatement = (item: { id: number; order_num: number; group_id?: number }) => {
            const tail = `${this.scopeSql(true)}`;
            const moveTo =
                item.group_id !== undefined && allowed.has(item.group_id)
                    ? item.group_id
                    : undefined;
            return moveTo === undefined
                ? this.db
                      .prepare(
                          `UPDATE sites SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${tail}`
                      )
                      .bind(...this.scopeParams([item.order_num, item.id]))
                : this.db
                      .prepare(
                          `UPDATE sites SET order_num = ?, group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${tail}`
                      )
                      .bind(...this.scopeParams([item.order_num, moveTo, item.id]));
        };

        // D1 单次 batch 的语句条数有上限，站点多的时候分批提交，避免整批失败
        const CHUNK_SIZE = 100;

        try {
            for (let i = 0; i < siteOrders.length; i += CHUNK_SIZE) {
                const chunk = siteOrders.slice(i, i + CHUNK_SIZE);
                await this.db.batch(chunk.map(buildStatement));
            }
            return true;
        } catch (error) {
            console.error("批量更新站点排序失败:", error);
            return false;
        }
    }

    /**
     * 当前身份能不能动「全站共享配置」（标题 / 主题 / 背景…）。
     * 只有站点所有者可以；未启用登录（拿不到账号）时是单账号部署，放行。
     *
     * 备份的导入导出都按它判断：普通账号导出的备份里不带全站设置，拿别人的备份
     * 恢复时也不会顺手把整站外观改掉 —— 全站外观是所有人共用的，不该被一个账号的
     * 恢复操作覆盖。
     */
    async canManageSharedConfigs(): Promise<boolean> {
        const uid = this.currentUserId;
        if (uid === null) return true;
        const me = await this.getUserById(uid);
        return me?.role === "owner";
    }

    // 导出所有数据
    async exportData(): Promise<ExportData> {
        await this.migrate();
        // 一次 batch 取回分组 + 站点 + 配置，只花一次 D1 往返（原来是三次）
        const { groups, sites, configs } = await this.withSchemaRetry(() =>
            this.queryExportBundle()
        );

        // M4：默认不含站点账号密码（明文 JSON 备份会被 WebDAV 同步到网盘，凭据跟着走风险高）。
        // 只有用户主动开启「备份含登录凭据」（backup.includeCredentials=true）才带。
        const withCreds = configs[BACKUP_CREDENTIALS_CONFIG] === "true";

        // 全站设置单独放 sharedConfigs，且只有所有者（或单账号部署）才写进备份文件。
        // 否则「一个账号导出的备份被另一个账号恢复」会把全站外观改掉。
        const sharedAllowed = await this.canManageSharedConfigs();

        // 普通账号自己的外观（标题 / 背景…）也进备份：那是「我看到的站点长什么样」，
        // 恢复时理应回到自己这份。所有者那份本来就在全站 configs 里（见 sharedConfigs），
        // 不必重复写一遍 —— 否则别的账号恢复他的备份会把全站外观一起改掉。
        let ownConfigs: Record<string, string> = {};
        if (!sharedAllowed && this.currentUserId !== null) {
            const own = await this.queryUserConfigs(this.currentUserId);
            for (const [key, value] of Object.entries(own)) {
                if (isPerUserAppearanceKey(key)) ownConfigs[key] = value;
            }
            ownConfigs = stripSecretConfigs(ownConfigs);
        }

        return {
            groups,
            // 关掉「备份含登录凭据」时把账号密码抹掉：备份文件是明文 JSON，
            // 又会被 WebDAV 同步到网盘，凭据一旦进去就等于跟着走了
            sites: withCreds ? sites : stripSiteCredentials(sites),
            // 自己的外观；敏感配置（WebDAV 凭据）一律不进备份
            configs: ownConfigs,
            ...(sharedAllowed ? { sharedConfigs: stripSecretConfigs(configs) } : {}),
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
        };
    }

    private async queryExportBundle(): Promise<{
        groups: Group[];
        sites: Site[];
        configs: Record<string, string>;
    }> {
        const [groupResult, siteResult, configResult] = await this.db.batch<Group | Site | Config>([
            this.db
                .prepare(
                    `SELECT id, name, order_num, created_at, updated_at FROM groups${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db
                .prepare(
                    `SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db.prepare("SELECT key, value FROM configs"),
        ]);

        const configs: Record<string, string> = {};
        for (const row of (configResult.results || []) as Config[]) {
            // 管理员凭据永远不进备份文件（WebDAV 凭据这里先取出，稍后由 stripSecretConfigs 剔除）
            if (isAuthConfigKey(row.key)) continue;
            configs[row.key] = row.value;
        }

        return {
            groups: (groupResult.results || []) as Group[],
            // 库里是密文，导出前解密成明文 JSON（备份文件整体再由 AES-GCM 加密一次）
            sites: await this.decryptSitePasswords((siteResult.results || []) as Site[]),
            configs,
        };
    }

    /**
     * 导入所有数据（覆盖式恢复）。
     *
     * 不再保留备份文件里的 id：groups / sites 的 id 是全局 AUTOINCREMENT，别的账号
     * 很可能早就占着同样的号（owner 先建的分组就是 1、2、3），照原 id 写回去会撞主键，
     * 整批导入直接失败 ——「A 账号的备份恢复到 B 账号」在过去基本必挂。
     * 现在一律由数据库重新发号，再把 旧id -> 新id 的映射回传给调用方：前端的星标 /
     * 标签是按站点 id 存在本机的，不翻译一遍就全丢了。
     *
     * 写入顺序刻意是「先 INSERT 备份内容，成功之后才 DELETE 旧数据」：
     * 过去是先把当前账号的数据清空再逐条写入，中途任何一步报错（某条数据写不进去、
     * 配置写入失败、连接断了…）都会让这个账号的数据凭空消失 —— 恢复失败反而比不
     * 恢复更糟，用户连「回退」的机会都没有。现在旧数据全程不动，失败了只把本次
     * 新建的行清掉就回到原样（D1 没有跨语句事务可用，只能靠这个顺序保底）。
     */
    async importData(data: ExportData): Promise<ImportResult> {
        const groupIdMap: Record<string, number> = {};
        const siteIdMap: Record<string, number> = {};
        // 本次新写进去的行 id：失败时靠它们回滚（旧数据一步都没动过，删掉这些就回到原样）
        const createdGroupIds: number[] = [];
        const createdSiteIds: number[] = [];

        try {
            await this.migrate();

            const normalized = normalizeImportData(data);

            // 先记下现有数据的 id：等新数据全部写成功之后再删它们。
            // 多账号后只清「当前账号」的，别把别人的数据一起抹了
            const oldSiteIds = await this.listOwnedIds("sites");
            const oldGroupIds = await this.listOwnedIds("groups");

            // 导入分组：id 交给数据库分配，同时记下新旧映射
            for (const group of normalized.groups) {
                const result = await this.db
                    .prepare(
                        "INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id"
                    )
                    .bind(group.name, group.order_num || 0, this.currentUserId)
                    .all<{ id: number }>();
                const newId = result.results?.[0]?.id;
                if (typeof newId !== "number") {
                    throw new Error(`分组「${group.name}」写入后拿不到新 id`);
                }
                createdGroupIds.push(newId);
                if (group.id !== undefined) groupIdMap[String(group.id)] = newId;
            }

            // 站点指向了备份里不存在的分组（手改过 / 老格式）时兜一个分组出来装它们，
            // sites.group_id 是 NOT NULL，没有归属就写不进去
            let orphanGroupId: number | null = null;

            // 导入站点数据（含账号密码）
            for (const site of normalized.sites) {
                let groupId =
                    site.group_id !== undefined && site.group_id !== null
                        ? groupIdMap[String(site.group_id)]
                        : undefined;

                if (typeof groupId !== "number") {
                    if (orphanGroupId === null) {
                        const created = await this.createGroup({
                            name: "导入的站点",
                            order_num: 999999,
                        } as Group);
                        if (typeof created?.id !== "number") {
                            throw new Error("为无归属站点创建兜底分组失败");
                        }
                        orphanGroupId = created.id;
                        createdGroupIds.push(orphanGroupId);
                    }
                    groupId = orphanGroupId;
                }

                const result = await this.db
                    .prepare(
                        `INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num, user_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
                    )
                    .bind(
                        groupId,
                        site.name,
                        site.url,
                        site.icon || "",
                        site.description || "",
                        site.notes || "",
                        site.username || "",
                        // 备份里是明文，写回 D1 前加密
                        await encryptSecret(site.password || "", this.secret),
                        site.order_num || 0,
                        this.currentUserId
                    )
                    .all<{ id: number }>();
                const newId = result.results?.[0]?.id;
                if (typeof newId !== "number") {
                    throw new Error(`站点「${site.name}」写入后拿不到新 id`);
                }
                createdSiteIds.push(newId);
                if (site.id !== undefined) siteIdMap[String(site.id)] = newId;
            }

            // 导入配置数据。
            // 老备份的全站设置混在 configs 里，新备份放在 sharedConfigs，两边同规则：
            // 共享键只有站点所有者（或单账号部署）能写，普通账号恢复时不改全站外观。
            const mayWriteShared = await this.canManageSharedConfigs();
            const configEntries: [string, string][] = [
                ...Object.entries(normalized.configs || {}),
                ...Object.entries(normalized.sharedConfigs || {}),
            ];

            for (const [key, value] of configEntries) {
                if (key === "DB_INITIALIZED") {
                    // 跳过数据库初始化标志
                    continue;
                }
                if (isSecretConfigKey(key)) {
                    // 恢复备份不覆盖管理员账号密码和 WebDAV 凭据
                    continue;
                }
                if (!isUserScopedConfigKey(key) && !mayWriteShared) {
                    continue;
                }
                await this.setConfig(key, value);
            }

            // 走到这里说明新数据已经整批就位，这才清掉旧数据：
            // 站点先删（挂在分组下），分组后删
            await this.deleteRowsByIds("sites", oldSiteIds);
            await this.deleteRowsByIds("groups", oldGroupIds);

            return { success: true, groupIdMap, siteIdMap };
        } catch (error) {
            console.error("导入数据失败:", error);
            // 回滚：只删本次新建的行。旧数据全程没被碰过，删掉这些就回到导入前的样子。
            // 回滚本身再出错也不能把异常抛出去（用户更该看到的是「为什么导入失败」）
            await this.rollbackCreatedRows(createdSiteIds, createdGroupIds);
            return {
                success: false,
                message: error instanceof Error ? error.message : "导入数据失败",
                groupIdMap,
                siteIdMap,
            };
        }
    }

    /** 当前账号（单账号部署则是全部）在某张表里的行 id —— 覆盖恢复时用来清旧数据 */
    private async listOwnedIds(table: "groups" | "sites"): Promise<number[]> {        const result = await this.db
            .prepare(`SELECT id FROM ${table}${this.scopeSql(false)}`)
            .bind(...this.scopeParams([]))
            .all<{ id: number }>();
        return (result.results || [])
            .map(row => row?.id)
            .filter((id): id is number => typeof id === "number");
    }

    /**
     * 从候选分组 id 里挑出「属于当前账号」的那些。
     * 卡片跨组移动时用它确认目标分组也是自己的（见 updateSiteOrder）。
     */
    private async filterOwnedGroupIds(ids: readonly number[]): Promise<Set<number>> {
        if (ids.length === 0) return new Set();
        const placeholders = ids.map(() => "?").join(",");
        try {
            const result = await this.db
                .prepare(
                    `SELECT id FROM groups WHERE id IN (${placeholders})${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams([...ids]))
                .all<{ id: number }>();
            return new Set(
                (result.results || [])
                    .map(row => row?.id)
                    .filter((id): id is number => typeof id === "number")
            );
        } catch (error) {
            console.error("校验分组归属失败:", error);
            return new Set();
        }
    }

    /**
     * 过期数据清理（每周定时任务调用）。
     *
     * 有四类东西只增不减，放久了会把 D1 撑成随时间线性增长的负担：
     *   - audit_log：登录、改密、删站点…每条一行；
     *   - token_blacklist：登出过期的令牌（过期后校验已不会再查它）；
     *   - auth.recoveryJti.*：恢复令牌用过后留的防重放标记（configs 里一行一个 key）；
     *   - invites：过期 / 已用掉的邀请码。
     * 行数配额按实际情况保留：审计日志留 90 天够溯源，邀请码留 7 天便于排查。
     */
    async cleanupExpiredRows(): Promise<{
        audit: number;
        blacklist: number;
        invites: number;
        recoveryJti: number;
    }> {
        const counts = { audit: 0, blacklist: 0, invites: 0, recoveryJti: 0 };
        const nowSec = Math.floor(Date.now() / 1000);

        try {
            const r = await this.db
                .prepare(
                    "DELETE FROM audit_log WHERE created_at < datetime('now', '-90 days')"
                )
                .run();
            counts.audit = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理审计日志失败:", error);
        }

        try {
            const r = await this.db
                .prepare("DELETE FROM token_blacklist WHERE exp < ?")
                .bind(nowSec)
                .run();
            counts.blacklist = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理令牌黑名单失败:", error);
        }

        try {
            const r = await this.db
                .prepare(
                    "DELETE FROM invites WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)"
                )
                .bind(nowSec - 7 * 24 * 3600, nowSec - 7 * 24 * 3600)
                .run();
            counts.invites = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理邀请码失败:", error);
        }

        // 恢复令牌的 jti 标记是 configs 里一行一个 key，只能按前缀挑出来逐个删
        counts.recoveryJti = await this.deleteExpiredRecoveryMarks(nowSec);

        return counts;
    }

    private async deleteExpiredRecoveryMarks(nowSec: number): Promise<number> {
        try {
            const rows = await this.db
                .prepare("SELECT key, value FROM configs WHERE key LIKE 'auth.recoveryJti.%'")
                .all<{ key: string; value: string }>();
            let removed = 0;
            for (const row of rows.results || []) {
                // value 存的就是令牌自带的 exp（秒）：过期后即使重放也通不过验证，标记可以丢掉
                const exp = Number(row.value);
                if (!Number.isFinite(exp) || exp < nowSec) {
                    await this.deleteConfig(row.key);
                    removed++;
                }
            }
            return removed;
        } catch (error) {
            console.error("清理恢复令牌标记失败:", error);
            return 0;
        }
    }

    /** 按 id 批量删行。D1 单条语句的绑定参数有上限，分片删，避免大站一次删不完 */
    private async deleteRowsByIds(
        table: "groups" | "sites",
        ids: readonly number[]
    ): Promise<void> {
        if (ids.length === 0) return;
        const CHUNK = 100;
        for (let offset = 0; offset < ids.length; offset += CHUNK) {
            const chunk = ids.slice(offset, offset + CHUNK);
            const placeholders = chunk.map(() => "?").join(",");
            await this.db
                .prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
                .bind(...chunk)
                .run();
        }
    }

    /** 导入失败后的回滚：删掉本次新建的行，旧数据原样保留 */
    private async rollbackCreatedRows(siteIds: number[], groupIds: number[]): Promise<void> {
        try {
            await this.deleteRowsByIds("sites", siteIds);
            await this.deleteRowsByIds("groups", groupIds);
        } catch (error) {
            console.error("导入失败后回滚新建数据失败:", error);
        }
    }
}

// 备份文件格式版本号。
// 1.3：全站共享配置从 configs 拆到 sharedConfigs（且只有所有者导出时才带），
// 导入不再保留备份里的 id（改由数据库重新发号并回传映射）。
export const EXPORT_VERSION = "1.3";

// 兼容多种备份格式：
// 1) 标准格式 { groups, sites, configs }
// 2) 旧格式   { groups: [{ ...group, sites: [...] }], configs }
// 1.3 起全站设置挪到 sharedConfigs；老备份没有这个字段，全站设置还混在 configs 里，
// 导入时按同一套归属规则判断（见 importData）。
export function normalizeImportData(data: ExportData | Record<string, unknown>): ExportData {
    const raw = (data || {}) as {
        groups?: (Group & { sites?: Site[] })[];
        sites?: Site[];
        configs?: Record<string, string>;
        sharedConfigs?: Record<string, string>;
        version?: string;
        exportDate?: string;
        localPrefs?: LocalPrefsBackup;
    };

    const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
    const groups: Group[] = [];
    const nestedSites: Site[] = [];

    rawGroups.forEach((group, index) => {
        groups.push({
            id: group.id,
            name: group.name,
            order_num: typeof group.order_num === "number" ? group.order_num : index,
            created_at: group.created_at,
            updated_at: group.updated_at,
        });

        if (Array.isArray(group.sites)) {
            group.sites.forEach((site, siteIndex) => {
                nestedSites.push({
                    ...site,
                    group_id: typeof site.group_id === "number" ? site.group_id : (group.id ?? 0),
                    order_num: typeof site.order_num === "number" ? site.order_num : siteIndex,
                });
            });
        }
    });

    const flatSites = Array.isArray(raw.sites) ? raw.sites : [];

    // 导入这条路径完全绕开表单校验：备份文件可能被手改过、也可能是很老的版本。
    // 入库前统一规范化（补 https:// / 挡危险协议）；规范化不过的直接把链接清空，
    // 卡片会退化成「没有链接」，而不是「点一下执行脚本」。
        const sites = (flatSites.length > 0 ? flatSites : nestedSites).map(site => {
            const result = normalizeUrl(site.url || "");
            const url = result.ok ? result.url : "";
            // L1：导入路径绕开表单校验，图标同样挡掉 javascript:/vbscript:/file:/data:text/html 等
            const icon = sanitizeIconUrl(site.icon || "");
            return { ...site, url, icon };
        });

    return {
        groups,
        sites,
        configs: raw.configs && typeof raw.configs === "object" ? raw.configs : {},
        // 全站共享配置：老备份没有这个字段，导入时那份全站设置从 configs 里按规则挑
        ...(raw.sharedConfigs && typeof raw.sharedConfigs === "object"
            ? { sharedConfigs: raw.sharedConfigs }
            : {}),
        version: raw.version || EXPORT_VERSION,
        exportDate: raw.exportDate || new Date().toISOString(),
        // 星标 / 标签这类本机偏好原样透传，交给前端写回 localStorage
        ...(raw.localPrefs && typeof raw.localPrefs === "object"
            ? { localPrefs: sanitizeLocalPrefs(raw.localPrefs) }
            : {}),
    };
}

/** 备份文件里的本机偏好做一次清洗：只保留数字 id 和字符串标签，脏数据直接丢掉 */
export function sanitizeLocalPrefs(input: LocalPrefsBackup): LocalPrefsBackup {
    const starred = Array.isArray(input.starred)
        ? Array.from(new Set(input.starred.filter(id => typeof id === "number" && Number.isFinite(id))))
        : [];

    const tags: Record<string, string[]> = {};
    if (input.tags && typeof input.tags === "object") {
        for (const [siteId, list] of Object.entries(input.tags)) {
            if (!Array.isArray(list)) continue;
            const clean = Array.from(
                new Set(list.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim()))
            );
            if (clean.length > 0) tags[String(siteId)] = clean;
        }
    }

    return { starred, tags };
}

/**
 * 清洗导入备份里的图标 URL：只放行 http(s) / data:image / 相对路径，
 * 丢弃 javascript:/vbscript:/file:/data:text/html 等可执行/危险协议。
 * 图标只作 <img src> 渲染，风险本就低，这里只是和 url 同样做一层规范化。
 */
export function sanitizeIconUrl(icon: string): string {
    const v = (icon || "").trim();
    if (!v) return "";
    // 挡掉可执行/危险协议：javascript:/vbscript:/file: 以及 data:text/html（HTML 文档可带脚本）。
    // 放行 http(s)、data:image（头像 base64）、以及相对路径（/api/icon?... 这类图标代理）。
    if (/^(javascript|vbscript|file|data:text\/html)/i.test(v)) return "";
    return v;
}

// 创建 API 辅助函数
export function createAPI(env: Env): NavigationAPI {
    return new NavigationAPI(env);
}
