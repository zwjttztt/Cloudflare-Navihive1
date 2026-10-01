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

export interface DataApi {
    getGroups(): Promise<Group[]>;
    queryGroups(): Promise<Group[]>;
    getBootstrap(): Promise<BootstrapData>;
    queryBootstrap(): Promise<BootstrapData>;
    getGroup(id: number): Promise<Group | null>;
    createGroup(group: Group): Promise<Group>;
    updateGroup(id: number, group: Partial<Group>): Promise<Group | null>;
    deleteGroup(id: number): Promise<{ success: boolean; recycleId?: number }>;
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
    deleteSites(ids: number[]): Promise<SiteBatchDeleteResult>;
    deleteSite(id: number): Promise<{ success: boolean; recycleId?: number }>;
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
     * 删除分组：先连同它的站点一起搬进回收站（软删除），再真正删除。
     * 返回 recycleId 供前端「撤销」时精确还原，避免本地重建产生重复副本。
     */
    deleteGroup: async function (this: NavigationAPI, id: number): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const group = await this.db
                .prepare(`SELECT * FROM groups WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!group) return { success: false };
            const sitesResult = await this.db
                .prepare(`SELECT * FROM sites WHERE group_id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .all<Record<string, unknown>>();
            const recycleId = await this.pushToRecycle(
                "group",
                JSON.stringify({ group, sites: sitesResult.results || [] })
            );
            const result = await this.db
                .prepare(`DELETE FROM groups WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success, recycleId: result.success ? recycleId : undefined };
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
     * 多选删 20 张卡，原来是 20 次 HTTP 往返 × 每次 3 条 SQL（读行 / 写回收站 / 删行），
     * 点下去要等十几秒。现在一次往返：1 次 SELECT 取回全部原始行 → 并发写回收站 →
     * 1 条 `DELETE ... IN` 删真身。
     */
    deleteSites: async function (this: NavigationAPI, ids: number[]): Promise<SiteBatchDeleteResult> {
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
            const pending: Promise<{ id: number; recycleId?: number }>[] = [];
            for (const id of unique) {
                const row = found.get(id);
                if (!row) {
                    failed.push(id);
                    continue;
                }
                pending.push(
                    this.pushToRecycle("site", JSON.stringify(row)).then(recycleId => ({
                        id,
                        recycleId,
                    }))
                );
            }
            const items = await Promise.all(pending);

            // 只有真的进了回收站的才删真身：写回收站失败就当成「没删」，
            // 免得多选删除把卡片变成硬删除（回收站里没有，找不回来）
            const okIds = items.filter(item => item.recycleId !== undefined).map(item => item.id);
            if (okIds.length > 0) {
                const delList = okIds.map(() => "?").join(", ");
                await this.db
                    .prepare(`DELETE FROM sites WHERE id IN (${delList})${this.scopeSql(true)}`)
                    .bind(...this.scopeParams(okIds))
                    .run();
            }

            return {
                items,
                failed: [...failed, ...items.filter(item => item.recycleId === undefined).map(i => i.id)],
            };
        });
    },

    /**
     * 删除站点：先搬进回收站（软删除，原样保留含密文密码的原始行），再真正删除。
     * 返回 recycleId 供前端「撤销」精确还原。
     */
    deleteSite: async function (this: NavigationAPI, id: number): Promise<{ success: boolean; recycleId?: number }> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const row = await this.db
                .prepare(`SELECT * FROM sites WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .first<Record<string, unknown>>();
            if (!row) return { success: false };
            const recycleId = await this.pushToRecycle("site", JSON.stringify(row));
            const result = await this.db
                .prepare(`DELETE FROM sites WHERE id = ?${this.scopeSql(true)}`)
                .bind(...this.scopeParams([id]))
                .run();
            return { success: result.success, recycleId: result.success ? recycleId : undefined };
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
