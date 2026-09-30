// src/API/methods/config.ts
// NavigationAPI 的「config」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { isAuthConfigKey, isEncryptedConfigKey, isPerUserAppearanceKey, isPrivateUserConfigKey, isUserScopedConfigKey } from "../configGuards";
import { decryptSecretDeep, encryptSecret } from "../crypto";
import { D1PreparedStatement } from "../schema";
import { Config } from "../types";

export interface ConfigApi {
    getConfigs(): Promise<Record<string, string>>;
    queryConfigs(): Promise<Record<string, string>>;
    queryUserConfigs(userId: number): Promise<Record<string, string>>;
    getUserConfig(userId: number, key: string): Promise<string | null>;
    setUserConfig(userId: number, key: string, value: string): Promise<boolean>;
    deleteUserConfig(userId: number, key: string): Promise<boolean>;
    scopeFor(key: string): Promise<number | null>;
    getConfig(key: string): Promise<string | null>;
    canWriteConfigKey(key: string): Promise<boolean>;
    setConfig(key: string, value: string): Promise<boolean>;
    /**
     * 条件更新（CAS）：**只有当前存的值等于 expected 时**才写入 next，返回有没有抢到。
     *
     * 「读出来 → 改 → 整条写回」这条路在 Workers 里是真会丢数据的：两个请求同时读到
     * 旧值，各自算完再写，后写的那份会把前一份**整个盖掉**。用在限速计数上就是
     * 「攻击者的失败次数被别人的写覆盖回小值」，限速直接失效。
     * 所以把「比较」和「写入」压进同一条 SQL：`UPDATE ... WHERE key = ? AND value = ?`
     * —— 命中行数不是 1，说明这中间有人抢先改过，调用方重读再算一次即可。
     *
     * 限制：**不支持加密键**（webdav.*）。它们落库是 AES-GCM 密文且 IV 随机，
     * 同一明文两次加密结果都不同，没法比对；这类键一律返回 false，调用方退回普通写入。
     * 同理不支持按账号隔离的键（user_configs），返回 false。
     */
    compareAndSetConfig(key: string, expected: string | null, next: string): Promise<boolean>;
    setSystemConfig(key: string, value: string): Promise<boolean>;
    deleteSystemConfig(key: string): Promise<boolean>;
    setConfigs(entries: Record<string, string>): Promise<boolean>;
    deleteConfig(key: string): Promise<boolean>;
    canManageSharedConfigs(): Promise<boolean>;
}

export const configImpl: ConfigApi = {

    // 配置相关API
    getConfigs: async function (this: NavigationAPI ): Promise<Record<string, string>> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryConfigs());
    },
    queryConfigs: async function (this: NavigationAPI ): Promise<Record<string, string>> {
        const uid = this.currentUserId;
        const result = await this.db.prepare("SELECT key, value FROM configs").all<Config>();

        // 先过滤出需要返回的键，再并行解密（decryptSecretDeep 是异步 CPU 密集操作，
        // 串行等每个会随配置项数线性变慢；Promise.all 一次性发出）。
        const rows = (result.results || []).filter(
            (config) =>
                !isAuthConfigKey(config.key) &&
                !(uid !== null && isPrivateUserConfigKey(config.key))
        );
        const decoded = await Promise.all(
            rows.map(async (config) => {
                const value = isEncryptedConfigKey(config.key)
                    ? await decryptSecretDeep(config.value, this.secret)
                    : config.value;
                return [config.key, value] as [string, string];
            })
        );
        const configs: Record<string, string> = {};
        for (const [key, value] of decoded) configs[key] = value;

        // 覆盖上当前账号自己的那份
        if (uid !== null) {
            const own = await this.queryUserConfigs(uid);
            for (const [key, value] of Object.entries(own)) configs[key] = value;
        }

        return configs;
    },

    // ============ 每账号一份的配置（user_configs） ============
    /** 取某个账号自己的全部私有配置（口令类已解密） */
    queryUserConfigs: async function (this: NavigationAPI, userId: number): Promise<Record<string, string>> {
        try {
            const result = await this.db
                .prepare("SELECT key, value FROM user_configs WHERE user_id = ?")
                .bind(userId)
                .all<{ key: string; value: string }>();
            const rows = result.results || [];
            // 并行解密：口令类配置随账号数增多时，串行等待会明显变慢
            const decoded = await Promise.all(
                rows.map(async (row) => {
                    const value = isEncryptedConfigKey(row.key)
                        ? await decryptSecretDeep(row.value, this.secret)
                        : row.value;
                    return [row.key, value] as [string, string];
                })
            );
            const configs: Record<string, string> = {};
            for (const [key, value] of decoded) configs[key] = value;
            return configs;
        } catch {
            return {};
        }
    },
    getUserConfig: async function (this: NavigationAPI, userId: number, key: string): Promise<string | null> {
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
    },
    setUserConfig: async function (this: NavigationAPI, userId: number, key: string, value: string): Promise<boolean> {
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
    },
    deleteUserConfig: async function (this: NavigationAPI, userId: number, key: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare("DELETE FROM user_configs WHERE user_id = ? AND key = ?")
                .bind(userId, key)
                .run();
            return result.success;
        } catch {
            return false;
        }
    },

    /**
     * 这个 key 该存哪儿：返回账号 id = 写进该账号自己的 user_configs；null = 写全站 configs。
     *
     * 严格私有的（webdav.*）永远跟账号走。外观键（site.*）要分人：
     * 站点所有者写在全站 configs —— 登录页还没有账号上下文，读的正是这份；
     * 其它账号写在自己那份，读不到才回落全站（见 getConfig / queryConfigs）。
     */
    scopeFor: async function (this: NavigationAPI, key: string): Promise<number | null> {
        const uid = this.currentUserId;
        if (uid === null) return null;
        if (isPrivateUserConfigKey(key)) return uid;
        if (isPerUserAppearanceKey(key)) {
            return (await this.canManageSharedConfigs()) ? null : uid;
        }
        return null;
    },
    getConfig: async function (this: NavigationAPI, key: string): Promise<string | null> {
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
    },

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
    canWriteConfigKey: async function (this: NavigationAPI, key: string): Promise<boolean> {
        if (isUserScopedConfigKey(key)) return true;
        if (isAuthConfigKey(key)) return true;
        const uid = this.currentUserId;
        if (uid === null) return true;
        return this.canManageSharedConfigs();
    },
    setConfig: async function (this: NavigationAPI, key: string, value: string): Promise<boolean> {
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
    },

    compareAndSetConfig: async function (
        this: NavigationAPI,
        key: string,
        expected: string | null,
        next: string
    ): Promise<boolean> {
        // 加密键存的是密文（IV 随机，同一明文两次加密结果不同），比对不了 → 不支持
        if (isEncryptedConfigKey(key)) return false;
        if (!(await this.canWriteConfigKey(key))) {
            console.warn(`拒绝非所有者改写全站配置: ${key}`);
            return false;
        }
        // 按账号隔离的键落在 user_configs，且 getValue 可能回落到全站那份，
        // 「读到的值」未必等于「表里的那行」——CAS 语义不成立，直接拒绝
        if ((await this.scopeFor(key)) !== null) return false;

        try {
            if (expected === null) {
                // 预期「还没有这条」：抢第一次写入，抢不到（并发已插进去）就让上层重来
                const result = await this.db
                    .prepare(
                        `INSERT INTO configs (key, value, updated_at)
                         VALUES (?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(key) DO NOTHING`
                    )
                    .bind(key, next)
                    .run();
                return affectedRows(result) === 1;
            }
            const result = await this.db
                .prepare(
                    `UPDATE configs SET value = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE key = ? AND value = ?`
                )
                .bind(next, key, expected)
                .run();
            return affectedRows(result) === 1;
        } catch (error) {
            console.error("条件更新配置失败:", error);
            return false;
        }
    },

    /**
     * 内部写全站配置：**跳过**所有者门控，只给 Worker 内部的定时任务用。
     *
     * 定时任务没有登录态：它会把自己绑成某个普通账号去读那人的数据，
     * 此时 canManageSharedConfigs() 是 false，走 setConfig 写 cron.* 会被门控挡掉，
     * 失败留痕就永远写不进去。这里写的是非敏感的系统状态键（cron.*），
     * 不加密、不做归属判断 —— HTTP 路由一律走 setConfig，别来调这个。
     */
    setSystemConfig: async function (this: NavigationAPI, key: string, value: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare(
                    `INSERT INTO configs (key, value, updated_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(key)
                     DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(key, value, value)
                .run();
            return result.success;
        } catch (error) {
            console.error("写入系统配置失败:", error);
            return false;
        }
    },

    /** 见 setSystemConfig：内部删全站配置，同样跳过所有者门控 */
    deleteSystemConfig: async function (this: NavigationAPI, key: string): Promise<boolean> {
        try {
            const result = await this.db
                .prepare("DELETE FROM configs WHERE key = ?")
                .bind(key)
                .run();
            return result.success;
        } catch (error) {
            console.error("删除系统配置失败:", error);
            return false;
        }
    },

    /**
     * 批量写入配置：保存网站设置时可能一次改十几项，
     * 逐条写就是十几个网络往返 + 十几次 D1 调用，这里用 batch 一次做完。
     */
    setConfigs: async function (this: NavigationAPI, entries: Record<string, string>): Promise<boolean> {
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
    },
    deleteConfig: async function (this: NavigationAPI, key: string): Promise<boolean> {
        if (!(await this.canWriteConfigKey(key))) {
            console.warn(`拒绝非所有者删除全站配置: ${key}`);
            return false;
        }
        const uid = await this.scopeFor(key);
        if (uid !== null) return this.deleteUserConfig(uid, key);

        const result = await this.db.prepare("DELETE FROM configs WHERE key = ?").bind(key).run();

        return result.success;
    },

    /**
     * 当前身份能不能动「全站共享配置」（标题 / 主题 / 背景…）。
     * 只有站点所有者可以；未启用登录（拿不到账号）时是单账号部署，放行。
     *
     * 备份的导入导出都按它判断：普通账号导出的备份里不带全站设置，拿别人的备份
     * 恢复时也不会顺手把整站外观改掉 —— 全站外观是所有人共用的，不该被一个账号的
     * 恢复操作覆盖。
     */
    canManageSharedConfigs: async function (this: NavigationAPI ): Promise<boolean> {
        const uid = this.currentUserId;
        if (uid === null) return true;
        const me = await this.getUserById(uid);
        return me?.role === "owner";
    },
};

/**
 * 这条语句真正动了几行。
 *
 * D1 的 `result.success` 只表示**语句没报错**，`UPDATE` 一行都没匹配上时它照样是 true
 * —— 而「有没有匹配到」正是 CAS 的全部依据。所以一律看 `meta.rows_written`。
 * 取不到（模拟器 / mock 没带 meta）时退回 `success`，至少不让判据比原来更松。
 */
function affectedRows(result: unknown): number | null {
    const meta = (result as { meta?: { rows_written?: number } } | undefined)?.meta;
    if (typeof meta?.rows_written === "number") return meta.rows_written;
    const success = (result as { success?: unknown } | undefined)?.success;
    return typeof success === "boolean" ? (success ? 1 : 0) : null;
}
