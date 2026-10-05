// src/API/methods/migration.ts
// NavigationAPI 的「migration」域方法体。
//
// 这些是类的成员，只是搬到了独立文件：方法体与拆分前**逐字一致**，
// 用 `this: NavigationAPI` 让 TS 认得 this，再由 http.ts 用 Object.assign 混回原型。
// 别在这个文件里 new NavigationAPI，也别在模块顶层读它的状态。

import type { NavigationAPI } from "../http";
import { RECOVERY_PUBLIC_KEY_CONFIG, WEBDAV_CONFIG_PREFIX } from "../configKeys";
import { hashPassword, isHashedPassword } from "../crypto";
import { CREATE_STATEMENTS, INDEX_STATEMENTS, migrationState } from "./internals";

/**
 * 表结构版本号，**只进不退**。
 *
 * 只要往 runMigrations 里加了新步骤（补列 / 建索引 / 搬数据…），就把这个号 +1 ——
 * 否则「读版本号对得上就跳过迁移」那条快路径会认为都跑过了，新步骤永远不会执行。
 * 快路径省掉的是查询，不是正确性；这个号就是它唯一的保险丝。
 */
/**
 * 结构版本号。**往 CREATE_STATEMENTS 里加了新表，就必须把这里 +1** ——
 * `migrateIfNeeded` 读到相同的版本号会直接返回、连建表都跳过，
 * 于是新表在**已经部署过的实例**上永远不会被建出来，
 * 症状是那个表的接口一律 500（本地/新库反而正常，因为那是全新迁移）。
 *
 * 3 = 记事本的 notes 表（2026-10-05）。
 * 4 = notes.archived 归档列（阶段三）。加表/加列时别忘了它。
 */
export const SCHEMA_VERSION = "4";
/** 版本号存在 configs 里的键名 */
export const SCHEMA_VERSION_KEY = "schema.version";

/** 首次建 owner 这把锁的存活时间：正常 bootstrap 几毫秒就完事，30 秒足够兜住崩掉的进程 */
export const OWNER_BOOTSTRAP_LOCK_TTL_MS = 30_000;
/** 没抢到锁时等同伴写完再读一次的间隔 */
export const OWNER_BOOTSTRAP_RETRY_MS = 120;

export interface MigrationApi {
    initDB(): Promise<{ success: boolean; alreadyInitialized: boolean }>;
    migrate(): Promise<void>;
    /** 按结构版本号判断这次冷启动要不要真的跑一遍迁移 */
    migrateIfNeeded(): Promise<void>;
    readSchemaVersion(): Promise<string | null>;
    writeSchemaVersion(version: string): Promise<void>;
    runMigrations(): Promise<void>;
    createIndexes(): Promise<void>;
    migrateAccountSecurityColumns(): Promise<void>;
    migrateInactiveColumns(): Promise<void>;
    migrateOwnerColumns(): Promise<void>;
    migrateNoteColumns(): Promise<void>;
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
     * 所以这里先读一次结构版本号：对得上就说明这套迁移已经跑过了，直接放行。
     * 版本号随迁移步骤一起改（见 SCHEMA_VERSION），加了新步骤就会自动重跑一次。
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
        // 版本号读不到（库是空的、configs 表还没建、D1 抖动）一律按「需要迁移」处理：
        // 宁可多跑一次全量建表，也不能因为一次读失败就让站点缺表。
        if ((await this.readSchemaVersion()) === SCHEMA_VERSION) {
            this.dbReady = true;
            return;
        }
        await this.runMigrations();
        await this.writeSchemaVersion(SCHEMA_VERSION);
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
    runMigrations: async function (this: NavigationAPI ): Promise<void> {
        // 1) 建表：合并成一次 batch，只花一次 D1 往返（原来是 3 次 exec 串行）
        try {
            await this.db.batch(CREATE_STATEMENTS.map(sql => this.db.prepare(sql)));
        } catch (error) {
            // batch 失败时退回逐条执行，保证结构一定可用
            console.error("批量建表失败，回退逐条执行:", error);
            for (const sql of CREATE_STATEMENTS) {
                try {
                    await this.db.exec(sql);
                } catch {
                    // 忽略
                }
            }
        }

        // 2) 旧库补齐站点凭据字段：先读表结构，确实缺列时才发 ALTER
        const missingColumns = await this.findMissingSiteColumns();
        if (missingColumns.length > 0) {
            try {
                await this.db.batch(
                    missingColumns.map(column => this.db.prepare(`ALTER TABLE sites ADD COLUMN ${column} TEXT`))
                );
            } catch {
                // 部分列已存在会让整批失败，逐条补一次即可
                for (const column of missingColumns) {
                    try {
                        await this.db.exec(`ALTER TABLE sites ADD COLUMN ${column} TEXT`);
                    } catch {
                        // 列已存在，忽略
                    }
                }
            }
        }

        // 3) 多账号：分组 / 站点挂上归属账号，再把老数据收归首个账号名下
        await this.migrateOwnerColumns();

        // 4) 沉睡账号治理：users 表补上「最后活跃 / 状态 / 停用时间」三列
        await this.migrateInactiveColumns();

        // 5) 账号各自的令牌版本：见 bumpTokenVersion 的注释
        await this.migrateAccountSecurityColumns();

        // 6) 阶段三：notes 补 archived 列（老库必须 ALTER 才会有，见 migrateNoteColumns）
        await this.migrateNoteColumns();

        // 7) 索引：排在最后，因为它依赖上面补出来的 user_id 列（见 INDEX_STATEMENTS 注释）
        await this.createIndexes();

        // 所有迁移步骤跑完，说明表结构已就绪：之后的查询出错就按「异常」处理（fail-closed），
        // 而不是「库还没建好」（fail-open）。
        this.dbReady = true;
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
        try {
            if (await this.hasColumn("notes", "archived")) return;
            await this.db.exec("ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
        } catch (error) {
            // 列已存在 / 表还不存在（全新库会先建表）—— 都不是问题
            void error;
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
        try {
            const result = await this.db
                .prepare("SELECT name FROM pragma_table_info(?)")
                .bind(table)
                .all<{ name: string }>();
            return (result.results || []).some(row => row.name === column);
        } catch {
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
            const got = await this.claimIdempotency(lockScope, lockKey, OWNER_BOOTSTRAP_LOCK_TTL_MS);
            try {
                // 拿到锁也要重读一次：可能在我们读空表和抢到锁之间，同伴已经建好了
                const again = await readOwner();
                if (again) return again;
                if (!got) {
                    // 同伴还在建（或幂等表此刻用不了）：等一小会儿再看，
                    // 拿到了就直接用，绝不抢着建第二个 owner。
                    await new Promise((r) => setTimeout(r, OWNER_BOOTSTRAP_RETRY_MS));
                    const waited = await readOwner();
                    if (waited) return waited;
                }

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
