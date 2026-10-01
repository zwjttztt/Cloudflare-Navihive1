// src/API/methods/accounts.ts
// NavigationAPI 的「accounts」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { AUTH_PASSWORD_KEY, AUTH_USERNAME_KEY, DEFAULT_TOKEN_TTL, INACTIVE_DELETE_GRACE_DAYS_DEFAULT, INACTIVE_DELETE_GRACE_DAYS_KEY, INACTIVE_DISABLE_DAYS_DEFAULT, INACTIVE_DISABLE_DAYS_KEY, INVITE_TTL_SECONDS, REMEMBER_TOKEN_TTL, SESSION_STATE_TTL_MS } from "../configKeys";
import { hashPassword, isHashedPassword, verifyPassword } from "../crypto";
import { D1PreparedStatement } from "../schema";
import { STARTER_GROUPS } from "../starterData";
import { AccountInfo, AccountSessionState, InviteInfo, LoginRequest, LoginResponse, RegisterResult, UserRecord, computeInactiveTimeline } from "../types";
import { randomInviteCode } from "./internals";

export interface AccountsApi {
    login(loginRequest: LoginRequest): Promise<LoginResponse>;
    hasAnyUser(): Promise<boolean>;
    disableLegacyCredentials(): Promise<void>;
    findUserByUsername(
        username: string
    ): Promise<{
        id: number;
        username: string;
        passwordHash: string;
        role: "owner" | "user";
        status: string | null;
    } | null>;
    findOwnerUser(): Promise<{ id: number; username: string } | null>;
    issueTokenForUser(
        uid: number,
        username: string, ttlSeconds?: number): Promise<string>;
    getUserById(id: number): Promise<UserRecord | null>;
    touchLastActive(uid: number): Promise<void>;
    getAccountSessionState(uid: number): Promise<AccountSessionState>;
    invalidateSessionState(uid: number): void;
    recordActiveLogin(uid: number): Promise<void>;
    listUsers(): Promise<AccountInfo[]>;
    setUserStatus(
        targetUid: number,
        status: "active" | "disabled",
        actorUid: number
    ): Promise<{ success: boolean; message?: string }>;
    sweepInactiveUsers(): Promise<{ disabled: number; deleted: number }>;
    getInactiveDisableDays(): Promise<number>;
    getInactiveGraceDays(): Promise<number>;
    findUserByIdWithRole(
        uid: number
    ): Promise<{ id: number; username: string; role: "owner" | "user" } | null>;
    verifyPasswordOfUser(userId: number, plain: string): Promise<boolean>;
    setUserPassword(userId: number, plain: string): Promise<boolean>;
    countOwners(): Promise<number>;
    registerUser(
        username: string,
        password: string,
        inviteCode: string
    ): Promise<RegisterResult>;
    seedStarterData(userId: number): Promise<void>;
    checkInvite(code: string): Promise<{ ok: boolean; message: string; code: string }>;
    createInvite(createdBy: number): Promise<
        { success: boolean; message: string } & Partial<InviteInfo>
    >;
    deleteAccount(userId: number): Promise<{ success: boolean; message: string }>;
    updateCurrentCredentials(
        username: string,
        password: string,
        currentPassword: string
    ): Promise<{ success: boolean; message: string }>;
}

export const accountsImpl: AccountsApi = {

    // 验证用户登录（多账号：优先查 users 表，查不到再退回旧的单管理员凭据）
    login: async function (this: NavigationAPI, loginRequest: LoginRequest): Promise<LoginResponse> {
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

        // H1 fail-closed：启用鉴权却没配 JWT 密钥，登录无法签发令牌
        if (this.authEnabled && !this.jwtSecretConfigured) {
            return {
                success: false,
                message: "服务器未配置 JWT 密钥（JWT_SECRET / AUTH_SECRET），无法签发登录令牌，请联系管理员",
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
    },

    /** users 表里有没有账号：有则不允许再落到 configs 那份老凭据上（见 login 里的注释） */
    hasAnyUser: async function (this: NavigationAPI ): Promise<boolean> {
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
    },

    /**
     * 把 configs 里那份单管理员凭据作废。
     *
     * 多账号之后改密改的是 users 表，configs 里那份（部署种子凭据）会一直留着；
     * 只要它还在，旧账号名 + 旧密码就仍然是一条能登进来的旁路。每次成功改密 / 改名
     * 都把它删掉，让「改了密码」这件事真正生效。
     */
    disableLegacyCredentials: async function (this: NavigationAPI ): Promise<void> {
        try {
            await this.deleteConfig(AUTH_USERNAME_KEY);
            await this.deleteConfig(AUTH_PASSWORD_KEY);
            this.anyUserCache = true; // 走到这一步 users 表里肯定有账号
        } catch (error) {
            console.error("清理旧管理员凭据失败:", error);
        }
    },

    // ============ 多账号：用户与邀请码 ============
    /** 按账号名查用户（含哈希，只在服务端内部用） */
    findUserByUsername: async function (
        this: NavigationAPI,
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
    },

    /** 取首个 owner（恢复密钥默认重置它） */
    findOwnerUser: async function (this: NavigationAPI ): Promise<{ id: number; username: string } | null> {
        try {
            return await this.db
                .prepare("SELECT id, username FROM users WHERE role = 'owner' ORDER BY id LIMIT 1")
                .first<{ id: number; username: string }>();
        } catch {
            return null;
        }
    },

    /** 给指定账号签一张令牌（注册成功后直接登录，省得再回登录页输一遍） */
    issueTokenForUser: async function (
        this: NavigationAPI,
        uid: number,
        username: string,
        ttlSeconds: number = DEFAULT_TOKEN_TTL
    ): Promise<string> {
        return this.generateToken({ username, uid }, ttlSeconds);
    },
    getUserById: async function (this: NavigationAPI, id: number): Promise<UserRecord | null> {
        try {
            const row = await this.db
                .prepare("SELECT id, username, role, created_at FROM users WHERE id = ?")
                .bind(id)
                .first<UserRecord>();
            return row ?? null;
        } catch {
            return null;
        }
    },

    /**
     * 刷新「最后活跃时间」——限频为每天最多写一次，避免每个请求都往 D1 落一行。
     *
     * 只要令牌验过（含「记住我」的静默恢复）就算活跃：一个每天来、只是 cookie 还有效
     * 的人，不该被判成沉睡账号。SQL 里带上 last_active_at 过期条件，没到一天就 0 行变更。
     */
    touchLastActive: async function (this: NavigationAPI, uid: number): Promise<void> {
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
    },

    /**
     * 令牌验签通过之后，再确认一次账号还在不在、有没有被停用。
     *
     * JWT 是自包含的，账号被停用或清除时它并不会失效 —— 「记住我」那张能活 30 天。
     * 只验签就放行的话：被停用的账号照样能改数据（等于停用形同虚设），
     * 被清除的账号写出来的行会挂在一个已不存在的 user_id 上变成孤儿数据。
     * 所以每个请求都要补这一问，用短缓存压掉查库开销（见 sessionStateCache）。
     */
    getAccountSessionState: async function (this: NavigationAPI, uid: number): Promise<AccountSessionState> {
        const now = Date.now();
        const cached = this.sessionStateCache.get(uid);
        if (cached && now - cached.at < SESSION_STATE_TTL_MS) return cached.state;

        let state: AccountSessionState;
        // 由「查询出错」推出的结论不进缓存：缓存了就会让一次偶发抖动把人卡住整个 TTL，
        // 而且下次请求即便 DB 已经恢复也拿不到正确结论。
        let fromError = false;

        const readState = async (): Promise<AccountSessionState> => {
            const row = await this.db
                .prepare(`SELECT "status" FROM users WHERE id = ?`)
                .bind(uid)
                .first<{ status: string | null }>();
            if (!row) return "missing";
            return row.status === "disabled" ? "disabled" : "active";
        };

        try {
            state = await readState();
        } catch {
            // 迁移未跑完（首请求、users 表 / status 列还没建好）时 fail-open，放行以免整站登不进
            if (!this.dbReady) {
                state = "active";
                fromError = true;
            } else {
                // 迁移跑完之后若还查出错：先重试一次，排除偶发抖动再下结论；
                // 仍失败就按 fail-closed 处理（除非显式开了逃生开关），
                // 避免被停用 / 清除的账号靠旧令牌继续过审。
                try {
                    state = await readState();
                } catch (error) {
                    console.error(`账号状态查询失败（uid=${uid}）：`, error);
                    state = this.failOpenOnError ? "active" : "missing";
                    fromError = true;
                }
            }
        }

        if (fromError) this.sessionStateCache.delete(uid);
        else this.sessionStateCache.set(uid, { state, at: now });
        return state;
    },

    /** 停用 / 清除 / 重新启用之后调一下：缓存里那条结论已经不成立了 */
    invalidateSessionState: function (this: NavigationAPI, uid: number): void {
        this.sessionStateCache.delete(uid);
    },

    /** 显式登录成功：无条件刷新活跃时间（不受每天的限频影响） */
    recordActiveLogin: async function (this: NavigationAPI, uid: number): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        try {
            await this.db
                .prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`)
                .bind(now, uid)
                .run();
        } catch {
            // 忽略
        }
    },

    /** 账号列表（owner 视角）：含停用状态、最后活跃、距停用/清除的推算时间 */
    listUsers: async function (this: NavigationAPI ): Promise<AccountInfo[]> {
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
    },

    /**
     * owner 手动改某个账号的状态：
     *   - active   = 豁免：清掉停用时间、并把活跃时间刷成现在（否则立刻又会被判沉睡）；
     *   - disabled = 手动停用。
     * 只有 owner 能调；自己不能在这里把自己停用（走「注销账号」那条路）。
     */
    setUserStatus: async function (
        this: NavigationAPI,
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
    },

    /**
     * 沉睡账号扫描（每周定时任务调用）。两步，都排除 owner（否则站点可能无人可管）：
     *   1. 停用：active 且「最后活跃（没有就用创建时间）」早于停用阈值 -> 置 disabled；
     *   2. 清除：disabled 且停用时间早于宽限期阈值 -> 硬删账号及其全部数据
     *      （user_configs / 它发的或用掉的邀请码 / 它名下的分组与卡片），真正释放 D1 行数。
     */
    sweepInactiveUsers: async function (this: NavigationAPI ): Promise<{ disabled: number; deleted: number }> {
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
    },

    /** 停用阈值（天）：configs 里没有就用默认 180 */
    getInactiveDisableDays: async function (this: NavigationAPI ): Promise<number> {
        const raw = parseInt((await this.getConfig(INACTIVE_DISABLE_DAYS_KEY)) || "", 10);
        return Number.isFinite(raw) && raw > 0 ? raw : INACTIVE_DISABLE_DAYS_DEFAULT;
    },

    /** 清除宽限期（天）：configs 里没有就用默认 30 */
    getInactiveGraceDays: async function (this: NavigationAPI ): Promise<number> {
        const raw = parseInt((await this.getConfig(INACTIVE_DELETE_GRACE_DAYS_KEY)) || "", 10);
        return Number.isFinite(raw) && raw > 0 ? raw : INACTIVE_DELETE_GRACE_DAYS_DEFAULT;
    },

    /** 按 id 查账号（带 role，用于 owner 权限判断） */
    findUserByIdWithRole: async function (
        this: NavigationAPI,
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
    },

    /** 校验某个账号的密码是否正确（注销账号这类高危操作前再确认一次身份） */
    verifyPasswordOfUser: async function (this: NavigationAPI, userId: number, plain: string): Promise<boolean> {
        const user = await this.findUserByIdWithHash(userId);
        if (!user) return false;
        return verifyPassword(plain, user.passwordHash);
    },

    /** 写入账号密码（一律哈希，绝不落明文） */
    setUserPassword: async function (this: NavigationAPI, userId: number, plain: string): Promise<boolean> {
        const hashed = await hashPassword(plain);
        const result = await this.db
            .prepare("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(hashed, userId)
            .run();
        return result.success;
    },

    /** 还剩几个 owner：最后一个 owner 不允许注销，否则站点无人可管 */
    countOwners: async function (this: NavigationAPI ): Promise<number> {
        try {
            const row = await this.db
                .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner'")
                .first<{ total: number }>();
            return row?.total ?? 0;
        } catch {
            return 0;
        }
    },

    /**
     * 注册新账号。必须带一枚有效邀请码 —— 注册入口是公开的，
     * 没有邀请码就等于任何人都能建号（邀请码是唯一的准入门槛）。
     */
    registerUser: async function (
        this: NavigationAPI,
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
    },

    /**
     * 给刚注册的账号塞一套默认分组与卡片。
     * 失败一律吞掉：起手数据只是「不至于空荡荡」，不能反过来让注册失败
     *（邀请码已经用掉了，这时候报错等于白白损失一个名额）。
     */
    seedStarterData: async function (this: NavigationAPI, userId: number): Promise<void> {
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
    },

    /** 校验邀请码是否还能用（不消耗） */
    checkInvite: async function (this: NavigationAPI, code: string): Promise<{ ok: boolean; message: string; code: string }> {
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
    },

    /** 生成一枚邀请码（已登录用户调用），30 分钟有效 */
    createInvite: async function (this: NavigationAPI, createdBy: number): Promise<
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
    },

    /**
     * 注销账号：分组、站点、账号记录全部删除，不留任何残留。
     * 最后一个 owner 不让注销 —— 否则站点变成没人能管的孤儿。
     */
    deleteAccount: async function (this: NavigationAPI, userId: number): Promise<{ success: boolean; message: string }> {
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
    },

    /**
     * 修改当前账号的账号名 / 密码。必须校验当前密码 ——
     * 否则拿到会话的人可以顺手改掉密码把主人锁在门外。
     * 没有用户上下文时（旧令牌 / 未升级）退回 configs 的单管理员逻辑。
     */
    updateCurrentCredentials: async function (
        this: NavigationAPI,
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
    },
};
