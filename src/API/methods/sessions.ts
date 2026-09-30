// src/API/methods/sessions.ts
// NavigationAPI 的「sessions」域方法体：登录设备（会话）的登记、刷新与吊销。
//
// 为什么需要它：JWT 是无状态的，「改密 / 注销」只能靠 bump token_version 把某个账号的
// 令牌**整体**作废。这样有个盲区 —— 电脑丢了、或怀疑某台设备被人用过，主人没法只踢那一台：
// 要么改密把自己其它设备一起踢掉，要么干瞪眼等着。
//
// 办法是给每张令牌发一张「身份证」：签发时按 jti 登记一行（UA / IP / 时间），
// 之后就能按 jti 单独吊销。吊销 = 拉黑（真正让令牌失效）+ 删行（列表里消失），
// 别的设备完全不受影响。
//
// ⚠️ 拉黑这一步不能省：只删行的话，那张令牌在过期前依然能通过验签（JWT 自包含），
// 界面上看不到它、它却照样能改数据 —— 比不吊销更糟，因为主人会以为已经踢掉了。
import type { NavigationAPI } from "../http";
import { peekJwtClaim } from "../crypto";
import type { SessionInfo } from "../types";

/** last_seen 的刷新限频：同一个会话 1 小时内只写一次，避免每个请求都往 D1 落一行 */
const SESSION_TOUCH_INTERVAL_SEC = 60 * 60;

/** UA 存库前截断：恶意客户端可以塞超长 UA，别让它把行撑爆 */
const MAX_UA_LEN = 300;

export interface SessionsApi {
    /** 登录成功后登记这张令牌（jti / 过期时间 / 账号都从 token 里解，调用方不必知道） */
    recordSession(token: string, userAgent: string, ip: string): Promise<void>;
    /** 验签通过后刷新「最后活跃」（限频） */
    touchSession(jti: string): Promise<void>;
    /** 列出某账号仍然有效的会话；currentJti 用来标出「当前这一台」 */
    listSessions(uid: number, currentJti: string): Promise<SessionInfo[]>;
    /** 吊销单个会话（只能吊销自己的） */
    revokeSession(uid: number, jti: string): Promise<{ success: boolean; message?: string }>;
    /** 吊销除 currentJti 之外的所有会话（「退出其它设备」） */
    revokeOtherSessions(
        uid: number,
        currentJti: string
    ): Promise<{ success: boolean; revoked: number; message?: string }>;
}

export const sessionsImpl: SessionsApi = {

    /**
     * 登记一张新令牌。
     *
     * 失败一律吞掉：登录本身已经成功了，不能因为「记设备」这件锦上添花的事
     * 反过来把人挡在门外（记不上最多是列表里少一行，踢设备的入口还在）。
     */
    recordSession: async function (
        this: NavigationAPI,
        token: string,
        userAgent: string,
        ip: string
    ): Promise<void> {
        if (!token) return;
        try {
            const jti = peekJwtClaim(token, "jti");
            const exp = peekJwtClaim(token, "exp");
            const uid = peekJwtClaim(token, "uid");
            if (typeof jti !== "string" || !jti) return;
            if (typeof exp !== "number") return;

            const now = Math.floor(Date.now() / 1000);
            // ON CONFLICT：同一 jti 重复登记（重试 / 重放登录）时只更新时间，不插第二行
            await this.db
                .prepare(
                    `INSERT INTO user_sessions (jti, user_id, user_agent, ip, created_at, last_seen_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(jti) DO UPDATE SET last_seen_at = ?, expires_at = ?`
                )
                .bind(
                    jti,
                    typeof uid === "number" ? uid : null,
                    (userAgent || "").slice(0, MAX_UA_LEN),
                    ip || "",
                    now,
                    now,
                    exp,
                    now,
                    exp
                )
                .run();
        } catch (error) {
            console.error("登记登录会话失败:", error);
        }
    },

    /**
     * 刷新「最后活跃」。限频写在 SQL 里（last_seen_at 超过 1 小时才更新），
     * 这样每个请求都不必先 SELECT 一次再决定要不要写 —— 省掉一半查询。
     */
    touchSession: async function (this: NavigationAPI, jti: string): Promise<void> {
        if (!jti) return;
        try {
            const now = Math.floor(Date.now() / 1000);
            await this.db
                .prepare(
                    `UPDATE user_sessions SET last_seen_at = ? WHERE jti = ? AND last_seen_at < ?`
                )
                .bind(now, jti, now - SESSION_TOUCH_INTERVAL_SEC)
                .run();
        } catch {
            // 表还没建好、或这行已被清理掉，都不该影响主流程
        }
    },

    /**
     * 列出某账号仍然有效的会话。
     *
     * 过期的直接不返回：令牌过期后这张会话已经不能再用了，列出来只会让人以为
     * 「还有一台设备登着」，实际点吊销也是空操作。
     */
    listSessions: async function (
        this: NavigationAPI,
        uid: number,
        currentJti: string
    ): Promise<SessionInfo[]> {
        const now = Math.floor(Date.now() / 1000);
        try {
            const result = await this.db
                .prepare(
                    `SELECT jti, user_agent, ip, created_at, last_seen_at, expires_at
                     FROM user_sessions
                     WHERE user_id = ? AND expires_at > ?
                     ORDER BY last_seen_at DESC`
                )
                .bind(uid, now)
                .all<{
                    jti: string;
                    user_agent: string | null;
                    ip: string | null;
                    created_at: number;
                    last_seen_at: number;
                    expires_at: number;
                }>();
            return (result.results || []).map(row => ({
                jti: row.jti,
                userAgent: row.user_agent || "",
                ip: row.ip || "",
                createdAt: row.created_at,
                lastSeenAt: row.last_seen_at,
                expiresAt: row.expires_at,
                current: row.jti === currentJti,
            }));
        } catch {
            // 表还没建好：返回空列表，界面上那段直接不显示
            return [];
        }
    },

    /**
     * 吊销单个会话。
     *
     * 用 `WHERE jti = ? AND user_id = ?` 而不是只按 jti：少了账号条件，
     * 任何人猜到一个 jti 就能把别人的设备踢下线（虽然踢人只是骚扰，但不能开这个口子）。
     */
    revokeSession: async function (
        this: NavigationAPI,
        uid: number,
        jti: string
    ): Promise<{ success: boolean; message?: string }> {
        if (!jti) return { success: false, message: "缺少会话标识" };
        try {
            const row = await this.db
                .prepare("SELECT jti, expires_at FROM user_sessions WHERE jti = ? AND user_id = ?")
                .bind(jti, uid)
                .first<{ jti: string; expires_at: number }>();
            if (!row) return { success: false, message: "会话不存在或不属于当前账号" };

            // 先拉黑再删行：顺序反了的话，万一删完崩了，那张令牌还能用到过期
            await this.blacklistToken(row.jti, row.expires_at);
            await this.db.prepare("DELETE FROM user_sessions WHERE jti = ?").bind(jti).run();
            return { success: true };
        } catch (error) {
            return {
                success: false,
                message: "吊销失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    },

    /**
     * 退出其它设备：除当前这一台之外全部吊销。
     *
     * currentJti 为空（用 Authorization 头的脚本客户端，没有 cookie 会话概念）时
     * 会把自己的也一起踢掉 —— 那种场景本来就没有「当前设备」可言，全踢才符合预期。
     */
    revokeOtherSessions: async function (
        this: NavigationAPI,
        uid: number,
        currentJti: string
    ): Promise<{ success: boolean; revoked: number; message?: string }> {
        try {
            const result = await this.db
                .prepare("SELECT jti, expires_at FROM user_sessions WHERE user_id = ? AND jti != ?")
                .bind(uid, currentJti)
                .all<{ jti: string; expires_at: number }>();
            const rows = result.results || [];

            for (const row of rows) {
                await this.blacklistToken(row.jti, row.expires_at);
            }
            await this.db
                .prepare("DELETE FROM user_sessions WHERE user_id = ? AND jti != ?")
                .bind(uid, currentJti)
                .run();

            return { success: true, revoked: rows.length };
        } catch (error) {
            return {
                success: false,
                revoked: 0,
                message: "吊销失败：" + (error instanceof Error ? error.message : "未知错误"),
            };
        }
    },
};
