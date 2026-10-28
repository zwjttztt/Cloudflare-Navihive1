// src/API/methods/transfer.ts
// NavigationAPI 的「transfer」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import type { D1PreparedStatement } from "../schema";
import { computeBackupIntegrity, verifyBackupIntegrity } from "../../utils/backupIntegrity";
import { normalizeUrl, urlIdentityKey } from "../../utils/url";
import { isAuthConfigKey, isAiConfigKey, isImportableConfigValue, isPerUserAppearanceKey, isSecretConfigKey, isUserScopedConfigKey, stripSecretConfigs } from "../configGuards";
import { BACKUP_CREDENTIALS_CONFIG } from "../configKeys";
import { encryptSecret } from "../crypto";
import {
    Config,
    ExportData,
    Group,
    ImportMode,
    ImportOptions,
    ImportResult,
    ImportStage,
    ImportStats,
    LocalPrefsBackup,
    Note,
    NoteImportStats,
    NoteFolder,
    NoteTag,
    Site,
    VaultBackup,
    VaultEntryRecord,
    VaultImportResult,
    VaultKeysRecord,
} from "../types";
import { sanitizeIconUrl, sanitizeLocalPrefs, stripSiteCredentials, tombstoneStamp } from "./internals";

/**
 * 恢复锁的存活时间。
 *
 * 比一次正常恢复的最坏耗时留足余量（几千行站点要跑一阵），又短到「崩了也能自己解开」：
 * 过期是这把锁唯一的自动释放机制 —— 没有它，一个在提交前崩掉的进程会把这个账号
 * 永久挡在恢复之外。
 */
export const RESTORE_LOCK_TTL_MS = 2 * 60 * 1000;

/** 一个待写入的分组 */
export interface GroupPlan { id: number; name: string; order_num: number; }
/**
 * 一个待写入的站点。
 * password 在「草稿」阶段是明文、加密后才是密文 —— 两个阶段共用同一个形状，
 * 免得为了一个字段再定义一套类型。
 */
export interface SitePlan {
    id: number; groupId: number; name: string; url: string; icon: string;
    description: string; notes: string; username: string; password: string;
    order_num: number;
}

/** 密码加密的并发窗口：见 encryptSitePasswords */
export const ENCRYPT_CONCURRENCY = 16;
/**
 * 站点万能兜底分组的名字。
 * 备份里的站点指向了这份备份不存在的分组（手改过 / 老格式）时，落到这里。
 * ⚠️ 必须是常量：重复导入要能按名字认出上次那个兜底分组，而不是再造一个。
 */
export const ORPHAN_GROUP_NAME = "导入的站点";

/**
 * 站点的「身份键」：同一分组内，有链接就比链接，没链接才比名字。
 *
 * 抽成函数是因为口令只有一处地方能定 —— 增量导入认同一条，
 * 与「新增卡片时的重复链接提示」用的是同一把尺子（utils/url 的 urlIdentityKey），
 * 两边分叉就会变成「界面说已存在、导入还是又建一条」。
 */
export function siteMatchKey(groupId: number, url?: string | null, name?: string | null): string {
    const key = urlIdentityKey(url);
    return key
        ? `${groupId}|u:${key}`
        : `${groupId}|n:${String(name ?? "").trim().toLowerCase()}`;
}

/**
 * 旧分块阈值（保留兼容导出及回归测试引用），不是 D1 的容量承诺。
 * 恢复现统一使用一个事务；容量超限由数据库拒绝，不拆开提交。
 */
export const COMMIT_CHUNK_STATEMENTS = 250;

/**
 * 限并发地跑一遍异步映射：同时最多 `limit` 个在飞，输出顺序与输入一致。
 *
 * 抽出来是因为「并发窗口到底生效没有」必须能被验证 —— 埋在 encryptSitePasswords
 * 里就只能靠计时猜。这里是个纯函数，测试可以直接数在飞的数量。
 * `limit` 会被夹到 [1, items.length]：0 会永久挂住，超过条目数则是白开几条空车道。
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
    onProgress?: (done: number, total: number) => void
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let done = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor++;
            out[index] = await fn(items[index], index);
            done++;
            onProgress?.(done, items.length);
        }
    };

    const lanes = Math.min(Math.max(1, limit), Math.max(1, items.length));
    await Promise.all(Array.from({ length: lanes }, worker));
    return out;
}

// 导入进度的形状定义在 types.ts（前端和 Worker 都要用），这里转手导出一份，
// 免得两处各写一遍、改了一边忘了另一边。
export type { ImportStage, ImportProgress, ImportOptions } from "../types";

export interface TransferApi {
    exportData(): Promise<ExportData>;
    queryExportBundle(): Promise<{
        groups: Group[];
        sites: Site[];
        configs: Record<string, string>;
    }>;
    importData(data: ExportData, opts?: ImportOptions): Promise<ImportResult>;
    /** 批量加密站点密码（限并发 + 进度回调） */
    encryptSitePasswords(
        drafts: readonly SitePlan[],
        onProgress?: (done: number, total: number) => void
    ): Promise<SitePlan[]>;
    /**
     * 表里当前最大的 id：恢复时用它当「预分配」的起点。
     * 拿不到（表不存在 / D1 异常）时返回 0，交给后续 INSERT 自己报错。
     */
    nextIdBase(table: "groups" | "sites" | "notes"): Promise<number>;
    listOwnedIds(table: "groups" | "sites" | "notes"): Promise<number[]>;
    filterOwnedGroupIds(ids: readonly number[]): Promise<Set<number>>;
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

        // 记事本：导航备份一律**不带**。导航页备份与记事本备份是两套独立的备份
        // （见 worker/notesBackup.ts），笔记只走自己的 WebDAV 备份；这样导航备份
        // 文件里不会出现半份笔记数据，导入时本地笔记也天然保持不动。

        // 全站设置单独放 sharedConfigs，且只有所有者（或单账号部署）才写进备份文件。
        // 否则「一个账号导出的备份被另一个账号恢复」会把全站外观改掉。
        const sharedAllowed = await this.canManageSharedConfigs();

        // 普通账号自己的外观（标题 / 背景…）也进备份：那是「我看到的站点长什么样」，
        // 恢复时理应回到自己这份。所有者那份本来就在全站 configs 里（见 sharedConfigs），
        // 不必重复写一遍 —— 否则别的账号恢复他的备份会把全站外观一起改掉。
        //
        // 2026-10-24：AI 设置整组（ai.*）跟着备份走（用户要求），所有角色都带。
        // 它和外观一样存在自己那份 user_configs 里，所以这里对所有登录账号都查一次，
        // 只是放行的键多一组 —— 结果进 configs（账号私有通道），恢复时由 scopeFor
        // 落回导入者自己的 user_configs，不会碰别人的。
        let ownConfigs: Record<string, string> = {};
        if (this.currentUserId !== null) {
            const own = await this.queryUserConfigs(this.currentUserId);
            for (const [key, value] of Object.entries(own)) {
                if (isPerUserAppearanceKey(key) || isAiConfigKey(key)) ownConfigs[key] = value;
            }
            // 纵深防御：放行条件将来若写错，也别把 webdav.* 带进备份文件
            ownConfigs = stripSecretConfigs(ownConfigs);
        }

        // 保险库：库里本来就是密文（KDF 参数 + 两份包好的 DEK + 条目密文信封），
        // 直接搬进导航备份即可（整份备份文件再由 AES-GCM 加密一次），服务端不解密、不碰明文。
        // 没有保险库（getVaultKeys 返回 null）就不写 vault 字段 —— 这样「老备份 / 没建保险库」
        // 的导入不会动本地现有的保险库。
        const vaultKeys = await this.getVaultKeys();
        const vaultPayload: VaultBackup | undefined = vaultKeys
            ? { keys: vaultKeys, entries: await this.listVaultEntries() }
            : undefined;

        const payload: ExportData = {
            groups,
            // 关掉「备份含登录凭据」时把账号密码抹掉：备份文件是明文 JSON，
            // 又会被 WebDAV 同步到网盘，凭据一旦进去就等于跟着走了
            sites: withCreds ? sites : stripSiteCredentials(sites),
            // 自己的外观与 AI 设置；敏感配置（WebDAV 凭据）一律不进备份
            configs: ownConfigs,
            ...(sharedAllowed ? { sharedConfigs: stripSecretConfigs(configs) } : {}),
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
            ...(vaultPayload ? { vault: vaultPayload } : {}),
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
        // 导航备份只负责站点 / 分组 / 配置；笔记有自己的独立备份
        // （worker/notesBackup.ts 的 exportNotesData），不跟导航备份混在一起。
        const [groupResult, siteResult, configResult] = await this.db.batch<
            Group | Site | Config
        >([
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
     * 导入所有数据。两种模式：
     *
     * - `merge`（默认，**增量合并**）：这条链路里没有任何一行 DELETE。既不清空、
     *   也不整体覆盖，更不会因为「备份里没有就把本地那条删掉」。库里已有的数据
     *   永远是加法：能认出是同一条的就更新/跳过，认不出是同一条的才新建，
     *   本地多出来的原样保留。
     * - `overwrite`（**覆盖导入**，必须用户显式勾选）：在合并的基础上，
     *   额外删掉「本地有、而这份备份里没有」的分组 / 卡片 / 笔记，
     *   把整站还原成备份那一刻的样子。
     *
     * 覆盖模式与老的「先清空再重建」有三点本质区别，都是冲着「别把人清空」去的：
     *   1. **只删备份里没有的**，认得出是同一条的照样就地更新 —— 卡片 id 不变，
     *      本机星标 / 标签 / 访问统计不会因为一次恢复全部掉线；
     *   2. **删除与写入同一个事务**，整批失败由数据库整批回滚，不存在「删完了没写进去」；
     *   3. **空备份不许覆盖**：一份没有分组也没有卡片的备份多半是选错文件了，
     *      直接拒绝，而不是把站点清空。
     *
     * 匹配口径（同一账号范围内）：
     *   - 分组：按**名称**
     *   - 站点：按**所属分组 + 链接**；没有链接时退回「所属分组 + 名称」
     *   - 笔记：按 uuid
     *   - 配置：按 key
     * 与「新增卡片时的重复链接提示」共用 utils/url 的 urlIdentityKey，
     * 免得出现「前端说重复、导入照样再建一条」。
     *
     * 站点更新采用与笔记一致的**新旧比对**：只有当备份里那条 updated_at 更新时才覆盖
     * 本地；时间缺失或解析不出来一律判「本地较新」保留本地 —— 宁可不更新，也不能
     * 把用户在本地改过的内容悄悄换掉。
     *
     * 备份文件里的 id 一律不沿用：groups / sites 的 id 是全局 AUTOINCREMENT，
     * 别的账号很可能早就占着同样的号，照原 id 写回去会撞主键、整批失败。
     * 一律由数据库重新发号，再把 旧id -> 新id 的映射回传给调用方：
     * 前端的星标 / 标签是按站点 id 存在本机的，不翻译一遍就全丢了。
     *
     * 所有写入（含已有笔记的 UPDATE、标签关联重建）塞进**同一个 D1 batch**：
     * batch 在 D1 里就是一个事务 —— 要么整份备份生效，要么一个字节都不变。
     * 所以这里不再需要「事后按 id 补偿删除」那种回滚：写一半失败由数据库自己退回去。
     */
    importData: async function (
        this: NavigationAPI,
        data: ExportData,
        opts?: ImportOptions
    ): Promise<ImportResult> {
        const report = (stage: ImportStage, done: number, total: number) => {
            try {
                opts?.onProgress?.({ stage, done, total });
            } catch {
                // 进度回调出错不能把导入拖垮
            }
        };
        /**
         * 合并（默认）还是覆盖。
         * 覆盖是唯一会删东西的模式，所以它必须由调用方显式传进来 —— 不传就是合并。
         */
        const mode: ImportMode = opts?.mode === "overwrite" ? "overwrite" : "merge";
        const overwrite = mode === "overwrite";
        const groupIdMap: Record<string, number> = {};
        /**
         * 笔记三态统计。声明在 try 之外：成功路径要返回它，
         * 而 try 之后的 return 才在作用域内。
         * 备份里没有 notes 字段时四项全为 0 —— 那表示「这份备份与笔记无关」，
         * 不是「导入后笔记没了」。
         */
        const noteStats: NoteImportStats = {
            created: 0,
            updated: 0,
            skipped: 0,
            removed: 0,
        };
        const siteIdMap: Record<string, number> = {};
        /**
         * 分组 / 站点的三态统计。
         *
         * 「已存在且本地更新所以跳过」是正确行为，但不给数字用户会以为没导进来；
         * 反过来「新建了多少」也要看得见 —— 重复导入时它必须是一串 0，
         * 那是幂等性唯一能被肉眼验证的地方。
         */
        const stats: ImportStats = {
            groupsCreated: 0,
            groupsMatched: 0,
            sitesCreated: 0,
            sitesUpdated: 0,
            sitesSkipped: 0,
        };
        let lockAcquired = false;
        // 保险库导入结果（仅回报 UI，不影响数据）
        let vaultResult: VaultImportResult = { action: "none", entries: 0 };

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

        // 完整性校验过了 —— 这是第一个阶段，也让 UI 立刻知道服务端接住活了
        // （后面还要排队抢锁，这段时间界面上不该是一片空白）
        report("verify", 1, 1);

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
                if (got) lockAcquired = true;
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

            // ── 覆盖模式的空备份闸门 ──
            //
            // 一份没有分组也没有卡片的备份，覆盖进去等于把站点清空。这不是「导入成功」
            // 而是「导入事故」，而它最常见的成因只是选错了文件 / 解析没成功。
            // 合并模式不受影响：那种模式下一份空备份本来就不会动任何东西。
            if (overwrite && normalized.groups.length === 0 && normalized.sites.length === 0) {
                return {
                    success: false,
                    message:
                        "这份备份里没有任何分组或卡片，覆盖导入已取消（现有数据未改动）",
                    groupIdMap,
                    siteIdMap,
                };
            }

            // ── 现有数据索引（只读）──
            //
            // 增量导入全靠这张表认「是不是同一条」。只读不写，所以这一段永远不会
            // 伤到库里的东西：认出来就更新/跳过，认不出来才新建。
            // 多账号部署下 scopeSql 会把结果限在当前账号内 —— A 的分组不会拿来跟 B 的撞。
            const existingGroupRows = await this.db
                .prepare(`SELECT id, name FROM groups${this.scopeSql(false)}`)
                .bind(...this.scopeParams([]))
                .all<{ id: number; name: string }>();
            const existingSiteRows = await this.db
                .prepare(
                    `SELECT id, group_id, name, url, updated_at FROM sites${this.scopeSql(
                        false
                    )}`
                )
                .bind(...this.scopeParams([]))
                .all<{ id: number; group_id: number; name: string; url: string; updated_at?: string }>();

            /** 名称 -> 分组 id。同名的老行取 id 最小的那条（历史脏数据可能存在）。 */
            const groupIdByName = new Map<string, number>();
            for (const row of existingGroupRows.results || []) {
                const name = String(row.name ?? "").trim();
                if (name && !groupIdByName.has(name)) groupIdByName.set(name, row.id);
            }
            /** `${groupId}|u:${urlKey}`（无链接则 `n:${name}`） -> 站点 id */
            const siteIdByKey = new Map<string, number>();
            /** 已有站点的时间戳：比对新旧时用 */
            const siteUpdatedAt = new Map<number, number>();
            for (const row of existingSiteRows.results || []) {
                const key = siteMatchKey(row.group_id, row.url, row.name);
                if (!siteIdByKey.has(key)) siteIdByKey.set(key, row.id);
                siteUpdatedAt.set(row.id, Date.parse(row.updated_at || "") || 0);
            }

            // ── 预分配 id：让所有写入能塞进同一个事务 ──
            //
            // 站点要靠分组的 id 才能落库，所以过去只能「先插分组拿 id，再插站点」——
            // 两步之间没有任何事务保护。现在先把 id 算出来（当前 MAX(id) 之后的一段
            // 连续号），所有写入互不依赖，整批进**同一个 D1 batch**（= 一个事务）。
            let nextNoteId = 0;
            const groupBase = await this.nextIdBase("groups");
            const siteBase = await this.nextIdBase("sites");
            nextNoteId = await this.nextIdBase("notes");

            // 第一阶段：把要写什么算清楚（加密、权限判定这些含 await 的都在这里做完），
            // 第二阶段只负责往 batch 里塞纯 SQL —— 保证事务里没有「等待」。
            const groupPlan: GroupPlan[] = [];
            /**
             * 本次认出来的已有分组 id（覆盖模式下这些分组保命）。
             *
             * 另外单独记一份 incomingSiteKeys：两张表一起才能算出
             * 「本地有、而备份里没有」的那些行 —— 光看名字会漏掉「卡片被搬走了」。
             */
            const matchedGroupIds = new Set<number>();
            const incomingSiteKeys = new Set<string>();
            let nextGroupId = groupBase + 1;
            for (const group of normalized.groups) {
                const name = String(group.name ?? "").trim();
                const existingId = name ? groupIdByName.get(name) : undefined;
                if (existingId !== undefined) {
                    matchedGroupIds.add(existingId);
                    // 同名分组已经存在：认出来就复用，不顺手改它的排序 / 名字 ——
                    // 用户在本地调过的顺序不该被一份备份悄悄覆盖掉
                    if (group.id !== undefined) groupIdMap[String(group.id)] = existingId;
                    stats.groupsMatched += 1;
                    continue;
                }
                const id = nextGroupId++;
                groupPlan.push({ id, name: group.name, order_num: group.order_num || 0 });
                // 同一份备份里出现两个同名分组时只建一个：没有这行，
                // 第二次循环会因为 map 里查不到又接着往下排一个 id
                if (name) groupIdByName.set(name, id);
                if (group.id !== undefined) groupIdMap[String(group.id)] = id;
                stats.groupsCreated += 1;
            }

            // 站点指向了备份里不存在的分组（手改过 / 老格式）时兜一个分组出来装它们，
            // sites.group_id 是 NOT NULL，没有归属就写不进去。
            // ⚠️ 同样先按名字找现成的：反复导入会一趟造一个「导入的站点」，
            // 那就是「重复导入长出新数据」最典型的一条。
            const needsOrphanGroup = normalized.sites.some(site => {
                const mapped = site.group_id !== undefined && site.group_id !== null
                    ? groupIdMap[String(site.group_id)]
                    : undefined;
                return typeof mapped !== "number";
            });
            let orphanGroupId: number | null = null;
            if (needsOrphanGroup) {
                const existingId = groupIdByName.get(ORPHAN_GROUP_NAME);
                if (existingId !== undefined) {
                    orphanGroupId = existingId;
                    // 兜底分组被复用 = 这次它装了东西，覆盖模式下不能把它删掉
                    matchedGroupIds.add(existingId);
                } else {
                    orphanGroupId = nextGroupId++;
                    groupPlan.push({ id: orphanGroupId, name: ORPHAN_GROUP_NAME, order_num: 999999 });
                    groupIdByName.set(ORPHAN_GROUP_NAME, orphanGroupId);
                    stats.groupsCreated += 1;
                }
            }

            let nextSiteId = siteBase + 1;
            // 「本次准备新建的行」：备份内部自己重复的条目也要在这一轮认出来，
            // 否则同一份文件里两个同链接卡片会各占一个新 id（也会把它当成「已存在」去 UPDATE 一条还没插进去的行）。
            const plannedSiteIds = new Set<number>();
            const siteDraft: SitePlan[] = [];
            /** 命中已有行、且备份里那条更新才走 UPDATE */
            const siteUpdateDraft: SitePlan[] = [];
            for (const site of normalized.sites) {
                const mapped = site.group_id !== undefined && site.group_id !== null
                    ? groupIdMap[String(site.group_id)]
                    : undefined;
                const groupId = typeof mapped === "number" ? mapped : orphanGroupId;
                if (typeof groupId !== "number") {
                    throw new Error(`站点「${site.name}」找不到所属分组`);
                }
                const key = siteMatchKey(groupId, site.url, site.name);
                // 记进「备份里有哪几张卡」：覆盖模式删除时用得上。
                // 放在匹配之前 —— 重复的、要新建的、要去更新的，全都要算进这张清单，
                // 否则「备份里明明有」的卡片会被当成没有而删掉。
                incomingSiteKeys.add(key);
                const existingId = siteIdByKey.get(key);

                if (existingId !== undefined && !plannedSiteIds.has(existingId)) {
                    // 认出是同一张卡：不新建，只决定要不要用备份里这份覆盖内容
                    if (site.id !== undefined) siteIdMap[String(site.id)] = existingId;
                    const localTime = siteUpdatedAt.get(existingId) ?? 0;
                    const incomingTime = Date.parse(site.updated_at || "") || 0;
                    if (incomingTime > localTime) {
                        siteUpdateDraft.push({
                            id: existingId,
                            groupId,
                            name: site.name,
                            url: site.url,
                            icon: site.icon || "",
                            description: site.description || "",
                            notes: site.notes || "",
                            username: site.username || "",
                            password: site.password || "",
                            order_num: site.order_num || 0,
                        });
                        stats.sitesUpdated += 1;
                    } else {
                        // 本地更新（或两边都算不出时间）：保守保留本地，一个数写回 stats 让人看得见
                        stats.sitesSkipped += 1;
                    }
                    continue;
                }
                if (existingId !== undefined) {
                    // 这份备份里自己重复了：指向同一个新建 id，不写第二遍
                    if (site.id !== undefined) siteIdMap[String(site.id)] = existingId;
                    stats.sitesSkipped += 1;
                    continue;
                }

                const id = nextSiteId++;
                plannedSiteIds.add(id);
                siteDraft.push({
                    id,
                    groupId,
                    name: site.name,
                    url: site.url,
                    icon: site.icon || "",
                    description: site.description || "",
                    notes: site.notes || "",
                    username: site.username || "",
                    password: site.password || "",
                    order_num: site.order_num || 0,
                });
                siteIdByKey.set(key, id);
                if (site.id !== undefined) siteIdMap[String(site.id)] = id;
                stats.sitesCreated += 1;
            }

            // ── 覆盖模式：算出「本地有、备份里没有」的那些行 ──
            //
            // 只删这一类，不是「先清空再重建」。两种做法差别很大：
            //   - 认得出是同一条的卡片**保住 id**：本机星标 / 标签、访问统计不会因为
            //     一次恢复全部掉线（老的做法是给每一行重新发号，代价是这些全没了）；
            //   - 卡片内容仍然按 merge 那套「谁新谁赢」，不硬灌旧的：
            //     备份里没带登录凭据时（导出开关关着）覆盖进去也不会把本地存的账号密码清空。
            //
            // 合并模式下这两段恒为空，整个 importData 依旧没有任何 DELETE。
            const removalStatements: D1PreparedStatement[] = [];
            if (overwrite) {
                const staleSiteIds: number[] = [];
                const staleGroupIds: number[] = [];
                for (const row of existingSiteRows.results || []) {
                    // 分组都被删了的话，它下面的卡片不必单独判断 —— 整个分组一起走
                    if (matchedGroupIds.has(row.group_id)) {
                        const key = siteMatchKey(row.group_id, row.url, row.name);
                        if (incomingSiteKeys.has(key)) continue;
                    }
                    staleSiteIds.push(row.id);
                }
                for (const row of existingGroupRows.results || []) {
                    if (matchedGroupIds.has(row.id)) continue;
                    staleGroupIds.push(row.id);
                }

                // 删卡片前先留墓碑：其它设备靠 /api/sites/changes 才知道少了哪几张，
                // 否则它们本地那几张会一直留着，谁都看不出已经被删了
                for (const id of staleSiteIds) {
                    removalStatements.push(
                        this.db
                            .prepare("INSERT INTO site_tombstone (user_id, site_id, deleted_at) VALUES (?, ?, ?)")
                            .bind(this.currentUserId, id, tombstoneStamp())
                    );
                }
                // ⚠️ 先删卡片再删分组：sites.group_id 有外键（ON DELETE CASCADE 在
                // 外键开关没打开的环境里不生效），顺序反了会在事务提交时撞外键约束，
                // 整批回滚 —— 表现为「覆盖导入总是失败」。
                for (const id of staleSiteIds) {
                    removalStatements.push(
                        this.db
                            .prepare(`DELETE FROM sites WHERE id = ?${this.scopeSql(true)}`)
                            .bind(...this.scopeParams([id]))
                    );
                }
                for (const id of staleGroupIds) {
                    removalStatements.push(
                        this.db
                            .prepare(`DELETE FROM groups WHERE id = ?${this.scopeSql(true)}`)
                            .bind(...this.scopeParams([id]))
                    );
                }

                stats.groupsRemoved = staleGroupIds.length;
                stats.sitesRemoved = staleSiteIds.length;
            }

            // 密码加密放在计划阶段之后、SQL 之前：几千条逐个 await 会把这一段拖成串行
            // 流水线，而加密是纯本地计算，压成一小批一小批并发跑最划算（限并发 16）。
            const encryptedTotal = siteDraft.length + siteUpdateDraft.length;
            if (encryptedTotal > 0) report("encrypt", 0, encryptedTotal);
            const sitePlan = await this.encryptSitePasswords(siteDraft, (done, _total) =>
                report("encrypt", done, encryptedTotal)
            );
            const siteUpdatePlan = await this.encryptSitePasswords(siteUpdateDraft, (done, _total) =>
                report("encrypt", siteDraft.length + done, encryptedTotal)
            );

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
                    // 恢复备份不覆盖管理员账号密码和 WebDAV 凭据。
                    // （AI 那组不在此列：2026-10-24 起整组跟着备份走。）
                    continue;
                }
                // 值形态校验：ai.endpoint 必须是 http(s):// —— 备份文件可能被改过，
                // 不挡的话下次用 AI 功能时请求就发到别人服务器上去了
                if (!isImportableConfigValue(key, value)) {
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

            // ── 记事本 ──
            //
            // 两种情形，靠字段是否存在区分：
            //   ① 备份里没有 notes 字段（老备份 / 用户关了「备份含记事本」）
            //      → **本地笔记一根汗毛都不动**。清空是不可逆的，宁可什么都不做。
            //   ② 有 notes 字段（默认路径）
            //      → 按 uuid 识别同一条：本地没有就插入；有就比 updated_at，
            //        文件里较新才覆盖，本地较新就跳过（保留本地）。
            //
            // ⚠️ 没有第三种了：以前还有一个「清空本地笔记再重灌」的 replace 模式，
            // 它与「导入不许删任何已有数据」直接冲突 —— 导入到一半失败、
            // 或用户挑错文件，本地写的笔记就没了。增量导入只做加法和就地更新。
            //
            // 关键：这一段只做**读**（要本地现有笔记），读到的结果用来算计划；
            // 真正的 INSERT / UPDATE 都在下面的第二阶段塞进同一个事务。
            const incomingNotes = normalized.notes;

            // 元数据只在笔记备份存在时恢复；老文件缺分类字段不清空本地分类。
            const folderMap = new Map<number, number>();
            const tagMap = new Map<number, number>();
            const metadataStatements: D1PreparedStatement[] = [];
            if (incomingNotes) {
                if (normalized.noteFolders) {
                    const local = await this.db.prepare(`SELECT id, name, parent_id FROM note_folder${this.scopeSql(false)}`)
                        .bind(...this.scopeParams([])).all<{ id: number; name: string; parent_id: number | null }>();
                    const max = await this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM note_folder").first<{ m: number }>();
                    let next = max?.m || 0;
                    const byPath = new Map((local.results || []).map(f => [JSON.stringify([f.parent_id ?? null, f.name]), f.id]));
                    const visiting = new Set<number>();
                    const source = new Map(normalized.noteFolders.map(f => [f.id, f]));
                    const add = (folder: NoteFolder): number => {
                        if (folder.id !== undefined && folderMap.has(folder.id)) return folderMap.get(folder.id)!;
                        if (folder.id !== undefined && visiting.has(folder.id)) throw new Error("备份文件夹层级存在循环");
                        if (folder.id !== undefined) visiting.add(folder.id);
                        const parent = folder.parent_id ? source.get(folder.parent_id) : undefined;
                        const parentId = parent ? add(parent) : null;
                        const key = JSON.stringify([parentId, folder.name]);
                        let id = byPath.get(key);
                        if (id === undefined) {
                            id = ++next;
                            byPath.set(key, id);
                            metadataStatements.push(this.db.prepare("INSERT INTO note_folder (id, user_id, name, order_num, parent_id) VALUES (?, ?, ?, ?, ?)")
                                .bind(id, this.currentUserId, folder.name, folder.order_num ?? 0, parentId));
                        }
                        if (folder.id !== undefined) { folderMap.set(folder.id, id); visiting.delete(folder.id); }
                        return id;
                    };
                    normalized.noteFolders.forEach(add);
                }
                for (const [table, rows, map] of [
                    ["note_tag", normalized.noteTags, tagMap],
                ] as const) {
                    if (!rows) continue;
                    const local = await this.db.prepare(`SELECT id, name FROM ${table}${this.scopeSql(false)}`)
                        .bind(...this.scopeParams([])).all<{ id: number; name: string }>();
                    const byName = new Map((local.results || []).map(r => [r.name, r.id]));
                    const max = await this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`)
                        .first<{ m: number }>();
                    let next = max?.m || 0;
                    for (const row of rows) {
                        let id = byName.get(row.name);
                        if (id === undefined) {
                            id = ++next;
                            byName.set(row.name, id);
                            metadataStatements.push(this.db.prepare("INSERT INTO note_tag (id, user_id, name, color) VALUES (?, ?, ?, ?)")
                                .bind(id, this.currentUserId, row.name, row.color ?? null));
                        }
                        if (typeof row.id === "number") map.set(row.id, id);
                    }
                }
            }
            const notePlan: Array<{
                id: number;
                uuid: string;
                title: string;
                content: string;
                pinned: boolean;
                order_num: number;
                site_id: number | null;
                folder_id?: number | null;
                archived?: boolean;
            }> = [];
            const importedMetadata = (n: Note) => ({
                folder_id: n.folder_id !== undefined ? folderMap.get(n.folder_id ?? 0) ?? null : undefined,
                archived: n.archived,
            });
            /** 本地已存在、需要就地覆盖的笔记 id（区别于新分配的 nextNoteId 段） */
            const existingNoteIds = new Set<number>();
            /** 覆盖模式要删的本地笔记 id（合并模式恒为空，一条都不动） */
            const staleNoteIds: number[] = [];
            const staleNoteTagLinks: number[] = [];

            if (incomingNotes) {
                // 合并：先读本地现有的，按 uuid 认同一条
                const localRows = await this.db
                    .prepare(
                        `SELECT id, uuid, title, content, pinned, order_num, site_id, updated_at FROM notes${this.scopeSql(
                            false
                        )}`
                    )
                    .bind(...this.scopeParams([]))
                    .all<Note>();
                const localByUuid = new Map<string, Note>();
                for (const row of localRows.results || []) {
                    // 没有 uuid 的老笔记不进索引：它没法参与去重，插进来的都会被当成新的
                    if (row.uuid) localByUuid.set(row.uuid, row);
                }

                for (const n of incomingNotes) {
                    const local = n.uuid ? localByUuid.get(n.uuid) : undefined;
                    if (!local) {
                        const id = ++nextNoteId;
                        notePlan.push({
                            id,
                            uuid: n.uuid!,
                            title: n.title,
                            content: n.content,
                            pinned: Boolean(n.pinned),
                            order_num: n.order_num ?? 0,
                            site_id: n.site_id != null ? siteIdMap[String(n.site_id)] ?? null : null,
                        ...importedMetadata(n),
                        });
                        noteStats.created += 1;
                        continue;
                    }
                    // 同一条笔记：比谁新。updated_at 缺失或解析不出来时，
                    // 保守起见判「本地较新」→ 跳过，不冒险覆盖用户正在用的那份
                    const localTime = Date.parse(local.updated_at || "") || 0;
                    const incomingTime = Date.parse(n.updated_at || "") || 0;
                    if (incomingTime > localTime) {
                        // 覆盖写回原 id —— 新建一条再删旧的，等于把 updated_at 弄丢了
                        notePlan.push({
                            id: local.id!,
                            uuid: n.uuid!,
                            title: n.title,
                            content: n.content,
                            pinned: Boolean(n.pinned),
                            order_num: n.order_num ?? 0,
                            site_id: n.site_id != null ? siteIdMap[String(n.site_id)] ?? null : null,
                        ...importedMetadata(n),
                        });
                        existingNoteIds.add(local.id!);
                        noteStats.updated += 1;
                    } else {
                        noteStats.skipped += 1;
                    }
                }
                // 覆盖模式：本地有、而这份备份里没有的笔记也要清掉。
                //
                // 仍然是「只删备份里没有的」，与卡片同一口径 —— 认得出是同一条的
                // 按 merge 那套比新旧（上面那段），认不出的才删。
                // 没有 uuid 的老笔记无法参与去重，覆盖模式下会被一起清掉：
                // 无从判断它是不是备份里那一条，留在库里就成了孤儿。
                if (overwrite) {
                    const incomingUuids = new Set(
                        incomingNotes.map(n => n.uuid).filter((u): u is string => !!u)
                    );
                    for (const row of localRows.results || []) {
                        if (row.uuid && incomingUuids.has(row.uuid)) continue;
                        if (typeof row.id !== "number") continue;
                        staleNoteIds.push(row.id);
                        // 标签关联跟着走：留下一批指向已删笔记的关联，
                        // 其它设备同步时会拿到引用不存在的行
                        staleNoteTagLinks.push(row.id);
                    }
                    noteStats.removed = staleNoteIds.length;
                } else {
                    // 本地多出来的笔记原样保留：removed 恒为 0
                    noteStats.removed = 0;
                }
            }

            // 覆盖模式要删的笔记：先掐掉标签关联，再删笔记本身。
            // 分块（每块 90 个 id）是给绑定参数上限留余量 —— D1 一条语句最多 100 个参数，
            // 一次删几百条笔记拼成一整条 IN(...) 会直接被拒。
            const noteRemovalStatements: D1PreparedStatement[] = [];
            for (let offset = 0; offset < staleNoteTagLinks.length; offset += 90) {
                const chunk = staleNoteTagLinks.slice(offset, offset + 90);
                noteRemovalStatements.push(
                    this.db
                        .prepare(
                            `DELETE FROM note_note_tag WHERE note_id IN (${chunk
                                .map(() => "?")
                                .join(",")})`
                        )
                        .bind(...chunk)
                );
            }
            for (let offset = 0; offset < staleNoteIds.length; offset += 90) {
                const chunk = staleNoteIds.slice(offset, offset + 90);
                noteRemovalStatements.push(
                    this.db
                        .prepare(
                            `DELETE FROM notes WHERE id IN (${chunk
                                .map(() => "?")
                                .join(",")})${this.scopeSql(true)}`
                        )
                        .bind(...this.scopeParams(chunk))
                );
            }

            // ── 第二阶段：整批提交（一个 D1 事务 = 原子切换）──
            //
            // 合并模式下这里只有 INSERT / UPDATE，没有任何 DELETE —— 连「先删后插」的
            // 关联重建都不做（ note_note_tag 用的是 INSERT OR IGNORE）。
            // 覆盖模式下会多出一批删除语句，它们与写入**同一个事务**提交：
            // 要么整份备份生效，要么一个字节都不变，不存在「删完了没写进去」。
            // ── 保险库（端到端加密，只搬密文）──
            // 自包含密文单元：keys（KDF 参数 + 两份包好的 DEK）+ entries（全部条目密文）。
            // 服务端解不开，备份文件整体再 AES-GCM 一次，不泄露明文、不做任何加解密。
            // 与笔记同一套「字段缺失 = 不动本地」：备份没有 vault 字段 → 本地保险库一根汗毛都不动。
            // 备份有 vault → 它是一把独立 DEK，和本地现有保险库（若有）大概率不是同一把钥匙，密文级无法合并：
            //   合并模式：本地已有保险库 → 整体跳过（保留本地，否则本地条目永久解不开）；本地没有 → 整包接纳。
            //   覆盖模式：明确还原成「备份那一刻」，整包替换（先删本地 keys+entries 再插）。
            // 条目 site_id 指向导航卡片；导入后站点重发号（siteIdMap），必须跟着重映射，否则绑定会断；映射不到置空。
            const incomingVault = normalized.vault;
            const vaultStatements: D1PreparedStatement[] = [];
            if (incomingVault) {
                const localVaultExists = (await this.getVaultKeys()) !== null;
                const shouldAdopt = !localVaultExists;
                if (overwrite || shouldAdopt) {
                    vaultStatements.push(
                        this.db.prepare(`DELETE FROM vault_keys${this.scopeSql(false)}`).bind(...this.scopeParams([]))
                    );
                    vaultStatements.push(
                        this.db.prepare(`DELETE FROM vault_entries${this.scopeSql(false)}`).bind(...this.scopeParams([]))
                    );
                    vaultStatements.push(
                        this.db
                            .prepare(
                                `INSERT INTO vault_keys (user_id, kdf_salt, kdf_iterations, wrapped_dek_iv, wrapped_dek,
                                   wrapped_dek_recovery_iv, wrapped_dek_recovery)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`
                            )
                            .bind(
                                this.currentUserId,
                                incomingVault.keys.kdf_salt,
                                incomingVault.keys.kdf_iterations,
                                incomingVault.keys.wrapped_dek_iv,
                                incomingVault.keys.wrapped_dek,
                                incomingVault.keys.wrapped_dek_recovery_iv,
                                incomingVault.keys.wrapped_dek_recovery
                            )
                    );
                    let nextVaultEntryId =
                        (await this.db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM vault_entries").first<{ m: number }>())?.m || 0;
                    nextVaultEntryId += 1;
                    for (const entry of incomingVault.entries) {
                        const mappedSiteId = entry.site_id != null ? siteIdMap[String(entry.site_id)] ?? null : null;
                        vaultStatements.push(
                            this.db
                                .prepare(`INSERT INTO vault_entries (id, user_id, ciphertext, iv, site_id) VALUES (?, ?, ?, ?, ?)`)
                                .bind(nextVaultEntryId++, this.currentUserId, entry.ciphertext, entry.iv, mappedSiteId)
                        );
                    }
                    vaultResult = { action: overwrite ? "replaced" : "adopted", entries: incomingVault.entries.length };
                } else {
                    vaultResult = { action: "skipped", entries: 0 };
                }
            }

            const commitStatements: D1PreparedStatement[] = [
                ...metadataStatements,
                ...noteRemovalStatements,
                ...removalStatements,
                ...vaultStatements,
            ];
            for (const n of notePlan) {
                // 同一个 uuid 既可能是「新建」也可能是「覆盖本地那条」——
                // 用 ON CONFLICT 的话需要 uuid 上有唯一索引，而老库里可能有重复
                // （uuid 是后加的列）。所以这里分两句：id 是新分配的就 INSERT，
                // 是本地已有 id 的（merge 覆盖）就 UPDATE。
                const isExisting = existingNoteIds.has(n.id);
                if (isExisting) {
                    commitStatements.push(
                        this.db
                            .prepare(
                                `UPDATE notes SET uuid = ?, title = ?, content = ?, pinned = ?,
                                 order_num = ?, site_id = ?, folder_id = CASE WHEN ? THEN ? ELSE folder_id END,
                                 archived = COALESCE(?, archived), updated_at = CURRENT_TIMESTAMP
                                 WHERE id = ?${this.scopeSql(true)}`
                            )
                            .bind(...this.scopeParams([
                                n.uuid, n.title, n.content, n.pinned ? 1 : 0,
                                n.order_num, n.site_id, n.folder_id !== undefined ? 1 : 0,
                                n.folder_id ?? null, n.archived === undefined ? null : n.archived ? 1 : 0,
                                n.id,
                            ]))
                    );
                } else {
                    commitStatements.push(
                        this.db
                            .prepare(
                                `INSERT INTO notes (id, user_id, uuid, title, content, pinned, order_num, site_id, folder_id, archived)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            )
                            .bind(
                                n.id,
                                // user_id 只能是**导入者自己** —— 文件里那个值是导出方的，
                                // 照抄会把笔记写到别人名下，而这个字段是唯一的隔离依据
                                this.currentUserId,
                                n.uuid,
                                n.title,
                                n.content,
                                n.pinned ? 1 : 0,
                                n.order_num,
                                n.site_id,
                                n.folder_id ?? null,
                                n.archived ? 1 : 0
                            )
                    );
                }
            }

            if (incomingNotes && normalized.noteTagLinks !== undefined) {
                for (const n of notePlan) {
                    // ⚠️ 这里刻意**不删**旧的关联：那条 DELETE 是给「覆盖式恢复」擦屁股用的，
                    // 增量语义下删掉用户自己勾过的标签就是丢数据。INSERT OR IGNORE 只补缺的，
                    // 重复导入同一份备份也因此是幂等的。
                    const ids = new Set(normalized.noteTagLinks.filter(l => l.note_uuid === n.uuid)
                        .map(l => tagMap.get(l.tag_id)).filter((id): id is number => id !== undefined));
                    for (const tagId of ids) {
                        commitStatements.push(this.db.prepare("INSERT OR IGNORE INTO note_note_tag (note_id, tag_id) VALUES (?, ?)")
                            .bind(n.id, tagId));
                    }
                }
            }

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
            // 站点「就地更新」：落在备份里那条较新的已存在卡片上（不换 id，星标 / 标签不丢）。
            // 走 MAT 更新而不是「删了重建」—— 重建会把 id 换了，本地星标与访问统计全跟着失效。
            for (const s of siteUpdatePlan) {
                commitStatements.push(
                    this.db
                        .prepare(
                            `UPDATE sites SET group_id = ?, name = ?, url = ?, icon = ?,
                             description = ?, notes = ?, username = ?, password = ?,
                             order_num = ?, updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?${this.scopeSql(true)}`
                        )
                        .bind(...this.scopeParams([
                            s.groupId, s.name, s.url, s.icon,
                            s.description, s.notes, s.username, s.password,
                            s.order_num, s.id,
                        ]))
                );
            }
            for (const c of configPlan) {
                // ⚠️ 末尾的 WHERE excluded.value <> '' 是有意为之：
                // 备份里「没设置过」的配置是空串（如 site.iconApi: ""），
                // 增量导入不能拿一个空值把现有配置清掉 —— 那是「清空数据」的一种形态。
                // 反过来，这份备份里确实没写的 key 根本不会走到这里，现有配置照样不受影响。
                commitStatements.push(
                    c.uid === null
                        ? this.db
                              .prepare("INSERT INTO configs (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP WHERE excluded.value <> ''")
                              .bind(c.key, c.value)
                        : this.db
                              .prepare("INSERT INTO user_configs (user_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP WHERE excluded.value <> ''")
                              .bind(c.uid, c.key, c.value)
                );
            }

            // 提交必须只有一个事务：把「新建 + 已有记录就地更新 + 关联」一次性落库。
            const total = commitStatements.length;
            report("write", 0, total);
            // 超出服务端容量时整批失败（数据库自动回滚），不再分块 ——
            // 分块会让「前 90 条写进去、后面失败」变成可能，而现在要做到的是
            // 「要么全成、要么一个字节都没动」。
            if (commitStatements.length > 0) {
                const committed = await this.db.batch(commitStatements);
                if (committed.some(result => !result.success)) {
                    throw new Error("导入事务提交失败");
                }
                report("write", total, total);
            }
            report("done", total, total);

            return {
                success: true,
                groupIdMap,
                siteIdMap,
                // 笔记三态统计。合并模式下「本地较新就跳过」是正确行为，
                // 但不给用户一个数字他会以为导入没生效。
                noteStats,
                // 卡片 / 分组的账：重复导入时这几个数应该全是 0（除了 skipped 变多）
                stats,
                vault: vaultResult,
            };
        } catch (error) {
            console.error("导入数据失败:", error);
            // 所有写入都在**同一个 batch（= 一个事务）**里，失败由数据库整批回滚，
            // 不存在「写了一半」的中间态，也就不必（且不准）事后按 id 去补偿删除 ——
            // 那种删除本身还会误伤并发写进来的行。
            const base = error instanceof Error ? error.message : "导入数据失败";
            return {
                success: false,
                message: base,
                groupIdMap,
                siteIdMap,
                // 笔记三态统计。合并模式下「本地较新就跳过」是正确行为，
                // 但不给用户一个数字他会以为导入没生效。
                noteStats,
                stats,
                vault: vaultResult,
            };
        } finally {
            // 仅释放本次实际取得的锁；拒绝请求也会进 finally，不能删持有者的锁。
            if (lockAcquired && typeof this.releaseIdempotency === "function") {
                await this.releaseIdempotency(lockScope, lockKey).catch(() => {});
            }
        }
    },

    /**
     * 批量加密站点密码（备份里是明文，写回 D1 前必须加密）。
     *
     * 限并发而不是「全并发」：一次几千个 Promise 会让 Worker 的 CPU 时间片被这一件事吃满，
     * 同 isolate 上别的请求只能干等；也不是「全串行」—— 那会把纯本地计算拖成
     * 几千次顺序 await。取一个固定的小窗口，边推进边回调进度。
     */
    encryptSitePasswords: async function (
        this: NavigationAPI,
        drafts: readonly SitePlan[],
        onProgress?: (done: number, total: number) => void
    ): Promise<SitePlan[]> {
        // 备份里是明文，写回 D1 前加密
        return mapWithConcurrency(
            drafts,
            ENCRYPT_CONCURRENCY,
            async draft => ({
                ...draft,
                password: await encryptSecret(draft.password || "", this.keyring),
            }),
            onProgress
        );
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

    /** 当前账号（单账号部署则是全部）在某张表里的行 id。
     *  注意：增量导入**不再**用它删东西；留着是为了测试与排障能查出某个账号名下有哪些行。 */
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

};

// 备份文件格式版本号。
// 1.3：全站共享配置从 configs 拆到 sharedConfigs（且只有所有者导出时才带），
// 导入不再保留备份里的 id（改由数据库重新发号并回传映射）。
export const EXPORT_VERSION = "1.4";

/**
 * 把备份里的 `version` 解析成数字段（`"1.10"` → `[1, 10]`）。
 *
 * ⚠️ 必须按**段**比数字，不能按字符串比：字符串比较里 `"1.10" < "1.9"`，
 * 那会让 1.10 导出的备份在只认到 1.9 的旧版本上大摇大摆地导进来 ——
 * 正好是这个闸门要挡的那类事故。
 *
 * 解析不了（缺字段 / 手改成 "test" / "1.4-beta"）返回 null，由调用方按
 * 「未知版本」处理，**不当成错误**：存量老备份里什么写法都有，一条解析不了
 * 就拒绝导入等于把用户的数据锁死在文件里。
 */
export function parseBackupVersion(value: unknown): number[] | null {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const text = String(value).trim();
    if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
    const parts = text.split(".").map(Number);
    return parts.every(n => Number.isSafeInteger(n) && n >= 0) ? parts : null;
}

/**
 * 按数字段比较两个版本号：a 比 b 新返回 1，旧返回 -1，相同返回 0。
 * 任意一边解析不了就返回 0 —— 「不认识的版本」不构成拒绝导入的理由。
 */
export function compareBackupVersion(a: unknown, b: unknown): number {
    const left = parseBackupVersion(a);
    const right = parseBackupVersion(b);
    if (!left || !right) return 0;
    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
        const x = left[i] ?? 0;
        const y = right[i] ?? 0;
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

export type BackupVersionStatus = "current" | "older" | "newer" | "unknown";

export interface BackupVersionCheck {
    /** false = 不许导入（只有「备份比当前版本新」这一种情况） */
    ok: boolean;
    status: BackupVersionStatus;
    /** 备份自称的版本；缺字段时等于当前支持的版本 */
    backupVersion: string;
    supportedVersion: string;
    /** 给用户看的一句话：ok=false 时是拒绝原因，否则是兼容提示 */
    message?: string;
}

/**
 * 备份版本闸门。
 *
 * 为什么需要它：导入侧过去是 `version: raw.version || EXPORT_VERSION` —— 读进来
 * 就丢，一个字都不校验。于是「新版导出的备份在老版本上导入」时，老代码不认识
 * 新字段，静默丢掉，用户看到的却是「恢复成功」。
 *
 * 三种结论：
 *   - 比当前版本**新** → 拒绝（说清是哪个版本、支持到哪个版本、该怎么升级）
 *   - 比当前版本**旧** → 放行，但给一句兼容提示（旧备份没有的设置项保持现状）
 *   - 缺版本号 / 解析不了 → 放行，按兼容模式导入（不能把存量用户堵死）
 */
export function checkBackupVersion(rawVersion: unknown): BackupVersionCheck {
    const supportedVersion = EXPORT_VERSION;
    const raw = typeof rawVersion === "string" ? rawVersion.trim() : "";
    const backupVersion = raw || supportedVersion;
    const parsed = parseBackupVersion(raw);

    if (!parsed) {
        return {
            ok: true,
            status: "unknown",
            backupVersion,
            supportedVersion,
            message: raw
                ? `备份的版本号「${raw}」无法识别，已按兼容模式导入`
                : "这份备份没有版本号（很旧的备份），已按兼容模式导入",
        };
    }

    const cmp = compareBackupVersion(parsed.join("."), supportedVersion);
    if (cmp > 0) {
        return {
            ok: false,
            status: "newer",
            backupVersion,
            supportedVersion,
            message:
                `这份备份来自更新的版本（${backupVersion}），` +
                `当前版本只支持到 ${supportedVersion}，请先升级再导入。` +
                `强行导入会静默丢掉这份备份里新版本才有的内容。`,
        };
    }
    if (cmp < 0) {
        return {
            ok: true,
            status: "older",
            backupVersion,
            supportedVersion,
            message:
                `这份备份来自较旧的版本（${backupVersion}），已按兼容模式导入；` +
                `旧备份里没有的设置项会保持当前值不变`,
        };
    }
    return { ok: true, status: "current", backupVersion, supportedVersion };
}

/** 「备份比当前版本新」时 normalizeImportData 抛出的错误，调用方据此给用户准确文案。 */
export class BackupVersionError extends Error {
    readonly code = "BACKUP_VERSION_TOO_NEW" as const;
    readonly backupVersion: string;
    readonly supportedVersion: string;

    constructor(check: BackupVersionCheck) {
        super(
            check.message ||
                `备份版本（${check.backupVersion}）高于当前支持的版本（${check.supportedVersion}），请先升级再导入`
        );
        this.name = "BackupVersionError";
        this.backupVersion = check.backupVersion;
        this.supportedVersion = check.supportedVersion;
    }
}

// 兼容多种备份格式：
// 1) 标准格式 { groups, sites, configs }
// 2) 旧格式   { groups: [{ ...group, sites: [...] }], configs }
// 1.3 起全站设置挪到 sharedConfigs；老备份没有这个字段，全站设置还混在 configs 里，
// 导入时按同一套归属规则判断（见 importData）。
export function normalizeImportData(data: ExportData | Record<string, unknown>): ExportData {
    const raw = (data || {}) as {
        groups?: (Group & { sites?: Site[] })[];
        sites?: Site[];
        notes?: Note[];
        noteFolders?: NoteFolder[];
        noteTags?: NoteTag[];
        noteTagLinks?: { note_uuid: string; tag_id: number }[];
        configs?: Record<string, string>;
        sharedConfigs?: Record<string, string>;
        version?: string;
        exportDate?: string;
        localPrefs?: LocalPrefsBackup;
        vault?: { keys?: VaultKeysRecord; entries?: VaultEntryRecord[] };
    };

    // ── 版本闸门（必须在动任何数据之前）──
    //
    // 「比当前版本新的备份」一律拒绝：老代码不认识新字段，会静默丢掉一部分内容，
    // 而用户看到的是「恢复成功」—— 数据缺失比报错难查得多。反过来，更旧 / 没有
    // 版本号的备份继续放行（存量用户的文件必须能导回来），只留一句兼容提示。
    const versionCheck = checkBackupVersion(raw.version);
    if (!versionCheck.ok) throw new BackupVersionError(versionCheck);

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

    // 记事本：content 是 Markdown 源码，这里只做「保证是字符串」的归一化，
    // 不做内容改写 —— 渲染层会把任何非文本的东西当纯文本显示，不会执行。
    // ⚠️ 没有 uuid 的老笔记要在这里补一个：合并导入全靠 uuid 识别同一条，
    // 缺了就会退化成「每次导入都多一份」。
    const rawNotes = Array.isArray(raw.notes) ? raw.notes : undefined;
    const notes: Note[] | undefined = rawNotes
        ? rawNotes.map((n, index) => ({
              uuid: typeof n?.uuid === "string" && n.uuid ? n.uuid : `legacy-${index}-${Date.now().toString(36)}`,
              title: typeof n?.title === "string" ? n.title : "",
              content: typeof n?.content === "string" ? n.content : "",
              pinned: Boolean(n?.pinned),
              order_num: typeof n?.order_num === "number" ? n.order_num : index,
              site_id: typeof n?.site_id === "number" ? n.site_id : null,
              ...(n?.folder_id !== undefined ? { folder_id: Number.isInteger(n.folder_id) && n.folder_id! > 0 ? n.folder_id : null } : {}),
              ...(n?.archived !== undefined ? { archived: Boolean(n.archived) } : {}),
              created_at: n?.created_at,
              updated_at: n?.updated_at,
          }))
        : undefined;

    // 保险库：整包密文单元。缺字段或形状不对就当「没有」（导入时本地保险库保持不动）。
    const rawVault = raw.vault;
    const vault: VaultBackup | undefined =
        rawVault && rawVault.keys && Array.isArray(rawVault.entries)
            ? {
                  keys: {
                      kdf_salt: String(rawVault.keys.kdf_salt ?? ""),
                      kdf_iterations: Number(rawVault.keys.kdf_iterations ?? 0),
                      wrapped_dek_iv: String(rawVault.keys.wrapped_dek_iv ?? ""),
                      wrapped_dek: String(rawVault.keys.wrapped_dek ?? ""),
                      wrapped_dek_recovery_iv: String(rawVault.keys.wrapped_dek_recovery_iv ?? ""),
                      wrapped_dek_recovery: String(rawVault.keys.wrapped_dek_recovery ?? ""),
                  },
                  entries: (rawVault.entries as (VaultEntryRecord | undefined)[]).map(e => ({
                      id: Number(e?.id ?? 0),
                      ciphertext: String(e?.ciphertext ?? ""),
                      iv: String(e?.iv ?? ""),
                      site_id: typeof e?.site_id === "number" ? e.site_id : null,
                  })),
              }
            : undefined;

    return {
        groups,
        sites,
        // **字段缺失与空数组是两件事**：老备份没有这个字段 → undefined →
        // 导入时保持本地笔记原样不动。空数组 → 明确「这份备份里一条笔记都没有」。
        ...(notes ? { notes } : {}),
        ...(notes && Array.isArray(raw.noteFolders) ? { noteFolders: raw.noteFolders.map(f => ({
            id: f.id, name: typeof f.name === "string" ? f.name.slice(0, 80) : "新建文件夹",
            order_num: Number.isFinite(f.order_num) ? f.order_num : 0,
            parent_id: Number.isInteger(f.parent_id) && f.parent_id! > 0 ? f.parent_id : null,
        })) } : {}),
        ...(notes && Array.isArray(raw.noteTags) ? { noteTags: raw.noteTags.map(t => ({
            id: t.id, name: typeof t.name === "string" ? t.name.slice(0, 80) : "新标签",
            color: typeof t.color === "string" ? t.color : null,
        })) } : {}),
        ...(notes && Array.isArray(raw.noteTagLinks) ? { noteTagLinks: raw.noteTagLinks.filter(l =>
            typeof l?.note_uuid === "string" && Number.isInteger(l.tag_id) && l.tag_id > 0
        ).map(l => ({ note_uuid: l.note_uuid, tag_id: l.tag_id })) } : {}),
        configs: raw.configs && typeof raw.configs === "object" ? raw.configs : {},
        // 全站共享配置：老备份没有这个字段，导入时那份全站设置从 configs 里按规则挑
        ...(raw.sharedConfigs && typeof raw.sharedConfigs === "object"
            ? { sharedConfigs: raw.sharedConfigs }
            : {}),
        // 版本号如实回传（缺字段的老备份才补成当前版本），并带上闸门给的兼容提示。
        // versionNotice 只在本机用（UI 可以拿它提示「这份备份来自旧版本」），
        // 不会写回文件、也不进请求体。
        version: versionCheck.backupVersion,
        ...(versionCheck.message ? { versionNotice: versionCheck.message } : {}),
        exportDate: raw.exportDate || new Date().toISOString(),
        // 星标 / 标签这类本机偏好原样透传，交给前端写回 localStorage
        ...(raw.localPrefs && typeof raw.localPrefs === "object"
            ? { localPrefs: sanitizeLocalPrefs(raw.localPrefs) }
            : {}),
        ...(vault ? { vault } : {}),
    };
}
