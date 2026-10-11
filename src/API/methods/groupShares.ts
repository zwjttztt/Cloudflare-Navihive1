// src/API/methods/groupShares.ts
// 分组分享（2026-10-11 阶段④）：把一个导航分组以只读公开页分享出去。
//
// 与 note_share 同一套语义（创建即轮换令牌 / 更新保留令牌 / 口令哈希落库 /
// 过期与作者状态判定），但分享的是**分组卡片**：公开读取只回
// name/url/description/icon 四个脱敏字段 —— 站点密码、用户名绝不出门。
//
// group_id 是 PRIMARY KEY：一个分组最多一份分享；删除分组后残留的 share 行
// 是无害的（公开读取 JOIN groups，组没了就是 not-found），不专门清理。

import type { NavigationAPI } from "../navigationApi";
import { newUuid } from "../../utils/uuid";
import { hashPassword, verifyPassword } from "../crypto";
import type { GroupShareConfig, PublicGroupAccess } from "../types";

export interface GroupShareApi {
    /** 创建/重建分享：每次轮换令牌，旧链接立即失效（days=null 永久） */
    createGroupShare(id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null>;
    /** 更新设置：保留令牌（链接不变）；password 传 string 重设 / null 清除 / undefined 保持 */
    updateGroupShare(id: number, days: number | null, password?: string | null): Promise<GroupShareConfig | null>;
    revokeGroupShare(id: number): Promise<{ success: boolean }>;
    /** 主人查当前配置（没分享过返回 null） */
    getGroupShareConfig(id: number): Promise<GroupShareConfig | null>;
    /** 公开读取（匿名）：口令错统一 need-password；组删了/过期/停用都是 not-found */
    getPublicGroupShare(token: string, password?: string | null): Promise<PublicGroupAccess>;
}

const SHARE_DAYS_ALLOWED = [1, 7, 30];

export const groupSharesImpl: GroupShareApi = {
    createGroupShare: async function (
        this: NavigationAPI,
        id: number,
        days: number | null,
        password?: string | null
    ): Promise<GroupShareConfig | null> {
        if (days !== null && !SHARE_DAYS_ALLOWED.includes(days)) throw new Error("分享有效期无效");
        await this.migrate();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b =>
            b.toString(16).padStart(2, "0")
        ).join("");
        const expires = days === null ? null : Date.now() + days * 86_400_000;
        const hashed = password && password.length > 0 ? await hashPassword(password) : null;
        return this.db
            .prepare(`INSERT INTO group_share (group_id, group_uuid, user_id, token, expires_at, password)
            SELECT id, ?, user_id, ?, ?, ?
            FROM groups WHERE id = ? AND user_id IS ?
            ON CONFLICT(group_id) DO UPDATE SET group_uuid = excluded.group_uuid,
                user_id = excluded.user_id, token = excluded.token, expires_at = excluded.expires_at,
                password = excluded.password
            RETURNING token, expires_at, views, (password IS NOT NULL) AS hasPassword`)
            // ⚠️ 占位符按**语句出现顺序**绑定：第 1 个 ? 是 group_uuid（SELECT 列表里），
            // 然后才是 token / expires_at / password（VALUES 位），最后 WHERE 的 id / user_id。
            .bind(newUuid(), token, expires, hashed, id, this.currentUserId)
            .first<GroupShareConfig>();
    },

    updateGroupShare: async function (
        this: NavigationAPI,
        id: number,
        days: number | null,
        password?: string | null
    ): Promise<GroupShareConfig | null> {
        if (days !== null && !SHARE_DAYS_ALLOWED.includes(days)) throw new Error("分享有效期无效");
        await this.migrate();
        const expires = days === null ? null : Date.now() + days * 86_400_000;
        let setSql = "expires_at = ?";
        const binds: unknown[] = [expires];
        if (password !== undefined) {
            setSql += ", password = ?";
            binds.push(password && password.length > 0 ? await hashPassword(password) : null);
        }
        binds.push(id, this.currentUserId);
        return this.db
            .prepare(`UPDATE group_share SET ${setSql} WHERE group_id = ? AND user_id IS ?
            RETURNING token, expires_at, views, (password IS NOT NULL) AS hasPassword`)
            .bind(...binds)
            .first<GroupShareConfig>();
    },

    revokeGroupShare: async function (this: NavigationAPI, id: number): Promise<{ success: boolean }> {
        await this.migrate();
        await this.db
            .prepare("DELETE FROM group_share WHERE group_id = ? AND user_id IS ?")
            .bind(id, this.currentUserId)
            .run();
        return { success: true };
    },

    getGroupShareConfig: async function (
        this: NavigationAPI,
        id: number
    ): Promise<GroupShareConfig | null> {
        await this.migrate();
        return this.db
            .prepare(
                `SELECT token, expires_at, views, (password IS NOT NULL) AS hasPassword
             FROM group_share WHERE group_id = ? AND user_id IS ?`
            )
            .bind(id, this.currentUserId)
            .first<GroupShareConfig>();
    },

    getPublicGroupShare: async function (
        this: NavigationAPI,
        token: string,
        password?: string | null
    ): Promise<PublicGroupAccess> {
        if (!/^[a-f0-9]{64}$/.test(token)) return { status: "not-found" };
        await this.migrate();
        const row = await this.db
            .prepare(
                `SELECT g.name AS name,
                    s.password AS password, s.views AS views, s.user_id AS owner_id
            FROM group_share s
            JOIN groups g ON g.id = s.group_id
            WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
            AND (s.user_id IS NULL OR EXISTS (
                SELECT 1 FROM users u WHERE u.id = s.user_id AND COALESCE(u.status, 'active') = 'active'))`
            )
            .bind(token, Date.now())
            .first<{ name: string; password: string | null; views: number; owner_id: number | null }>();
        if (!row) return { status: "not-found" };
        if (row.password) {
            const ok =
                password !== undefined &&
                password !== null &&
                password.length > 0 &&
                (await verifyPassword(password, row.password));
            if (!ok) return { status: "need-password" };
        }
        // ⚠️ 脱敏由 SELECT 列表保证：只有 name/url/description/icon 出门，
        // sites 表里的 username / password 永远不进公开响应。
        const sites = await this.db
            .prepare(
                `SELECT name, url, description, icon FROM sites
             WHERE group_id = (SELECT group_id FROM group_share WHERE token = ?)
               AND user_id IS ?
             ORDER BY order_num, id`
            )
            .bind(token, row.owner_id)
            .all<{ name: string; url: string; description: string | null; icon: string | null }>();
        const inc = await this.db
            .prepare("UPDATE group_share SET views = views + 1 WHERE token = ?")
            .bind(token)
            .run();
        const views = (typeof row.views === "number" ? row.views : 0) + (inc.success ? 1 : 0);
        return {
            status: "ok",
            group: { name: row.name },
            sites: sites.results || [],
            views,
        };
    },
};
