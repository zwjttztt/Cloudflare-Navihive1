// src/API/methods/recovery.ts
// NavigationAPI 的「recovery」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { AUTH_PASSWORD_KEY, AUTH_USERNAME_KEY, RECOVERY_PUBLIC_KEY_CONFIG } from "../configKeys";
import { RecoveryPayload, isHashedPassword, isValidRecoveryPublicKey, peekRecoveryTokenUsername, verifyPassword, verifyRecoveryToken } from "../crypto";

export interface RecoveryApi {
    getRecoveryPublicKey(): Promise<string>;
    getRecoveryPublicKeyOfUser(userId: number): Promise<string>;
    setRecoveryPublicKeyOfUser(userId: number, key: string): Promise<boolean>;
    reactivateUser(userId: number): Promise<void>;
    collectRecoveryCandidates(
        username: string
    ): Promise<{ userId: number | null; publicKey: string }[]>;
    hasRecoveryKey(): Promise<boolean>;
    setRecoveryPublicKey(
        publicKey: string,
        currentPassword: string, clientKey?: string): Promise<{ success: boolean; message: string }>;
    redeemRecoveryToken(
        token: string, clientKey?: string): Promise<{ success: boolean; message: string }>;
}

export const recoveryImpl: RecoveryApi = {

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
    getRecoveryPublicKey: async function (this: NavigationAPI ): Promise<string> {
        if (this.recoveryPubKey) return this.recoveryPubKey;
        const uid = this.currentUserId;
        if (uid !== null) return this.getRecoveryPublicKeyOfUser(uid);
        const stored = await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG);
        return stored || "";
    },

    /** 读某个账号自己的恢复公钥（列还没建好时当「没配」处理） */
    getRecoveryPublicKeyOfUser: async function (this: NavigationAPI, userId: number): Promise<string> {
        try {
            const row = await this.db
                .prepare("SELECT recovery_public_key FROM users WHERE id = ?")
                .bind(userId)
                .first<{ recovery_public_key: string | null }>();
            return (row?.recovery_public_key || "").trim();
        } catch {
            return "";
        }
    },

    /** 写某个账号自己的恢复公钥（传空串 = 停用） */
    setRecoveryPublicKeyOfUser: async function (this: NavigationAPI, userId: number, key: string): Promise<boolean> {
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
    },

    /**
     * 解除停用：状态恢复 active、清掉停用时间，并把活跃时间刷成现在。
     * 活跃时间必须刷 —— 沉睡扫描每周都跑，不刷的话下周还会被判成沉睡账号。
     */
    reactivateUser: async function (this: NavigationAPI, userId: number): Promise<void> {
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
    },

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
    collectRecoveryCandidates: async function (
        this: NavigationAPI,
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
    },
    hasRecoveryKey: async function (this: NavigationAPI ): Promise<boolean> {
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
    },

    /**
     * 保存 / 更换恢复公钥（网页端「生成并下载私钥」时调用）。
     * 必须校验当前密码：否则拿到管理员会话的人可以把自己的公钥塞进来，
     * 即使管理员改了密码也仍能凭自己的私钥重置 —— 一个持久后门。
     */
    setRecoveryPublicKey: async function (
        this: NavigationAPI,
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
    },
    redeemRecoveryToken: async function (
        this: NavigationAPI,
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
    },
};
