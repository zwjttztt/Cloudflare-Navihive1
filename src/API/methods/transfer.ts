// src/API/methods/transfer.ts
// NavigationAPI 的「transfer」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { computeBackupIntegrity, verifyBackupIntegrity } from "../../utils/backupIntegrity";
import { normalizeUrl } from "../../utils/url";
import { isAuthConfigKey, isPerUserAppearanceKey, isSecretConfigKey, isUserScopedConfigKey, stripSecretConfigs } from "../configGuards";
import { BACKUP_CREDENTIALS_CONFIG } from "../configKeys";
import { encryptSecret } from "../crypto";
import { Config, ExportData, Group, ImportResult, LocalPrefsBackup, Site } from "../types";
import { sanitizeIconUrl, sanitizeLocalPrefs, stripSiteCredentials } from "./internals";

export interface TransferApi {
    exportData(): Promise<ExportData>;
    queryExportBundle(): Promise<{
        groups: Group[];
        sites: Site[];
        configs: Record<string, string>;
    }>;
    importData(data: ExportData): Promise<ImportResult>;
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

        try {
            await this.migrate();

            const normalized = normalizeImportData(data);

            // 先记下现有数据的 id：等新数据全部写成功之后再删它们。
            // 多账号后只清「当前账号」的，别把别人的数据一起抹了
            const oldSiteIds = await this.listOwnedIds("sites");
            const oldGroupIds = await this.listOwnedIds("groups");

            // 导入分组：id 交给数据库分配，同时记下新旧映射
            for (const group of normalized.groups) {
                const result = await this.db
                    .prepare(
                        "INSERT INTO groups (name, order_num, user_id) VALUES (?, ?, ?) RETURNING id"
                    )
                    .bind(group.name, group.order_num || 0, this.currentUserId)
                    .all<{ id: number }>();
                const newId = result.results?.[0]?.id;
                if (typeof newId !== "number") {
                    throw new Error(`分组「${group.name}」写入后拿不到新 id`);
                }
                createdGroupIds.push(newId);
                if (group.id !== undefined) groupIdMap[String(group.id)] = newId;
            }

            // 站点指向了备份里不存在的分组（手改过 / 老格式）时兜一个分组出来装它们，
            // sites.group_id 是 NOT NULL，没有归属就写不进去
            let orphanGroupId: number | null = null;

            // 导入站点数据（含账号密码）
            for (const site of normalized.sites) {
                let groupId =
                    site.group_id !== undefined && site.group_id !== null
                        ? groupIdMap[String(site.group_id)]
                        : undefined;

                if (typeof groupId !== "number") {
                    if (orphanGroupId === null) {
                        const created = await this.createGroup({
                            name: "导入的站点",
                            order_num: 999999,
                        } as Group);
                        if (typeof created?.id !== "number") {
                            throw new Error("为无归属站点创建兜底分组失败");
                        }
                        orphanGroupId = created.id;
                        createdGroupIds.push(orphanGroupId);
                    }
                    groupId = orphanGroupId;
                }

                const result = await this.db
                    .prepare(
                        `INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num, user_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
                    )
                    .bind(
                        groupId,
                        site.name,
                        site.url,
                        site.icon || "",
                        site.description || "",
                        site.notes || "",
                        site.username || "",
                        // 备份里是明文，写回 D1 前加密
                        await encryptSecret(site.password || "", this.secret),
                        site.order_num || 0,
                        this.currentUserId
                    )
                    .all<{ id: number }>();
                const newId = result.results?.[0]?.id;
                if (typeof newId !== "number") {
                    throw new Error(`站点「${site.name}」写入后拿不到新 id`);
                }
                createdSiteIds.push(newId);
                if (site.id !== undefined) siteIdMap[String(site.id)] = newId;
            }

            // 导入配置数据。
            // 老备份的全站设置混在 configs 里，新备份放在 sharedConfigs，两边同规则：
            // 共享键只有站点所有者（或单账号部署）能写，普通账号恢复时不改全站外观。
            const mayWriteShared = await this.canManageSharedConfigs();
            const configEntries: [string, string][] = [
                ...Object.entries(normalized.configs || {}),
                ...Object.entries(normalized.sharedConfigs || {}),
            ];

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
                await this.setConfig(key, value);
            }

            // 走到这里说明新数据已经整批就位，这才清掉旧数据：
            // 站点先删（挂在分组下），分组后删
            await this.deleteRowsByIds("sites", oldSiteIds);
            await this.deleteRowsByIds("groups", oldGroupIds);

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
