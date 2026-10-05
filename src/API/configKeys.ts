// configs 表里的键名与各种时长常量。
//
// 从 http.ts 拆出来：这些是「约定的字符串」，路由层、定时任务、前端都要对上号，
// 集中放一份才好改，也才好一眼看清哪些键是敏感的（见 configGuards.ts）。

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

// ---- AI 助手配置 ----
// 前缀统一是 ai.：整组都是「每个账号一份 + 不进备份 + 凭据加密落库」
// （判定见 configGuards，这里只定键名）。放进备份等于把别人的 API 密钥交给拿到备份文件的人。
export const AI_CONFIG_PREFIX = "ai.";
/** 总开关：只有显式写成 "true" 才启用，缺失 / 报错一律按关闭处理 */
export const AI_ENABLED_KEY = "ai.enabled";
/** provider：workers-ai（Cloudflare）或 openai-compatible（DeepSeek / 智谱 / OpenAI …） */
export const AI_PROVIDER_KEY = "ai.provider";
/** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
export const AI_ENDPOINT_KEY = "ai.endpoint";
/** 文本模型名（openai-compatible 用；workers-ai 有默认值） */
export const AI_TEXT_MODEL_KEY = "ai.textModel";
/** 嵌入模型名（openai-compatible 用；workers-ai 有默认值） */
export const AI_EMBED_MODEL_KEY = "ai.embedModel";
/** OpenAI 兼容端点的密钥 —— 加密落库 */
export const AI_API_KEY_KEY = "ai.apiKey";
/** Workers AI 走 REST 时用的 Cloudflare API token —— 加密落库 */
export const AI_CF_TOKEN_KEY = "ai.cfToken";
/** Workers AI 走 REST 时的账号 ID */
export const AI_CF_ACCOUNT_KEY = "ai.cfAccount";

// 保留期（天）：审计日志与回收站条目都只留这么久，超期由定时任务自动清除。
// 两处都存的是「事后补救」性质的东西 —— 审计用于溯源、回收站用于反悔，
// 留太久了既占 D1 行数，也让旧数据一直挂在界面上。7 天足够覆盖"昨天删错了"这类场景。
export const RETENTION_DAYS = 7;
/**
 * 保留期可以在「网站设置 → 数据保留」里改（站点所有者专属）。
 * 上下界都守住：0 天等于「每次定时任务都把自己刚记的东西删掉」，
 * 而放到几百天以外，D1 行数就是一笔随时间线性增长的账。
 */
export const RETENTION_DAYS_KEY = "retention.days";
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 365;

// 长期未登录账号治理：阈值（天）存进 configs，owner 可在后台改；读取带默认值。
// disableDays：超过这么久没活跃 -> 置为 disabled（禁止登录，数据保留）。
// deleteGraceDays：disabled 之后再过这么久 -> 硬删（释放 D1 行数）。owner 永不被治理。
export const INACTIVE_DISABLE_DAYS_KEY = "inactive.disableDays";
export const INACTIVE_DELETE_GRACE_DAYS_KEY = "inactive.deleteGraceDays";
export const INACTIVE_DISABLE_DAYS_DEFAULT = 180;
export const INACTIVE_DELETE_GRACE_DAYS_DEFAULT = 30;

/**
 * 会话状态缓存有效期。停用 / 清除是低频操作（每周扫描一次），
 * 缓存 60 秒足以让「刚被停用」最多延迟一分钟生效，同时把每个请求一次 D1 读降到每分钟一次。
 */
export const SESSION_STATE_TTL_MS = 60 * 1000;

// 令牌有效期（秒）：普通登录 1 天；勾选「记住账号密码」后 30 天，实现「一个月内免登录」
export const DEFAULT_TOKEN_TTL = 24 * 60 * 60;
export const REMEMBER_TOKEN_TTL = 30 * 24 * 60 * 60;

/**
 * 邀请码有效期：30 分钟。
 * 注册入口是公开的（否则新用户进不来），所以发码必须短命 ——
 * 就算码被截获，半小时后也只是一串废字符。
 */
export const INVITE_TTL_SECONDS = 30 * 60;

/**
 * 「备份文件里要不要带上网站登录凭据」的配置键。
 * 存服务端而不是只放前端，是为了让每周的定时备份（跑在 Worker 的 cron 里）也遵守同一个开关。
 * 默认带上（保持老行为），只有显式写成 "false" 才抹掉。
 */
export const BACKUP_CREDENTIALS_CONFIG = "backup.includeCredentials";

/**
 * 「备份文件里要不要带上记事本」的配置键。
 *
 * **刻意不复用** `backup.includeCredentials`：那个默认是**不含**（凭据敏感），
 * 笔记是主要内容、默认应该带上。合成一个开关的话，用户为了拿笔记就得把密码也导出去。
 * 与凭据一样存服务端，好让定时备份（跑在 Worker 的 cron 里）也遵守。
 * 默认含 —— 只有显式写成 "false" 才排除。
 */
export const BACKUP_NOTES_CONFIG = "backup.includeNotes";

/**
 * 定时任务最近一次失败的留痕（值是 JSON：{ task, message, at }）。
 *
 * 定时任务跑在 Worker 里，失败时只有一行 console —— 页面上看不到，于是「每周自动备份
 * 其实已经连着失败三个月」这种事只能靠恢复那天才发现。现在失败写这里、成功清掉，
 * 前端读它给所有者一条明确提示（普通账号读不到全站配置，正好也不会被吓到）。
 */
export const CRON_LAST_ERROR_KEY = "cron.lastError";
