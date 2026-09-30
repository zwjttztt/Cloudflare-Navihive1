// src/API/methods/audit.ts
// NavigationAPI 的「audit」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";

export interface AuditApi {
    writeAudit(action: string, actor: string, ip: string, detail?: string): Promise<void>;
    getAuditLog(opts?: { limit?: number; offset?: number; actor?: string }): Promise<
        Array<{ id: number; action: string; actor: string; ip: string; detail: string; created_at: string }>
    >;
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
