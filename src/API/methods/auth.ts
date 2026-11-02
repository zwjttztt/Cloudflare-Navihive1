// src/API/methods/auth.ts
// NavigationAPI 的「auth」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { AUTH_PASSWORD_KEY, AUTH_USERNAME_KEY, DEFAULT_TOKEN_TTL, MUST_CHANGE_PASSWORD_KEY, TOKEN_VERSION_KEY } from "../configKeys";
import { hashPassword, peekJwtClaim, signJwt, verifyJwtAny, verifyPassword } from "../crypto";
import type { AccountSessionState } from "../types";
import { logger } from "../../../shared/logger";

/**
 * 三读合一里「账号态」那一列的可能取值。
 *
 * 比 AccountSessionState 多一个 `unknown`：老令牌（多账号之前签的、payload 里没有 uid）
 * 根本没有 users 行可查，硬判成 active / missing 都是编造。中间件只在拿得到数值 uid 时
 * 才认这个字段，所以 `unknown` 只会被忽略、不会被当成放行。
 */
export type AuthProbeAccountStatus = AccountSessionState | "unknown";

/** 三读合一的结果：一次往返拿齐「令牌版本 / 账号态 / 是否已拉黑」 */
export interface AuthProbeResult {
    /**
     * 令牌版本。
     * - 有 uid：users.token_version；**行不存在时为 null**（调用方按 0 处理，
     *   与改造前 `row?.token_version ?? 0` 一致）。
     * - 没有 uid（遗留令牌）：全站那份（configs.auth.tokenVersion），不会是 null。
     */
    tokenVersion: number | null;
    accountStatus: AuthProbeAccountStatus;
    blacklisted: boolean;
}

/**
 * 三读合一的唯一一条 SQL：三个标量子查询，三个匿名参数，**永远返回 1 行**。
 *
 * - 三个子查询都走主键 / 唯一索引（users.id 主键、token_blacklist.jti 主键），没有全表扫；
 * - 账号不存在时子查询是 NULL（不是 0 行），所以 `tv IS NULL AND st IS NULL` 即「账号没了」；
 * - ⚠️ `status` 是 SQL 保留字，**必须加双引号**（本仓 accounts.ts 里同一写法，照抄即可）；
 * - ⚠️ 老库里可能没有 token_blacklist 表 —— 那时整条语句会报错，
 *   authProbe 把错误抛出去，由 verifyToken 的降级路径退回三次独立读（行为与改造前逐字一致）。
 */
const AUTH_PROBE_SQL = `
    SELECT
      (SELECT token_version FROM users WHERE id = ?)        AS tv,
      (SELECT "status"        FROM users WHERE id = ?)      AS st,
      (SELECT 1 FROM token_blacklist WHERE jti = ? LIMIT 1) AS bl
`;

/** authProbe 的原始行形状（三列都可能为 NULL） */
interface AuthProbeRow {
    tv?: number | string | null;
    st?: string | null;
    bl?: number | null;
}

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
    /**
     * 一次往返拿齐「令牌版本 + 账号态 + 是否已拉黑」（已认证请求的热路径）。
     *
     * 失败**不吞**：抛给 verifyToken，由它退回到改造前的三次独立读。
     * 这样任何历史库形态（缺列、缺表、连接抖动）上的对外行为都与改造前一致。
     */
    authProbe(uid: number | null, jti: string): Promise<AuthProbeResult>;
    /**
     * 取出（并清空）本请求 verifyToken 那次 authProbe 的结果 —— 内部通道。
     *
     * uid / jti 都要对得上才给：对不上说明是别的令牌留下的结论，绝不能借用。
     * 结果**不进 JWT payload**，verifyToken 的返回形状也不变。
     */
    takeAuthProbe(uid: number | null, jti: string): AuthProbeResult | null;
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
            logger.error("读取管理员凭据失败，回退到环境变量:", { err: error, component: "auth" })
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
            // ⚠️ created_at 必须显式给：这一列没有 DEFAULT，老库里全是 NULL
            //    （2026-10-22 查线上库时发现，13 条拉黑记录没一条有创建时间，
            //     于是「这条是什么时候拉黑的」根本答不出来，排障时很碍事）。
            const now = Math.floor(Date.now() / 1000);
            await this.db
                .prepare(
                    `INSERT INTO token_blacklist (jti, exp, created_at) VALUES (?, ?, ?)
                     ON CONFLICT(jti) DO UPDATE SET exp = ?`
                )
                .bind(jti, exp, now, exp)
                .run();
        } catch (error) {
            logger.error("拉黑令牌失败:", { err: error, component: "auth" })
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
            logger.error("读取账号角色失败:", { err: error, component: "auth" })
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
            logger.error("按账号递增令牌版本失败，退回全局:", { err: error, component: "auth" })
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

    // ============ 三读合一：已认证请求的读路径收成一次往返 ============
    //
    // 改造前每个已认证请求要打三次独立的读：getTokenVersion（验签用）、
    // getAccountSessionState（中间件查账号态）、isTokenBlacklisted（拉黑判定）。
    // 三次都指向主键 / 唯一索引，一条语句就能全拿到 —— 见 AUTH_PROBE_SQL。
    //
    // ⚠️ 失败**不吞**（与 isTokenBlacklisted 的 fail-closed 不冲突）：
    //    这里把错误抛出去，verifyToken 捕获后走「降级路径」退回三次独立读，
    //    在那种路径上 isTokenBlacklisted 的 catch → true（401）原样保留。
    //    把错误吞成「默认值」反而会在缺表的库上静默放行，那是把安全判据换成了运气。
    authProbe: async function (
        this: NavigationAPI,
        uid: number | null,
        jti: string
    ): Promise<AuthProbeResult> {
        const row = await this.db
            .prepare(AUTH_PROBE_SQL)
            // 三个匿名参数：两个 uid（两个 users 子查询）+ 一个 jti。
            // uid 为 null 时 `id = NULL` 恒不成立 → tv / st 都是 NULL，正是我们要的。
            .bind(uid, uid, jti || "")
            .first<AuthProbeRow>();

        // 形状自检：真 D1 / SQLite 一定回**恰好这三列**（子查询取不到值时值是 NULL、键仍在）。
        // 列不对 = 这条 SQL 压根没被这条语句执行（按前缀猜 SQL 的测试替身，会把它
        // 当成普通的 `SELECT ... FROM users` 回一整行用户记录）—— 那时绝不能拿它的结果
        // 做判断，抛出去走降级路径：宁可多查三次，也不能误放行、也不能误判账号态。
        const keys = row ? Object.keys(row) : [];
        const shaped =
            keys.length === 3 && keys.includes("tv") && keys.includes("st") && keys.includes("bl");
        if (!row || !shaped) {
            throw new Error("authProbe 结果形状异常（不是 tv / st / bl 三列），已退回三次独立读");
        }

        const tvRaw = row.tv ?? null;
        const stRaw = row.st ?? null;

        // 版本号：老令牌（payload 里没有 uid）没有 users 行可查，只能走全站那份
        // （getTokenVersion(null) 自带 tokenVersionCache，且这条分支已不是热路径）。
        // 有 uid 而 tv 为 NULL = 账号行已不存在 → 按 0 处理，与改造前
        // `Number(row?.token_version ?? 0)` 逐字一致。
        let tokenVersion: number | null;
        if (uid === null) {
            tokenVersion = await this.getTokenVersion(null);
        } else if (tvRaw === null) {
            tokenVersion = null;
        } else {
            const v = Number(tvRaw);
            tokenVersion = Number.isFinite(v) ? v : 0;
        }

        // 账号态：tv 与 st 同时为 NULL → 一行都没有 → missing；
        // 否则只有 status = 'disabled' 算停用，其余（含 NULL）一律 active ——
        // 与 getAccountSessionState 的 `row.status === "disabled" ? ... : "active"` 同口径。
        let accountStatus: AuthProbeAccountStatus;
        if (uid === null) {
            accountStatus = "unknown";
        } else if (tvRaw === null && stRaw === null) {
            accountStatus = "missing";
        } else {
            accountStatus = stRaw === "disabled" ? "disabled" : "active";
        }

        // jti 为空时与 isTokenBlacklisted 的 `if (!jti) return false` 对齐：不去查空串
        const blacklisted = jti ? !!row.bl : false;

        return { tokenVersion, accountStatus, blacklisted };
    },

    takeAuthProbe: function (
        this: NavigationAPI,
        uid: number | null,
        jti: string
    ): AuthProbeResult | null {
        const cached = this.authProbeCache;
        // 取出即作废：一个请求只该用一次，留着只会在别的路径上串味
        this.authProbeCache = null;
        if (!cached) return null;
        if (cached.uid !== uid || cached.jti !== jti) return null;
        return cached.result;
    },

    // 验证令牌有效性
    verifyToken: async function (
        this: NavigationAPI,
        token: string
    ): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
        if (!this.authEnabled) {
            return { valid: true };
        }
        // H1 fail-closed：启用鉴权但 JWT 密钥缺失，拒绝一切令牌（避免被公开默认密钥伪造）
        if (!this.jwtSecretConfigured) {
            return { valid: false };
        }
        // 现在会真正验签（HMAC-SHA256）+ 校验过期 + 校验令牌版本，
        // 伪造的 token 直接被拒，改密后旧 token 也立即失效。
        //
        // 版本号按「令牌里的账号」来取：先看 payload 里的 uid —— 未验签的 payload 只读
        // uid / jti 这两个字段，不做任何信任判断，安全仍然由下面的 verifyJwtAny 全权负责。
        const uidFromToken = peekJwtClaim(token, "uid");
        const tokenUid = typeof uidFromToken === "number" ? uidFromToken : null;
        const jtiFromToken = peekJwtClaim(token, "jti");
        const tokenJti = typeof jtiFromToken === "string" ? jtiFromToken : "";

        // ---- 三读合一：tokenVersion + 账号态 + 黑名单，一条 SQL 一次往返 ----
        //
        // ⚠️ **顺序是有意改过的，不要「修」回去**：
        //    改造前是 getTokenVersion → verifyJwtAny → isTokenBlacklisted，
        //    现在黑名单判定被提前到验签之前。这意味着「未验签的 token 也能触发
        //    一次 token_blacklist 的主键查找」—— 但这与改造前完全等价：
        //    验签之前我们本来就已经拿未验签的 uid 查过 users 表了；而且这里只是
        //    单条主键读，既没有放大面（不产生额外往返），也不泄漏任何可比对的信息
        //    （命中与否最终仍由验签 + 下面的判定共同决定）。
        let probed: AuthProbeResult | null;
        try {
            probed = await this.authProbe(tokenUid, tokenJti);
        } catch (error) {
            // 降级路径（**必现项，不是可选优化**）：任何历史库形态（缺 token_blacklist 表、
            // 缺 users.status / token_version 列、连接抖动）上这条合并 SQL 都会炸，
            // 那时下面这条路与改造前**逐字一致**：三次独立读、各自的 catch 语义原样保留
            // （isTokenBlacklisted 出错 → true → 401 fail-closed）。
            logger.error("鉴权三读合一失败，退回三次独立读:", { err: error, component: "auth" });
            probed = null;
        }

        let tv: number;
        if (probed) {
            // 行不存在时 tokenVersion 是 null → 按 0，改造前 getTokenVersion 就是这个数。
            // 遗留令牌（没有 uid）的那一份在 authProbe 内部就已经取成全站版本了。
            tv = probed.tokenVersion ?? 0;
            // 有 uid 时顺手填 accountVersionCache：它与 getTokenVersion / bumpTokenVersion
            // 共用同一份缓存，不填就等于「省了一次读、丢了一层缓存」，后面的 bump 会多查一次。
            if (tokenUid !== null) this.accountVersionCache.set(tokenUid, tv);
        } else {
            tv = await this.getTokenVersion(tokenUid);
        }

        const result = await verifyJwtAny(token, this.jwtKeys, { tokenVersion: tv });

        if (!result.valid) {
            // 验签不过：中间件不该再借用这次探测的账号态，清掉免得串到别的判断上
            this.authProbeCache = null;
            return result;
        }

        if (probed) {
            // 合并路径下黑名单结论已经随那条 SQL 一起拿到了（同理，读异常会走上面的降级）
            if (probed.blacklisted) {
                this.authProbeCache = null;
                return { valid: false };
            }
            // 走内部通道交给中间件，省掉它再查一次账号态。
            // ⚠️ 不塞进 JWT payload，也不改本方法的返回形状（invariant）。
            this.authProbeCache = { uid: tokenUid, jti: tokenJti, result: probed };
            return result;
        }

        // 验签通过还要再查一次黑名单：退出登录过的令牌不能复活（降级路径，与改造前逐字一致）
        const verifiedJti = typeof result.payload?.jti === "string" ? result.payload.jti : "";
        if (await this.isTokenBlacklisted(verifiedJti)) {
            return { valid: false };
        }
        return result;
    },

    // 生成JWT令牌
    generateToken: async function (
        this: NavigationAPI,
        payload: Record<string, unknown>,
        ttlSeconds: number = DEFAULT_TOKEN_TTL
    ): Promise<string> {
        // H1 fail-closed：启用鉴权却没配 JWT 密钥，拒绝签发令牌
        if (this.authEnabled && !this.jwtSecretConfigured) {
            throw new Error("JWT 密钥未配置（JWT_SECRET / AUTH_SECRET），拒绝签发令牌");
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
        return signJwt(tokenPayload, this.jwtSecret);
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
