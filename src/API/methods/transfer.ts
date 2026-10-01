// src/API/methods/transfer.ts
// NavigationAPI 的「transfer」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import type { D1PreparedStatement } from "../schema";
import { computeBackupIntegrity, verifyBackupIntegrity } from "../../utils/backupIntegrity";
import { normalizeUrl } from "../../utils/url";
import { isAuthConfigKey, isPerUserAppearanceKey, isSecretConfigKey, isUserScopedConfigKey, stripSecretConfigs } from "../configGuards";
import { BACKUP_CREDENTIALS_CONFIG } from "../configKeys";
import { encryptSecret } from "../crypto";
import { Config, ExportData, Group, ImportResult, LocalPrefsBackup, Site } from "../types";
import { sanitizeIconUrl, sanitizeLocalPrefs, stripSiteCredentials } from "./internals";

/**
 * 恢复锁的存活时间。
 *
 * 比一次正常恢复的最坏耗时留足余量（几千行站点要跑一阵），又短到「崩了也能自己解开」：
 * 过期是这把锁唯一的自动释放机制 —— 没有它，一个在提交前崩掉的进程会把这个账号
 * 永久挡在恢复之外。
 */
export const RESTORE_LOCK_TTL_MS = 2 * 60 * 1000;

export interface TransferApi {
    exportData(): Promise<ExportData>;
    queryExportBundle(): Promise<{
        groups: Group[];
        sites: Site[];
        configs: Record<string, string>;
    }>;
    importData(data: ExportData): Promise<ImportResult>;
    /**
     * 表里当前最大的 id：恢复时用它当「预分配」的起点。
     * 拿不到（表不存在 / D1 异常）时返回 0，交给后续 INSERT 自己报错。
     */
    nextIdBase(table: "groups" | "sites"): Promise<number>;
    listOwnedIds(table: "groups" | "sites"): Promise<number[]>;
    filterOwnedGroupIds(ids: readonly number[]): Promise<Set<number>>;
    rollbackCreatedRows(siteIds: number[], groupIds: number[]): Promise<void>;
}

export const transferImpl: TransferApi = {

    // 导出所有数据
    exportData: async function (this: NavigationAPI ): Promise<ExportData> {
        await this.migrate();
        // 一次 batch 取回分组 + 站点 + 配置，只花一次 D1 往返（原来是三次）
        const { groups, sites, configs } = await this.withSchemaRetry(() =>
            this.queryExportBundle()
        );

        // M4：默认不含站点账号密码（明文 JSON 备份会被 WebDAV 同步到网盘，凭据跟着走风险高）。
        // 只有用户主动开启「备份含登录凭据」（backup.includeCredentials=true）才带。
        const withCreds = configs[BACKUP_CREDENTIALS_CONFIG] === "true";

        // 全站设置单独放 sharedConfigs，且只有所有者（或单账号部署）才写进备份文件。
        // 否则「一个账号导出的备份被另一个账号恢复」会把全站外观改掉。
        const sharedAllowed = await this.canManageSharedConfigs();

        // 普通账号自己的外观（标题 / 背景…）也进备份：那是「我看到的站点长什么样」，
        // 恢复时理应回到自己这份。所有者那份本来就在全站 configs 里（见 sharedConfigs），
        // 不必重复写一遍 —— 否则别的账号恢复他的备份会把全站外观一起改掉。
        let ownConfigs: Record<string, string> = {};
        if (!sharedAllowed && this.currentUserId !== null) {
            const own = await this.queryUserConfigs(this.currentUserId);
            for (const [key, value] of Object.entries(own)) {
                if (isPerUserAppearanceKey(key)) ownConfigs[key] = value;
            }
            ownConfigs = stripSecretConfigs(ownConfigs);
        }

        const payload: ExportData = {
            groups,
            // 关掉「备份含登录凭据」时把账号密码抹掉：备份文件是明文 JSON，
            // 又会被 WebDAV 同步到网盘，凭据一旦进去就等于跟着走了
            sites: withCreds ? sites : stripSiteCredentials(sites),
            // 自己的外观；敏感配置（WebDAV 凭据）一律不进备份
            configs: ownConfigs,
            ...(sharedAllowed ? { sharedConfigs: stripSecretConfigs(configs) } : {}),
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
        };

        // 摘要只对此刻这份内容负责。前端往里补 localPrefs（星标 / 标签）之后会重算一次
        // （见 utils/backupIntegrity 的 withBackupIntegrity），别把两份混着用。
        const integrity = await computeBackupIntegrity(payload);
        return integrity ? { ...payload, integrity } : payload;
    },
    queryExportBundle: async function (this: NavigationAPI ): Promise<{
        groups: Group[];
        sites: Site[];
        configs: Record<string, string>;
    }> {
        const [groupResult, siteResult, configResult] = await this.db.batch<Group | Site | Config>([
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
        for (const row of (configResult.results || []) as Config[]) {
            // 管理员凭据永远不进备份文件（WebDAV 凭据这里先取出，稍后由 stripSecretConfigs 剔除）
            if (isAuthConfigKey(row.key)) continue;
            configs[row.key] = row.value;
        }

        return {
            groups: (groupResult.results || []) as Group[],
            // 库里是密文，导出前解密成明文 JSON（备份文件整体再由 AES-GCM 加密一次）
            sites: await this.decryptSitePasswords((siteResult.results || []) as Site[]),
            configs,
        };
    },

    /**
     * 导入所有数据（覆盖式恢复）。
     *
     * 不再保留备份文件里的 id：groups / sites 的 id 是全局 AUTOINCREMENT，别的账号
     * 很可能早就占着同样的号（owner 先建的分组就是 1、2、3），照原 id 写回去会撞主键，
     * 整批导入直接失败 ——「A 账号的备份恢复到 B 账号」在过去基本必挂。
     * 现在一律由数据库重新发号，再把 旧id -> 新id 的映射回传给调用方：前端的星标 /
     * 标签是按站点 id 存在本机的，不翻译一遍就全丢了。
     *
     * 写入顺序刻意是「先 INSERT 备份内容，成功之后才 DELETE 旧数据」：
     * 过去是先把当前账号的数据清空再逐条写入，中途任何一步报错（某条数据写不进去、
     * 配置写入失败、连接断了…）都会让这个账号的数据凭空消失 —— 恢复失败反而比不
     * 恢复更糟，用户连「回退」的机会都没有。现在旧数据全程不动，失败了只把本次
     * 新建的行清掉就回到原样（D1 没有跨语句事务可用，只能靠这个顺序保底）。
     */
    importData: async function (this: NavigationAPI, data: ExportData): Promise<ImportResult> {
        const groupIdMap: Record<string, number> = {};
        const siteIdMap: Record<string, number> = {};
        // 本次新写进去的行 id：失败时靠它们回滚（旧数据一步都没动过，删掉这些就回到原样）
        const createdGroupIds: number[] = [];
        const createdSiteIds: number[] = [];

        // 先验完整性：文件坏了就别开始。放在最前面是因为本函数全程「旧数据不动」，
        // 一旦开始 INSERT 再失败就得靠回滚擦屁股 —— 能在动手前拦住最省事。
        // 注意这里校验的是**原始**数据：归一化会补默认值、重排字段，
        // 归一化之后再算摘要必然对不上，会变成好文件也被拦（见前端导入时传原始 data）。
        const integrityCheck = await verifyBackupIntegrity(data);
        if (!integrityCheck.ok) {
            return {
                success: false,
                message: integrityCheck.reason || "备份文件校验失败",
                groupIdMap,
                siteIdMap,
            };
        }

        // ── 账号级恢复锁 ──
        // 两个恢复并发跑会互相踩：都先记下「旧数据 id」，都插自己的新数据，
        // 然后各自把**对方刚插进去的**当成旧数据删掉 —— 最终谁的数据都不完整。
        // 所以整段恢复期间只准一个在跑。锁借幂等键那张表（主键天然是抢锁），
        // 带过期时间：跑到一半进程崩了，两分钟后自动失效，不会把人永久堵在门外。
        const lockScope = "restore.lock";
        const lockKey = `u${this.currentUserId ?? "anon"}`;

        try {
            await this.migrate();

            if (typeof this.claimIdempotency === "function") {
                const got = await this.claimIdempotency(lockScope, lockKey, RESTORE_LOCK_TTL_MS);
                if (!got) {
                    // 抢不到有两种可能，必须分开处理：
                    //   - 确实有另一个恢复在跑 → 拒绝（这才是锁的意义）
                    //   - 存储压根读不出这条记录 → 放行：D1 不可用时后面每一步都会自己失败，
                    //     没必要在这里把恢复整个堵死
                    // 重读一次而不是用进入前的快照：并发下两个请求都会先读到空，
                    // 只有重读才认得出「刚才有人抢赢了」。
                    const holder = await this.readIdempotency(lockScope, lockKey).catch(() => null);
                    if (holder) {
                        return {
                            success: false,
                            message: "上一次恢复还没结束，请稍后再试",
                            groupIdMap,
                            siteIdMap,
                        };
                    }
                }
            }

            const normalized = normalizeImportData(data);

            // 旧数据 id：等新数据全部写完、并且整批一起提交成功之后才删它们。
            // 多账号后只清「当前账号」的，别把别人的数据一起抹了
            const oldSiteIds = await this.listOwnedIds("sites");
            const oldGroupIds = await this.listOwnedIds("groups");

            // ── 预分配 id：让「插分组 / 插站点 / 写配置 / 删旧数据」能进同一个事务 ──
            //
            // 站点要靠分组的新 id 才能落库，所以过去只能「先插分组拿 id，再插站点」——
            // 两步之间没有任何事务保护，中途任何一步失败都得靠事后回滚擦屁股，
            // 而回滚本身也可能失败（那就会留下没人认领的孤儿行）。
            //
            // 现在先把 id 算出来（当前 MAX(id) 之后的一段连续号），所有写入就不再互相
            // 依赖，可以整批塞进**同一个 D1 batch** —— batch 在 D1 里就是一个事务：
            // 要么整份备份生效，要么一个字节都不变。这才是「全部写入验证后原子切换」。
            const groupBase = await this.nextIdBase("groups");
            const siteBase = await this.nextIdBase("sites");

            // 第一阶段：把要写什么算清楚（加密、权限判定这些含 await 的都在这里做完），
            // 第二阶段只负责往 batch 里塞纯 SQL —— 保证事务里没有「等待」。
            interface GroupPlan { id: number; name: string; order_num: number; }
            interface SitePlan {
                id: number; groupId: number; name: string; url: string; icon: string;
                description: string; notes: string; username: string; password: string;
                order_num: number;
            }
            const groupPlan: GroupPlan[] = [];
            let nextGroupId = groupBase + 1;
            for (const group of normalized.groups) {
                const id = nextGroupId++;
                groupPlan.push({ id, name: group.name, order_num: group.order_num || 0 });
                if (group.id !== undefined) groupIdMap[String(group.id)] = id;
                createdGroupIds.push(id);
            }

            // 站点指向了备份里不存在的分组（手改过 / 老格式）时兜一个分组出来装它们，
            // sites.group_id 是 NOT NULL，没有归属就写不进去
            const needsOrphanGroup = normalized.sites.some(site => {
                const mapped = site.group_id !== undefined && site.group_id !== null
                    ? groupIdMap[String(site.group_id)]
                    : undefined;
                return typeof mapped !== "number";
            });
            let orphanGroupId: number | null = null;
            if (needsOrphanGroup) {
                orphanGroupId = nextGroupId++;
                groupPlan.push({ id: orphanGroupId, name: "导入的站点", order_num: 999999 });
                createdGroupIds.push(orphanGroupId);
            }

            let nextSiteId = siteBase + 1;
            const sitePlan: SitePlan[] = [];
            for (const site of normalized.sites) {
                const mapped = site.group_id !== undefined && site.group_id !== null
                    ? groupIdMap[String(site.group_id)]
                    : undefined;
                const groupId = typeof mapped === "number" ? mapped : orphanGroupId;
                if (typeof groupId !== "number") {
                    throw new Error(`站点「${site.name}」找不到所属分组`);
                }
                const id = nextSiteId++;
                sitePlan.push({
                    id,
                    groupId,
                    name: site.name,
                    url: site.url,
                    icon: site.icon || "",
                    description: site.description || "",
                    notes: site.notes || "",
                    username: site.username || "",
                    // 备份里是明文，写回 D1 前加密
                    password: await encryptSecret(site.password || "", this.keyring),
                    order_num: site.order_num || 0,
                });
                if (site.id !== undefined) siteIdMap[String(site.id)] = id;
                createdSiteIds.push(id);
            }

            // 导入配置数据。
            // 老备份的全站设置混在 configs 里，新备份放在 sharedConfigs，两边同规则：
            // 共享键只有站点所有者（或单账号部署）能写，普通账号恢复时不改全站外观。
            const mayWriteShared = await this.canManageSharedConfigs();
            const configEntries: [string, string][] = [
                ...Object.entries(normalized.configs || {}),
                ...Object.entries(normalized.sharedConfigs || {}),
            ];
            const configPlan: { key: string; value: string; uid: number | null }[] = [];
            for (const [key, value] of configEntries) {
                if (key === "DB_INITIALIZED") {
                    // 跳过数据库初始化标志
                    continue;
                }
                if (isSecretConfigKey(key)) {
                    // 恢复备份不覆盖管理员账号密码和 WebDAV 凭据
                    continue;
                }
                if (!isUserScopedConfigKey(key) && !mayWriteShared) {
                    continue;
                }
                if (typeof value !== "string" || key.length > 200 || value.length > 256 * 1024) {
                    throw new Error("备份配置格式无效或过大");
                }
                configPlan.push({ key, value, uid: await this.scopeFor(key) });
            }

            // ── 第二阶段：整批提交（一个 D1 事务 = 原子切换）──
            const commitStatements: D1PreparedStatement[] = [];
            for (const g of groupPlan) {
                commitStatements.push(
                    this.db
                        .prepare("INSERT INTO groups (id, name, order_num, user_id) VALUES (?, ?, ?, ?)")
                        .bind(g.id, g.name, g.order_num, this.currentUserId)
                );
            }
            for (const s of sitePlan) {
                commitStatements.push(
                    this.db
                        .prepare(
                            `INSERT INTO sites (id, group_id, name, url, icon, description, notes, username, password, order_num, user_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .bind(
                            s.id,
                            s.groupId,
                            s.name,
                            s.url,
                            s.icon,
                            s.description,
                            s.notes,
                            s.username,
                            s.password,
                            s.order_num,
                            this.currentUserId
                        )
                );
            }
            for (const c of configPlan) {
                commitStatements.push(
                    c.uid === null
                        ? this.db
                              .prepare("INSERT INTO configs (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP")
                              .bind(c.key, c.value)
                        : this.db
                              .prepare("INSERT INTO user_configs (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP")
                              .bind(c.uid, c.key, c.value)
                );
            }

            // 删除旧数据仍在同一个事务里：新数据已经全部写好了，切过去和清掉旧的是一步。
            //
            // 仍然剔除本次新建的 id：预分配用的是 MAX(id)+1 起，理论上与旧 id 不重叠，
            // 但 SQLite 的 rowid 会复用「刚被删掉的最大值」，留着这层过滤等于多一道保险 ——
            // 真重叠了也只是少删几行，绝不会把刚恢复进来的数据抹掉。
            const freshGroups = new Set(createdGroupIds);
            const freshSites = new Set(createdSiteIds);
            for (const [table, ids, fresh] of [
                ["sites", oldSiteIds, freshSites],
                ["groups", oldGroupIds, freshGroups],
            ] as const) {
                const stale = ids.filter(id => !fresh.has(id));
                for (let offset = 0; offset < stale.length; offset += 90) {
                    const chunk = stale.slice(offset, offset + 90);
                    commitStatements.push(this.db.prepare(`DELETE FROM ${table} WHERE id IN (${chunk.map(() => "?").join(",")})${this.scopeSql(true)}`).bind(...this.scopeParams([...chunk])));
                }
            }

            if (commitStatements.length) {
                const committed = await this.db.batch(commitStatements);
                if (committed.some(result => !result.success)) {
                    throw new Error("恢复事务提交失败：整份恢复已回滚，当前数据未改动");
                }
            }

            return { success: true, groupIdMap, siteIdMap };
        } catch (error) {
            console.error("导入数据失败:", error);
            // 回滚：只删本次新建的行。旧数据全程没被碰过，删掉这些就回到导入前的样子。
            // 回滚本身再出错也不能把异常抛出去（用户更该看到的是「为什么导入失败」）
            await this.rollbackCreatedRows(createdSiteIds, createdGroupIds);
            return {
                success: false,
                message: error instanceof Error ? error.message : "导入数据失败",
                groupIdMap,
                siteIdMap,
            };
        } finally {
            // 锁必须释放，成功失败都要。拿不到锁的那一次压根没进 try，
            // 也就不会走到这里、不会误删别人的锁。
            if (typeof this.releaseIdempotency === "function") {
                await this.releaseIdempotency(lockScope, lockKey).catch(() => {});
            }
        }
    },

    nextIdBase: async function (this: NavigationAPI, table: "groups" | "sites"): Promise<number> {
        try {
            const row = await this.db
                .prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)
                .first<{ m: number }>();
            return typeof row?.m === "number" ? row.m : 0;
        } catch {
            return 0;
        }
    },

    /** 当前账号（单账号部署则是全部）在某张表里的行 id —— 覆盖恢复时用来清旧数据 */
    listOwnedIds: async function (this: NavigationAPI, table: "groups" | "sites"): Promise<number[]> {
        const result = await this.db
            .prepare(`SELECT id FROM ${table}${this.scopeSql(false)}`)
            .bind(...this.scopeParams([]))
            .all<{ id: number }>();
        return (result.results || [])
            .map(row => row?.id)
            .filter((id): id is number => typeof id === "number");
    },

    /**
     * 从候选分组 id 里挑出「属于当前账号」的那些。
     * 卡片跨组移动时用它确认目标分组也是自己的（见 updateSiteOrder）。
     */
    filterOwnedGroupIds: async function (this: NavigationAPI, ids: readonly number[]): Promise<Set<number>> {
        if (ids.length === 0) return new Set();
        const placeholders = ids.map(() => "?").join(",");
        try {
            const result = await this.db
                .prepare(
                    `SELECT id FROM groups WHERE id IN (${placeholders})${this.scopeSql(true)}`
                )
                .bind(...this.scopeParams([...ids]))
                .all<{ id: number }>();
            return new Set(
                (result.results || [])
                    .map(row => row?.id)
                    .filter((id): id is number => typeof id === "number")
            );
        } catch (error) {
            console.error("校验分组归属失败:", error);
            return new Set();
        }
    },

    /** 导入失败后的回滚：删掉本次新建的行，旧数据原样保留 */
    rollbackCreatedRows: async function (this: NavigationAPI, siteIds: number[], groupIds: number[]): Promise<void> {
        try {
            await this.deleteRowsByIds("sites", siteIds);
            await this.deleteRowsByIds("groups", groupIds);
        } catch (error) {
            console.error("导入失败后回滚新建数据失败:", error);
            // 回滚失败必须留痕：这批行已经不在任何人的视野里（前端只看到「导入失败」），
            // 没人知道库里多了些孤儿卡片。写进审计日志，日后能按 id 找出来清掉。
            try {
                await this.writeAudit(
                    "import.rollbackFailed",
                    "",
                    "",
                    `回滚未清理: sites=${siteIds.join(",") || "-"} groups=${groupIds.join(",") || "-"}`
                );
            } catch {
                // 审计也写不进去就只剩日志了，不能再抛 —— 用户该看到的是「为什么导入失败」
            }
        }
    },
};

// 备份文件格式版本号。
// 1.3：全站共享配置从 configs 拆到 sharedConfigs（且只有所有者导出时才带），
// 导入不再保留备份里的 id（改由数据库重新发号并回传映射）。
export const EXPORT_VERSION = "1.3";

// 兼容多种备份格式：
// 1) 标准格式 { groups, sites, configs }
// 2) 旧格式   { groups: [{ ...group, sites: [...] }], configs }
// 1.3 起全站设置挪到 sharedConfigs；老备份没有这个字段，全站设置还混在 configs 里，
// 导入时按同一套归属规则判断（见 importData）。
export function normalizeImportData(data: ExportData | Record<string, unknown>): ExportData {
    const raw = (data || {}) as {
        groups?: (Group & { sites?: Site[] })[];
        sites?: Site[];
        configs?: Record<string, string>;
        sharedConfigs?: Record<string, string>;
        version?: string;
        exportDate?: string;
        localPrefs?: LocalPrefsBackup;
    };

    const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
    const groups: Group[] = [];
    const nestedSites: Site[] = [];

    rawGroups.forEach((group, index) => {
        groups.push({
            id: group.id,
            name: group.name,
            order_num: typeof group.order_num === "number" ? group.order_num : index,
            created_at: group.created_at,
            updated_at: group.updated_at,
        });

        if (Array.isArray(group.sites)) {
            group.sites.forEach((site, siteIndex) => {
                nestedSites.push({
                    ...site,
                    group_id: typeof site.group_id === "number" ? site.group_id : (group.id ?? 0),
                    order_num: typeof site.order_num === "number" ? site.order_num : siteIndex,
                });
            });
        }
    });

    const flatSites = Array.isArray(raw.sites) ? raw.sites : [];

    // 导入这条路径完全绕开表单校验：备份文件可能被手改过、也可能是很老的版本。
    // 入库前统一规范化（补 https:// / 挡危险协议）；规范化不过的直接把链接清空，
    // 卡片会退化成「没有链接」，而不是「点一下执行脚本」。
        const sites = (flatSites.length > 0 ? flatSites : nestedSites).map(site => {
            const result = normalizeUrl(site.url || "");
            const url = result.ok ? result.url : "";
            // L1：导入路径绕开表单校验，图标同样挡掉 javascript:/vbscript:/file:/data:text/html 等
            const icon = sanitizeIconUrl(site.icon || "");
            return { ...site, url, icon };
        });

    return {
        groups,
        sites,
        configs: raw.configs && typeof raw.configs === "object" ? raw.configs : {},
        // 全站共享配置：老备份没有这个字段，导入时那份全站设置从 configs 里按规则挑
        ...(raw.sharedConfigs && typeof raw.sharedConfigs === "object"
            ? { sharedConfigs: raw.sharedConfigs }
            : {}),
        version: raw.version || EXPORT_VERSION,
        exportDate: raw.exportDate || new Date().toISOString(),
        // 星标 / 标签这类本机偏好原样透传，交给前端写回 localStorage
        ...(raw.localPrefs && typeof raw.localPrefs === "object"
            ? { localPrefs: sanitizeLocalPrefs(raw.localPrefs) }
            : {}),
    };
}
