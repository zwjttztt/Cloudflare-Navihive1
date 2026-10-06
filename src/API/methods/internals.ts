// src/API/methods/internals.ts
// 拆 http.ts 时抽出来的共享内部件：建表 / 索引 SQL、迁移缓存、邀请码、凭据脱敏。
// 只给 src/API/methods/* 和 http.ts 自己用，不是对外 API（对外仍从 ../http 走）。

import { LocalPrefsBackup, Site } from "../types";

// 笔记文件夹 / 标签这三张表的 DDL 单独提出来：
// 它们**只在迁移里逐条建**（runMigrations 第 6.5 步），不进 CREATE_STATEMENTS 那个 batch。
// 原因写在 migration.ts 那一步的注释里 —— 老库上已经在的 notes 表不会因
// CREATE TABLE IF NOT EXISTS 补出新表，而这三张新表在老库上根本不存在，
// 得单独显式执行；放进 batch 反而会让它和「补列」抢同一批事务。
const NOTE_FOLDER_TABLE_SQL = `CREATE TABLE IF NOT EXISTS note_folder (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    parent_id INTEGER,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    order_num INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const NOTE_TAG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS note_tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    color TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

/**
 * 笔记的修订快照（inkstone 顶栏「版本历史」）。
 *
 * 存的是**上一版内容**：保存正文时先把改动前的样子落一行，用户就能「退回那一刻」。
 * 每条笔记只留最近 REVISION_KEEP_PER_NOTE 条（见 notes.ts 的裁剪），
 * 所以这张表不会随时间无限膨胀 —— 这是能不能上线的关键（D1 有容量上限）。
 */
const NOTE_REVISION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS note_revision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    user_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

/** 按 note_id 查历史，没有索引就是整表扫（recycle_bin 那边已经吃过一次这个亏） */
const NOTE_REVISION_INDEX_SQL =
    `CREATE INDEX IF NOT EXISTS idx_note_revision_note ON note_revision(note_id, id DESC);`;

const NOTE_TAG_LINK_TABLE_SQL = `CREATE TABLE IF NOT EXISTS note_note_tag (    note_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (note_id, tag_id)
);`;

/** 迁移里逐条执行的「新表」DDL（见 runMigrations 第 6.5 步） */
export const FOLDER_TAG_TABLE_STATEMENTS = [
    NOTE_FOLDER_TABLE_SQL,
    NOTE_TAG_TABLE_SQL,
    NOTE_TAG_LINK_TABLE_SQL,
    NOTE_REVISION_TABLE_SQL,
    NOTE_REVISION_INDEX_SQL,
    `CREATE TABLE IF NOT EXISTS note_share (
        note_id INTEGER PRIMARY KEY,
        note_uuid TEXT NOT NULL,
        user_id INTEGER,
        token TEXT NOT NULL UNIQUE,
        expires_at INTEGER
    );`,
];

// 建表 SQL（幂等）
export const CREATE_STATEMENTS = [
    // 分享表也进基础迁移batch，避免部署中的分步迁移漏建但版本已更新。
    `CREATE TABLE IF NOT EXISTS note_share (note_id INTEGER PRIMARY KEY, note_uuid TEXT NOT NULL, user_id INTEGER, token TEXT NOT NULL UNIQUE, expires_at INTEGER);`,
    // 保证表结构存在（新建的 D1 库即使没访问过 /api/init 也能直接用）
    `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    `CREATE TABLE IF NOT EXISTS sites (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, icon TEXT, description TEXT, notes TEXT, username TEXT, password TEXT, order_num INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE);`,
    `CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    // 审计日志：登录、改密、重置、删除站点、改备份配置等关键动作留痕，事后能溯源。
    // 不返回给前端、不进备份（不属于 configs 表）。
    `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor TEXT, ip TEXT, detail TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    // 账号表：从「单管理员」升级为「多账号」。
    // 首个账号（owner）就是升级前那套 configs 里的管理员，历史数据全部挂在它名下，
    // 老部署升上来不会「数据凭空消失」。
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    // 邀请码：已登录用户生成，新用户注册时用掉。时间戳一律存秒，避免 SQLite 时区歧义。
    `CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_by INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by INTEGER, used_at INTEGER);`,
    // 每账号一份的配置（WebDAV 备份凭据等）。与 configs 分开存：
    // configs 是全站共享的（标题、背景），塞进去就会被别的账号看到。
    `CREATE TABLE IF NOT EXISTS user_configs (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, key));`,
    // 令牌黑名单（退出登录 = 服务端可吊销）。
    // 以前是 configs 里一个 JSON 字符串：两个请求并发登出会互相覆盖（后写的把前一个
    // jti 抹掉，那张令牌就又活了），而且每次校验都要把整份 JSON 读出来解析。
    // 改成一行一条之后插入到 key 冲突时覆盖是幂等的，查也是走主键的单行查询。
    `CREATE TABLE IF NOT EXISTS token_blacklist (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
    // 记事本：全局的笔记列表，跟账号走（user_id + scopeSql 复用 sites 那套隔离）。
    //
    // 与 sites.notes（每个站点一条、跟着卡片生灭）是两回事，两者并存。
    //   - uuid：跨设备/跨导入识别同一条笔记。**合并导入靠它去重** ——
    //     没有它就只能按「标题+内容」硬比，用户改过一次的笔记会被当成两条。
    //   - site_id：可选，只是个可空引用，**故意不建外键** —— 卡片删了，笔记要留下来
    //     （这正是笔记独立于卡片的意义）。UI 上显示成「站点已删除」而已。
    //   - content 存 **Markdown 源码**，不是 HTML。
    //   - folder_id 可空：NULL = 未归类（阶段三的「未归类」视图就是靠它筛出来的）。
    //     刻意不建外键 —— 文件夹删了，笔记要留下来而不是连带消失，
    //     删文件夹时只把笔记的 folder_id 置空即可。
    `CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        uuid TEXT,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        order_num INTEGER NOT NULL DEFAULT 0,
        site_id INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        folder_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`,
    // 笔记文件夹：与分组/站点那套同一套路 —— 按账号隔离（user_id + scopeSql）。
    // 与 groups 的区别是它只装笔记，不装书签卡片，两边刻意不复用同一张表。
    NOTE_FOLDER_TABLE_SQL,
    // 笔记标签：多对多。所以只有标签本体一张表，关联关系在下面那张。
    // 存 color 只是给 UI 上色用（存色值而不是枚举 —— 以后想换调色板不用改数据）。
    NOTE_TAG_TABLE_SQL,
    // 笔记 ↔ 标签的关联表。
    // 主键选 (note_id, tag_id) 而不是 id：插入时天然幂等，同一条笔记重复打同一个标签
    // 不会插出两行（离线队列重放时这个特性特别省事，不用先查再判）。
    NOTE_TAG_LINK_TABLE_SQL,
    // 回收站：站点 / 分组删除不再硬删，先原样搬到这里，给「删错了」留后悔药。
    // data 存原始行（站点含密文密码，不解密，避免落回明文）；owner_user_id 做按账号隔离。
    `CREATE TABLE IF NOT EXISTS recycle_bin (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        owner_user_id INTEGER,
        data TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        expires_at INTEGER
    );`,
    // 登录会话：一台设备一行（jti = 那张令牌的编号），用来做「只踢某一台设备」。
    // 没启用鉴权的部署（guest 令牌）uid 为 NULL —— 那种场景下整站就一个人，
    // 也就没有「踢别人」的需求，记下来只为界面上能看到自己登过哪几台。
    `CREATE TABLE IF NOT EXISTS user_sessions (
        jti TEXT PRIMARY KEY,
        user_id INTEGER,
        user_agent TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );`,
    // 幂等键：离线队列重放 / 网络超时重试时，客户端给每次「意图」发一个不重复的 ID，
    // 服务端据此认出「这一条其实已经执行过了」，直接把上次的响应回放回去，
    // 而不是再建一个重复站点。
    //
    // 为什么单独建表而不是塞 configs：
    //   - configs 会进备份文件，这些临时回放记录混进去只会让备份变脏；
    //   - configs 的写入要过所有者门控，普通账号记不了自己的幂等状态；
    //   - 主键 (scope, op_id) 天然是「抢占位」的语义 —— 两个并发请求同时 INSERT，
    //     只有一个成功，另一个立刻知道自己来晚了，不用读改写。
    // scope 里带账号 id 与操作类型，所以不同账号、不同端点之间不会互相撞。
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
        scope TEXT NOT NULL,
        op_id TEXT NOT NULL,
        user_id INTEGER,
        state TEXT NOT NULL,
        status INTEGER,
        body TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, op_id)
    );`,
    // 站点语义向量：AI 语义搜索用（「搜描述里没写的东西」）。
    //
    // 为什么不用 Vectorize：现在这个站的量级是几十条，把向量存 D1、查询时在 Worker 内存里
    // 算余弦相似度就够了，不引新绑定（绑定要在 wrangler.jsonc 里声明，账号没开通会直接
    // 让部署失败），也不给冷启动加一次远程查询。上千条再迁到向量库不迟 —— 那时换掉
    // 读写这两处即可，接口不变。
    //
    // vec 存 JSON 数组（不是 BLOB）：D1 里 BLOB 读写要转成 Uint8Array 再回来，
    // 而这里的数据量是几十条、每行几 KB，JSON 更好调试也更好迁移。
    // model 记下来是为了「换了嵌入模型就把旧向量作废」——不同模型的向量不能互相比较。
    `CREATE TABLE IF NOT EXISTS site_embeddings (
        site_id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,
];

/**
 * 索引（幂等）。
 *
 * 建这几条是因为：groups / sites 的每个查询都会被 scopeSql() 追加 `user_id = ?` 做账号隔离，
 * 而 D1 里这两列没有索引，于是任何一次列表查询都是全表扫；定时清理同理 —— audit_log /
 * recycle_bin / token_blacklist / invites 都是按时间范围 DELETE，没有索引就整表扫一遍。
 * 审计日志是唯一会持续膨胀的表（每次写操作都留痕），扫的代价随使用时间线性增长。
 *
 * 注意：必须等所有「补列」迁移跑完才能建索引 —— groups / sites 的 user_id 是
 * migrateOwnerColumns() 用 ALTER 加出来的，在它之前建会因列不存在直接报错。
 * 所以这里单独成一个步骤，排在 runMigrations 的最后。
 */
export const INDEX_STATEMENTS = [
    // 按分组取站点（最频繁的查询路径）
    `CREATE INDEX IF NOT EXISTS idx_sites_group_id ON sites(group_id);`,
    // 账号隔离：SELECT ... FROM sites WHERE user_id = ?
    `CREATE INDEX IF NOT EXISTS idx_sites_user_id ON sites(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_groups_user_id ON groups(user_id);`,
    // 回收站：按账号列清单（ORDER BY id DESC）+ 定时清理按时间删
    `CREATE INDEX IF NOT EXISTS idx_recycle_bin_owner ON recycle_bin(owner_user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_recycle_bin_deleted_at ON recycle_bin(deleted_at);`,
    // 记事本：列清单（pinned DESC, order_num）+ 合并导入按 uuid 找
    // 不写 `pinned DESC`：SQLite 的索引本来就能反向扫描满足 DESC 排序，
    // 写上去只会让「按列名解析索引」的校验工具误判（把 "pinned DESC" 当成一个列名）。
    `CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, pinned, order_num);`,
    `CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(user_id, archived, updated_at);`,
    `CREATE INDEX IF NOT EXISTS idx_notes_uuid ON notes(user_id, uuid);`,
    // 文件夹视图：WHERE folder_id = ? ORDER BY updated_at，两个条件都得能走索引
    `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(user_id, folder_id, updated_at);`,
    // 文件夹 / 标签清单：列表查询都带 user_id 过滤
    `CREATE INDEX IF NOT EXISTS idx_note_folder_user ON note_folder(user_id, order_num);`,
    `CREATE INDEX IF NOT EXISTS idx_note_tag_user ON note_tag(user_id, name);`,
    // 标签视图：按标签筛笔记时，从关联表按 tag_id 出发找 note_id
    `CREATE INDEX IF NOT EXISTS idx_note_note_tag_tag ON note_note_tag(tag_id, note_id);`,
    `CREATE INDEX IF NOT EXISTS idx_note_note_tag_note ON note_note_tag(note_id, tag_id);`,
    // 定时清理：审计日志 / 令牌黑名单 / 邀请码都按过期时间整批删
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_token_blacklist_exp ON token_blacklist(exp);`,
    `CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON invites(expires_at);`,
    // 登录会话：按账号列清单 + 按过期时间清理
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);`,
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);`,
    // 幂等记录按过期时间整批清（跟其它临时表一个套路）
    `CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_keys(expires_at);`,
];

// 还原时的兜底字段：只在读不到表结构（pragma 不可用）时才用，
// 正常情况下按回收站里那份原始行的列来插，避免写死清单跟表结构脱节。
export const SITE_RESTORE_COLUMNS = [
    "id", "group_id", "name", "url", "icon", "description", "notes",
    "username", "password", "order_num", "created_at", "updated_at", "user_id",
];

export const GROUP_RESTORE_COLUMNS = [
    "id", "name", "order_num", "created_at", "updated_at", "user_id",
];

// 数据库迁移只需在每个 Worker isolate 中执行一次。
// 注意：NavigationAPI 是每个请求 new 出来的，实例字段无法跨请求复用，
// 之前迁移挂在实例上导致「每个请求都跑一遍 DDL」，这是接口变慢的主因，所以缓存放在模块作用域。
// 包一层对象是为了让别的文件也能读写（模块级的 let 没法从外部赋值）。
export const migrationState: { promise: Promise<void> | null } = { promise: null };

/**
 * 仅供测试：清掉迁移缓存。
 * 生产环境每个 isolate 只应迁移一次（缓存是有意为之），但测试里每个用例都要换一套
 * 全新的内存数据库，不重置的话第二个用例起就永远跑不到建表 / 迁移逻辑。
 */
export function resetMigrationCacheForTests(): void {
    migrationState.promise = null;
}

// 邀请码取自「去掉易混字符」的字母表：没有 0/O、1/I，口头转述也不容易错。
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomInviteCode(length = 8): string {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes)
        .map(byte => INVITE_ALPHABET[byte % INVITE_ALPHABET.length])
        .join("");
}

/** 去掉每个站点的账号密码，其它字段原样保留 */
export function stripSiteCredentials(sites: Site[]): Site[] {
    return sites.map(site => ({ ...site, username: "", password: "" }));
}

/** 备份文件里的本机偏好做一次清洗：只保留数字 id 和字符串标签，脏数据直接丢掉 */
export function sanitizeLocalPrefs(input: LocalPrefsBackup): LocalPrefsBackup {
    const starred = Array.isArray(input.starred)
        ? Array.from(new Set(input.starred.filter(id => typeof id === "number" && Number.isFinite(id))))
        : [];

    const tags: Record<string, string[]> = {};
    if (input.tags && typeof input.tags === "object") {
        for (const [siteId, list] of Object.entries(input.tags)) {
            if (!Array.isArray(list)) continue;
            const clean = Array.from(
                new Set(list.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim()))
            );
            if (clean.length > 0) tags[String(siteId)] = clean;
        }
    }

    return { starred, tags };
}

/**
 * 清洗导入备份里的图标 URL：只放行 http(s) / data:image / 相对路径，
 * 丢弃 javascript:/vbscript:/file:/data:text/html 等可执行/危险协议。
 * 图标只作 <img src> 渲染，风险本就低，这里只是和 url 同样做一层规范化。
 */
export function sanitizeIconUrl(icon: string): string {
    const v = (icon || "").trim();
    if (!v) return "";
    // 挡掉可执行/危险协议：javascript:/vbscript:/file: 以及 data:text/html（HTML 文档可带脚本）。
    // 放行 http(s)、data:image（头像 base64）、以及相对路径（/api/icon?... 这类图标代理）。
    if (/^(javascript|vbscript|file|data:text\/html)/i.test(v)) return "";
    return v;
}
