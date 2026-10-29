// src/API/methods/audit.ts
// NavigationAPI 的「audit」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { deriveDeadLinks } from "../../utils/linkKey";
import { groupClientErrors } from "../../utils/clientErrorGroups";
import { logger } from "../../../shared/logger";

/** 前端错误上报按「来源 + 错误信息」聚合后的一组 */
export interface ClientErrorGroup {
    /** 聚合键（source + 消息前 120 字符），前端当 key 用 */
    key: string;
    /** 错误来源（auth / save / render …，上报时自定义的分类） */
    source: string;
    /** 错误信息（已 sanitize 过） */
    message: string;
    /** 这段时间内出现了几次 */
    count: number;
    /** 最近一次发生的时间 */
    lastAt: string;
    /** 发生在哪些页面上（去重后最多留 3 个） */
    paths: string[];
}

export interface AuditApi {
    writeAudit(action: string, actor: string, ip: string, detail?: string): Promise<void>;
    getAuditLog(opts?: { limit?: number; offset?: number; actor?: string }): Promise<
        Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>
    >;
    /**
     * 前端错误上报的聚合视图（owner 看「最近哪里在崩」用）。
     *
     * 上报已经落进 audit_log（action = client-error，detail 是一小段 JSON），
     * 但审计列表里那一串 JSON 没人看得懂 —— 这里按「来源 + 错误信息」归并，
     * 给出次数、最近发生时间、发生在哪些页面上。
     */
    getClientErrors(limit?: number): Promise<ClientErrorGroup[]>;
    purgeExpiredAudit(days: number): Promise<number>;
    /**
     * 运维统计看板聚合（仅 owner，一次拉全）：内容计数、近 30 天审计活跃、
     * 分享浏览 Top、链接健康快照。聚合在服务端做，前端只画图。
     */
    getOpsStats(): Promise<OpsStats>;
}

/** 运维统计看板的一次聚合结果 */
export interface OpsStats {
    /** 内容计数（按当前账号 scope；audit 是全站审计不分账号） */
    counts: { sites: number; groups: number; notes: number; attachments: number; attachmentBytes: number };
    /** 近 30 天审计活跃：缺日补零，day 为 UTC 日期（YYYY-MM-DD） */
    auditDaily: Array<{ day: string; count: number }>;
    /** 近 30 天 Top 动作（按次数降序，最多 8 条） */
    auditTopActions: Array<{ action: string; count: number }>;
    /** 分享浏览次数 Top（笔记 + 分组合并排序，最多 8 条） */
    shareTop: Array<{ kind: "note" | "group"; title: string; views: number }>;
    /** 链接健康：来自 link.health 快照（开启健康同步后才有服务端数据） */
    health: { total: number; deadCount: number; deadLatest: Array<{ url: string; at: number }> };
}

export const auditImpl: AuditApi = {

    // ============ 审计日志 ============
    // 关键动作留痕（登录成功/失败、改密、重置、删站点、改备份配置）。
    // 写入失败一律吞掉：审计不能反过来把正常操作搞挂。
    writeAudit: async function (this: NavigationAPI, action: string, actor: string, ip: string, detail = ""): Promise<void> {
        try {
            await this.db
                .prepare(
                    "INSERT INTO audit_log (action, actor, ip, detail) VALUES (?, ?, ?, ?)"
                )
                .bind(action, actor || "", ip || "", detail || "")
                .run();
        } catch (error) {
            logger.error("写入审计日志失败:", { err: error, component: "audit" })
        }
    },

    /** 读取审计日志（owner 只读视图）。按时间倒序，支持分页与按操作者过滤。 */
    getAuditLog: async function (this: NavigationAPI, opts: { limit?: number; offset?: number; actor?: string } = {}): Promise<
        Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>
    > {
        await this.migrate();
        // 每次打开都先清一遍：定时任务每周才跑一次，光靠它的话过期条目最长能多挂好几天
        await this.purgeExpiredAudit(await this.getRetentionDays());
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
            logger.error("读取审计日志失败:", { err: error, component: "audit" })
            return [];
        }
    },

    /**
     * 前端错误上报的聚合视图。
     *
     * 只取最近一批 client-error（保留期内的量足够看出「哪里在崩」），
     * 逐条解析 detail 里的 JSON 再归并。解析不了的老记录不丢 —— 退化成「整条 detail 当消息」。
     */
    getClientErrors: async function (this: NavigationAPI, limit = 200): Promise<ClientErrorGroup[]> {
        await this.migrate();
        const take = Math.min(Math.max(limit, 1), 500);
        let rows: Array<{ detail: string; created_at: string }>;
        try {
            const result = await this.db
                .prepare(
                    "SELECT detail, created_at FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?"
                )
                .bind("client-error", take)
                .all<{ detail: string; created_at: string }>();
            rows = result.results || [];
        } catch (error) {
            logger.error("读取前端错误上报失败:", { err: error, component: "audit" })
            return [];
        }

        // 3.3 同源化（2026-10-22）：归并规则搬到 utils/clientErrorGroups，与 mock 侧共用。
        // 原先两份实现不只是重复 —— mock 那份压根没收集 paths，本地看着「正常」而已。
        return groupClientErrors(rows);
    },

    /** 清掉超过保留期的审计日志，返回清掉的行数 */
    purgeExpiredAudit: async function (this: NavigationAPI, days: number): Promise<number> {
        try {
            // days 已经夹过上下界，是纯整数，拼进 SQL 安全
            const r = await this.db
                .prepare(
                    `DELETE FROM audit_log WHERE created_at < datetime('now', '-${days} days')`
                )
                .run();
            return Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            logger.error("清理审计日志失败:", { err: error, component: "audit" })
            return 0;
        }
    },

    /**
     * 运维统计看板聚合。分四块，每块独立容错——一块挂了不影响其余三块
     * （看板是观测工具，宁可少一块也不能整页 500）。
     *
     * ⚠️ JOIN 里计数浏览 Top 时 user_id 必须限表名（n.user_id / g.user_id）：
     * note_share / group_share 同样有 user_id 列，裸写 user_id 在登录态直接
     * ambiguous column 500（FTS 那次的老坑）。所以这两条查询不走 scopeSql，
     * 按当前账号手工拼限定名条件。
     */
    getOpsStats: async function (this: NavigationAPI): Promise<OpsStats> {
        await this.migrate();
        const stats: OpsStats = {
            counts: { sites: 0, groups: 0, notes: 0, attachments: 0, attachmentBytes: 0 },
            auditDaily: [],
            auditTopActions: [],
            shareTop: [],
            health: { total: 0, deadCount: 0, deadLatest: [] },
        };

        // —— 内容计数：单表查询，scopeSql（uid 为 null 时无条件，单账号部署）——
        try {
            const one = async (sql: string): Promise<number> => {
                const stmt = this.db.prepare(sql);
                const row =
                    this.currentUserId === null
                        ? await stmt.first<{ n: number }>()
                        : await stmt.bind(this.currentUserId).first<{ n: number }>();
                return Number(row?.n ?? 0);
            };
            stats.counts.sites = await one(`SELECT COUNT(*) AS n FROM sites${this.scopeSql(false)}`);
            stats.counts.groups = await one(`SELECT COUNT(*) AS n FROM groups${this.scopeSql(false)}`);
            stats.counts.notes = await one(`SELECT COUNT(*) AS n FROM notes${this.scopeSql(false)}`);
            const attStmt = this.db.prepare(
                `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM attachments${this.scopeSql(false)}`
            );
            const att =
                this.currentUserId === null
                    ? await attStmt.first<{ n: number; bytes: number }>()
                    : await attStmt.bind(this.currentUserId).first<{ n: number; bytes: number }>();
            stats.counts.attachments = Number(att?.n ?? 0);
            stats.counts.attachmentBytes = Number(att?.bytes ?? 0);
        } catch (error) {
            logger.error("统计内容计数失败:", { err: error, component: "audit" })
        }

        // —— 近 30 天审计活跃 + Top 动作（audit_log 全站共用，不按账号拆）——
        try {
            const daily = await this.db
                .prepare(
                    "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM audit_log WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day"
                )
                .all<{ day: string; count: number }>();
            const byDay = new Map<string, number>(
                (daily.results || []).map(r => [r.day, Number(r.count)])
            );
            const out: Array<{ day: string; count: number }> = [];
            const now = new Date();
            for (let i = 29; i >= 0; i--) {
                const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
                const day = d.toISOString().slice(0, 10);
                out.push({ day, count: byDay.get(day) ?? 0 });
            }
            stats.auditDaily = out;

            const top = await this.db
                .prepare(
                    "SELECT action, COUNT(*) AS count FROM audit_log WHERE created_at >= datetime('now', '-30 days') GROUP BY action ORDER BY count DESC, action LIMIT 8"
                )
                .all<{ action: string; count: number }>();
            stats.auditTopActions = (top.results || []).map(r => ({
                action: r.action,
                count: Number(r.count),
            }));
        } catch (error) {
            logger.error("统计审计活跃失败:", { err: error, component: "audit" })
        }

        // —— 分享浏览 Top：两条 JOIN 各取 8，合并后重排再截 8 ——
        try {
            const uid = this.currentUserId;
            const noteRows =
                uid === null
                    ? await this.db
                          .prepare(
                              "SELECT n.title AS title, s.views AS views FROM note_share s JOIN notes n ON n.id = s.note_id WHERE s.views > 0 ORDER BY s.views DESC LIMIT 8"
                          )
                          .all<{ title: string; views: number }>()
                    : await this.db
                          .prepare(
                              "SELECT n.title AS title, s.views AS views FROM note_share s JOIN notes n ON n.id = s.note_id WHERE s.views > 0 AND n.user_id = ? ORDER BY s.views DESC LIMIT 8"
                          )
                          .bind(uid)
                          .all<{ title: string; views: number }>();
            const groupRows =
                uid === null
                    ? await this.db
                          .prepare(
                              "SELECT g.name AS title, s.views AS views FROM group_share s JOIN groups g ON g.id = s.group_id WHERE s.views > 0 ORDER BY s.views DESC LIMIT 8"
                          )
                          .all<{ title: string; views: number }>()
                    : await this.db
                          .prepare(
                              "SELECT g.name AS title, s.views AS views FROM group_share s JOIN groups g ON g.id = s.group_id WHERE s.views > 0 AND g.user_id = ? ORDER BY s.views DESC LIMIT 8"
                          )
                          .bind(uid)
                          .all<{ title: string; views: number }>();
            stats.shareTop = [
                ...(noteRows.results || []).map(r => ({ kind: "note" as const, title: r.title || "（无标题）", views: Number(r.views) })),
                ...(groupRows.results || []).map(r => ({ kind: "group" as const, title: r.title || "（未命名分组）", views: Number(r.views) })),
            ]
                .sort((a, b) => b.views - a.views)
                .slice(0, 8);
        } catch (error) {
            logger.error("统计分享浏览失败:", { err: error, component: "audit" })
        }

        // —— 链接健康：user_configs 里的 link.health 快照（开启同步才有）——
        try {
            const uid = this.currentUserId;
            if (uid !== null) {
                const raw = await this.getUserConfig(uid, "link.health");
                if (raw) {
                    const snap = JSON.parse(raw) as {
                        dead?: Record<string, number>;
                        probe?: Record<string, number>;
                        white?: string[];
                        suspect?: Record<string, number>;
                    };
                    // ⚠️ 必须走与前端卡片**同一套**推导（deriveDeadLinks）：
                    // 光数 dead 表的行数会把「之后又探测成功」和「用户标过可访问」的
                    // 链接也算成失效，看板上的数字就和卡片上的标记对不上。
                    const dead = deriveDeadLinks(snap.dead ?? {}, snap.probe ?? {}, snap.white ?? []);
                    const deadLatest = Object.entries(dead)
                        .map(([url, at]) => ({ url, at: Number(at) }))
                        .sort((a, b) => b.at - a.at)
                        .slice(0, 20);
                    stats.health = {
                        deadCount: Object.keys(dead).length,
                        total:
                            Object.keys(dead).length +
                            Object.keys(snap.probe ?? {}).length +
                            (snap.white?.length ?? 0),
                        deadLatest,
                    };
                }
            }
        } catch (error) {
            logger.error("读取链接健康快照失败:", { err: error, component: "audit" })
        }

        return stats;
    },
};
