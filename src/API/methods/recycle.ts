// src/API/methods/recycle.ts
// NavigationAPI 的「recycle」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { RETENTION_DAYS, RETENTION_DAYS_KEY, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from "../configKeys";
import { D1PreparedStatement } from "../schema";
import { RecycleBatchRestoreResult, Site } from "../types";
import { GROUP_RESTORE_COLUMNS, SITE_RESTORE_COLUMNS } from "./internals";

export interface RecycleApi {
    pushToRecycle(kind: string, data: string): Promise<number | undefined>;
    listRecycleBin(): Promise<
        Array<{ id: number; kind: "site" | "group"; name: string; deletedAt: number }>
    >;
    restoreRecycleItem(id: number): Promise<boolean>;
    restoreRecycleItems(ids: number[]): Promise<RecycleBatchRestoreResult>;
    purgeRecycleItems(ids: number[]): Promise<{ purged: number[] }>;
    purgeRecycleItem(id: number): Promise<boolean>;
    emptyRecycleBin(): Promise<boolean>;
    tableColumns(table: string): Promise<Set<string> | null>;
    reinsertRow(
        table: "sites" | "groups",
        row: Record<string, unknown>,
        fallbackColumns: string[]
    ): Promise<void>;
    buildReinsert(
        table: "sites" | "groups",
        row: Record<string, unknown>,
        fallbackColumns: string[]
    ): Promise<D1PreparedStatement | null>;
    reinsertSite(site: Record<string, unknown>): Promise<void>;
    reinsertSitesBatch(rows: Record<string, unknown>[]): Promise<void>;
    recycleRowToSite(row: Record<string, unknown>): Site;
    reinsertGroup(group: Record<string, unknown>, sites: Record<string, unknown>[]): Promise<void>;
    getRetentionDays(): Promise<number>;
    purgeExpiredRecycle(
        days: number, nowSec?: number): Promise<number>;
    cleanupExpiredRows(): Promise<{
        audit: number;
        recycle: number;
        blacklist: number;
        invites: number;
        recoveryJti: number;
        sessions: number;
    }>;
    deleteExpiredRecoveryMarks(nowSec: number): Promise<number>;
    deleteRowsByIds(
        table: "groups" | "sites",
        ids: readonly number[]
    ): Promise<void>;
}

export const recycleImpl: RecycleApi = {

    /** 把一条记录塞进回收站，返回新插入的行 id（失败返回 undefined） */
    pushToRecycle: async function (this: NavigationAPI, kind: string, data: string): Promise<number | undefined> {
        const result = await this.db
            .prepare(
                `INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)`
            )
            .bind(kind, this.currentUserId, data, Math.floor(Date.now() / 1000))
            .run();
        const meta = result.meta as { last_row_id?: number } | undefined;
        return typeof meta?.last_row_id === "number" ? meta.last_row_id : undefined;
    },

    // ============ 回收站（软删除的兜底恢复） ============
    /** 当前账号在回收站里的条目（owner 看到自己删的；普通账号只看自己的） */
    listRecycleBin: async function (this: NavigationAPI ): Promise<
        Array<{ id: number; kind: "site" | "group"; name: string; deletedAt: number }>
    > {
        await this.migrate();
        // 过期的先清掉再列：定时任务每周才跑一次，光靠它的话「到期自动删除」并不真的成立
        await this.purgeExpiredRecycle(await this.getRetentionDays());
        try {
            const result = await this.db
                .prepare(
                    `SELECT id, kind, data, deleted_at FROM recycle_bin WHERE owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"} ORDER BY id DESC`
                )
                .bind(...(this.currentUserId === null ? [] : [this.currentUserId]))
                .all<{ id: number; kind: string; data: string; deleted_at: number }>();
            return (result.results || []).map(r => {
                let name: string;
                try {
                    const parsed = JSON.parse(r.data) as { group?: { name?: string }; sites?: unknown[]; name?: string };
                    name =
                        typeof parsed.name === "string"
                            ? parsed.name
                            : typeof parsed.group?.name === "string"
                              ? parsed.group.name
                              : r.kind === "group"
                                ? "分组"
                                : "站点";
                    if (r.kind === "group" && Array.isArray(parsed.sites)) {
                        name += `（含 ${parsed.sites.length} 张卡片）`;
                    }
                } catch {
                    name = r.kind === "group" ? "分组" : "站点";
                }
                return { id: r.id, kind: r.kind === "group" ? "group" : "site", name, deletedAt: r.deleted_at };
            });
        } catch (error) {
            console.error("读取回收站失败:", error);
            return [];
        }
    },

    /** 从回收站还原一条（按原始 id 重新插入，含其站点）。返回是否成功。 */
    restoreRecycleItem: async function (this: NavigationAPI, id: number): Promise<boolean> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT kind, data FROM recycle_bin WHERE id = ? AND owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`)
                .bind(...(this.currentUserId === null ? [id] : [id, this.currentUserId]))
                .first<{ kind: string; data: string }>();
            if (!row) return false;
            let parsed: unknown;
            try {
                parsed = JSON.parse(row.data);
            } catch {
                return false;
            }
            if (row.kind === "site") {
                await this.reinsertSite(parsed as Record<string, unknown>);
            } else {
                const g = parsed as { group?: Record<string, unknown>; sites?: Record<string, unknown>[] };
                await this.reinsertGroup(g.group || {}, g.sites || []);
            }
            await this.db.prepare(`DELETE FROM recycle_bin WHERE id = ?`).bind(id).run();
            return true;
        });
    },

    /**
     * 批量从回收站还原：一次请求替代「前端逐条 POST」。
     *
     * 关键不只是少几次往返 —— 它还把还原出来的站点**直接返回**给前端，
     * 前端照单插回界面即可，不用再来一次 bootstrap 全量重拉（撤销慢主要就慢在这步：
     * 全量重拉要把所有分组、站点、配置重新拉一遍再整体重建界面）。
     */
    restoreRecycleItems: async function (this: NavigationAPI, ids: number[]): Promise<RecycleBatchRestoreResult> {
        await this.migrate();
        const unique = [...new Set(ids.filter(id => Number.isInteger(id)))];
        if (unique.length === 0) return { restored: [], failed: [] };

        return this.withSchemaRetry(async () => {
            const inList = unique.map(() => "?").join(", ");
            const ownerIsNull = this.currentUserId === null;
            const rows = await this.db
                .prepare(
                    `SELECT id, kind, data FROM recycle_bin WHERE id IN (${inList}) AND owner_user_id ${ownerIsNull ? "IS NULL" : "= ?"}`
                )
                .bind(...(ownerIsNull ? unique : [...unique, this.currentUserId]))
                .all<{ id: number; kind: string; data: string }>();

            const siteRows: Record<string, unknown>[] = [];
            const restored: Site[] = [];
            const doneIds: number[] = [];
            const hit = new Set<number>();

            for (const row of rows.results || []) {
                const rid = Number(row.id);
                if (!Number.isFinite(rid)) continue;
                hit.add(rid);
                // 分组条目不走这条批量路（要连分组带卡片一起还原），留给单条接口
                if (row.kind !== "site") continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(row.data);
                } catch {
                    continue;
                }
                if (!parsed || typeof parsed !== "object") continue;
                const record = parsed as Record<string, unknown>;
                siteRows.push(record);
                doneIds.push(rid);
                restored.push(this.recycleRowToSite(record));
            }

            await this.reinsertSitesBatch(siteRows);
            if (doneIds.length > 0) {
                const delList = doneIds.map(() => "?").join(", ");
                await this.db
                    .prepare(`DELETE FROM recycle_bin WHERE id IN (${delList})`)
                    .bind(...doneIds)
                    .run();
            }

            const failed: number[] = [];
            for (const id of unique) {
                if (!hit.has(id)) failed.push(id);
            }

            // 回收站里存的是原始行，密码还是密文，解密后再给前端（否则界面上是一串 enc$）
            return { restored: await this.decryptSitePasswords(restored), failed };
        });
    },

    /**
     * 批量永久删除回收站记录（撤销后又删一次时用），一次 `DELETE ... IN` 搞定。
     * 返回真正删掉的 id；DELETE 是单条语句，成败一致，所以不逐个区分。
     */
    purgeRecycleItems: async function (this: NavigationAPI, ids: number[]): Promise<{ purged: number[] }> {
        await this.migrate();
        const unique = [...new Set(ids.filter(id => Number.isInteger(id)))];
        if (unique.length === 0) return { purged: [] };
        const inList = unique.map(() => "?").join(", ");
        const ownerIsNull = this.currentUserId === null;
        const result = await this.db
            .prepare(
                `DELETE FROM recycle_bin WHERE id IN (${inList}) AND owner_user_id ${ownerIsNull ? "IS NULL" : "= ?"}`
            )
            .bind(...(ownerIsNull ? unique : [...unique, this.currentUserId]))
            .run();
        return { purged: result.success ? unique : [] };
    },

    /** 永久删除一条回收站记录（数据不可恢复） */
    purgeRecycleItem: async function (this: NavigationAPI, id: number): Promise<boolean> {
        await this.migrate();
        const result = await this.db
            .prepare(
                `DELETE FROM recycle_bin WHERE id = ? AND owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`
            )
            .bind(...(this.currentUserId === null ? [id] : [id, this.currentUserId]))
            .run();
        return result.success;
    },

    /** 清空当前账号的回收站 */
    emptyRecycleBin: async function (this: NavigationAPI ): Promise<boolean> {
        await this.migrate();
        const result = await this.db
            .prepare(
                `DELETE FROM recycle_bin WHERE owner_user_id ${this.currentUserId === null ? "IS NULL" : "= ?"}`
            )
            .bind(...(this.currentUserId === null ? [] : [this.currentUserId]))
            .run();
        return result.success;
    },

    /** 表的真实列集合；读不到（表不存在 / pragma 不支持）返回 null */
    tableColumns: async function (this: NavigationAPI, table: string): Promise<Set<string> | null> {
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info(?)")
                .bind(table)
                .all<{ name: string }>();
            const names = (result.results || []).map(row => row.name);
            return names.length > 0 ? new Set(names) : null;
        } catch {
            return null;
        }
    },

    /**
     * 把一条原始行按原 id 插回（密码仍是原密文，不解密）。
     *
     * 用原始行自带的列，而不是写死的字段清单：站点/分组是按 user_id 做账号隔离的，
     * 清单漏掉 user_id 会让还原出来的行 user_id 为 NULL，立刻被 scopeSql 的
     * "user_id = ?" 过滤掉 —— 用户看到的就是「点了还原，什么也没发生」。
     */
    reinsertRow: async function (
        this: NavigationAPI,
        table: "sites" | "groups",
        row: Record<string, unknown>,
        fallbackColumns: string[]
    ): Promise<void> {
        const statement = await this.buildReinsert(table, row, fallbackColumns);
        if (statement) await statement.run();
    },

    /**
     * 组装「把原始行插回表」的语句（只组装不执行，方便批量提交）。
     * 组装不出任何列时返回 null（表里没这些列，插了也没意义）。
     */
    buildReinsert: async function (
        this: NavigationAPI,
        table: "sites" | "groups",
        row: Record<string, unknown>,
        fallbackColumns: string[]
    ): Promise<D1PreparedStatement | null> {
        const known = await this.tableColumns(table);
        let data = row;

        // 归属兜底：多账号上线之前删的条目里没有 user_id，还原时归给当前账号
        // （否则插回去是 NULL，照样看不见）。鉴权关闭时 currentUserId 为 null，保持原样。
        if (!known || known.has("user_id")) {
            if (data.user_id === undefined || data.user_id === null) {
                data = { ...data, user_id: this.currentUserId };
            }
        }

        let cols = Object.keys(data).filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
        cols = known ? cols.filter(c => known.has(c)) : cols.filter(c => fallbackColumns.includes(c));
        if (cols.length === 0) return null;

        const placeholders = cols.map(() => "?").join(", ");
        const vals = cols.map(c => (data[c] === undefined ? null : data[c]));
        return this.db
            .prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`)
            .bind(...vals);
    },
    reinsertSite: async function (this: NavigationAPI, site: Record<string, unknown>): Promise<void> {
        await this.reinsertRow("sites", site, SITE_RESTORE_COLUMNS);
    },

    /**
     * 批量插回站点：组装成一批 prepared statement 后一次 batch 提交，
     * 还原 20 张卡只花一次 D1 往返（逐条 run 就是 20 次）。
     */
    reinsertSitesBatch: async function (this: NavigationAPI, rows: Record<string, unknown>[]): Promise<void> {
        if (rows.length === 0) return;
        const built = await Promise.all(
            rows.map(row => this.buildReinsert("sites", row, SITE_RESTORE_COLUMNS))
        );
        const statements = built.filter((s): s is D1PreparedStatement => s !== null);
        if (statements.length === 0) return;
        await this.db.batch(statements);
    },

    /** 把回收站里的原始行（DB 列名）转成前端的 Site 形状，交给界面直接渲染 */
    recycleRowToSite: function (this: NavigationAPI, row: Record<string, unknown>): Site {
        const asNumber = (value: unknown, fallback = 0): number => {
            if (typeof value === "number" && Number.isFinite(value)) return value;
            if (typeof value === "string" && value.trim() !== "") {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) return parsed;
            }
            return fallback;
        };
        const asText = (value: unknown): string =>
            typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
        const asOptional = (value: unknown): string | undefined =>
            value === null || value === undefined || value === "" ? undefined : asText(value);

        return {
            id: asNumber(row.id, 0) || undefined,
            group_id: asNumber(row.group_id),
            name: asText(row.name),
            url: asText(row.url),
            icon: asText(row.icon),
            description: asText(row.description),
            notes: asText(row.notes),
            username: asOptional(row.username),
            password: asOptional(row.password),
            order_num: asNumber(row.order_num),
            created_at: asOptional(row.created_at),
            updated_at: asOptional(row.updated_at),
        };
    },

    /** 把分组原始行按原 id 插回，再插回其站点（站点 group_id 指向原分组 id） */
    reinsertGroup: async function (this: NavigationAPI, group: Record<string, unknown>, sites: Record<string, unknown>[]): Promise<void> {
        await this.reinsertRow("groups", group, GROUP_RESTORE_COLUMNS);
        for (const site of sites) {
            await this.reinsertSite(site);
        }
    },

    /** 保留期（天）：配置里没有就用默认 7 天，越界的一律夹回上下界 */
    getRetentionDays: async function (this: NavigationAPI ): Promise<number> {
        const raw = parseInt((await this.getConfig(RETENTION_DAYS_KEY)) || "", 10);
        if (!Number.isFinite(raw)) return RETENTION_DAYS;
        return Math.min(Math.max(raw, RETENTION_DAYS_MIN), RETENTION_DAYS_MAX);
    },

    /** 清掉超过保留期的回收站条目，返回清掉的行数（deleted_at 是 epoch 秒） */
    purgeExpiredRecycle: async function (
        this: NavigationAPI,
        days: number,
        nowSec = Math.floor(Date.now() / 1000)
    ): Promise<number> {
        try {
            const r = await this.db
                .prepare("DELETE FROM recycle_bin WHERE deleted_at < ?")
                .bind(nowSec - days * 24 * 3600)
                .run();
            return Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理回收站失败:", error);
            return 0;
        }
    },

    /**
     * 过期数据清理（每周定时任务调用）。
     *
     * 有五类东西只增不减，放久了会把 D1 撑成随时间线性增长的负担：
     *   - audit_log：登录、改密、删站点…每条一行；
     *   - recycle_bin：删错的站点 / 分组，过了后悔期就没用了；
     *   - token_blacklist：登出过期的令牌（过期后校验已不会再查它）；
     *   - auth.recoveryJti.*：恢复令牌用过后留的防重放标记（configs 里一行一个 key）；
     *   - invites：过期 / 已用掉的邀请码；
     *   - user_sessions：登录设备记录，令牌过期后这行就只剩占地方。
     * 审计日志与回收站统一按保留期（默认 7 天，站点所有者可改）保留，
     * 邀请码也留同样久便于排查。
     */
    cleanupExpiredRows: async function (this: NavigationAPI ): Promise<{
        audit: number;
        recycle: number;
        blacklist: number;
        invites: number;
        recoveryJti: number;
        sessions: number;
    }> {
        const counts = { audit: 0, recycle: 0, blacklist: 0, invites: 0, recoveryJti: 0, sessions: 0 };
        const nowSec = Math.floor(Date.now() / 1000);
        const days = await this.getRetentionDays();

        counts.audit = await this.purgeExpiredAudit(days);
        counts.recycle = await this.purgeExpiredRecycle(days, nowSec);

        try {
            const r = await this.db
                .prepare("DELETE FROM token_blacklist WHERE exp < ?")
                .bind(nowSec)
                .run();
            counts.blacklist = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理令牌黑名单失败:", error);
        }

        // 登录会话：令牌过期后这行就没用了（验签必挂），留着只会让设备列表越堆越长
        try {
            const r = await this.db
                .prepare("DELETE FROM user_sessions WHERE expires_at < ?")
                .bind(nowSec)
                .run();
            counts.sessions = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理登录会话失败:", error);
        }

        try {
            const r = await this.db
                .prepare(
                    "DELETE FROM invites WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)"
                )
                .bind(nowSec - days * 24 * 3600, nowSec - days * 24 * 3600)
                .run();
            counts.invites = Number((r.meta as { changes?: number } | undefined)?.changes ?? 0);
        } catch (error) {
            console.error("清理邀请码失败:", error);
        }

        // 恢复令牌的 jti 标记是 configs 里一行一个 key，只能按前缀挑出来逐个删
        counts.recoveryJti = await this.deleteExpiredRecoveryMarks(nowSec);

        return counts;
    },
    deleteExpiredRecoveryMarks: async function (this: NavigationAPI, nowSec: number): Promise<number> {
        try {
            const rows = await this.db
                .prepare("SELECT key, value FROM configs WHERE key LIKE 'auth.recoveryJti.%'")
                .all<{ key: string; value: string }>();
            let removed = 0;
            for (const row of rows.results || []) {
                // value 存的就是令牌自带的 exp（秒）：过期后即使重放也通不过验证，标记可以丢掉
                const exp = Number(row.value);
                if (!Number.isFinite(exp) || exp < nowSec) {
                    await this.deleteConfig(row.key);
                    removed++;
                }
            }
            return removed;
        } catch (error) {
            console.error("清理恢复令牌标记失败:", error);
            return 0;
        }
    },

    /** 按 id 批量删行。D1 单条语句的绑定参数有上限，分片删，避免大站一次删不完 */
    deleteRowsByIds: async function (
        this: NavigationAPI,
        table: "groups" | "sites",
        ids: readonly number[]
    ): Promise<void> {
        if (ids.length === 0) return;
        const CHUNK = 100;
        for (let offset = 0; offset < ids.length; offset += CHUNK) {
            const chunk = ids.slice(offset, offset + CHUNK);
            const placeholders = chunk.map(() => "?").join(",");
            await this.db
                .prepare(`DELETE FROM ${table} WHERE id IN (${placeholders})`)
                .bind(...chunk)
                .run();
        }
    },
};
