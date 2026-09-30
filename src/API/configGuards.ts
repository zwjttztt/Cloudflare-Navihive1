// 配置键的分类：哪些进备份、哪些要加密落库、哪些按账号隔离。
//
// 从 http.ts 拆出来：这几个判定散落在类的前后，改一处很容易漏掉另一处
// （比如 link.health 不能当前缀匹配，会把 link.healthSync 一起吃掉）。
// 集中之后「一类规则一坨」，也方便单测直接打这些函数。

import { WEBDAV_CONFIG_PREFIX, WEBDAV_PASSWORD_KEY, WEBDAV_BACKUP_PASSWORD_KEY } from "./configKeys";

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
 * 落库前要用 AUTH_SECRET 派生密钥加密的配置键。
 * 两个 WebDAV 凭据都在这里：明文落 D1，导一份库就等于把网盘账号交出去了。
 * 注意：这里只是「静态保护」，备份口令本身不是 AUTH_SECRET —— 备份文件用它自己的
 * 口令加密，换 AUTH_SECRET 不影响已有备份能不能解开。
 */
const ENCRYPTED_CONFIG_KEYS = [WEBDAV_PASSWORD_KEY, WEBDAV_BACKUP_PASSWORD_KEY];

export function isEncryptedConfigKey(key: string): boolean {
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
/**
 * 必须整键匹配的私有键：死链巡检快照。
 * 不能写成前缀 —— `link.health` 会把开关 `link.healthSync` 一起匹配掉，
 * 而那个开关是「这台设备要不要同步」的偏好，本来就属于全站/本机层面。
 */
const PRIVATE_USER_CONFIG_KEYS = ["link.health"];
const PER_USER_APPEARANCE_PREFIXES = ["site."];

export function isPrivateUserConfigKey(key: string): boolean {
    return (
        PRIVATE_USER_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix)) ||
        PRIVATE_USER_CONFIG_KEYS.includes(key)
    );
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
