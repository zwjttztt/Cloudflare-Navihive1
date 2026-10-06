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
import { BACKUP_NOTES_CONFIG,
    BACKUP_CREDENTIALS_CONFIG } from "../configKeys";
import { encryptSecret } from "../crypto";
import {
    Config,
    ExportData,
    Group,
    ImportOptions,
    ImportResult,
    ImportStage,
    LocalPrefsBackup,
    Note,
    NoteImportStats,
    NoteFolder,
    NoteTag,
    Site,
} from "../types";
import { sanitizeIconUrl, sanitizeLocalPrefs, stripSiteCredentials } from "./internals";

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
        notes: Note[];
        noteFolders: NoteFolder[];
        noteTags: NoteTag[];
        noteTagLinks: { note_uuid: string; tag_id: number }[];
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
    rollbackCreatedRows(siteIds: number[], groupIds: number[], noteIds: number[]): Promise<void>;
}

export const transferImpl: TransferApi = {

    // 导出所有数据
    exportData: async function (this: NavigationAPI ): Promise<ExportData> {
        await this.migrate();
        // 一次 batch 取回分组 + 站点 + 配置，只花一次 D1 往返（原来是三次）
        const { groups, sites, configs, notes, noteFolders, noteTags, noteTagLinks } = await this.withSchemaRetry(() =>
            this.queryExportBundle()
        );

        // M4：默认不含站点账号密码（明文 JSON 备份会被 WebDAV 同步到网盘，凭据跟着走风险高）。
        // 只有用户主动开启「备份含登录凭据」（backup.includeCredentials=true）才带。
        const withCreds = configs[BACKUP_CREDENTIALS_CONFIG] === "true";

        // 记事本：**默认带上**（它是主要内容），只有显式写成 "false" 才排除。
        // 与上面的凭据开关刻意分开：那个默认不带（凭据敏感），合成一个开关的话
        // 用户为了拿笔记就得把密码也导出去。
        const withNotes = configs[BACKUP_NOTES_CONFIG] !== "false";

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
            // 关掉「备份含记事本」时整块不放 notes 字段（而不是放空数组）：
            // 空数组会被导入当成「备份里有一条笔记都没有」，从而清空本地；
            // 字段缺失才表示「这份备份与记事本无关」，导入时保持本地不动。
            ...(withNotes ? { notes, noteFolders, noteTags, noteTagLinks } : {}),
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
        notes: Note[];
        noteFolders: NoteFolder[];
        noteTags: NoteTag[];
        noteTagLinks: { note_uuid: string; tag_id: number }[];
    }> {
        // 记事本跟着同一次 batch 走 —— 多一张表不该多一次 D1 往返
        const [groupResult, siteResult, configResult, noteResult, folderResult, tagResult, linkResult] = await this.db.batch<
            Group | Site | Config | Note | NoteFolder | NoteTag | { note_uuid: string; tag_id: number }
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
            this.db
                .prepare(
                    `SELECT id, uuid, title, content, pinned, order_num, site_id, folder_id, archived, created_at, updated_at FROM notes${this.scopeSql(
                        false
                    )} ORDER BY pinned DESC, order_num, id`
                )
                .bind(...this.scopeParams([])),
            this.db.prepare(`SELECT * FROM note_folder${this.scopeSql(false)} ORDER BY order_num, id`)
                .bind(...this.scopeParams([])),
            this.db.prepare(`SELECT * FROM note_tag${this.scopeSql(false)} ORDER BY id`)
                .bind(...this.scopeParams([])),
            this.db.prepare(`SELECT n.uuid AS note_uuid, l.tag_id FROM note_note_tag l
                JOIN notes n ON n.id = l.note_id
                WHERE n.id IN (SELECT id FROM notes${this.scopeSql(false)})
                  AND l.tag_id IN (SELECT id FROM note_tag${this.scopeSql(false)})`)
                .bind(...this.scopeParams([]), ...this.scopeParams([])),
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
            // 导出时把 id / user_id 抹掉：id 是对方库里的 AUTOINCREMENT，照搬必撞主键；
            // user_id 更是只能由导入者自己决定（那是唯一的账号隔离依据）。
            // uuid 保留 —— 合并导入靠它识别「同一条笔记」。
            notes: ((noteResult.results || []) as Note[]).map(n => ({
                uuid: n.uuid,
                title: n.title,
                content: n.content,
                pinned: n.pinned,
                order_num: n.order_num,
                site_id: n.site_id,
                folder_id: n.folder_id ?? null,
                archived: Boolean(n.archived),
                created_at: n.created_at,
                updated_at: n.updated_at,
            })),
            noteFolders: ((folderResult.results || []) as NoteFolder[]).map(({ user_id: _uid, count: _count, ...folder }) => folder),
            noteTags: ((tagResult.results || []) as NoteTag[]).map(({ user_id: _uid, count: _count, ...tag }) => tag),
            noteTagLinks: (linkResult.results || []) as { note_uuid: string; tag_id: number }[],
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
        // 本次新写进去的行 id：失败时靠它们回滚（旧数据一步都没动过，删掉这些就回到原样）
        const createdGroupIds: number[] = [];
        const createdSiteIds: number[] = [];
        /** 本次新建的笔记 id：分批提交中途失败时靠它回滚（漏清会留下用户看不见的孤儿笔记） */
        const createdNoteIds: number[] = [];
        let lockAcquired = false;

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
            let nextNoteId = 0;
            const groupBase = await this.nextIdBase("groups");
            const siteBase = await this.nextIdBase("sites");
            nextNoteId = await this.nextIdBase("notes");

            // 第一阶段：把要写什么算清楚（加密、权限判定这些含 await 的都在这里做完），
            // 第二阶段只负责往 batch 里塞纯 SQL —— 保证事务里没有「等待」。
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
            // 先把「每个站点要写成什么」记下来（id 与分组归属在这一步定好），
            // 密码单独走一趟限并发的加密：几千条逐个 await 会把这一段拖成串行流水线，
            // 而加密是纯本地计算，压成一小批一小批并发跑最划算。
            const siteDraft: SitePlan[] = [];
            for (const site of normalized.sites) {
                const mapped = site.group_id !== undefined && site.group_id !== null
                    ? groupIdMap[String(site.group_id)]
                    : undefined;
                const groupId = typeof mapped === "number" ? mapped : orphanGroupId;
                if (typeof groupId !== "number") {
                    throw new Error(`站点「${site.name}」找不到所属分组`);
                }
                const id = nextSiteId++;
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
                if (site.id !== undefined) siteIdMap[String(site.id)] = id;
                createdSiteIds.push(id);
            }

            const sitePlan = await this.encryptSitePasswords(siteDraft, (done, total) =>
                report("encrypt", done, total)
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

            // ── 记事本 ──
            //
            // 三种情形，语义完全不同，**靠字段是否存在区分**：
            //   ① 备份里没有 notes 字段（老备份 / 用户关了「备份含记事本」）
            //      → **本地笔记一根汗毛都不动**。清空是不可逆的，宁可什么都不做。
            //   ② notesMode='replace'（用户明确选了「完全覆盖」）
            //      → 清掉本地全部笔记，再插入备份里的。
            //   ③ notesMode='merge'（默认）
            //      → 按 uuid 识别同一条：本地没有就插入；有就比 updated_at，
            //        文件里较新才覆盖，本地较新就跳过（保留本地）。
            //
            // 关键：这一段只做**读**（要本地现有笔记），读到的结果用来算计划；
            // 真正的 INSERT / DELETE 都在下面的第二阶段塞进同一个事务。
            const notesMode = opts?.notesMode === "replace" ? "replace" : "merge";
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
            /** replace 模式要清的本地笔记 id；merge 模式为空数组（本地一律不动） */
            const staleNoteIds: string[] = [];

            if (incomingNotes) {
                if (notesMode === "replace") {
                    staleNoteIds.push(...(await this.listOwnedIds("notes")).map(String));
                    for (const n of incomingNotes) {
                        const id = ++nextNoteId;
                        createdNoteIds.push(id);
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
                    }
                } else {
                    // 合并：先读本地现有的（只在这个分支读 —— replace 用不上）
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
                            createdNoteIds.push(id);
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
                            noteStats.updated += 1;
                        } else {
                            noteStats.skipped += 1;
                        }
                    }
                    noteStats.removed = 0;
                }
                noteStats.removed = staleNoteIds.length;
            }

            // ── 第二阶段：整批提交（一个 D1 事务 = 原子切换）──
            const commitStatements: D1PreparedStatement[] = [...metadataStatements];

            // 记事本：replace 模式先清本地全部（和卡片一样「先插新的成功、再删旧的」
            // 的顺序反过来 —— 这里是**同一个事务**里先 DELETE 再 INSERT，
            // 中途失败整批回滚，本地笔记不会少）。
            // merge 模式下 staleNoteIds 恒为空，本地一条都不动。
            for (let offset = 0; offset < staleNoteIds.length; offset += 90) {
                const chunk = staleNoteIds.slice(offset, offset + 90);
                commitStatements.push(this.db.prepare(`DELETE FROM note_note_tag WHERE note_id IN
                    (SELECT id FROM notes WHERE id IN (${chunk.map(() => "?").join(",")})${this.scopeSql(true)})`)
                    .bind(...this.scopeParams(chunk)));
                commitStatements.push(
                    this.db
                        .prepare(
                            `DELETE FROM notes WHERE id IN (${chunk
                                .map(() => "?")
                                .join(",")})${this.scopeSql(true)}`
                        )
                        .bind(...this.scopeParams(chunk))
                );
            }
            for (const n of notePlan) {
                // 同一个 uuid 既可能是「新建」也可能是「覆盖本地那条」——
                // 用 ON CONFLICT 的话需要 uuid 上有唯一索引，而老库里可能有重复
                // （uuid 是后加的列）。所以这里分两句：id 是新分配的就 INSERT，
                // 是本地已有 id 的（merge 覆盖）就 UPDATE。
                const isExisting = !createdNoteIds.includes(n.id);
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
                    commitStatements.push(this.db.prepare(`DELETE FROM note_note_tag WHERE note_id IN
                        (SELECT id FROM notes WHERE id = ?${this.scopeSql(true)})`)
                        .bind(...this.scopeParams([n.id])));
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

            // 提交必须只有一个事务：包含新增、已有笔记更新、关联与旧数据清理。
            const total = commitStatements.length;
            report("write", 0, total);
            // 关联恢复和已有笔记 UPDATE 无法靠删除新行补偿，必须一次事务提交。
            // 超出服务端容量时整批失败，不允许先删旧笔记后分块落库。
            if (commitStatements.length > 0) {
                const committed = await this.db.batch(commitStatements);
                if (committed.some(result => !result.success)) {
                    throw new Error("恢复事务提交失败");
                }
                report("write", total, total);
            }
            report("cleanup", total, total);
            report("done", total, total);

            return {
                success: true,
                groupIdMap,
                siteIdMap,
                // 笔记三态统计。合并模式下「本地较新就跳过」是正确行为，
                // 但不给用户一个数字他会以为导入没生效。
                noteStats,
            };
        } catch (error) {
            console.error("导入数据失败:", error);
            // 单次 batch 失败由 D1 整批回滚。不得按预分配 ID 发补偿删除，
            // 因为这些 ID 可能已被另一个并发写入占用。
            const base = error instanceof Error ? error.message : "导入数据失败";
            return {
                success: false,
                message: base,
                groupIdMap,
                siteIdMap,
                // 笔记三态统计。合并模式下「本地较新就跳过」是正确行为，
                // 但不给用户一个数字他会以为导入没生效。
                noteStats,
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
    rollbackCreatedRows: async function (
        this: NavigationAPI,
        siteIds: number[],
        groupIds: number[],
        noteIds: number[] = []
    ): Promise<void> {
        try {
            await this.deleteRowsByIds("sites", siteIds);
            await this.deleteRowsByIds("groups", groupIds);
            // 合并模式下被「覆盖」的那几条是 UPDATE，回滚不了（那是覆盖不是新建）；
            // 这里只清**新建**的。漏清会留下一批用户看不见的孤儿笔记。
            if (noteIds.length > 0) {
                for (let offset = 0; offset < noteIds.length; offset += 90) {
                    const chunk = noteIds.slice(offset, offset + 90);
                    await this.db
                        .prepare(
                            `DELETE FROM notes WHERE id IN (${chunk
                                .map(() => "?")
                                .join(",")})${this.scopeSql(true)}`
                        )
                        .bind(...this.scopeParams(chunk))
                        .run();
                }
            }
        } catch (error) {
            console.error("导入失败后回滚新建数据失败:", error);
            // 回滚失败必须留痕：这批行已经不在任何人的视野里（前端只看到「导入失败」），
            // 没人知道库里多了些孤儿卡片。写进审计日志，日后能按 id 找出来清掉。
            try {
                await this.writeAudit(
                    "import.rollbackFailed",
                    "",
                    "",
                    `回滚未清理: sites=${siteIds.join(",") || "-"} groups=${groupIds.join(",") || "-"} notes=${noteIds.join(",") || "-"}`
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
export const EXPORT_VERSION = "1.4";

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
        version: raw.version || EXPORT_VERSION,
        exportDate: raw.exportDate || new Date().toISOString(),
        // 星标 / 标签这类本机偏好原样透传，交给前端写回 localStorage
        ...(raw.localPrefs && typeof raw.localPrefs === "object"
            ? { localPrefs: sanitizeLocalPrefs(raw.localPrefs) }
            : {}),
    };
}
