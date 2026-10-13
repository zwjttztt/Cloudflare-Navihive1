// src/API/methods/data.ts
// NavigationAPI 的「data」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { isAuthConfigKey, isEncryptedConfigKey, isPrivateUserConfigKey } from "../configGuards";
import { decryptSecretDeep, encryptSecret } from "../crypto";
import { BootstrapData, Config, Group, Site, SiteBatchDeleteResult, SiteOrderUpdateResult } from "../types";
import type { D1PreparedStatement } from "../schema";

/** 随删除事务一起落库的审计条目（不传就不写审计） */
export interface AuditEntry {
    action: string;
    actor: string;
    ip: string;
    detail?: string;
}

/** 审计与删除语句进同一个 batch：少一次串行往返，且「删了」与「记了」同生同死 */
export function auditStatement(api: NavigationAPI, audit?: AuditEntry): D1PreparedStatement | null {
    if (!audit) return null;
    return api.db
        .prepare("INSERT INTO audit_log (action, actor, ip, detail) VALUES (?, ?, ?, ?)")
        .bind(audit.action, audit.actor || "", audit.ip || "", audit.detail || "");
}

/**
 * 墓碑时间戳：**必须带毫秒**。
 * CURRENT_TIMESTAMP 只到秒，同一秒里连删两张卡时游标分不出先后 ——
 * 表现为「第二次删除的墓碑被上一次的游标挡住」。
 */
function tombstoneStamp(): string {
    return new Date().toISOString().replace("T", " ").replace("Z", "");
}

/** 从 batch 结果里取回收站行 id（拿不到就 undefined，调用方当「没进站」处理） */
function recycleIdOf(result: { meta?: unknown } | undefined): number | undefined {
    const meta = result?.meta as { last_row_id?: number } | undefined;
    return typeof meta?.last_row_id === "number" ? meta.last_row_id : undefined;
}

export interface DataApi {
    getGroups(): Promise<Group[]>;
    queryGroups(): Promise<Group[]>;
    getBootstrap(): Promise<BootstrapData>;
    queryBootstrap(): Promise<BootstrapData>;
    getGroup(id: number): Promise<Group | null>;
    createGroup(group: Group): Promise<Group>;
    updateGroup(id: number, group: Partial<Group>): Promise<Group | null>;
    deleteGroup(id: number, audit?: AuditEntry): Promise<{ success: boolean; recycleId?: number }>;
    getSites(groupId?: number): Promise<Site[]>;
    decryptSitePassword(site: Site): Promise<Site>;
    decryptSitePasswords(sites: Site[]): Promise<Site[]>;
    querySites(groupId?: number): Promise<Site[]>;
    getSite(id: number): Promise<Site | null>;
    querySite(id: number): Promise<Site | null>;
    createSite(site: Site): Promise<Site>;
    insertSite(site: Site): Promise<Site>;
    updateSite(id: number, site: Partial<Site>): Promise<Site | null>;
    updateSiteRow(id: number, site: Partial<Site>): Promise<Site | null>;
    deleteSites(ids: number[], audit?: AuditEntry): Promise<SiteBatchDeleteResult>;
    deleteSite(id: number, audit?: AuditEntry): Promise<{ success: boolean; recycleId?: number }>;
    /** 卡片侧增量同步：自 since 以来被删除的站点 id（跨设备轮询用） */
    siteChanges(since?: string): Promise<{ deleted: number[]; since: string }>;
    updateGroupOrder(groupOrders: { id: number; order_num: number }[]): Promise<boolean>;
    updateSiteOrder(
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<SiteOrderUpdateResult>;
}

export const dataImpl: DataApi = {

    // 分组相关 API
    getGroups: async function (this: NavigationAPI ): Promise<Group[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryGroups());
    },
    queryGroups: async function (this: NavigationAPI ): Promise<Group[]> {
        // 多账号：只看自己的分组（系统级调用不带上用户上下文，照旧看全量）
        const result = await this.db
            .prepare(
                `SELECT id, name, order_num, created_at, updated_at FROM groups${this.scopeSql(
                    false
                )} ORDER BY order_num`
            )
            .bind(...this.scopeParams([]))
            .all<Group>();
        return result.results || [];
    },

    // 首屏 / 刷新：一次请求取回全部分组、站点与配置。
    // 用 db.batch 把 3 条查询合并为一次 D1 往返，替代原先「1 次分组 + 每个分组一次站点」的 N+1 请求。
    getBootstrap: async function (this: NavigationAPI ): Promise<BootstrapData> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryBootstrap());
    },
    queryBootstrap: async function (this: NavigationAPI ): Promise<BootstrapData> {
        const [groupsResult, sitesResult, configsResult] = await this.db.batch<unknown>([
            this.db
                .prepare(
                    `SELECT id, name, order_num, created_at, updated_at FROM groups${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db
                .prepare(
                    `SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites${this.scopeSql(
                        false
                    )} ORDER BY order_num`
                )
                .bind(...this.scopeParams([])),
            this.db.prepare("SELECT key, value FROM configs"),
        ]);

        const configs: Record<string, string> = {};
        for (const row of (configsResult.results || []) as Config[]) {
            // 管理员凭据不下发到浏览器，避免出现「拿到配置就等于拿到密码」
            if (isAuthConfigKey(row.key)) continue;
            // 严格私有的那批（WebDAV）只认自己那份：全局里有同键（迁移残留）一律不采纳。
            // 外观键（site.*）保留全站那份当底稿，下面再用账号自己的覆盖 ——
            // 自己没改过标题/背景的话，看到的就是站点所有者定的样子。
            if (this.currentUserId !== null && isPrivateUserConfigKey(row.key)) continue;
            // webdav.password / webdav.backupPassword 落库是密文，这里必须和
            // queryConfigs / getConfig 一样解密还原：
            // 否则刷新后前端拿到的是 enc$... 密文，回填进密码框，用户再保存一次就变成
            // 「密文的密文」（测试连接也就永远认证失败，备份也永远解不开）
            configs[row.key] = isEncryptedConfigKey(row.key)
                ? await decryptSecretDeep(row.value, this.keyring)
                : row.value;
        }

        // 覆盖上当前账号自己的那份（WebDAV 备份配置 + 自己的外观）
        if (this.currentUserId !== null) {
            const own = await this.queryUserConfigs(this.currentUserId);
            for (const [key, value] of Object.entries(own)) configs[key] = value;
        }

        return {
            groups: (groupsResult.results || []) as Group[],
            // 站点密码同样是密文落库，首屏必须和 querySites / querySite 一样解密还原：
            // 不解密的话刷新后「复制密码」复制出去的是 enc$...，改站点再保存就变双重加密
            sites: await this.decryptSitePasswords((sitesResult.results || []) as Site[]),
            configs,
        };
    },
    getGroup: async function (this: NavigationAPI, id: number): Promise<Group | null> {
        const result = await this.db
            .prepare(
                `SELECT id, name, order_num, created_at, updated_at FROM groups WHERE id = ?${this.scopeSql(
                    true
                )}`
            )
            .bind(...this.scopeParams([id]))
            .first<Group>();
        return result;
    },
    createGroup: async function (this: NavigationAPI, group: Group): Promise<Group> {
        const result = await this.db
            .prepare(
                "INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id, name, order_num, created_at, updated_at"
            )
            .bind(group.name, group.order_num, this.currentUserId)
            .all<Group>();
        if (!result.results || result.results.length === 0) {
            throw new Error("创建分组失败");
        }
        return result.results[0];
    },
    updateGroup: async function (this: NavigationAPI, id: number, group: Partial<Group>): Promise<Group | null> {
        // 使用参数化查询，避免SQL注入
        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: (string | number)[] = [];

        // 安全地添加字段
        if (group.name !== undefined) {
            updates.push("name = ?");
            params.push(group.name);
        }

        if (group.order_num !== undefined) {
            updates.push("order_num = ?");
            params.push(group.order_num);
        }

        // 构建安全的参数化查询（带上归属账号：改不了别人的分组）
        const query = `UPDATE groups SET ${updates.join(
            ", "
        )} WHERE id = ?${this.scopeSql(
            true
        )} RETURNING id, name, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Group>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        return result.results[0];
    },

    /**
     * 卡片侧的增量变更（跨设备同步用）：自 since 以来被删除的站点 id。
     *
     * 与 notes/changes 同一个理由 —— 删除是物理删行，只看 updated_at 的轮询
     * 永远看不见「少了哪张」，必须靠墓碑。改/增的行本身带 updated_at，
     * 客户端比对整份 bootstrap 就能发现，所以这里只回删除。
     */
    siteChanges: async function (
        this: NavigationAPI,
        since?: string
    ): Promise<{ deleted: number[]; since: string }> {
        await this.migrate();
        const cursor = new Date().toISOString();
        const params: (string | number)[] = [];
        let where = "";
        if (since && Date.parse(since)) {
            // ⚠️ 直接比文本、不走 datetime()：datetime() 会把游标**截断到秒**，
            // 于是同一秒里发生的旧删除也会被当成「之后的变更」重复下发。
            // 存进墓碑的是 'YYYY-MM-DD HH:MM:SS.mmm'，游标归一化成同一个格式再比。
            where = " WHERE deleted_at > ?";
            params.push(since.replace("T", " ").replace("Z", ""));
        }
        try {
            const rows = await this.db
                .prepare(
                    `SELECT site_id FROM site_tombstone${where}${this.scopeSql(where.length > 0)}`
                )
                .bind(...this.scopeParams(params))
                .all<{ site_id: number }>();
            const deleted = (rows.results || [])
                .map(row => row?.site_id)
                .filter((id): id is number => typeof id === "number");
            return { deleted: [...new Set(deleted)], since: cursor };
        } catch (error) {
            // 表不存在（老库还没迁上来）不该让同步端点 500：退化成「没有删除」
            console.error("读取站点删除墓碑失败:", error);
            return { deleted: [], since: cursor };
        }
    },

    /**
     * 删除分组：先连同它的站点一起搬进回收站（软删除），再真正删除。
     * 返回 recycleId 供前端「撤销」时精确还原，避免本地重建产生重复副本。
     *
     * 往返优化：两个 SELECT 互不依赖并行发；回收站写入 + 删除真身 + 审计
     * 合进同一个 db.batch（= 一次往返 + 一个事务），以前是 3~4 次串行往返。
     */
    deleteGroup: async function (
        this: NavigationAPI,
        id: number,
        audit?: AuditEntry
    ): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const [group, sitesResult] = await Promise.all([
                this.db
                    .prepare(`SELECT * FROM groups WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id]))
                    .first<Record<string, unknown>>(),
                this.db
                    .prepare(`SELECT * FROM sites WHERE group_id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id]))
                    .all<Record<string, unknown>>(),
            ]);
            if (!group) return { success: false };
            const statements: D1PreparedStatement[] = [
                this.db
                    .prepare(
                        "INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)"
                    )
                    .bind(
                        "group",
                        this.currentUserId,
                        JSON.stringify({ group, sites: sitesResult.results || [] }),
                        Math.floor(Date.now() / 1000)
                    ),
                this.db
                    .prepare(`DELETE FROM groups WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
            ];
            const auditStmt = auditStatement(this, audit);
            if (auditStmt) statements.push(auditStmt);
            const results = await this.db.batch(statements);
            const recycleId = recycleIdOf(results[0]);
            return { success: true, recycleId };
        });
    },

    // 网站相关 API
    getSites: async function (this: NavigationAPI, groupId?: number): Promise<Site[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySites(groupId));
    },

    /**
     * 站点密码在库里是密文，读出来统一解密还原给调用方。
     * 历史明文（没有 enc$ 前缀）会原样返回，升级过程无感。
     */
    decryptSitePassword: async function (this: NavigationAPI, site: Site): Promise<Site> {
        if (!site || !site.password) return site;
        // 用 Deep 版：已被套成多重加密的历史脏值也能解回明文（首屏拿到密文再保存就会套一层）
        return { ...site, password: await decryptSecretDeep(site.password, this.keyring) };
    },
    decryptSitePasswords: async function (this: NavigationAPI, sites: Site[]): Promise<Site[]> {
        return Promise.all(sites.map(site => this.decryptSitePassword(site)));
    },
    querySites: async function (this: NavigationAPI, groupId?: number): Promise<Site[]> {
        let query =
            "SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites";
        const params: (string | number)[] = [];

        if (groupId !== undefined) {
            query += " WHERE group_id = ?";
            params.push(groupId);
        }

        // 只取属于自己的卡片：否则 A 账号能看到 B 账号的链接与登录凭据
        query += this.scopeSql(groupId !== undefined);

        query += " ORDER BY order_num";

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Site>();
        return this.decryptSitePasswords(result.results || []);
    },
    getSite: async function (this: NavigationAPI, id: number): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySite(id));
    },
    querySite: async function (this: NavigationAPI, id: number): Promise<Site | null> {
        const result = await this.db
            .prepare(
                `SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites WHERE id = ?${this.scopeSql(
                    true
                )}`
            )
            .bind(...this.scopeParams([id]))
            .first<Site>();
        return result ? this.decryptSitePassword(result) : result;
    },
    createSite: async function (this: NavigationAPI, site: Site): Promise<Site> {
        await this.migrate();
        return this.withSchemaRetry(() => this.insertSite(site));
    },
    insertSite: async function (this: NavigationAPI, site: Site): Promise<Site> {
        const result = await this.db
            .prepare(
                `
      INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at
    `
            )
            .bind(
                site.group_id,
                site.name,
                site.url,
                site.icon || "",
                site.description || "",
                site.notes || "",
                site.username || "",
                // 站点登录凭据落库即加密（读出来时解密）
                await encryptSecret(site.password || "", this.keyring),
                site.order_num,
                this.currentUserId
            )
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            throw new Error("创建站点失败");
        }
        // RETURNING 取回的是库里的密文，解密后再返回给前端
        return this.decryptSitePassword(result.results[0]);
    },
    updateSite: async function (this: NavigationAPI, id: number, site: Partial<Site>): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.updateSiteRow(id, site));
    },
    updateSiteRow: async function (this: NavigationAPI, id: number, site: Partial<Site>): Promise<Site | null> {
        // 使用参数化查询，避免SQL注入
        const updates: string[] = ["updated_at = CURRENT_TIMESTAMP"];
        const params: (string | number)[] = [];

        // 安全地添加字段
        if (site.group_id !== undefined) {
            updates.push("group_id = ?");
            params.push(site.group_id);
        }

        if (site.name !== undefined) {
            updates.push("name = ?");
            params.push(site.name);
        }

        if (site.url !== undefined) {
            updates.push("url = ?");
            params.push(site.url);
        }

        if (site.icon !== undefined) {
            updates.push("icon = ?");
            params.push(site.icon);
        }

        if (site.description !== undefined) {
            updates.push("description = ?");
            params.push(site.description);
        }

        if (site.notes !== undefined) {
            updates.push("notes = ?");
            params.push(site.notes);
        }

        if (site.username !== undefined) {
            updates.push("username = ?");
            params.push(site.username);
        }

        if (site.password !== undefined) {
            updates.push("password = ?");
            // 站点登录凭据落库即加密（读出来时解密），D1 导出/备份泄露也解不出明文
            params.push(await encryptSecret(site.password, this.keyring));
        }

        if (site.order_num !== undefined) {
            updates.push("order_num = ?");
            params.push(site.order_num);
        }

        // 构建安全的参数化查询（带上归属账号，避免改到别人的卡片）
        const query = `UPDATE sites SET ${updates.join(
            ", "
        )} WHERE id = ?${this.scopeSql(
            true
        )} RETURNING id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...this.scopeParams(params))
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        // RETURNING 取回的是库里的密文，解密后再返回给前端
        return this.decryptSitePassword(result.results[0]);
    },

    /**
     * 批量删除站点：一次请求搬完，替代「前端 for 循环逐个 DELETE」。
     *
     * 往返优化：回收站写入按 200 条/批 chunk（D1 单次 batch 有语句数上限，
     * 500 张卡的上限下不能一口气塞 500 条 INSERT），全部进站后一个 batch 删真身 + 审计。
     * 以前是 N 条并发 INSERT，中途失败会留下「部分进站部分硬删」的混合态。
     */
    deleteSites: async function (
        this: NavigationAPI,
        ids: number[],
        audit?: AuditEntry
    ): Promise<SiteBatchDeleteResult> {
        await this.migrate();
        const unique = [...new Set(ids.filter(id => Number.isInteger(id)))];
        if (unique.length === 0) return { items: [], failed: [] };

        return this.withSchemaRetry(async () => {
            const inList = unique.map(() => "?").join(", ");
            const rows = await this.db
                .prepare(`SELECT * FROM sites WHERE id IN (${inList})${this.scopeSql(true)}`)
                .bind(...this.scopeParams(unique))
                .all<Record<string, unknown>>();

            const found = new Map<number, Record<string, unknown>>();
            for (const row of rows.results || []) {
                const id = Number(row.id);
                if (Number.isFinite(id)) found.set(id, row);
            }

            const failed: number[] = [];
            const orderedIds: number[] = [];
            const recycleStatements: D1PreparedStatement[] = [];
            for (const id of unique) {
                const row = found.get(id);
                if (!row) {
                    failed.push(id);
                    continue;
                }
                orderedIds.push(id);
                recycleStatements.push(
                    this.db
                        .prepare(
                            "INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)"
                        )
                        .bind("site", this.currentUserId, JSON.stringify(row), Math.floor(Date.now() / 1000))
                );
            }
            if (orderedIds.length === 0) return { items: [], failed };

            // 只有真的进了回收站的才删真身：写回收站失败就当成「没删」，
            // 免得多选删除把卡片变成硬删除（回收站里没有，找不回来）
            const RECYCLE_CHUNK = 200;
            const recycleIds: (number | undefined)[] = new Array(orderedIds.length).fill(undefined);
            for (let i = 0; i < recycleStatements.length; i += RECYCLE_CHUNK) {
                const results = await this.db.batch(recycleStatements.slice(i, i + RECYCLE_CHUNK));
                results.forEach((r, j) => {
                    recycleIds[i + j] = recycleIdOf(r);
                });
            }

            const okIndex = recycleIds
                .map((rid, i) => (rid !== undefined ? i : -1))
                .filter(i => i >= 0);
            if (okIndex.length > 0) {
                const okIds = okIndex.map(i => orderedIds[i]);
                const delList = okIds.map(() => "?").join(", ");
                const tail: D1PreparedStatement[] = [
                    this.db
                        .prepare(`DELETE FROM sites WHERE id IN (${delList})${this.scopeSql(true)}`)
                        .bind(...this.scopeParams(okIds)),
                ];
                // 墓碑：批量删除的每一张都要留一条，其它设备才知道少了哪些
                for (const id of okIds) {
                    tail.push(
                        this.db
                            .prepare(
                                "INSERT INTO site_tombstone (user_id, site_id, deleted_at) VALUES (?, ?, ?)"
                            )
                            .bind(this.currentUserId, id, tombstoneStamp())
                    );
                }
                const auditStmt = auditStatement(this, audit);
                if (auditStmt) tail.push(auditStmt);
                await this.db.batch(tail);
            }

            const items = orderedIds.map((id, i) => ({ id, recycleId: recycleIds[i] }));
            return {
                items,
                failed: [
                    ...failed,
                    ...items.filter(item => item.recycleId === undefined).map(item => item.id),
                ],
            };
        });
    },

    /**
     * 删除站点：先搬进回收站（软删除，原样保留含密文密码的原始行），再真正删除。
     * 返回 recycleId 供前端「撤销」精确还原。
     *
     * 往返优化：回收站写入 + 删除真身 + 审计合进同一个 db.batch（一次往返 + 事务），
     * 以前是 SELECT → INSERT 回收站 → DELETE 三次串行往返。
     */
    deleteSite: async function (
        this: NavigationAPI,
        id: number,
        audit?: AuditEntry
    ): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT * FROM sites WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!row) return { success: false };
            const statements: D1PreparedStatement[] = [
                this.db
                    .prepare(
                        "INSERT INTO recycle_bin (kind, owner_user_id, data, deleted_at) VALUES (?, ?, ?, ?)"
                    )
                    .bind("site", this.currentUserId, JSON.stringify(row), Math.floor(Date.now() / 1000)),
                this.db
                    .prepare(`DELETE FROM sites WHERE id = ?${this.scopeSql(true)}`)
                    .bind(...this.scopeParams([id])),
            ];
            const auditStmt = auditStatement(this, audit);
            if (auditStmt) statements.push(auditStmt);
            // 删除墓碑：让其它设备的 /api/sites/changes 能看见「少了哪张卡」
            statements.push(
                this.db
                    .prepare(
                        "INSERT INTO site_tombstone (user_id, site_id, deleted_at) VALUES (?, ?, ?)"
                    )
                    .bind(this.currentUserId, id, tombstoneStamp())
            );
            const results = await this.db.batch(statements);
            return { success: true, recycleId: recycleIdOf(results[0]) };
        });
    },

    // 批量更新排序
    updateGroupOrder: async function (this: NavigationAPI, groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        if (groupOrders.length === 0) return true;
        // 使用事务确保所有更新一起成功或失败
        return await this.db
            .batch(
                groupOrders.map(item =>
                    this.db
                        .prepare(
                            `UPDATE groups SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${this.scopeSql(
                                true
                            )}`
                        )
                        .bind(...this.scopeParams([item.order_num, item.id]))
                )
            )
            .then(() => true)
            .catch(() => false);
    },

    /**
     * 批量更新站点排序。
     * item 里带 group_id 时同时把卡片移动到新分组 —— 这样「排序 + 跨组移动」
     * 只需要一次请求、一次 D1 batch 就能写完，不必逐张卡片发请求。
     */
    updateSiteOrder: async function (
        this: NavigationAPI,
        siteOrders: { id: number; order_num: number; group_id?: number }[]
    ): Promise<SiteOrderUpdateResult> {
        if (siteOrders.length === 0) {
            return { success: true, updated: [], failed: [] };
        }
        await this.migrate();

        // 跨组移动要先确认「目标分组也是自己的」：
        // 以前只给 sites 加了 user_id 条件，group_id 却任意填 —— 拖拽时能把卡片塞进
        // 别人的分组（那之后它既不在自己能看到的分组里，自己也就找不回来了）。
        // 校验不通过的项只更新排序、不改所属分组。
        const wantedGroupIds = [
            ...new Set(
                siteOrders
                    .map(item => item.group_id)
                    .filter((id): id is number => typeof id === "number")
            ),
        ];
        const allowed = await this.filterOwnedGroupIds(wantedGroupIds);

        const buildStatement = (item: { id: number; order_num: number; group_id?: number }) => {
            const tail = `${this.scopeSql(true)}`;
            const moveTo =
                item.group_id !== undefined && allowed.has(item.group_id)
                    ? item.group_id
                    : undefined;
            return moveTo === undefined
                ? this.db
                      .prepare(
                          `UPDATE sites SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${tail}`
                      )
                      .bind(...this.scopeParams([item.order_num, item.id]))
                : this.db
                      .prepare(
                          `UPDATE sites SET order_num = ?, group_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?${tail}`
                      )
                      .bind(...this.scopeParams([item.order_num, moveTo, item.id]));
        };

        // D1 单次 batch 的语句条数有上限，站点多的时候分批提交，避免整批失败
        const CHUNK_SIZE = 100;

        const updated: number[] = [];
        const failed: number[] = [];

        try {
            for (let i = 0; i < siteOrders.length; i += CHUNK_SIZE) {
                const chunk = siteOrders.slice(i, i + CHUNK_SIZE);
                // 逐条看命中行数：UPDATE 一行都没匹配上（rows_written 为 0）说明这张卡片
                // 不存在或不是自己的 —— 表面上 batch 成功，其实那条压根没写进去
                const results = (await this.db.batch(chunk.map(buildStatement))) as Array<{
                    success?: boolean;
                    meta?: { rows_written?: number };
                }>;

                chunk.forEach((item, index) => {
                    const row = results[index];
                    const written = row?.meta?.rows_written;
                    // 拿不到行数（某些环境 / 假实现）时退一步，只信 success 标志
                    const ok = written === undefined ? row?.success !== false : written > 0;
                    if (ok) updated.push(item.id);
                    else failed.push(item.id);
                });
            }

            if (failed.length > 0) {
                console.warn(`批量更新站点排序：${failed.length} 条未生效（id: ${failed.join(",")}）`);
            }
            return { success: failed.length === 0, updated, failed };
        } catch (error) {
            // 整批挂了：本批和后面还没提交的都算失败，已提交的按已生效的算
            console.error("批量更新站点排序失败:", error);
            const rest = siteOrders.slice(updated.length + failed.length).map(item => item.id);
            return { success: false, updated, failed: [...failed, ...rest] };
        }
    },
};
