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

/** 首次建 owner 这把锁的存活时间：正常 bootstrap 几毫秒就完事，30 秒足够兜住崩掉的进程 */
export const OWNER_BOOTSTRAP_LOCK_TTL_MS = 30_000;
/** 没抢到锁时等同伴写完再读一次的间隔 */
export const OWNER_BOOTSTRAP_RETRY_MS = 120;

export interface MigrationApi {
    initDB(): Promise<{ success: boolean; alreadyInitialized: boolean }>;
    migrate(): Promise<void>;
    runMigrations(): Promise<void>;
    createIndexes(): Promise<void>;
    migrateAccountSecurityColumns(): Promise<void>;
    migrateInactiveColumns(): Promise<void>;
    migrateOwnerColumns(): Promise<void>;
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
    migrate: async function (this: NavigationAPI ): Promise<void> {
        if (!migrationState.promise) {
            migrationState.promise = this.runMigrations().catch(error => {
                console.error("数据库迁移失败:", error);
                // 失败后清空缓存，允许下一个请求重试，避免一次偶发错误导致表结构永久缺失
                migrationState.promise = null;
            });
        }
        return migrationState.promise;
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

        // 6) 索引：排在最后，因为它依赖上面补出来的 user_id 列（见 INDEX_STATEMENTS 注释）
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
