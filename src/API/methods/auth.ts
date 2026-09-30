// src/API/methods/auth.ts
// NavigationAPI 的「auth」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { AUTH_PASSWORD_KEY, AUTH_USERNAME_KEY, DEFAULT_TOKEN_TTL, MUST_CHANGE_PASSWORD_KEY, TOKEN_VERSION_KEY } from "../configKeys";
import { hashPassword, peekJwtClaim, signJwt, verifyJwt, verifyPassword } from "../crypto";

export interface AuthApi {
    getAuthCredentials(): Promise<{ username: string; password: string }>;
    readAuthCredentials(): Promise<{ username: string; password: string }>;
    blacklistToken(jti: string, exp: number): Promise<void>;
    isTokenBlacklisted(jti: string): Promise<boolean>;
    mustChangePassword(role?: string | null): Promise<boolean>;
    roleOfUser(userId: number): Promise<string | null>;
    clearMustChangePassword(): Promise<void>;
    getTokenVersion(uid?: number | null): Promise<number>;
    bumpTokenVersion(uid?: number | null): Promise<void>;
    updateAuthCredentials(username: string, password: string): Promise<boolean>;
    findUserByIdWithHash(
        id: number
    ): Promise<{ id: number; username: string; passwordHash: string; role: "owner" | "user" } | null>;
    verifyToken(
        token: string
    ): Promise<{ valid: boolean; payload?: Record<string, unknown> }>;
    generateToken(
        payload: Record<string, unknown>, ttlSeconds?: number): Promise<string>;
    verifyCurrentPassword(plain: string): Promise<boolean>;
    isAuthEnabled(): boolean;
}

export const authImpl: AuthApi = {

    /**
     * 读取生效中的管理员凭据。
     * 数据库中已存在 → 直接用它（重新部署不再改变）；
     * 数据库中没有 → 说明是第一次部署，把 wrangler vars 里的默认值固化到数据库。
     */
    getAuthCredentials: async function (this: NavigationAPI ): Promise<{ username: string; password: string }> {
        await this.migrate();
        try {
            return await this.withSchemaRetry(() => this.readAuthCredentials());
        } catch (error) {
            console.error("读取管理员凭据失败，回退到环境变量:", error);
            return { username: this.seedUsername, password: this.seedPassword };
        }
    },
    readAuthCredentials: async function (this: NavigationAPI ): Promise<{ username: string; password: string }> {
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
    },

    // ============ 令牌黑名单（退出登录 = 服务端可吊销） ============
    // JWT 本身无状态，退出登录只能靠「把这张令牌的 jti 拉黑」来实现真正失效。
    // 存一张表而不是 configs 里的一个 JSON：并发登出时「读-改-写」会互相覆盖，
    // 被覆盖掉的那张令牌就能一直用到过期。按 jti 作主键插入则天然幂等。
    // 过期行由每周定时任务清理（见 cleanupExpiredRows）。

    /** 把某张令牌拉黑（退出登录 / 发现令牌泄露时调用） */
    blacklistToken: async function (this: NavigationAPI, jti: string, exp: number): Promise<void> {
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
    },
    isTokenBlacklisted: async function (this: NavigationAPI, jti: string): Promise<boolean> {
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
    },

    // ============ 首次部署强制改密 ============
    // 种子凭据来自部署变量（等同半公开），首次部署后必须改一次才算安全。
    /**
     * 是否还卡在「必须先改密」。
     *
     * 这个标志是全局的（configs 里一份），但含义只针对**种子管理员那一个人** ——
     * 之后注册的账号都是自己设的密码，不该被牵连：否则新账号一登录就弹「请先修改密码」，
     * 而且写操作还会被 worker 的闸门一并拦成 403，等于替管理员背锅。
     *
     * @param role 登录者的角色；不传则按当前账号上下文判定
     */
    mustChangePassword: async function (this: NavigationAPI, role?: string | null): Promise<boolean> {
        const raw = await this.getConfig(MUST_CHANGE_PASSWORD_KEY);
        if (raw !== "1") return false;

        let effectiveRole = role ?? null;
        if (effectiveRole === null && this.currentUserId !== null) {
            effectiveRole = await this.roleOfUser(this.currentUserId);
        }
        // 查不到角色（老式单管理员 / 没有账号上下文）时维持原样：仍然要求改密
        if (effectiveRole === null) return true;
        return effectiveRole === "owner";
    },

    /** 读某账号的角色；查不到或表还没建好时返回 null（不是 'user'——别把它当普通账号放行） */
    roleOfUser: async function (this: NavigationAPI, userId: number): Promise<string | null> {
        try {
            const row = await this.db
                .prepare("SELECT role FROM users WHERE id = ?")
                .bind(userId)
                .first<{ role: string | null }>();
            return row?.role ?? null;
        } catch (error) {
            console.error("读取账号角色失败:", error);
            return null;
        }
    },
    clearMustChangePassword: async function (this: NavigationAPI ): Promise<void> {
        await this.setConfig(MUST_CHANGE_PASSWORD_KEY, "0");
    },

    // 令牌版本：改密 / 重置后 +1，让已签发的令牌立即失效（服务端可吊销）。
    //
    // 多账号之前是全站一份（configs.auth.tokenVersion），于是「任何一个账号改密、注销、
    // 密钥恢复」会把所有人的会话一起踢掉 —— 别人什么都没做就被迫重新登录。
    // 现在按账号记（users.token_version）：
    //   - 有账号上下文 → 认自己那一列，改只作废自己的令牌；
    //   - 没有账号上下文（老令牌 / 还没迁移到 users 的单管理员）→ 仍走全站那份。
    getTokenVersion: async function (this: NavigationAPI, uid: number | null = null): Promise<number> {
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
    },

    /**
     * 令牌版本 +1。传账号 id 就只作废那一个账号的令牌；传 null（或没传）作废全站。
     */
    bumpTokenVersion: async function (this: NavigationAPI, uid: number | null = null): Promise<void> {
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
    },

    // 更新管理员凭据（写入数据库后立即生效）
    updateAuthCredentials: async function (this: NavigationAPI, username: string, password: string): Promise<boolean> {
        // 密码一律哈希存储，绝不落明文
        const hashed = await hashPassword(password);
        const okUser = await this.setConfig(AUTH_USERNAME_KEY, username);
        const okPass = await this.setConfig(AUTH_PASSWORD_KEY, hashed);
        await this.bumpTokenVersion();
        // 已经换成自己的密码了，解除「必须改密」限制
        await this.clearMustChangePassword();
        return okUser && okPass;
    },
    findUserByIdWithHash: async function (
        this: NavigationAPI,
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
    },

    // 验证令牌有效性
    verifyToken: async function (
        this: NavigationAPI,
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
    },

    // 生成JWT令牌
    generateToken: async function (
        this: NavigationAPI,
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
    },

    // 校验「当前密码」是否正确（auth/credentials 改密时用，避免明文比对）
    verifyCurrentPassword: async function (this: NavigationAPI, plain: string): Promise<boolean> {
        const creds = await this.getAuthCredentials();
        return verifyPassword(plain, creds.password);
    },

    // 检查认证是否启用
    isAuthEnabled: function (this: NavigationAPI ): boolean {
        return this.authEnabled;
    },
};
