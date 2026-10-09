// 进出 NavigationAPI 的数据形状，以及只跟这些形状打交道的纯函数。
//
// 从 http.ts 拆出来：这一整块是「数据长什么样」，跟数据库读写无关，
// 前端、Worker 路由、测试都要 import，不该被塞在一个四千行的类前面。

import type { BackupIntegrity } from "../utils/backupIntegrity";

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

/**
 * 记事本里的一条笔记。
 *
 * 与 `Site.notes`（每个站点一条、跟着卡片生灭）是两回事，两者并存：
 * 站点备注记「这个站怎么登录」，记事本记「临时想法、待办、片段」。
 */
export interface Note {
    id?: number;
    /**
     * 跨设备 / 跨导入识别同一条笔记。**合并导入靠它去重** ——
     * 没有它就只能按「标题 + 内容」硬比，用户改过一次的笔记会被当成两条。
     * 服务端在 createNote 时生成。
     */
    uuid?: string;
    title: string;
    /** Markdown 源码，不是 HTML */
    content: string;
    /** 置顶排在最前 */
    pinned?: boolean;
    order_num?: number;
    /**
     * 可选：这条笔记是关于哪个站点的。
     * **不建外键** —— 卡片删了，笔记要留下来；所以它只是一个可空引用。
     */
    site_id?: number | null;
    /** 阶段三：归档。归档后不在「全部」里列表，但还好好留着，可以随时取回 */
    archived?: boolean;
    /** 阶段三收尾：归入哪个文件夹。NULL = 未归类 */
    folder_id?: number | null;
    created_at?: string;
    updated_at?: string;
}

/** 分享令牌只在主人接口返回；公开接口仅返回正文白名单。时间单位为毫秒。 */
export interface NoteShare {
    token: string;
    expires_at: number | null;
    /** 所属笔记的创建时间（getNoteShare 顺带返回；公开页等其它链路可能没有） */
    created_at?: string;
    /** 累计浏览次数（每次公开页成功打开 +1；后端补全站计数） */
    views?: number;
    /** 是否设置了访问口令（true = 公开页需要输口令才能看；仅主人接口返回） */
    hasPassword?: boolean;
}

/**
 * 图片附件的存储通道（2026-07）。
 *
 * ⚠️ 这是**有主次**的，不是二选一（见 worker/attachments.ts 的 selectAttachmentStorage）：
 *   "r2" 优先（R2 更合适：读配额便宜、可设缓存头）；没有 R2 才退 "kv"。
 * 现在部署只配了 KV，所以实际都落在 "kv"；以后加一条 r2 绑定就自动切换，
 * **前端与 API 都不用改**。
 *
 * 之所以单独定义而不是引用 worker/attachments.ts 的类型：那份文件在 worker/
 * 目录里、依赖 Workers 运行时；前端 bundle 不能引它（会把 @cloudflare/workers-types
 * 拖进浏览器构建，与 DOM lib 打架 —— tsconfig.tests.json:10-12 记着这个坑）。
 */
export type AttachmentStorage = "r2" | "kv";

/**
 * 一张图片的**元数据**（2026-07）。二进制不在这里 —— 25MB 的图走 JSON 会撑爆响应体。
 * 取图走 `GET /api/notes/attachments/<id>`。
 */
export interface NoteAttachment {
    /** uuid 字符串（不是自增整数）：对象 key 里带它，见 worker/attachments.ts */
    id: string;
    note_id: number | null;
    filename: string;
    mime: string;
    size: number;
    storage: AttachmentStorage;
    /** 只在服务端用；列给前端时会被剥掉（暴露它等于泄漏存储布局） */
    object_key?: string;
    created_at: number;
}

/**
 * 上传一张图的返回结果。
 *
 * ⚠️ 单独起个名字而不是内联写 `Promise<{…}>` ——
 * mock.ts 那个内联写法让 TS 解析器在 `noteId?: number | null): Promise<{…}> {`
 * 这里卡住（TS1068 连报三行），排查绕了很久。具名类型没这个问题。
 */
export interface AttachmentUploadResult {
    id: string;
    /** 取图地址。⚠️ 走鉴权，`<img src>` 不能直接用（会 401），要 fetch 成 blob */
    url: string;
    filename: string;
    mime: string;
    size: number;
}
/** 分享列表的一行（设置页「分享列表」用；把笔记标题一起带出来，省一次请求） */
export interface NoteShareListItem {
    note_id: number;
    title: string;
    token: string;
    /** null = 永不过期 */
    expires_at: number | null;
    created_at?: string;
    updated_at?: string;
    /** 累计浏览次数（后端补全站计数） */
    views?: number;
}

/**
 * 数据页概览里「双链」「版本历史」两格需要的全站计数（inkstone 的 settings.stats）。
 * 这两项是后端现算的：版本历史 = note_revision 总行数；双链 = 全站正文里
 * `[[目标]]` 引用出现的总次数（不含 `![[...]]` 嵌入）。前端不持有全量正文，
 * 不能像「笔记/文件夹/标签/总字数」那样在本地现算，必须走这个端点。
 */
export interface NoteStats {
    /** 全部笔记的历史快照总数（note_revision 行数，按账号隔离） */
    versions: number;
    /** 全站 `[[双链]]` 引用出现次数（不含 `![[嵌入]]`） */
    links: number;
}
export interface PublicNote {
    title: string;
    content: string;
    updated_at?: string;
    /** 累计浏览次数（随这次访问 +1 后的值） */
    views?: number;
}

/**
 * 公开取笔记的结果（getPublicNote 的返回）。
 * 用判别联合把「没找到 / 要口令 / 正文」三态分清楚，路由与公开页都按 status 分支，
 * 不用再靠「null 到底是没找到还是没权限」这种含糊语义猜。
 */
export type PublicNoteAccess =
    | { status: "ok"; note: PublicNote; views: number }
    | { status: "need-password" }
    | { status: "not-found" };

/** 笔记文件夹（row 形状和 note_folder 表一致，count 是查询时顺带算出来的） */
export interface NoteFolder {
    id?: number;
    user_id?: number | null;
    /** NULL = 根文件夹；父子关系只允许同账号且无环。 */
    parent_id?: number | null;
    name: string;
    order_num?: number;
    /**
     * 文件夹外观（inkstone 的「文件夹外观」）：图标名 + 颜色。
     * 存的是**约定枚举的字符串**（icon 名 / 十六进制色值），不是自由文本——
     * 渲染端只认自己调色板里的名字，脏数据直接按默认样式画。
     * 两个都可空：空 = 默认图标 + 默认颜色（老数据一行都不用回填）。
     */
    icon?: string | null;
    color?: string | null;
    /** UI 要显示「这个文件夹几条」，查询时算出来，不进表里 */
    count?: number;
    created_at?: string;
    updated_at?: string;
}

/** 笔记标签（row 形状和 note_tag 表一致） */
export interface NoteTag {
    id?: number;
    user_id?: number | null;
    name: string;
    color?: string | null;
    /** 同上：用到这条标签的笔记数 */
    count?: number;
    created_at?: string;
    updated_at?: string;
}

/**
 * 笔记的一个历史快照（note_revision 表）。
 *
 * `content` 在**列表接口里是空串**（为了不一次拉十几份正文全文），
 * 只有 getNoteRevision 才带真的 —— 所以判断「有没有正文」别拿它。
 */
export interface NoteRevision {
    id: number;
    note_id: number;
    title: string;
    content: string;
    /** 列表接口返回的正文摘要，给用户一眼认出是哪一版 */
    excerpt?: string;
    created_at?: string;
    /** 字数差（相对当前正文），比「有多少字」更有用：一眼看出改动大小 */
    size?: number;
}

/** 导入后笔记的处理统计（合并模式下用户要知道每种各几条） */
export interface NoteImportStats {
    /** 文件里有、本地没有 → 新增 */
    created: number;
    /** 同 uuid，取了文件里较新的一份 → 覆盖 */
    updated: number;
    /** 同 uuid 但本地较新，或内容一致 → 保留本地不动 */
    skipped: number;
    /** 完全覆盖模式下被清掉的本地笔记数 */
    removed: number;
}

/**
 * 记事本导出文件的形状（NotesPage exportAllData 生成，notes/import 读回）。
 * 与全站备份（ExportData）**不是一个格式**：这里没有 groups/sites/configs，
 * 导入只动记事本，绝不碰导航站数据 —— 所以也不能复用 transfer.importData
 * （那条路径会先清空再重建分组/站点，空数组等于清光导航站）。
 */
export interface NotesImportPayload {
    /** "navihive-notes-export"（老导出文件没写也接受，按字段形状判） */
    kind?: string;
    notes?: Note[];
    /** 备份内引用的文件夹/标签 id，导入时按「父路径+名称」/「名称」去重重建 */
    folders?: NoteFolder[];
    tags?: NoteTag[];
    /** 导出方笔记 id -> 标签 id 列表（JSON 的键一定是字符串）；导入时翻译到新 id */
    noteTags?: Record<string, number[]>;
}

// WebDAV 备份配置
export interface WebDavConfig {
    url: string;
    username: string;
    password: string;
    path: string;
    /**
     * 备份文件的加密口令（可选，留空 = 不加密）。
     *
     * 刻意不用 AUTH_SECRET 当备份密钥：AUTH_SECRET 是 JWT 签名密钥，轮换它会让此前
     * 所有备份一起变成解不开的废文件；而备份一旦传到网盘，本来就不在服务端密钥的
     * 保护范围内。用用户自己的口令，换服务端密钥不影响历史备份。
     * 落库时和 webdav.password 一样加密（只是静态保护，密钥本身仍由用户掌握）。
     */
    backupPassword?: string;
    /**
     * 允许 WebDAV 服务器指向内网 / 本机地址（如家里 NAS 的 192.168.x.x、xxx.local）。
     * 默认关闭 —— Worker 代发请求前会挡掉内网地址，防止账号一旦被攻破就把 Basic 凭据
     * 打到内网服务上。只有确认 WebDAV 就在自己内网时才打开。
     */
    allowPrivateNetwork?: boolean;
}

// WebDAV 远端备份文件信息
export interface WebDavFile {
    name: string;
    size: number;
    lastModified: string;
}

/**
 * WebDAV 失败原因代码。
 * 「口令加密」「口令不对」都靠它区分：备份文件是别的账号传的、或本账号没存过备份口令时，
 * 前端要能弹出口令输入框，而不是笼统报一句「下载失败」让人不知道下一步该干嘛。
 */
export type WebDavErrorCode = "encrypted" | "badPassword";

// WebDAV 操作通用返回
export interface WebDavResult<T = unknown> {
    success: boolean;
    message?: string;
    data?: T;
    code?: WebDavErrorCode;
}

// 新增配置接口
export interface Config {
    key: string;
    value: string;
    created_at?: string;
    updated_at?: string;
}

// 只存在浏览器本机、但跟着备份文件一起走的偏好（星标站点 + 站点标签）。
// 它们没有对应的数据库字段，导出/恢复都由前端负责写入 localStorage。
export interface LocalPrefsBackup {
    /** 加了星标的站点 id */
    starred?: number[];
    /** 站点 id -> 标签名数组（JSON 的键一定是字符串） */
    tags?: Record<string, string[]>;
}

// 导出数据接口
export interface ExportData {
    groups: Group[];
    sites: Site[];
    /**
     * 记事本。老备份文件里没有这个字段 —— 那时还没有记事本。
     *
     * 可选还有一个原因：`normalizeImportData` 为「老文件没有新字段」做了兼容，
     * 导入时 `notes` 为 undefined 就**保持本地笔记原样不动**（清空会毁掉用户现有的笔记）。
     */
    notes?: Note[];
    /** 文件夹和标签的 id 仅作为备份内引用，恢复时重新映射。缺失表示老备份。 */
    noteFolders?: NoteFolder[];
    noteTags?: NoteTag[];
    /** 用笔记 uuid 关联标签，绝不依赖源库笔记 id。 */
    noteTagLinks?: { note_uuid: string; tag_id: number }[];
    /**
     * 跟着「账号」走的配置（目前没有非敏感的按账号配置，所以这里是空的；
     * webdav.* 属敏感配置，与 auth.* 一样不进备份）。
     */
    configs: Record<string, string>;
    /**
     * 全站共享的配置（标题 / 主题 / 背景…）。
     * 只有「这份备份有权改全站」时才会写进文件（站点所有者，或未启用登录的单账号部署）。
     * 老备份没有这个字段 —— 那时候全站设置混在 configs 里，导入时按同一套归属规则判断。
     */
    sharedConfigs?: Record<string, string>;
    version: string;
    exportDate: string;
    /** 本机偏好（星标 / 标签），老备份文件里没有这个字段 */
    localPrefs?: LocalPrefsBackup;
    /**
     * 内容摘要，导入前用来判断文件有没有损坏（见 utils/backupIntegrity）。
     * 老备份没有这个字段 —— 导入时一律放行，不会因为少了它就恢复不了。
     */
    integrity?: BackupIntegrity;
}

/** 导入结果：成功与否 + 新旧 id 映射（前端的星标 / 标签记的是旧 id，要翻译一遍） */
export interface ImportResult {
    success: boolean;
    message?: string;
    /** 备份里的分组 id -> 库里新分到的 id（JSON 的键一定是字符串） */
    groupIdMap: Record<string, number>;
    /** 备份里的站点 id -> 库里新分到的 id */
    siteIdMap: Record<string, number>;
    /**
     * 笔记三态统计。
     *
     * 为什么必须有：合并模式下「本地较新就不动」是**正确行为**，但不给用户一个数字，
     * 他会以为导入没生效。老备份没有笔记时全为 0。
     */
    noteStats?: NoteImportStats;
}

/** 导入的阶段，顺序与服务端真实推进的顺序一致 */
export type ImportStage = "verify" | "encrypt" | "write" | "cleanup" | "done";

/** 一次导入的阶段进度。done/total 是服务端数出来的真实条数，不是估算。 */
export interface ImportProgress {
    stage: ImportStage;
    done: number;
    total: number;
}

export interface ImportOptions {
    /**
     * 阶段进度回调。只在前端确实要显示进度时才传 —— 传了会走流式响应，
     * 服务端边跑边推真实进度；不传就是普通的一问一答。
     */
    onProgress?: (progress: ImportProgress) => void;
    /**
     * 备份里的笔记怎么处理。默认 `merge`。
     *
     * - `merge`（默认）：按 uuid 识别同一条笔记，本地没有就插入；同 uuid 时
     *   比 updated_at，**文件里较新才覆盖，本地较新就保留本地**。
     *   本地多出来的笔记原样保留 —— 合并的意思就是不动本地多余的。
     * - `replace`：先清空本地笔记再插入（与卡片的行为一致）。用于「用一份旧备份
     *   真正回滚」，所以 UI 上要用 destructive 的措辞提示「本地笔记会被清掉」。
     *
     * 备份里**没有** notes 字段时（老备份 / 用户关了「备份含记事本」），
     * 无论哪种模式都**保持本地笔记原样不动** —— 清空不可逆，宁可什么都不做。
     */
    notesMode?: "merge" | "replace";
}

/**
 * 导入进度的流式响应媒体类型。
 *
 * 前端用它当 Accept 头要进度，服务端用它当 Content-Type 回 NDJSON
 * （每行一个 {type:"progress"|"result"|"error"}），两边共用同一个常量，免得写歪。
 * 老部署不认这个 Accept，回的还是普通 JSON —— 前端按 Content-Type 自动兜住。
 */
export const IMPORT_PROGRESS_MEDIA = "application/x-ndjson";

/**
 * 批量改排序 / 移动卡片的结果。
 *
 * 以前只回一个 boolean：D1 没有跨语句事务，一批里第 50 条挂了，前 49 条照样写进去了，
 * 返回 false 之后前端整体不更新 —— 库里搬走一半、界面还停在原样，得手动刷新才看得到。
 * 现在把「成了哪几个、没成哪几个」如实回传，前端按实际结果更新并说明。
 */
export interface SiteOrderUpdateResult {
    /** 全部成功 */
    success: boolean;
    /** 真正写进去的卡片 id */
    updated: number[];
    /** 没写进去的卡片 id（卡片不存在、不是自己的，或目标分组不是自己的） */
    failed: number[];
}

/** 批量删除的结果：items 里有 recycleId 的才算真删掉了 */
export interface SiteBatchDeleteResult {
    items: Array<{ id: number; recycleId?: number }>;
    /** 一个都没动过的 id（卡片不存在 / 不是自己的 / 回收站没写进去） */
    failed: number[];
}

/** 批量从回收站还原的结果：restored 直接给前端插回界面，省掉一次全量重拉 */
export interface RecycleBatchRestoreResult {
    /** 还原出来的站点（按原始 id 插回，密码已解密） */
    restored: Site[];
    failed: number[];
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
    /** 勾选「记住我」时签发更长期限的令牌（1 个月），实现免登录 */
    remember?: boolean;
}

export interface LoginResponse {
    success: boolean;
    token?: string;
    message?: string;
    /** 首次部署的种子凭据还没换过：服务端会拦住其它写操作，直到改一次密码 */
    mustChangePassword?: boolean;
    // 多账号后登录响应带上账号身份，前端不必再发一次请求问「我是谁」
    username?: string;
    role?: "owner" | "user";
}

/** 注册结果：成功时顺带把账号信息回给前端，省掉一次 /auth/me */
export interface RegisterResult {
    success: boolean;
    message: string;
    user?: UserRecord;
}

/**
 * 会话存活状态：令牌验签通过之后，还要确认账号本身还在不在。
 * missing = 账号已被清除（沉睡治理 / 注销），但手上这张 30 天令牌还没过期。
 */
export type AccountSessionState = "active" | "disabled" | "missing";

/** 账号记录（不含哈希，只给能下发的字段用） */
export interface UserRecord {
    id: number;
    username: string;
    /** owner = 站点所有者（首个账号），user = 被邀请进来的普通账号 */
    role: "owner" | "user";
    created_at?: string;
}

/** 账号列表项（owner 在「账号管理」里看到的那一列，含沉睡治理状态） */
export interface AccountInfo {
    id: number;
    username: string;
    role: "owner" | "user";
    /** active = 正常；disabled = 已因长期未登录被停用（数据仍在，登录会被拒） */
    status: "active" | "disabled";
    /** 最后活跃时间（秒级时间戳；null = 从未登录过，用创建时间当锚点） */
    lastActiveAt: number | null;
    /** 被停用的时间（秒级时间戳） */
    disabledAt: number | null;
    createdAt: number | null;
    /** 按当前阈值推算：active -> 预计被停用的时间；disabled -> 预计被清除的时间 */
    willDisableAt: number | null;
    willDeleteAt: number | null;
}

/**
 * 登录会话：一台设备一张（jti 就是那张令牌的编号）。
 * 「退出登录 / 踢掉某台设备」靠它才能精确到单台 —— 否则只能改密把全部设备一起踢掉。
 */
export interface SessionInfo {
    jti: string;
    /** 浏览器 UA（入库时已截断，避免超长 UA 把行撑爆） */
    userAgent: string;
    ip: string;
    /** 签发时间（秒） */
    createdAt: number;
    /** 最后活跃（秒）；限频刷新，不代表「刚刚」 */
    lastSeenAt: number;
    /** 这张令牌的过期时间（秒） */
    expiresAt: number;
    /** 是否为发起本次请求的这一台（列表里标「当前设备」并禁用它的吊销按钮） */
    current: boolean;
}

/**
 * 沉睡治理的时间轴推算（纯函数，便于单测，不碰数据库）。
 * 判定口径：
 *   - active：以「最后活跃时间」为锚点（从没活跃过就退回创建时间），锚点 + 停用阈值；
 *   - disabled：以「被停用时间」为锚点，锚点 + 清除宽限期 -> 预计被清除。
 * 「记住我」静默恢复也会刷新最后活跃时间，所以每天来的人不会被误判沉睡。
 */
export function computeInactiveTimeline(
    base: {
        status: string;
        lastActiveAt: number | null;
        disabledAt: number | null;
        createdAt: number | null;
    },
    disableDays: number,
    graceDays: number
): { willDisableAt: number | null; willDeleteAt: number | null } {
    const day = 24 * 60 * 60;
    if (base.status === "disabled") {
        // 已停用：只关心「什么时候会被清除」
        if (base.disabledAt === null) return { willDisableAt: null, willDeleteAt: null };
        return { willDisableAt: null, willDeleteAt: base.disabledAt + graceDays * day };
    }
    // active：算「什么时候会被停用」
    const anchor = base.lastActiveAt ?? base.createdAt;
    if (anchor === null) return { willDisableAt: null, willDeleteAt: null };
    return { willDisableAt: anchor + disableDays * day, willDeleteAt: null };
}

/** 邀请码信息（生成后返回给前端展示） */
export interface InviteInfo {
    code: string;
    /** 过期时间（秒级时间戳） */
    expiresAt: number;
    /** 有效期秒数，前端用来显示「30 分钟内有效」 */
    ttlSeconds: number;
}

/** AI 助手的可用性（/api/ai/status 的返回）：前端拿它决定按钮置不置灰 */
export interface AiStatus {
    enabled: boolean;
    provider: string;
    textModel: string;
    embedModel: string;
    /** 已经算好向量的站点数量 */
    embedded: number;
    /** 还缺什么；null 表示可以正常调用 */
    problem: string | null;
}

/**
 * AI 建议类接口的返回。
 * 成功时带着建议内容，失败时只有一句话的原因 —— 前端一律把 message 摆在按钮旁边，
 * 不做弹窗、不阻断用户正在做的事（AI 帮不上忙不等于操作失败）。
 */
export type AiSuggestResponse<T> =
    | ({ success: true } & T)
    | { success: false; message: string };

/** 测试连接时某一项的探测结果（文本模型 / 嵌入模型各一项） */
export interface AiProbeResult {
    ok: boolean;
    /** 没通的原因，直接来自模型服务那边的原话 */
    message?: string;
    /** 嵌入向量的维度（仅嵌入项有） */
    dim?: number;
}

/** POST ai/test 的返回：success 表示文本与嵌入两项都通 */
export type AiTestResponse =
    | {
          success: true;
          text: AiProbeResult;
          embed: AiProbeResult;
      }
    | {
          success: false;
          message: string;
          text?: AiProbeResult;
          embed?: AiProbeResult;
      };
