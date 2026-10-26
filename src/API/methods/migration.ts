// src/API/methods/migration.ts
// NavigationAPI 的「migration」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { RECOVERY_PUBLIC_KEY_CONFIG, WEBDAV_CONFIG_PREFIX } from "../configKeys";
import { encryptSecret, hashPassword, isHashedPassword } from "../crypto";
import { countWikiLinks } from "../../utils/noteWikiLinkCount";
import type { D1PreparedStatement } from "../schema";
import {
    ATTACHMENTS_TABLE_STATEMENTS,
    CREATE_STATEMENTS,
    FOLDER_TAG_TABLE_STATEMENTS,
    INDEX_STATEMENTS,
    NOTES_FTS_TABLE_SQL,
    VAULT_TABLE_STATEMENTS,
    migrationState,
} from "./internals";

/**
 * 表结构版本号，**只进不退**。
 *
 * 只要往 runMigrations 里加了新步骤（补列 / 建索引 / 搬数据…），就把这个号 +1 ——
 * 否则「读版本号对得上就跳过迁移」那条快路径会认为都跑过了，新步骤永远不会执行。
 * 快路径省掉的是查询，不是正确性；这个号就是它唯一的保险丝。
 *
 * ⚠️ 这段是 2026-10-26 之前的做法：靠人记住 +1，忘了就出事
 * （tests/noteFolderTagRealSql.test.ts:296 与 noteStarRevRealSql.test.ts:36 各记过一次）。
 * 现在闸门比的是下面那个**派生**出来的 MIGRATION_VERSION，加步骤 / 加索引会自动顶号；
 * 这个字面量只剩「可读的历史刻度」与测试锚点两个用途。
 */
/**
 * 结构版本号。**往 CREATE_STATEMENTS 里加了新表，就必须把这里 +1** ——
 * `migrateIfNeeded` 读到相同的版本号会直接返回、连建表都跳过，
 * 于是新表在**已经部署过的实例**上永远不会被建出来，
 * 症状是那个表的接口一律 500（本地/新库反而正常，因为那是全新迁移）。
 *
 * 3 = 记事本的 notes 表（2026-10-05）。
 * 4 = notes.archived 归档列（阶段三）。加表/加列时别忘了它。
 * 5 = notes.folder_id + note_folder / note_tag / note_note_tag 三张新表（阶段三收尾）。
 * 6/7 = 版本历史（note_revision）/ 内容块等后续迭代的表与列。
 * 8 = note_folder.parent_id 补列。老库建 note_folder 时那张表还没有 parent_id，
 *     CREATE TABLE IF NOT EXISTS 不补列、而 migrateFolderTagTables（它负责 ALTER 补 parent_id）
 *     又有定义却没接进 runMigrations —— 于是线上「新建文件夹 / 删除文件夹」一律 500。
 *     （见下方 runMigrations 第 6.5 步 + 2026-10-06 的修复）
 */
// 9 = 令牌只读分享 note_share（uuid 防止删除/恢复后旧链接复活）。
// 11 = note_folder.icon / note_folder.color（文件夹外观）。
//     ⚠️ CREATE TABLE IF NOT EXISTS 对已存在的表**不会补列**（2026-10-06 的
//     parent_id 500 就是这个坑），所以老库必须走 migrateFolderTagTables 里的
//     hasColumn + ALTER，版本号必须 +1 让快路径失效。
// 13 = note_share.password / note_share.views（访问口令 + 浏览次数）。
//     ⚠️ 2026-10-09 线上「分享列表 API错误: 500」的真因：补列代码（6.7 步）
//     写了但版本号忘了 +1 —— 已部署的库存着 "12"，新代码也是 "12"，
//     migrateIfNeeded 快路径整段跳过迁移，views 列永远补不上，
//     listNoteShares 的 SELECT s.views 直接 500（本地/新库全新迁移必然跑，
//     所以单测全绿测不出）。加任何迁移步骤都要动这个号。
// 14 = notes_fts（笔记全文检索的 FTS5 虚拟表）。虚拟表同样吃快路径：
//     老库建不出来 → searchNotes 一律走 LIKE 回退（能搜但慢、且不排序）。
// 15 = notes.starred（收藏，与置顶分离）+ notes.rev（乐观并发版本号）。
//     两列都是老库上必须 ALTER 才有的，版本号 +1 让快路径失效。
// 17 = note_tombstone（笔记删除墓碑，跨设备变更轮询用）。
//     新表同样吃快路径：老库建不出来 → notes/changes 的墓碑计数恒 0，
//     「彻底删除」对其他设备不可见。加表必须 +1。
// 18 = group_share（公开分组分享，阶段④）。新表同样吃快路径：
//     老库建不出来 → 分组分享接口一律 500。加表必须 +1。
// 19 = idx_sites_user_group（sites(user_id, group_id) 复合索引）。
//     索引步骤同样吃快路径：版本号不 +1 的话老库永远建不上这条索引。
// 20 = 历史明文站点凭据一次性加密写回（encryptLegacySitePasswords）。
//     只动「升级前落库、之后没再编辑过」的那批行；同样吃快路径。
// 21 = site_tombstone（卡片删除墓碑，跨设备增量同步用）。新表同样吃快路径：
//     老库建不出来 → /api/sites/changes 一律 0 条变更，删卡对其它设备不可见。
// 22 = idx_notes_user_order（notes(user_id, pinned, order_num, id) 列表排序覆盖索引）。
//     索引步骤同样吃快路径：版本号不 +1 的话老库永远建不上这条索引（同 19 的先例）。
// 23 = user_sessions.device_id（设备判重改客户端持久 ID，修两台 Windows+Chrome 互踢）。
// 24 = idx_notes_site（notes(site_id) 站点↔笔记绑定反查索引，#477）。
//     同样吃快路径，同样必须 +1 —— 否则老库上站点列表那两个相关子查询永远是全表扫。
// 25 = notes.link_count（每一行的双链条数，2026-10-24）。
//     加列同样吃快路径，必须 +1；回填也挂在这一步（`WHERE link_count IS NULL` 分批扫，
//     所以即使中途失败，下次迁移还会接着填）。
// 26 = vault_keys / vault_entries（方案 B 端到端保险库，2026-10-25）。
//     两张新表，老库上 CREATE TABLE IF NOT EXISTS 建不出来，必须显式 migrateVaultTables。
// 27 = 两条 notes 索引（2026-10-26，服务端性能）：
//     · idx_notes_user_updated(user_id, updated_at) —— 笔记变更轮询那个
//       `SELECT COUNT(*) FROM notes WHERE updated_at >= ? AND user_id IS ?`
//       每 2 分钟一次，原本只能对该用户的全部笔记做一次扫（见 notesBackup.ts）；
//     · idx_notes_site_recent(site_id, updated_at DESC, id DESC) —— 站点列表那个
//       「绑定的那篇笔记」相关子查询不用再每站点排一次序（见 data.ts）。
//     索引步骤同样吃快路径：版本号不 +1 的话老库永远建不上（同 19 / 22 / 24 的先例）。
//
// ⚠️ 从 27 起，「什么时候该升号」不再靠人记住 —— 见下面 MIGRATION_VERSION 的说明：
// 往 MIGRATION_STEPS 加一条步骤、或往 INDEX_STATEMENTS 加一条索引，落库的版本串会
// 自动往前走一格。手工改这个字面量，只在「搬数据但没新增步骤」这类情况下才还需要。
export const SCHEMA_VERSION = "27";
/** 版本号存在 configs 里的键名 */
export const SCHEMA_VERSION_KEY = "schema.version";
/** 「已执行过的迁移步骤」集合存在 configs 里的键名（值是 JSON 字符串数组） */
export const MIGRATION_STEPS_KEY = "schema.steps";

/** 首次建 owner 这把锁的存活时间：正常 bootstrap 几毫秒就完事，30 秒足够兜住崩掉的进程 */
export const OWNER_BOOTSTRAP_LOCK_TTL_MS = 30_000;
/** 没抢到锁时等同伴写完再读一次的间隔 */
export const OWNER_BOOTSTRAP_RETRY_MS = 120;
/**
 * 等同伴放手的最长时间。
 * 取 10 秒的理由：正常 bootstrap 是「一次口令哈希 + 一次 INSERT」，自托管即便按 60 万
 * 次迭代也就几百毫秒；10 秒足够兜住慢机器与冷启动，又短于锁本身的 30 秒 TTL ——
 * 同伴真崩了要等 TTL 过期，那就交给下一次请求，本次不抢。
 */
export const OWNER_BOOTSTRAP_LOCK_WAIT_MS = 10_000;

/**
 * 一条迁移步骤。
 *
 * 以前 runMigrations 是一段直叙代码 + 一个全局版本号：版本对得上就整段跳过，
 * 于是「补列代码写了、忘了升号」= 这一步在已部署的库上永远不执行
 * （tests/noteFolderTagRealSql.test.ts:296 记的就是这一次）。改成步骤表之后：
 *   - 每一步有个**稳定**的 stepId（上线后不许改，改了等于让老库把它重跑一遍）；
 *   - 每跑成功一步就把它记进「已执行集合」，下次启动只跑集合里没有的那些；
 *   - 失败的 step **不进集合**，于是一次 D1 抖动不会把整条升级链吞掉。
 */
export interface MigrationStep {
    /** 稳定的步骤标识 */
    id: string;
    run(api: NavigationAPI): Promise<void>;
}

/**
 * 迁移步骤总表：**顺序即依赖顺序**（建表在前、补列居中、索引在后 —— 索引依赖
 * migrateOwnerColumns 补出来的 user_id 列，见 internals.ts 里 INDEX_STATEMENTS 的注释）。
 *
 * ⚠️ 加新步骤只要往这个数组里加一项即可，**不用**再惦记 SCHEMA_VERSION ——
 * 闸门用的 MIGRATION_VERSION 会自动跟着往前走（见下面它的定义）。
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
    {
        id: "core-tables",
        run: async api => {
            // 合并成一次 batch，只花一次 D1 往返（原来是 3 次 exec 串行）
            try {
                await api.db.batch(CREATE_STATEMENTS.map(sql => api.db.prepare(sql)));
            } catch (error) {
                // batch 失败时退回逐条执行，保证结构一定可用
                console.error("批量建表失败，回退逐条执行:", error);
                for (const sql of CREATE_STATEMENTS) {
                    try {
                        await api.db.exec(sql);
                    } catch {
                        // 忽略
                    }
                }
            }
        },
    },
    {
        // 旧库补齐站点凭据字段：先读表结构，确实缺列时才发 ALTER
        id: "sites-credential-columns",
        run: async api => {
            const missingColumns = await api.findMissingSiteColumns();
            if (missingColumns.length === 0) return;
            try {
                await api.db.batch(
                    missingColumns.map(column => api.db.prepare(`ALTER TABLE sites ADD COLUMN ${column} TEXT`))
                );
            } catch {
                // 部分列已存在会让整批失败，逐条补一次即可
                for (const column of missingColumns) {
                    try {
                        await api.db.exec(`ALTER TABLE sites ADD COLUMN ${column} TEXT`);
                    } catch {
                        // 列已存在，忽略
                    }
                }
            }
        },
    },
    // 多账号：分组 / 站点挂上归属账号，再把老数据收归首个账号名下
    { id: "owner-columns", run: api => api.migrateOwnerColumns() },
    // 沉睡账号治理：users 表补上「最后活跃 / 状态 / 停用时间」三列
    { id: "users-inactive-columns", run: api => api.migrateInactiveColumns() },
    // 账号各自的令牌版本：见 bumpTokenVersion 的注释
    { id: "users-token-version", run: api => api.migrateAccountSecurityColumns() },
    { id: "sessions-device-id", run: api => api.migrateSessionDeviceColumn() },
    { id: "notes-archived-folder", run: api => api.migrateNoteColumns() },
    { id: "folder-tag-tables", run: api => api.migrateFolderTagTables() },
    { id: "attachments-table", run: api => api.migrateAttachmentsTable() },
    { id: "note-share-columns", run: api => api.migrateNoteShareColumns() },
    { id: "notes-starred-rev", run: api => api.migrateNoteStarRevColumns() },
    { id: "notes-link-count", run: api => api.migrateNoteLinkCount() },
    {
        id: "attachments-dimensions",
        run: async api => {
            for (const column of ["width", "height"]) {
                if (!(await api.hasColumn("attachments", column))) {
                    try {
                        await api.db.prepare(`ALTER TABLE attachments ADD COLUMN ${column} INTEGER`).run();
                    } catch (error) {
                        if (!(await api.hasColumn("attachments", column))) throw error;
                    }
                }
            }
        },
    },
    { id: "notes-fts", run: api => api.migrateNotesFtsTable() },
    { id: "group-share-table", run: api => api.migrateGroupShareTable() },
    { id: "vault-tables", run: api => api.migrateVaultTables() },
    {
        // 安全加固，失败只记日志不影响启动
        id: "encrypt-legacy-site-passwords",
        run: async api => {
            try {
                await api.encryptLegacySitePasswords();
            } catch (error) {
                console.error("历史站点凭据加密失败（已忽略，下次迁移会重试）:", error);
            }
        },
    },
    // 索引排在最后：它依赖上面补出来的 user_id 列
    { id: "indexes", run: api => api.createIndexes() },
];

/** 27 号这一版登记的步骤条数（加步骤时**不用**改这个数，见 MIGRATION_VERSION） */
const STEPS_AT_V27 = 18;
/** 27 号这一版 INDEX_STATEMENTS 的条数（加索引时**不用**改这个数） */
const INDEXES_AT_V27 = 24;
/**
 * 自 27 号以来新增的「结构变更」条数：多一条迁移步骤、或多一条索引都算一格。
 *
 * 它大于 0 时闸门用的版本串就变成 `27+N`，于是**老库必然被判定为需要迁移** ——
 * 「补列写了却忘了升号」这类事故（见 tests/noteFolderTagRealSql.test.ts:296）
 * 在结构上就不可能再发生：升号是算出来的，不是记出来的。
 */
const SCHEMA_DELTA =
    MIGRATION_STEPS.length - STEPS_AT_V27 + (INDEX_STATEMENTS.length - INDEXES_AT_V27);
/**
 * 真正落库、也真正拿来比对的版本串。
 *
 * ⚠️ 在当前这份代码里它必须**正好等于** SCHEMA_VERSION（也就是 delta 为 0）。
 * 不为 0 的话要么 STEPS_AT_V27 没跟上 MIGRATION_STEPS 的实际条数，要么
 * INDEXES_AT_V27 没跟上 INDEX_STATEMENTS 的实际条数 ——
 * tests/migrationVersion.test.ts 第一条（写回的版本串要等于 SCHEMA_VERSION）会立刻红。
 */
export const MIGRATION_VERSION = SCHEMA_DELTA > 0 ? `${SCHEMA_VERSION}+${SCHEMA_DELTA}` : SCHEMA_VERSION;

export interface MigrationApi {
    initDB(): Promise<{ success: boolean; alreadyInitialized: boolean }>;
    migrate(): Promise<void>;
    /** 按结构版本号判断这次冷启动要不要真的跑一遍迁移 */
    migrateIfNeeded(): Promise<void>;
    readSchemaVersion(): Promise<string | null>;
    writeSchemaVersion(version: string): Promise<void>;
    /** 读「已执行过的迁移步骤」集合；读不到 / 解析不出来一律当空集合 */
    readMigrationSteps(): Promise<string[]>;
    /** 写回「已执行过的迁移步骤」集合（整份覆盖） */
    writeMigrationSteps(ids: string[]): Promise<void>;
    runMigrations(): Promise<void>;
    createIndexes(): Promise<void>;
    migrateAccountSecurityColumns(): Promise<void>;
    /** user_sessions 补 device_id 列（2026-10-22） */
    migrateSessionDeviceColumn(): Promise<void>;
    migrateInactiveColumns(): Promise<void>;
    migrateOwnerColumns(): Promise<void>;
    migrateNoteColumns(): Promise<void>;
    /** 阶段三收尾：文件夹 / 标签三张新表（老库上 CREATE TABLE IF NOT EXISTS 建不出来） */
    migrateFolderTagTables(): Promise<void>;
    /** 2026-07：图片附件元数据表（老库上同样建不出来，必须显式跑） */
    migrateAttachmentsTable(): Promise<void>;
    /** 2026-10-09：分享表补访问口令（password）与浏览次数（views）两列 */
    migrateNoteShareColumns(): Promise<void>;
    /** 2026-10-09：notes 补收藏（starred）与乐观并发版本号（rev）两列 */
    migrateNoteStarRevColumns(): Promise<void>;
    /** 2026-10-24：notes 补 link_count（双链条数），让数据页统计不再全表拉正文 */
    migrateNoteLinkCount(): Promise<void>;
    /** 2026-10-11：group_share（公开分组分享，阶段④） */
    migrateGroupShareTable(): Promise<void>;
    /** 2026-10-25：保险库 vault_keys / vault_entries（方案 B 端到端加密，schema 26） */
    migrateVaultTables(): Promise<void>;
    /** 2026-10-13：把升级前落库的明文站点凭据一次性加密写回 */
    encryptLegacySitePasswords(): Promise<void>;
    /** 2026-10-09：笔记全文检索的 FTS5 虚拟表（建不出来就降级，不阻断启动） */
    migrateNotesFtsTable(): Promise<void>;
    migrateRecoveryKeyToOwner(ownerId: number): Promise<void>;
    migrateWebdavConfigToOwner(ownerId: number): Promise<void>;
    hasColumn(table: string, column: string): Promise<boolean>;
    ensureOwnerUser(): Promise<number | null>;
    findMissingSiteColumns(): Promise<string[]>;
    withSchemaRetry<T>(run: () => Promise<T>): Promise<T>;
}

export const migrationImpl: MigrationApi = {

    // 初始化数据库表
    // 修改initDB方法，将SQL语句分开执行
    initDB: async function (this: NavigationAPI ): Promise<{ success: boolean; alreadyInitialized: boolean }> {
        // 首先检查数据库是否已初始化
        try {
            const isInitialized = await this.getConfig("DB_INITIALIZED");
            if (isInitialized === "true") {
                return { success: true, alreadyInitialized: true };
            }
        } catch {
            // 如果发生错误，可能是配置表不存在，继续初始化
        }

        // 建表并补齐字段（幂等，重复执行无副作用）
        await this.migrate();

        // 设置初始化标志
        await this.setConfig("DB_INITIALIZED", "true");

        return { success: true, alreadyInitialized: false };
    },
    /**
     * 迁移入口：**先看版本，版本对得上就一条查询都不多发**。
     *
     * 迁移里建表 / 补列 / 建索引加起来二十多条语句，而每个 isolate 冷启动都要走一遍。
     * 部署频繁、流量稀疏的时候，「建一遍早就好好的表」会变成冷启动的主要成本。
     * 所以这里先读一次版本串：对得上就说明这套迁移已经跑过了，直接放行。
     *
     * ⚠️ 比的是 **MIGRATION_VERSION** 而不是 SCHEMA_VERSION：前者由步骤表与索引清单
     * 派生（加一条步骤 / 一条索引就自动前进一格），不需要谁记得去 +1。
     */
    migrate: async function (this: NavigationAPI ): Promise<void> {
        if (!migrationState.promise) {
            migrationState.promise = this.migrateIfNeeded().catch(error => {
                console.error("数据库迁移失败:", error);
                // 失败后清空缓存，允许下一个请求重试，避免一次偶发错误导致表结构永久缺失
                migrationState.promise = null;
            });
        }
        return migrationState.promise;
    },

    migrateIfNeeded: async function (this: NavigationAPI ): Promise<void> {
        // 版本串读不到（库是空的、configs 表还没建、D1 抖动）一律按「需要迁移」处理：
        // 宁可多跑一次全量建表，也不能因为一次读失败就让站点缺表。
        if ((await this.readSchemaVersion()) === MIGRATION_VERSION) {
            this.dbReady = true;
            return;
        }
        await this.runMigrations();
        await this.writeSchemaVersion(MIGRATION_VERSION);
    },

    /** 读结构版本号；读不到返回 null */
    readSchemaVersion: async function (this: NavigationAPI ): Promise<string | null> {
        try {
            const row = await this.db
                .prepare("SELECT value FROM configs WHERE key = ?")
                .bind(SCHEMA_VERSION_KEY)
                .first<{ value: string }>();
            return typeof row?.value === "string" && row.value ? row.value : null;
        } catch {
            return null;
        }
    },

    /** 写结构版本号。写不进去不影响功能，只是下次冷启动要多跑一次迁移 */
    writeSchemaVersion: async function (this: NavigationAPI, version: string): Promise<void> {
        try {
            await this.db
                .prepare(
                    `INSERT INTO configs (key, value, updated_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(SCHEMA_VERSION_KEY, version)
                .run();
        } catch (error) {
            console.error("写入结构版本号失败（下次冷启动会重跑一次迁移）:", error);
        }
    },
    /**
     * 读「已执行过的迁移步骤」集合。
     *
     * 存在 configs 的 `schema.steps` 里（一个 JSON 字符串数组）。复用现成的 configs 表
     * 而不是新建一张表：这张表早就在备份 / 导出里了，多一个键没有额外代价；
     * 而新建一张表本身又会引出「快路径会不会把它跳过去」这个新风险。
     *
     * 读不到 / JSON 坏了 / 类型不对，一律按**空集合**处理：宁可把跑过的步骤再跑一遍
     * （每一步自身都是幂等的），也不能因为一条脏记录就把该补的列永久跳过。
     */
    readMigrationSteps: async function (this: NavigationAPI ): Promise<string[]> {
        try {
            const row = await this.db
                .prepare("SELECT value FROM configs WHERE key = ?")
                .bind(MIGRATION_STEPS_KEY)
                .first<{ value: string }>();
            if (typeof row?.value !== "string" || !row.value) return [];
            const parsed: unknown = JSON.parse(row.value);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter((id): id is string => typeof id === "string");
        } catch {
            return [];
        }
    },

    /** 写回「已执行过的迁移步骤」集合（整份覆盖）。写不进去只是下次多跑几步，不影响功能 */
    writeMigrationSteps: async function (this: NavigationAPI, ids: string[]): Promise<void> {
        try {
            await this.db
                .prepare(
                    `INSERT INTO configs (key, value, updated_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(MIGRATION_STEPS_KEY, JSON.stringify(ids))
                .run();
        } catch (error) {
            console.error("写入迁移步骤集合失败（下次冷启动会重跑这几步）:", error);
        }
    },

    /**
     * 跑迁移：**只跑「已执行集合」里没有的那些步骤**，而不是一段从头到尾的直叙代码。
     *
     * 每一步「为什么要跑、为什么必须显式跑」的理由写在 MIGRATION_STEPS 与对应
     * migrateXxx 方法的注释里，这里只管调度。三条语义保证：
     *   - **幂等**：跑成功一步就立刻把它加进集合，重复启动时它被跳过。就算记录没写进去，
     *     每一步自身也是幂等的（CREATE IF NOT EXISTS / hasColumn + ALTER / 按数据状态
     *     兜底的回填），重跑一遍等于什么都没做。
     *   - **升级路径不变**：始终按 MIGRATION_STEPS 的数组顺序跑（建表 → 补列 → 索引），
     *     老库从任何历史版本一路补到最新走的都是同一条路径。
     *   - **失败可重试**：失败的步骤**不进集合**，所以下一次冷启动只重跑那几步，
     *     不必把整条链再走一遍。
     */
    runMigrations: async function (this: NavigationAPI ): Promise<void> {
        const done = new Set(await this.readMigrationSteps());
        const failed: string[] = [];
        for (const step of MIGRATION_STEPS) {
            if (done.has(step.id)) continue;
            try {
                await step.run(this);
                done.add(step.id);
            } catch (error) {
                // 单独一步挂了不挡着其它步骤继续补（索引挂了不该挡住补列）；
                // 但**不把它记进集合** —— 下次冷启动要再试一次。
                console.error(`迁移步骤 ${step.id} 执行失败（下次冷启动会重试）:`, error);
                failed.push(step.id);
            }
        }
        // 成功的先落库：即便下面抛错，重试时也只要补失败的那几步
        await this.writeMigrationSteps([...done]);

        // 结构已尽力补齐：之后的查询出错按「异常」处理（fail-closed），
        // 而不是「库还没建好」（fail-open）。
        this.dbReady = true;

        if (failed.length > 0) {
            // 往上抛是为了让 migrate() 清掉缓存的 promise —— 否则这一个 isolate 里
            // 失败的步骤再也没机会重试了。代价是本次请求拿到的结构可能不完整，
            // 但 withSchemaRetry 会在「no such column/table」时再兜一次。
            throw new Error(`迁移步骤未全部完成: ${failed.join(", ")}`);
        }
    },

    /**
     * 建索引。索引纯粹是性能优化，任何一条失败都不该让站点起不来，
     * 所以整批失败就退回逐条、逐条再失败就只记日志继续。
     */
    createIndexes: async function (this: NavigationAPI ): Promise<void> {
        const statements = INDEX_STATEMENTS;
        try {
            await this.db.batch(statements.map(sql => this.db.prepare(sql)));
        } catch (error) {
            console.error("批量建索引失败，回退逐条执行:", error);
            for (const sql of statements) {
                try {
                    await this.db.exec(sql);
                } catch (indexError) {
                    // 索引缺失只是查询变慢，不影响功能，不阻断启动
                    console.error("创建索引失败（已忽略）:", sql, indexError);
                }
            }
        }
    },

    /**
     * users 表补列（幂等）：token_version。
     *
     * 令牌版本原本是全站一份（configs.auth.tokenVersion），于是「任一账号改密 / 密钥恢复 /
     * 注销」都会把所有人的会话一起踢掉 —— 多账号上线后这就成了互相干扰。
     * 改成每个账号一份后，A 改密只作废 A 的令牌；没有账号上下文时（老令牌、单管理员
     * configs 凭据）仍然走全站那份，行为不变。
     */
    migrateAccountSecurityColumns: async function (this: NavigationAPI ): Promise<void> {
        const wanted: { name: string; type: string }[] = [
            { name: "token_version", type: "INTEGER NOT NULL DEFAULT 0" },
        ];
        for (const column of wanted) {
            if (await this.hasColumn("users", column.name)) continue;
            try {
                await this.db.exec(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`);
            } catch {
                // 并发迁移时列可能已存在，忽略
            }
        }
    },

    /**
     * users 表补列（幂等，按列是否已经存在决定发不发 ALTER）：
     *   last_active_at —— 最后活跃时间（秒），「记住我」静默恢复也会刷新；
     *   status         —— active / disabled，停用的账号登录会被拒但数据保留；
     *   disabledAt     —— 被停用的时间，清除倒计时的锚点。
     */
    /**
     * user_sessions 补 device_id 列（2026-10-22，幂等）。
     *
     * 为什么必须补列：判「是不是同一台设备」从归一化 UA 改成客户端持久设备 ID。
     * 老库里没有这一列，SELECT 会直接报错（不是返回 NULL），所以必须先 ALTER。
     * 版本号已 +1，快路径（版本相等就跳过）会失效一次，补完即恢复。
     */
    migrateSessionDeviceColumn: async function (this: NavigationAPI ): Promise<void> {
        if (await this.hasColumn("user_sessions", "device_id")) return;
        try {
            await this.db.exec("ALTER TABLE user_sessions ADD COLUMN device_id TEXT");
        } catch {
            // 并发迁移时列可能已存在，忽略
        }
    },

    migrateInactiveColumns: async function (this: NavigationAPI ): Promise<void> {
        const wanted: { name: string; type: string }[] = [
            { name: "last_active_at", type: "INTEGER" },
            { name: "status", type: "TEXT NOT NULL DEFAULT 'active'" },
            { name: "disabled_at", type: "INTEGER" },
        ];
        for (const column of wanted) {
            if (await this.hasColumn("users", column.name)) continue;
            try {
                await this.db.exec(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`);
            } catch {
                // 并发迁移时列可能已存在，忽略
            }
        }
    },

    /**
     * 多账号迁移。分三步，全部幂等：
     *   1. groups / sites 补 user_id 列（老库没有这一列）；
     *   2. 把 configs 里那份单管理员凭据搬进 users 表，成为 owner；
     *   3. user_id 为空的历史数据全部归到 owner —— 升级后原账号看到的数据和升级前一模一样。
     */
    /**
     * notes 补 `archived` 列（阶段三的「归档」）。
     *
     * ⚠️ `CREATE TABLE IF NOT EXISTS` 对**已经存在的表不会补列**：
     * 建表语句里加字段只对全新库有效，已经部署过的实例必须 ALTER。
     * 漏了这一步的症状：老库上 `SELECT archived FROM notes` 报「no such column」，
     * 整个记事本 500，而本地新库一切正常 —— 极难查。
     */
    migrateNoteColumns: async function (this: NavigationAPI ): Promise<void> {
        // ⚠️ 每一列**各判各的**，绝不能写成「archived 在就直接 return」——
        // 那是上一版留下的真 bug：线上库里 archived 早就有了，于是这个 return 把后面
        // folder_id 的 ALTER 一起跳过，notes 表永远没有 folder_id 列，
        // 而 NOTE_FIELDS 里已经带上了它 → 所有 notes 接口一律 500「加载记事本失败」。
        // 新表建出来了、列没建出来，就是这个不对称造成的。
        try {
            if (!(await this.hasColumn("notes", "archived"))) {
                await this.db.exec("ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
            }
        } catch (error) {
            // 列已存在 / 表还不存在（全新库会先建表）—— 都不是问题
            void error;
        }
        try {
            if (!(await this.hasColumn("notes", "folder_id"))) {
                // 可空列，不给 NOT NULL 默认值：老笔记一条都不用回填就成了「未归类」
                await this.db.exec("ALTER TABLE notes ADD COLUMN folder_id INTEGER");
            }
        } catch (error) {
            // 同上，忽略
            void error;
        }
    },

    /**
     * 阶段三收尾：note_folder / note_tag / note_note_tag 三张新表。
     *
     * 为什么不能只靠 runMigrations 第 1 步那个 batch：
     *   - `migrateIfNeeded` 读到**相同的** SCHEMA_VERSION 会直接返回，一条建表都不跑；
     *   - 新表只写在 CREATE_STATEMENTS 里的话，只有「全新库」才会建出来；
     *   - 已经部署过的实例（表结构停留在 4） upgrading 到 5 时，batch 里那三条
     *     `CREATE TABLE IF NOT EXISTS` 本来会执行 —— 但**版本号不匹配**会让
     *     migrateIfNeeded 根本不进 runMigrations。
     * 显式逐条执行是唯一稳的做法，失败（表已存在）忽略即可。
     */
    migrateFolderTagTables: async function (this: NavigationAPI ): Promise<void> {
        for (const sql of FOLDER_TAG_TABLE_STATEMENTS) {
            // D1 exec 按行拆SQL，不适合多行DDL；prepare整条执行。
            // IF NOT EXISTS 已处理并发建表；不能吞错误后仍写新版本。
            await this.db.prepare(sql).run();
        }
        if (!(await this.hasColumn("note_folder", "parent_id"))) {
            try {
                await this.db.exec("ALTER TABLE note_folder ADD COLUMN parent_id INTEGER");
            } catch (error) {
                if (!(await this.hasColumn("note_folder", "parent_id"))) throw error;
            }
        }
        // 文件夹外观两列（schema 11）。⚠️ 每列**各判各的**，不能写成
        // 「icon 在就直接 return」—— 那是 archived/folder_id 那次真 bug 的原样复刻。
        // 老库上 note_folder 早就在了，CREATE TABLE 里的新列对它无效，必须 ALTER。
        for (const column of ["icon", "color"] as const) {
            if (await this.hasColumn("note_folder", column)) continue;
            try {
                await this.db.exec(`ALTER TABLE note_folder ADD COLUMN ${column} TEXT`);
            } catch (error) {
                // 并发迁移时列可能已存在；确认真的存在才算没事
                if (!(await this.hasColumn("note_folder", column))) throw error;
            }
        }
    },

    /**
     * 图片附件的元数据表（2026-07，schema 12）。
     *
     * ⚠️ 只有**元数据**在 D1 —— 二进制在 R2（首选）或 KV（降级）。
     * D1 单行上限约 2MB，一张图就顶满，所以绝不能把图片本体塞进来
     * （inkstone 同样如此，constants.ts:19 的注释里写明了这点）。
     *
     * 为什么这张表必须在迁移里显式建：已经部署过的实例上，
     * 「版本号读得到就整段跳过迁移」的快路径（见 migrateIfNeeded）
     * 会连建表都跳过 → 表永远不存在 → 附件接口一律 500。
     * 这与 migrateFolderTagTables 当初的 500 是同一个坑。
     */
    migrateAttachmentsTable: async function (this: NavigationAPI ): Promise<void> {
        for (const sql of ATTACHMENTS_TABLE_STATEMENTS) {
            // 同上：D1 exec 按行拆 SQL，不适合多行 DDL；prepare 整条执行。
            await this.db.prepare(sql).run();
        }
    },

    /**
     * 2026-10-09：分享表补「访问口令」与「浏览次数」两列。
     * 老库上 note_share 早建好了，CREATE TABLE IF NOT EXISTS 不补列，
     * 这里用 hasColumn + ALTER 兜底（与 migrateNoteColumns 那套同一个姿势）。
     * password 可空（没设口令就是公开）；views 默认 0，老数据从 0 计起。
     */
    migrateNoteShareColumns: async function (this: NavigationAPI ): Promise<void> {
        if (!(await this.hasColumn("note_share", "password"))) {
            try {
                await this.db.exec("ALTER TABLE note_share ADD COLUMN password TEXT");
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }
        if (!(await this.hasColumn("note_share", "views"))) {
            try {
                await this.db.exec("ALTER TABLE note_share ADD COLUMN views INTEGER NOT NULL DEFAULT 0");
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }
    },

    /**
     * 建笔记全文检索的 FTS5 虚拟表（2026-10-09）。
     *
     * ⚠️ 刻意**不抛错**：FTS5 是可选的加速件，不是功能本体。建不出来（D1 没编
     * FTS5 模块、或者虚拟表的磁盘格式在这版 SQLite 上不受支持）时把
     * `notesFtsReady` 置 false，searchNotes 自动退回 LIKE 全表扫 ——
     * 慢一点但结果一样，绝不能因为一张加速表建不出来就让整个站点起不来。
     */
    migrateNotesFtsTable: async function (this: NavigationAPI ): Promise<void> {
        try {
            await this.db.exec(NOTES_FTS_TABLE_SQL);
            // 建完立刻探一次：CREATE VIRTUAL TABLE 在某些环境上是「懒失败」，
            // 真正 MATCH 时才炸。这里先跑一条空查询把失败提前到迁移阶段。
            await this.db
                .prepare("SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? LIMIT 1")
                .bind("\"a\"")
                .all();
            migrationState.ftsReady = true;
        } catch (error) {
            migrationState.ftsReady = false;
            console.error("全文检索表不可用，搜索将退回 LIKE：", error);
        }
    },

    /**
     * notes 补 `starred`（收藏）与 `rev`（乐观并发版本号）两列（2026-10-09）。
     *
     * 同样是老库必须 ALTER 才有 —— CREATE TABLE IF NOT EXISTS 不补列，
     * 而 notes 表在所有已部署实例上早就存在了。
     * rev 还要给已有行填 1（默认值只对新行生效，老行是 NULL，
     * `rev = ?` 的并发守卫在 NULL 上永远不成立 → 保存直接 409 变「改不动」）。
     */
    migrateNoteStarRevColumns: async function (this: NavigationAPI ): Promise<void> {
        if (!(await this.hasColumn("notes", "starred"))) {
            try {
                await this.db.exec("ALTER TABLE notes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0");
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }
        if (!(await this.hasColumn("notes", "rev"))) {
            try {
                await this.db.exec("ALTER TABLE notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 1");
            } catch {
                // 同上
            }
            // 老行的 rev 是 NULL（DEFAULT 只作用于新插入的行），回填成 1
            try {
                await this.db.prepare("UPDATE notes SET rev = 1 WHERE rev IS NULL").run();
            } catch {
                // 回填失败不该让站点起不来；代价只是那几行第一次保存可能报冲突
            }
        }
    },

    /**
     * notes 补 `link_count` 列（2026-10-24）：这一行正文里的 `[[双链]]` 条数。
     *
     * 为什么要存一列：数据页的「双链」一格要的是**当前账号的全站总数**，而前端只持有
     * 截断后的列表（`?fields=list`），本地算不了；只能后端统计。老实现是
     * 「SELECT content FROM notes 全表拉回 JS 逐条正则」—— 打开一次数据页就把当前账号的
     * **全部正文**从 D1 搬进 Worker：几百条笔记就是几 MB 的传输 + 几 MB 的正则扫描，
     * 全为了一个两位数。现在改成「写入时算好、读取时 SUM 一列」：读变成 O(1)。
     *
     * 写入侧的三条路径（createNote / updateNote / importNotes）必须都维护这一列，
     * 漏一处就会慢慢累出偏差 —— 所以统计口径统一走 `utils/noteWikiLink.countWikiLinks`。
     *
     * 老数据要回填一次（这一次确实扫全表，但只在版本升级时跑一次）：
     *   · 哨兵用 **NULL 而不是 0** —— 「0 条双链」是合法值，不能和「还没算过」混淆；
     *   · 分批（每批 200 条），避免一次把全部正文读进内存；
     *   · 分页靠 `WHERE link_count IS NULL LIMIT 200`：每批填完就不再被选中，
     *     不需要额外游标。
     */
    migrateNoteLinkCount: async function (this: NavigationAPI ): Promise<void> {
        if (!(await this.hasColumn("notes", "link_count"))) {
            try {
                // 可空、无默认值：NULL = 还没算过（见上面哨兵的说明）
                await this.db.exec("ALTER TABLE notes ADD COLUMN link_count INTEGER");
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }
        for (;;) {
            let batch: { id: number; content: string | null }[];
            try {
                const rows = await this.db
                    .prepare("SELECT id, content FROM notes WHERE link_count IS NULL LIMIT 200")
                    .all<{ id: number; content: string | null }>();
                batch = rows.results || [];
            } catch {
                // notes 表还不存在（全新库：建表语句在第 1 步，本步骤排在它后面，
                // 但某些降级/自愈路径可能还没跑到）—— 没有行需要回填
                return;
            }
            if (batch.length === 0) return;
            try {
                await this.db.batch(
                    batch.map(row =>
                        this.db
                            .prepare("UPDATE notes SET link_count = ?1 WHERE id = ?2")
                            .bind(countWikiLinks(row.content ?? ""), row.id)
                    )
                );
            } catch {
                // 回填失败不该让站点起不来：剩下的行下次迁移还会被选中（仍为 NULL）。
                // 代价只是「双链」那个数字暂时偏小。
                return;
            }
        }
    },

    migrateGroupShareTable: async function (this: NavigationAPI ): Promise<void> {
        await this.db.prepare(`CREATE TABLE IF NOT EXISTS group_share (
            group_id INTEGER PRIMARY KEY,
            group_uuid TEXT,
            user_id INTEGER,
            token TEXT NOT NULL UNIQUE,
            expires_at INTEGER,
            password TEXT,
            views INTEGER NOT NULL DEFAULT 0
        )`).run();
        await this.db.prepare(
            "CREATE INDEX IF NOT EXISTS idx_group_share_user ON group_share(user_id)"
        ).run();
    },

    migrateVaultTables: async function (this: NavigationAPI ): Promise<void> {
        // 两张新表 + 两个索引，逐条显式建（老库上 CREATE IF NOT EXISTS 建不出来，
        // 与 migrateGroupShareTable 同款原因）。IF NOT EXISTS 已处理重复/并发建表。
        for (const sql of VAULT_TABLE_STATEMENTS) {
            await this.db.prepare(sql).run();
        }
    },

    /**
     * 把**升级前**落库的明文站点凭据一次性加密写回（schema 20）。
     *
     * 背景：`insertSite` / `updateSiteRow` 早就加密落库了，但**升级前**写进去的老行
     * 是明文（读出来时 decryptSecretDeep 认不出 enc$ 前缀就原样返回）。那些卡片
     * 只要被重新保存一次就会自动变密文，剩下的是「建了之后再没编辑过」的那批。
     * 这是 D1 导出 / 备份文件里唯一可能躺着明文的一段，补上它。
     *
     * ⚠️ 必须**先探密钥再动笔**：encryptSecret 在拿不到密钥时返回**空串**
     * （见 crypto.ts），照写就是把老凭据清空 —— 那比留着明文更糟。探测方式是
     * 拿一个探针值走一遍真实的加密链路，拿回空串就整批跳过。
     *
     * ⚠️ 失败一律只记日志：这一步是安全加固，不该让站点起不来。
     */
    encryptLegacySitePasswords: async function (this: NavigationAPI ): Promise<void> {
        const probe = await encryptSecret("probe", this.keyring);
        if (!probe) {
            console.warn("跳过历史站点凭据加密：加密密钥不可用（宁可留明文，也不能写空）");
            return;
        }
        const BATCH = 200;
        // 上限只是防御死循环：正常情况每批都会把命中的行变成 enc$，扫完自然退出
        for (let round = 0; round < 50; round += 1) {
            const rows = await this.db
                .prepare(
                    `SELECT id, password FROM sites
                     WHERE password IS NOT NULL AND password <> '' AND password NOT LIKE 'enc$%'
                     LIMIT ${BATCH}`
                )
                .all<{ id: number; password: string }>();
            const found = rows.results || [];
            if (found.length === 0) return;

            const statements: D1PreparedStatement[] = [];
            for (const row of found) {
                const cipher = await encryptSecret(row.password, this.keyring);
                // 加密失败（空串）就不动这一行 —— 绝不能把凭据写成空
                if (!cipher) continue;
                statements.push(
                    this.db
                        .prepare("UPDATE sites SET password = ? WHERE id = ?")
                        .bind(cipher, row.id)
                );
            }
            if (statements.length > 0) await this.db.batch(statements);
            if (found.length < BATCH) return;
        }
    },

    migrateOwnerColumns: async function (this: NavigationAPI ): Promise<void> {
        for (const table of ["groups", "sites"]) {
            if (await this.hasColumn(table, "user_id")) continue;
            try {
                await this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`);
            } catch {
                // 列已存在（并发迁移）或表不存在，忽略
            }
        }

        const ownerId = await this.ensureOwnerUser();
        if (ownerId === null) return;

        const backfill = [
            this.db.prepare("UPDATE groups SET user_id = ? WHERE user_id IS NULL").bind(ownerId),
            this.db.prepare("UPDATE sites SET user_id = ? WHERE user_id IS NULL").bind(ownerId),
        ];
        try {
            await this.db.batch(backfill);
        } catch {
            for (const statement of backfill) {
                try {
                    await statement.run();
                } catch {
                    // 忽略
                }
            }
        }

        // 4) 恢复公钥：老部署里是全站一份，现在改成每个账号一份
        await this.migrateRecoveryKeyToOwner(ownerId);

        // 5) WebDAV 备份配置：老部署里是全站一份，现在改成每个账号一份
        await this.migrateWebdavConfigToOwner(ownerId);
    },

    /**
     * 把 configs 里那份「全站恢复公钥」搬进 owner 账号。
     * 搬成功才删掉全局那份 —— 留着会让新账号显示成「恢复密钥（已配置）」，
     * 可它手里的私钥根本不是自己的，真要找回密码时只会得到「签名不匹配」。
     */
    migrateRecoveryKeyToOwner: async function (this: NavigationAPI, ownerId: number): Promise<void> {
        try {
            if (!(await this.hasColumn("users", "recovery_public_key"))) {
                await this.db.exec("ALTER TABLE users ADD COLUMN recovery_public_key TEXT");
            }
        } catch {
            // 列已存在（并发迁移）或表不存在，忽略
        }

        try {
            const legacy = ((await this.getConfig(RECOVERY_PUBLIC_KEY_CONFIG)) || "").trim();
            if (!legacy) return;

            const row = await this.db
                .prepare("SELECT recovery_public_key FROM users WHERE id = ?")
                .bind(ownerId)
                .first<{ recovery_public_key: string | null }>();
            // 已经搬过，或 owner 后来自己重新生成过 → 以账号里那份为准
            if (row?.recovery_public_key) return;

            const updated = await this.db
                .prepare("UPDATE users SET recovery_public_key = ? WHERE id = ?")
                .bind(legacy, ownerId)
                .run();
            if (updated.success) await this.deleteConfig(RECOVERY_PUBLIC_KEY_CONFIG);
        } catch (error) {
            console.error("迁移恢复公钥失败:", error);
        }
    },

    /**
     * 把 configs 里那份「全站 WebDAV 备份配置」搬进 owner 账号。
     * 不搬的话：老部署里配过网盘的人升级后，新注册的账号一打开「数据备份」就能看到
     * 别人的网盘地址和账号 —— 搬完顺手删掉全局那份，杜绝残留。
     * 值在 configs 里已经是密文（口令类），原样搬，不重复加密。
     */
    migrateWebdavConfigToOwner: async function (this: NavigationAPI, ownerId: number): Promise<void> {
        try {
            const rows = await this.db
                .prepare("SELECT key, value FROM configs WHERE key LIKE ?")
                .bind(`${WEBDAV_CONFIG_PREFIX}%`)
                .all<{ key: string; value: string }>();
            const list = rows.results || [];
            if (list.length === 0) return;

            const statements = list.map(row =>
                this.db
                    .prepare(
                        `INSERT INTO user_configs (user_id, key, value, updated_at)
                         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(user_id, key) DO NOTHING`
                    )
                    .bind(ownerId, row.key, row.value)
            );
            try {
                await this.db.batch(statements);
            } catch {
                for (const statement of statements) {
                    try {
                        await statement.run();
                    } catch {
                        // 已存在，忽略
                    }
                }
            }

            // 全局那份删掉：留着就等于给所有账号留了一份「默认网盘」
            for (const row of list) {
                try {
                    await this.deleteConfig(row.key);
                } catch {
                    // 忽略
                }
            }
        } catch (error) {
            console.error("迁移 WebDAV 配置失败:", error);
        }
    },
    hasColumn: async function (this: NavigationAPI, table: string, column: string): Promise<boolean> {
        // 表名是**直接插进 SQL**的，不是绑定参数：把表名当占位符传给 pragma_table_info
        // 在 D1 上会抛「near ? syntax error」，catch 掉之后一律 return false ——
        // 于是 hasColumn 恒为 false，补列逻辑等于「每次都盲发 ALTER」，
        // 失败还被静默吞掉，列就永远补不上（folder_id 缺失就是这么来的）。
        // 所以先做白名单校验（表名只可能来自代码里的字面量）再插值。
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return false;
        try {
            const result = await this.db
                .prepare(`SELECT name FROM pragma_table_info('${table}')`)
                .all<{ name: string }>();
            return (result.results || []).some(row => row.name === column);
        } catch {
            // 表还不存在（全新库还没建表）—— 当作「没有这列」，让上层去补
            return false;
        }
    },

    /**
     * users 表为空 = 还没升级过：把 configs 里的管理员凭据搬进来当 owner。
     * 已经搬过就直接返回 owner 的 id。
     */
    ensureOwnerUser: async function (this: NavigationAPI ): Promise<number | null> {
        const readOwner = async (): Promise<number | null> => {
            const row = await this.db
                .prepare("SELECT id, username FROM users ORDER BY id LIMIT 1")
                .first<{ id: number; username: string }>();
            return row?.id ?? null;
        };
        try {
            const existing = await readOwner();
            if (existing) return existing;

            // 「users 表为空」这个判断和随后的 INSERT 之间有个裂缝：首次部署时
            // 两个并发请求（刷新 + 另一个标签页、或重试）会同时看到空表，各自建一个
            // owner。Workers 是多 isolate 的，进程内互斥锁挡不住，所以用幂等表当
            // 跨请求的锁 —— 拿不到锁的那个先等等再读，读出同伴的成果就直接用。
            const lockScope = "owner.bootstrap";
            const lockKey = "global";
            const claim = () =>
                this.claimIdempotencyDetailed(lockScope, lockKey, OWNER_BOOTSTRAP_LOCK_TTL_MS);
            let state = await claim();
            if (state === "busy") {
                // 同伴正在建。**等到它放手，而不是等一个固定时长**（2026-10-20 改）：
                // 建 owner 要先做一次口令哈希，那一步要多久是配置决定的
                // （自托管默认 60 万次迭代 ≈ 几百毫秒）。原先只等 120 ms 再瞄一眼，
                // 迭代数一上调就瞄早了 —— 看到还是空表，于是两个请求各建一个 owner。
                // 同伴是在收尾的 finally 里才释放锁，所以「能抢到锁」才是它真干完了的
                // 判据，比任何拍脑袋的等待时间都可靠。
                const deadline = Date.now() + OWNER_BOOTSTRAP_LOCK_WAIT_MS;
                while (Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, OWNER_BOOTSTRAP_RETRY_MS));
                    const waited = await readOwner();
                    if (waited) return waited;
                    state = await claim();
                    if (state !== "busy") break;
                }
                // 等满了同伴还没放手（多半是它崩了、要等 TTL 过期）：
                // 这次返回 null，让下一次请求接手 —— 宁可晚一点，也不建第二个 owner。
                if (state === "busy") return null;
            }
            // 幂等表不可用（建表之前那一次）时 state 是 "unavailable"：锁不生效，
            // 按老行为照常往下建，不能因为锁用不了就把初始化卡住。
            const got = state === "acquired";
            try {
                // 拿到锁也要重读一次：可能在我们读空表和抢到锁之间，同伴已经建好了
                const again = await readOwner();
                if (again) return again;

                const creds = await this.readAuthCredentials();
                // 没有凭据说明站点还没初始化（连种子账号都没有），等第一次真正写凭据时再建
                if (!creds.username || !creds.password) return null;

                const hashed = isHashedPassword(creds.password)
                    ? creds.password
                    : await hashPassword(creds.password);
                const inserted = await this.db
                    .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) RETURNING id")
                    .bind(creds.username, hashed, "owner")
                    .first<{ id: number }>();
                return inserted?.id ?? null;
            } finally {
                if (got) await this.releaseIdempotency(lockScope, lockKey).catch(() => {});
            }
        } catch (error) {
            // 并发撞 UNIQUE 也落到这里：owner 已经存在，下一次请求会读到它，
            // 本次返回 null 让调用方跳过回填即可，不会留下第二个 owner。
            console.error("迁移首个账号失败:", error);
            return null;
        }
    },

    // 读取 sites 表已有列，返回缺失的凭据列（无法读取时按「都缺」处理，交给 ALTER 自行兼容）
    findMissingSiteColumns: async function (this: NavigationAPI ): Promise<string[]> {
        const credentials = ["username", "password"];
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info('sites')")
                .all<{ name: string }>();
            const columns = new Set((result.results || []).map(row => row.name));
            // 表都还不存在时不用 ALTER，建表语句里已经包含这两列
            if (columns.size === 0) return [];
            return credentials.filter(column => !columns.has(column));
        } catch {
            return credentials;
        }
    },

    // 结构异常（缺表 / 缺列）时重跑一次迁移再重试。
    // 迁移结果虽然缓存，但遇到 D1 里结构被回退或首次迁移被跳过的情况仍能自愈，代价只有出错时的一次重试。
    withSchemaRetry: async function <T>(this: NavigationAPI, run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no such (column|table)/i.test(message)) {
                throw error;
            }
            console.warn("检测到数据库结构异常，重新执行迁移后重试:", message);
            migrationState.promise = null;
            await this.migrate();
            return await run();
        }
    },
};
