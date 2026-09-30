// src/API/methods/audit.ts
// NavigationAPI 的「audit」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";

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
            console.error("写入审计日志失败:", error);
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
            console.error("读取审计日志失败:", error);
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
        let rows: Array<{ detail: string; created_at: string }> = [];
        try {
            const result = await this.db
                .prepare(
                    "SELECT detail, created_at FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?"
                )
                .bind("client-error", take)
                .all<{ detail: string; created_at: string }>();
            rows = result.results || [];
        } catch (error) {
            console.error("读取前端错误上报失败:", error);
            return [];
        }

        const groups = new Map<string, ClientErrorGroup>();
        for (const row of rows) {
            let parsed: { source?: unknown; message?: unknown; path?: unknown } = {};
            try {
                parsed = JSON.parse(row.detail || "{}") as typeof parsed;
            } catch {
                // 老记录 / 手写记录可能不是 JSON：整条当消息，至少还能看见
                parsed = { message: (row.detail || "").slice(0, 200) };
            }
            const source =
                typeof parsed.source === "string" && parsed.source ? parsed.source : "unknown";
            const message =
                typeof parsed.message === "string" && parsed.message
                    ? parsed.message
                    : (row.detail || "（无错误信息）").slice(0, 200);
            const key = `${source}|${message.slice(0, 120)}`;

            const existing = groups.get(key);
            if (existing) {
                existing.count += 1;
                if (row.created_at > existing.lastAt) existing.lastAt = row.created_at;
                if (typeof parsed.path === "string" && parsed.path) {
                    if (!existing.paths.includes(parsed.path) && existing.paths.length < 3) {
                        existing.paths.push(parsed.path);
                    }
                }
                continue;
            }
            groups.set(key, {
                key,
                source,
                message,
                count: 1,
                lastAt: row.created_at || "",
                paths: typeof parsed.path === "string" && parsed.path ? [parsed.path] : [],
            });
        }

        // 出现最多的排前面，同样多的最近发生的排前面
        return [...groups.values()].sort(
            (a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)
        );
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
            console.error("清理审计日志失败:", error);
            return 0;
        }
    },
};
