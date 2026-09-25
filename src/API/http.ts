// src/api/http.ts
// 不使用外部JWT库，改为内置的crypto API

// 定义D1数据库类型
interface D1Database {
    prepare(query: string): D1PreparedStatement;
    exec(query: string): Promise<D1Result>;
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(column?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
    results?: T[];
    success: boolean;
    error?: string;
    meta?: unknown;
}

// 定义环境变量接口
interface Env {
    DB: D1Database;
    AUTH_ENABLED?: string; // 是否启用身份验证
    AUTH_USERNAME?: string; // 认证用户名
    AUTH_PASSWORD?: string; // 认证密码
    AUTH_SECRET?: string; // JWT密钥
}

// 数据类型定义
export interface Group {
    id?: number;
    name: string;
    order_num: number;
    created_at?: string;
    updated_at?: string;
}

export interface Site {
    id?: number;
    group_id: number;
    name: string;
    url: string;
    icon: string;
    description: string;
    notes: string;
    // 站点登录凭据（可选，保存在数据库中，备份时会一起导出）
    username?: string;
    password?: string;
    order_num: number;
    created_at?: string;
    updated_at?: string;
}

// WebDAV 备份配置
export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
}

// WebDAV 远端备份文件信息
export interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

// WebDAV 操作通用返回
export interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
}

// 新增配置接口
export interface Config {
    key: string;
    value: string;
    created_at?: string;
    updated_at?: string;
}

// 导出数据接口
export interface ExportData {
    groups: Group[];
    sites: Site[];
    configs: Record<string, string>;
    version: string;
    exportDate: string;
}

// 首屏/刷新一次性返回的数据（分组 + 平铺的站点 + 配置）
export interface BootstrapData {
    groups: Group[];
    sites: Site[];
    configs: Record<string, string>;
}

// 新增用户登录接口
export interface LoginRequest {
    username: string;
    password: string;
}

export interface LoginResponse {
    success: boolean;
    token?: string;
    message?: string;
}

// 数据库迁移只需在每个 Worker isolate 中执行一次。
// 注意：NavigationAPI 是每个请求 new 出来的，实例字段无法跨请求复用，
// 之前迁移挂在实例上导致「每个请求都跑一遍 DDL」，这是接口变慢的主因，所以缓存放在模块作用域。
let migrationPromise: Promise<void> | null = null;

/**
 * 管理员凭据保存在数据库的 configs 表里（键：auth.username / auth.password）。
 * wrangler vars 里的 AUTH_USERNAME / AUTH_PASSWORD 只当作「第一次部署」的默认种子：
 * 首次用到时写入数据库，之后就以数据库为准，
 * 这样反复重新部署（哪怕改了 vars）都不会把已经生效的账号密码改回去。
 */
export const AUTH_USERNAME_KEY = "auth.username";
export const AUTH_PASSWORD_KEY = "auth.password";

// 敏感配置：不参与备份文件的导入导出（管理员 / WebDAV 凭据）
const SECRET_CONFIG_PREFIXES = ["auth.", "webdav."];

// 判断某个配置键是否属于敏感信息
export function isSecretConfigKey(key: string): boolean {
    return SECRET_CONFIG_PREFIXES.some(prefix => key.startsWith(prefix));
}

// 管理员凭据额外连正常的配置读取都不返回，避免出现「拿到配置就等于拿到密码」。
// 注意：WebDAV 凭据要照常下发，前端「备份」弹窗靠它回填已保存的配置。
export function isAuthConfigKey(key: string): boolean {
    return key.startsWith("auth.");
}

// 去掉敏感配置后再返回（用于写入备份文件）
export function stripSecretConfigs(configs: Record<string, string>): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [key, value] of Object.entries(configs)) {
        if (!isSecretConfigKey(key)) {
            safe[key] = value;
        }
    }
    return safe;
}

// API 类
export class NavigationAPI {
    private db: D1Database;
    private authEnabled: boolean;
    // 来自 wrangler vars 的默认账号密码，仅在数据库里还没有凭据时用作种子
    private seedUsername: string;
    private seedPassword: string;
    private secret: string;

    constructor(env: Env) {
        this.db = env.DB;
        this.authEnabled = env.AUTH_ENABLED === "true";
        this.seedUsername = env.AUTH_USERNAME || "";
        this.seedPassword = env.AUTH_PASSWORD || "";
        this.secret = env.AUTH_SECRET || "默认密钥，建议在生产环境中设置";
    }

    // 初始化数据库表
    // 修改initDB方法，将SQL语句分开执行
    async initDB(): Promise<{ success: boolean; alreadyInitialized: boolean }> {
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
    }

    async migrate(): Promise<void> {
        if (!migrationPromise) {
            migrationPromise = this.runMigrations().catch(error => {
                console.error("数据库迁移失败:", error);
                // 失败后清空缓存，允许下一个请求重试，避免一次偶发错误导致表结构永久缺失
                migrationPromise = null;
            });
        }
        return migrationPromise;
    }

    // 建表 SQL（幂等）
    private static readonly CREATE_STATEMENTS = [
        // 保证表结构存在（新建的 D1 库即使没访问过 /api/init 也能直接用）
        `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, icon TEXT, description TEXT, notes TEXT, username TEXT, password TEXT, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE);`,
        `CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    ];

    private async runMigrations(): Promise<void> {
        // 1) 建表：合并成一次 batch，只花一次 D1 往返（原来是 3 次 exec 串行）
        try {
            await this.db.batch(NavigationAPI.CREATE_STATEMENTS.map(sql => this.db.prepare(sql)));
        } catch (error) {
            // batch 失败时退回逐条执行，保证结构一定可用
            console.error("批量建表失败，回退逐条执行:", error);
            for (const sql of NavigationAPI.CREATE_STATEMENTS) {
                try {
                    await this.db.exec(sql);
                } catch {
                    // 忽略
                }
            }
        }

        // 2) 旧库补齐站点凭据字段：先读表结构，确实缺列时才发 ALTER
        const missingColumns = await this.findMissingSiteColumns();
        if (missingColumns.length === 0) return;

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

    // 读取 sites 表已有列，返回缺失的凭据列（无法读取时按「都缺」处理，交给 ALTER 自行兼容）
    private async findMissingSiteColumns(): Promise<string[]> {
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
    }

    // 结构异常（缺表 / 缺列）时重跑一次迁移再重试。
    // 迁移结果虽然缓存，但遇到 D1 里结构被回退或首次迁移被跳过的情况仍能自愈，代价只有出错时的一次重试。
    private async withSchemaRetry<T>(run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no such (column|table)/i.test(message)) {
                throw error;
            }
            console.warn("检测到数据库结构异常，重新执行迁移后重试:", message);
            migrationPromise = null;
            await this.migrate();
            return await run();
        }
    }

    /**
     * 读取生效中的管理员凭据。
     * 数据库中已存在 → 直接用它（重新部署不再改变）；
     * 数据库中没有 → 说明是第一次部署，把 wrangler vars 里的默认值固化到数据库。
     */
    async getAuthCredentials(): Promise<{ username: string; password: string }> {
        await this.migrate();
        try {
            return await this.withSchemaRetry(() => this.readAuthCredentials());
        } catch (error) {
            console.error("读取管理员凭据失败，回退到环境变量:", error);
            return { username: this.seedUsername, password: this.seedPassword };
        }
    }

    private async readAuthCredentials(): Promise<{ username: string; password: string }> {
        const [userRow, passRow] = await this.db.batch<{ value: string }>([
            this.db.prepare("SELECT value FROM configs WHERE key = ?").bind(AUTH_USERNAME_KEY),
            this.db.prepare("SELECT value FROM configs WHERE key = ?").bind(AUTH_PASSWORD_KEY),
        ]);

        const storedUsername = (userRow.results || [])[0]?.value;
        const storedPassword = (passRow.results || [])[0]?.value;

        // 两个值都在 → 以数据库为准，后续部署不再改动
        if (storedUsername && storedPassword) {
            return { username: storedUsername, password: storedPassword };
        }

        // 没有配置环境变量时不写库（否则会把空账号密码固化下来）
        if (!this.seedUsername && !this.seedPassword) {
            return { username: this.seedUsername, password: this.seedPassword };
        }

        // 第一次部署：把环境变量里的默认值写进数据库，之后就一直用它
        await this.updateAuthCredentials(this.seedUsername, this.seedPassword);
        return { username: this.seedUsername, password: this.seedPassword };
    }

    // 更新管理员凭据（写入数据库后立即生效）
    async updateAuthCredentials(username: string, password: string): Promise<boolean> {
        const okUser = await this.setConfig(AUTH_USERNAME_KEY, username);
        const okPass = await this.setConfig(AUTH_PASSWORD_KEY, password);
        return okUser && okPass;
    }

    // 验证用户登录
    async login(loginRequest: LoginRequest): Promise<LoginResponse> {
        // 如果未启用身份验证，直接返回成功
        if (!this.authEnabled) {
            return {
                success: true,
                token: await this.generateToken({ username: "guest" }),
                message: "身份验证未启用，默认登录成功",
            };
        }

        // 凭据以数据库为准：首次部署才会用到 wrangler vars 里的默认值
        const credentials = await this.getAuthCredentials();

        // 验证用户名和密码
        if (loginRequest.username === credentials.username && loginRequest.password === credentials.password) {
            // 生成JWT令牌
            const token = await this.generateToken({ username: loginRequest.username });
            return {
                success: true,
                token,
                message: "登录成功",
            };
        }

        return {
            success: false,
            message: "用户名或密码错误",
        };
    }

    // 验证令牌有效性
    async verifyToken(
        token: string
    ): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
        if (!this.authEnabled) {
            return { valid: true };
        }

        try {
            // 解析JWT
            const [header, payload, signature] = token.split(".");
            if (!header || !payload || !signature) {
                throw new Error("无效的Token格式");
            }

            // 解码payload
            const decodedPayload = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));

            // 验证过期时间
            if (decodedPayload.exp && decodedPayload.exp < Math.floor(Date.now() / 1000)) {
                throw new Error("Token已过期");
            }

            // 注意：这个简化版本没有验证签名，仅用于开发/测试
            // 在生产环境中，应该使用crypto.subtle.verify来验证签名

            return { valid: true, payload: decodedPayload };
        } catch (error) {
            console.error("Token验证失败:", error);
            return { valid: false };
        }
    }

    // 生成JWT令牌
    private async generateToken(payload: Record<string, unknown>): Promise<string> {
        // 准备payload
        const tokenPayload = {
            ...payload,
            exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60, // 24小时过期
            iat: Math.floor(Date.now() / 1000),
        };

        // 创建Header和Payload部分
        const header = { alg: "HS256", typ: "JWT" };
        const encodedHeader = btoa(JSON.stringify(header))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        const encodedPayload = btoa(JSON.stringify(tokenPayload))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

        // 创建签名（简化版，仅用于开发/测试）
        // 在生产环境中，应该使用crypto.subtle.sign生成签名
        const signature = btoa(this.secret + encodedHeader + encodedPayload)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

        // 组合JWT
        return `${encodedHeader}.${encodedPayload}.${signature}`;
    }

    // 检查认证是否启用
    isAuthEnabled(): boolean {
        return this.authEnabled;
    }

    // 分组相关 API
    async getGroups(): Promise<Group[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryGroups());
    }

    private async queryGroups(): Promise<Group[]> {
        const result = await this.db
            .prepare(
                "SELECT id, name, order_num, created_at, updated_at FROM groups ORDER BY order_num"
            )
            .all<Group>();
        return result.results || [];
    }

    // 首屏 / 刷新：一次请求取回全部分组、站点与配置。
    // 用 db.batch 把 3 条查询合并为一次 D1 往返，替代原先「1 次分组 + 每个分组一次站点」的 N+1 请求。
    async getBootstrap(): Promise<BootstrapData> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryBootstrap());
    }

    private async queryBootstrap(): Promise<BootstrapData> {
        const [groupsResult, sitesResult, configsResult] = await this.db.batch<unknown>([
            this.db.prepare(
                "SELECT id, name, order_num, created_at, updated_at FROM groups ORDER BY order_num"
            ),
            this.db.prepare(
                "SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites ORDER BY order_num"
            ),
            this.db.prepare("SELECT key, value FROM configs"),
        ]);

        const configs: Record<string, string> = {};
        for (const row of (configsResult.results || []) as Config[]) {
            // 管理员凭据不下发到浏览器，避免出现「拿到配置就等于拿到密码」
            if (isAuthConfigKey(row.key)) continue;
            configs[row.key] = row.value;
        }

        return {
            groups: (groupsResult.results || []) as Group[],
            sites: (sitesResult.results || []) as Site[],
            configs,
        };
    }

    async getGroup(id: number): Promise<Group | null> {
        const result = await this.db
            .prepare("SELECT id, name, order_num, created_at, updated_at FROM groups WHERE id = ?")
            .bind(id)
            .first<Group>();
        return result;
    }

    async createGroup(group: Group): Promise<Group> {
        const result = await this.db
            .prepare(
                "INSERT INTO groups (name, order_num) VALUES (?, ?) RETURNING id, name, order_num, created_at, updated_at"
            )
            .bind(group.name, group.order_num)
            .all<Group>();
        if (!result.results || result.results.length === 0) {
            throw new Error("创建分组失败");
        }
        return result.results[0];
    }

    async updateGroup(id: number, group: Partial<Group>): Promise<Group | null> {
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

        // 构建安全的参数化查询
        const query = `UPDATE groups SET ${updates.join(
            ", "
        )} WHERE id = ? RETURNING id, name, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...params)
            .all<Group>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        return result.results[0];
    }

    async deleteGroup(id: number): Promise<boolean> {
        const result = await this.db.prepare("DELETE FROM groups WHERE id = ?").bind(id).run();
        return result.success;
    }

    // 网站相关 API
    async getSites(groupId?: number): Promise<Site[]> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySites(groupId));
    }

    private async querySites(groupId?: number): Promise<Site[]> {
        let query =
            "SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites";
        const params: (string | number)[] = [];

        if (groupId !== undefined) {
            query += " WHERE group_id = ?";
            params.push(groupId);
        }

        query += " ORDER BY order_num";

        const result = await this.db
            .prepare(query)
            .bind(...params)
            .all<Site>();
        return result.results || [];
    }

    async getSite(id: number): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.querySite(id));
    }

    private async querySite(id: number): Promise<Site | null> {
        const result = await this.db
            .prepare(
                "SELECT id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at FROM sites WHERE id = ?"
            )
            .bind(id)
            .first<Site>();
        return result;
    }

    async createSite(site: Site): Promise<Site> {
        await this.migrate();
        return this.withSchemaRetry(() => this.insertSite(site));
    }

    private async insertSite(site: Site): Promise<Site> {
        const result = await this.db
            .prepare(
                `
      INSERT INTO sites (group_id, name, url, icon, description, notes, username, password, order_num) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) 
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
                site.password || "",
                site.order_num
            )
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            throw new Error("创建站点失败");
        }
        return result.results[0];
    }

    async updateSite(id: number, site: Partial<Site>): Promise<Site | null> {
        await this.migrate();
        return this.withSchemaRetry(() => this.updateSiteRow(id, site));
    }

    private async updateSiteRow(id: number, site: Partial<Site>): Promise<Site | null> {
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
            params.push(site.password);
        }

        if (site.order_num !== undefined) {
            updates.push("order_num = ?");
            params.push(site.order_num);
        }

        // 构建安全的参数化查询
        const query = `UPDATE sites SET ${updates.join(
            ", "
        )} WHERE id = ? RETURNING id, group_id, name, url, icon, description, notes, username, password, order_num, created_at, updated_at`;
        params.push(id);

        const result = await this.db
            .prepare(query)
            .bind(...params)
            .all<Site>();

        if (!result.results || result.results.length === 0) {
            return null;
        }
        return result.results[0];
    }

    async deleteSite(id: number): Promise<boolean> {
        await this.migrate();
        return this.withSchemaRetry(async () => {
            const result = await this.db.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
            return result.success;
        });
    }

    // 配置相关API
    async getConfigs(): Promise<Record<string, string>> {
        await this.migrate();
        return this.withSchemaRetry(() => this.queryConfigs());
    }

    private async queryConfigs(): Promise<Record<string, string>> {
        const result = await this.db.prepare("SELECT key, value FROM configs").all<Config>();

        // 将结果转换为键值对对象（管理员凭据永远不返回）
        const configs: Record<string, string> = {};
        for (const config of result.results || []) {
            if (isAuthConfigKey(config.key)) continue;
            configs[config.key] = config.value;
        }

        return configs;
    }

    async getConfig(key: string): Promise<string | null> {
        const result = await this.db
            .prepare("SELECT value FROM configs WHERE key = ?")
            .bind(key)
            .first<{ value: string }>();

        return result ? result.value : null;
    }

    async setConfig(key: string, value: string): Promise<boolean> {
        try {
            // 使用UPSERT语法（SQLite支持）
            const result = await this.db
                .prepare(
                    `INSERT INTO configs (key, value, updated_at) 
                    VALUES (?, ?, CURRENT_TIMESTAMP) 
                    ON CONFLICT(key) 
                    DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP`
                )
                .bind(key, value, value)
                .run();

            return result.success;
        } catch (error) {
            console.error("设置配置失败:", error);
            return false;
        }
    }

    async deleteConfig(key: string): Promise<boolean> {
        const result = await this.db.prepare("DELETE FROM configs WHERE key = ?").bind(key).run();

        return result.success;
    }

    // 批量更新排序
    async updateGroupOrder(groupOrders: { id: number; order_num: number }[]): Promise<boolean> {
        // 使用事务确保所有更新一起成功或失败
        return await this.db
            .batch(
                groupOrders.map(item =>
                    this.db
                        .prepare(
                            "UPDATE groups SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                        )
                        .bind(item.order_num, item.id)
                )
            )
            .then(() => true)
            .catch(() => false);
    }

    async updateSiteOrder(siteOrders: { id: number; order_num: number }[]): Promise<boolean> {
        // 使用事务确保所有更新一起成功或失败
        return await this.db
            .batch(
                siteOrders.map(item =>
                    this.db
                        .prepare(
                            "UPDATE sites SET order_num = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
                        )
                        .bind(item.order_num, item.id)
                )
            )
            .then(() => true)
            .catch(() => false);
    }

    // 导出所有数据
    async exportData(): Promise<ExportData> {
        // 获取所有分组
        const groups = await this.getGroups();

        // 获取所有站点（包含账号密码等凭据）
        const sites = await this.getSites();

        // 获取所有配置（管理员与 WebDAV 凭据属于隐私信息，不写入备份文件）
        const configs = stripSecretConfigs(await this.getConfigs());

        return {
            groups,
            sites,
            configs,
            version: EXPORT_VERSION,
            exportDate: new Date().toISOString(),
        };
    }

    // 导入所有数据（覆盖式恢复，尽量保留原有ID）
    async importData(data: ExportData): Promise<boolean> {
        try {
            await this.migrate();

            const normalized = normalizeImportData(data);

            // 清空现有数据
            await this.db.exec("DELETE FROM sites");
            await this.db.exec("DELETE FROM groups");

            // 导入分组数据（保留原ID，保证站点归属关系不变）
            for (const group of normalized.groups) {
                if (group.id !== undefined) {
                    await this.db
                        .prepare("INSERT INTO groups (id, name, order_num) VALUES (?, ?, ?)")
                        .bind(group.id, group.name, group.order_num || 0)
                        .run();
                } else {
                    await this.createGroup(group);
                }
            }

            // 导入站点数据（含账号密码）
            for (const site of normalized.sites) {
                if (site.id !== undefined) {
                    await this.db
                        .prepare(
                            `INSERT INTO sites (id, group_id, name, url, icon, description, notes, username, password, order_num)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .bind(
                            site.id,
                            site.group_id,
                            site.name,
                            site.url,
                            site.icon || "",
                            site.description || "",
                            site.notes || "",
                            site.username || "",
                            site.password || "",
                            site.order_num || 0
                        )
                        .run();
                } else {
                    await this.createSite(site);
                }
            }

            // 导入配置数据
            for (const [key, value] of Object.entries(normalized.configs || {})) {
                if (key === "DB_INITIALIZED") {
                    // 跳过数据库初始化标志
                    continue;
                }
                if (isSecretConfigKey(key)) {
                    // 恢复备份不覆盖管理员账号密码和 WebDAV 凭据
                    continue;
                }
                await this.setConfig(key, value);
            }

            return true;
        } catch (error) {
            console.error("导入数据失败:", error);
            return false;
        }
    }
}

// 备份文件格式版本号
export const EXPORT_VERSION = "1.1";

// 兼容多种备份格式：
// 1) 标准格式 { groups, sites, configs }
// 2) 旧格式   { groups: [{ ...group, sites: [...] }], configs }
export function normalizeImportData(data: ExportData | Record<string, unknown>): ExportData {
    const raw = (data || {}) as {
        groups?: (Group & { sites?: Site[] })[];
        sites?: Site[];
        configs?: Record<string, string>;
        version?: string;
        exportDate?: string;
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

    return {
        groups,
        sites: flatSites.length > 0 ? flatSites : nestedSites,
        configs: raw.configs && typeof raw.configs === "object" ? raw.configs : {},
        version: raw.version || EXPORT_VERSION,
        exportDate: raw.exportDate || new Date().toISOString(),
    };
}

// 创建 API 辅助函数
export function createAPI(env: Env): NavigationAPI {
    return new NavigationAPI(env);
}
