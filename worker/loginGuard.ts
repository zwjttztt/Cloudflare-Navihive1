// worker/loginGuard.ts

import type { NavigationAPI } from "../src/API/navigationApi";
import { ApiError, errorResponse } from "./lib/apiError";
import { REAL_IP_HEADER, X_REAL_IP_HEADER } from "./httpUtils";

// ============ 登录失败限速 ============
// 连续输错会越等越久，避免密码被无限次猜。
//
// ⚠️ 存储从 configs 里的「一整块 JSON」搬到了 **rate_limit_bucket 表（一桶一行）**
// （C1，schema 29）。原来十把锁各自把**所有来源**的计数塞进一条 configs 记录
// （单份上限 2000 桶 ≈ 220 KB），每次「输错一次密码」都要读 220 KB → 全量 JSON.parse
// → 改一个桶 → 排序裁剪 → serialize → CAS 写回 220 KB，并发撞上 CAS 还要整套重跑。
// 现在一次失败 = 一条 upsert（`count = count + 1`）。为什么不双写 / 不惰性回查旧 JSON，
// 见 src/API/methods/internals.ts 里 RATE_LIMIT_BUCKET_TABLE_SQL 的注释。
// 旧键（auth.*Guard）**保留不动、不再写入**，那是回滚用的冷冻快照。
export const LOGIN_GUARD_KEY = "auth.loginGuard";
// 前 5 次给手滑留余地，之后每次等待时间翻倍
export const LOGIN_FREE_ATTEMPTS = 5;
export const LOGIN_BASE_LOCK_MS = 60_000; // 第 6 次起锁 1 分钟
export const LOGIN_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

// 该端点每天不限 developments —— 但过去这把锁是**全站一把**：
// 任何人只要连着输错 5 次，站点主人自己也登不进去了（最长 30 分钟）。
// 多账号上线后这条从「防爆破」变成了「DoS 入口」：陌生人动动手指就能把所有人挡在门外。
// 现在按来源 IP 分桶：A 乱猜只会锁住 A 自己。
// 桶数设上限 + 清理长时间不活动的桶，避免有人用一堆代理 IP 把这张表撑爆。
export const MAX_BUCKETS = 2_000;
/** 桶多久没动静就丢掉（24 小时）。注意：处于锁定期的桶不在此列，必须留到解锁。 */
export const BUCKET_IDLE_MS = 24 * 60 * 60 * 1000;

export interface LoginGuard {
    count: number;
    /** 解锁时刻（毫秒时间戳）；0 表示当前不在锁定期 */
    until: number;
}

/** 存储结构：扁平的 {count, until} 是旧格式（全站一把锁），新格式按桶名索引 */
export interface GuardState extends LoginGuard {
    /** 该桶最后一次被写入的时刻（毫秒），用于清理长期不活动的桶 */
    seen?: number;
}
export type GuardStore = Record<string, GuardState>;

/**
 * 取客户端标识（限速分桶用）。
 *
 * Cloudflare 部署下 `CF-Connecting-IP` 由平台注入、客户端伪造不了，直接用。
 * 自托管（没有 CF-Connecting-IP）时，**默认不再信任 `X-Forwarded-For`**：
 * 否则攻击者每次换一个 XFF 首段就能换一个新桶，把爆破限速彻底绕过去。
 * 只有在「明确把 Worker 放在可信反代后面、反代会老实填 XFF」的部署里，
 * 才把 `NAVIHIVE_TRUST_XFF=1` 打开、显式允许读 XFF 首段。
 *
 * ⚠️ 2026-11-01 XFF 绕过加固：即便 TRUST_XFF=1，只要反代用的是**追加模式**
 * （`$proxy_add_x_forwarded_for`），XFF 首段仍是客户端自己填的 —— 随机换一个
 * 就换一个新桶，登录 / 注册 / 分享口令的爆破锁等于没有。所以信任链里插一档
 * `X-Real-IP`（见 X_REAL_IP_HEADER）：部署模板让 Nginx 用覆盖模式写它，
 * 客户端带来的值进不了应用，伪造不了。取值顺序变为：
 *   CF-Connecting-IP → X-Real-IP（两个开关都为真时）→ XFF 首段 → 入口 socket 对端
 * 反代没配 X-Real-IP 的老部署自动回退 XFF 首段（与旧行为一致），
 * 部署侧把 XFF 改成覆盖模式（见 deploy/nginx 模板）后彻底封死。
 *
 * ⚠️ 2026-11-02：`X-Real-IP` **也不过是客户端可填的头**，必须有独立开关
 * `NAVIHIVE_TRUST_X_REAL_IP`。只跟着 TRUST_XFF 放行是不够的：TRUST_XFF=1 只说明
 * 「这层反代老实写 XFF」，不代表它写了 X-Real-IP（Caddy / Traefik 默认就不写），
 * 那种部署里客户端自带的 `X-Real-IP` 会原样透传，每请求换一个就是全新空桶 ——
 * 五类限速同时失效，且每次尝试仍要跑一遍 PBKDF2（CPU 放大）。所以只有
 * trustXForwardedFor 与 trustXRealIp 同时为真才读这一档。
 *
 * 不信任且又拿不到真实 IP 时所有来源共用一个 `unknown` 桶 —— 最多只是限速粒度变粗，
 * 不会失守。
 *
 * ⚠️ 自托管（Node 直连、前面没有 Cloudflare）时前两条**都是客户端自己填的**：
 * 请求头里塞一个 `CF-Connecting-IP: 随机值`，每猜一次换一个就能无限换桶，
 * 登录爆破限速等于没有。所以最后一档读 `REAL_IP_HEADER`：那是 server/entry.ts
 * 从 socket 对端地址写进去的，且一律覆盖客户端带过来的值，伪造不了。
 * Workers 部署下 CF-Connecting-IP 永远命中第一档，这条链路不受影响。
 */
export function clientBucket(
    request: Request,
    trustXForwardedFor = false,
    trustXRealIp = false
): string {
    const cf = request.headers.get("CF-Connecting-IP");
    if (cf) return cf.slice(0, 64);
    if (trustXForwardedFor) {
        // 先问 Nginx 覆盖写入的 X-Real-IP（伪造不了），再回退 XFF 首段（追加模式下可伪造）。
        // ⚠️ X-Real-IP 必须第二个开关也开着才读：它是客户端可填的头，见函数头注释。
        if (trustXRealIp) {
            const real = request.headers.get(X_REAL_IP_HEADER);
            if (real && real.trim()) return real.trim().slice(0, 64);
        }
        const xff = (request.headers.get("X-Forwarded-For") || "").split(",")[0]?.trim();
        if (xff) return xff.slice(0, 64);
    }
    const real = request.headers.get(REAL_IP_HEADER);
    if (real) return real.trim().slice(0, 64);
    return "unknown";
}

/**
 * 计算「第 count 次失败后还要锁多久」。前 freeAttempts 次给手滑留余地，
 * 之后每次等待时间翻倍、封顶 maxLockMs。登录 / 恢复限速共用，避免算法重复。
 */
export function computeLockAfterFailure(
    count: number,
    freeAttempts: number,
    baseLockMs: number,
    maxLockMs: number
): number {
    const over = count - freeAttempts;
    if (over <= 0) return 0;
    return Math.min(baseLockMs * Math.pow(2, over - 1), maxLockMs);
}

/**
 * 解析存储内容；读不出来 / 格式不对都当「没有限制」（不能因为存储异常把正常用户挡在门外）。
 *
 * 导出只为两件事：迁移步骤 `rate-limit-bucket-rows` 要把旧 JSON 搬进新表，
 * 以及单测要直接核对解析规则。**新代码不再往这份 JSON 写任何东西**
 * （见文件头那条「不双写 / 不惰性回查」的说明）。
 */
export function parseGuardStore(raw: string | null): GuardStore {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        // 旧格式（扁平的 {count, until}）折算成一个名为 legacy 的桶，升级不至于「越狱」：
        // 正在锁定期的话让它锁完，否则直接丢弃这个计数
        if (parsed && typeof parsed === "object" && !("buckets" in (parsed as object))) {
            const legacy = parsed as Partial<LoginGuard>;
            const until = typeof legacy.until === "number" ? legacy.until : 0;
            if (until > Date.now()) {
                return { legacy: { count: 0, until, seen: Date.now() } };
            }
            return {};
        }
        const buckets = (parsed as { buckets?: unknown }).buckets;
        return buckets && typeof buckets === "object" ? (buckets as GuardStore) : {};
    } catch {
        return {};
    }
}

function serializeGuardStore(buckets: GuardStore): string {
    const now = Date.now();
    let entries = Object.entries(buckets).filter(([, v]) => {
        if (!v || typeof v !== "object") return false;
        if (typeof v.until === "number" && v.until > now) return true; // 还在锁定期，必须留着
        return typeof v.seen === "number" && now - v.seen < BUCKET_IDLE_MS;
    });

    // 桶太多（被一堆 IP 刷过）时先丢最久没动静的，始终给新来的 IP 留位置
    if (entries.length > MAX_BUCKETS) {
        entries = entries
            .sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0))
            .slice(0, MAX_BUCKETS);
    }

    return JSON.stringify({ version: 2, buckets: Object.fromEntries(entries) });
}

/**
 * CAS 重试次数。真撞上一次并发概率不高，重试 3 次足够；
 * 写不进去也只是「这次没能记上数」，绝不能因此把登录请求本身打回去。
 *
 * ⚠️ 现在只在两条路上还会用到它：
 *   · 新表路径里 `next` 不是「计数 +1」的那种写入（锁定期续 seen、按窗口衰减重置）；
 *   · 没有 `db` 的存储层（测试桩）走的那条 JSON 老路。
 * 热路径（新 IP 第一次、额度内多一次失败）走的是**单条原子 upsert**，不需要重试。
 */
const CAS_MAX_ATTEMPTS = 3;
/** 重试前的退避（毫秒），给抢先那一方留出写完的时间 */
const CAS_BACKOFF_MS = 10;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 条件写入（**只有 JSON 老路径用**）：只有存储值还是 expected 时才写 next。
 *
 * 早先是「读整条 → 改 → 整条写回」：两个请求同时读到旧值，各自算完再写，
 * 后写的那份会把前一份**整个盖掉**。放在限速上就是「别人的写入把攻击者积累的
 * 失败次数冲回小值」，爆破可以一直续杯 —— 这是真实的防护失效，不是洁癖。
 * 现在比较和写入合为一条 SQL（`configs.compareAndSetConfig`），抢不到就重算一次。
 * 没有 CAS 能力的存储层退回普通写入。
 */
async function casWrite(
    api: NavigationAPI,
    key: string,
    expected: string | null,
    next: string
): Promise<boolean> {
    try {
        const cas = api.compareAndSetConfig;
        if (typeof cas === "function") return await cas.call(api, key, expected, next);
        return await api.setConfig(key, next);
    } catch {
        // 写失败只影响限速强度，不影响登录本身
        return false;
    }
}

// ============ 桶行存储（rate_limit_bucket：一桶一行） ============
//
// 十把锁的计数全部落在这张表上（DDL 见 src/API/methods/internals.ts）。
// 主键是 (bucket_key, bucket)：bucket_key 就是原来的 configs 键（auth.loginGuard 等），
// bucket 是来源标识（IP / 账号+IP / IP+分享 token）。十把锁共表不共用行，互不影响。
//
// 三条硬约束（改这里之前先读一遍）：
//   1. **fail-open**：读不到 / 写不进 = 当作「没有限制」放行。这是既有设计，
//      库都读不出来时后面真正干活的那一步自己会失败，不该在这里把错误码盖成 503。
//   2. `computeLockAfterFailure` / `FREE_ATTEMPTS` / `BASE_LOCK_MS` / `MAX_LOCK_MS`
//      一个都不许动 —— 它们决定「锁多久」，与「计数存在哪」无关。
//   3. **锁定中的桶永远不许被裁掉**（`until > now` 的行裁桶 SQL 必须跳过）。

/** 一行桶的完整状态 */
interface BucketRow {
    count: number;
    until: number;
    seen: number;
}

/** 空的桶（相当于「这个来源从没失败过」） */
function emptyBucketRow(): BucketRow {
    return { count: 0, until: 0, seen: 0 };
}

/** 把任意来源的数字收成一个安全的非负整数 */
function toSafeCount(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 这个存储层有没有表（真 D1 / 自托管适配器都有 `prepare`）。
 *
 * 返回 null 的只有一种情况：测试里的极简假 api（只实现 getConfig / setConfig）。
 * 那种存储连 `db` 都没有，只能退回 configs 里的 JSON 老路 —— 这不是「双写」，
 * 同一个 api 实例永远只会走其中一条路，绝不会两边都写、也不会回查另一边。
 */
function bucketStoreOf(api: NavigationAPI): NavigationAPI["db"] | null {
    const db = (api as { db?: NavigationAPI["db"] }).db;
    if (!db || typeof db.prepare !== "function") return null;
    return db;
}

/** 读一行桶。读不到（含表不存在 / SQL 炸了）一律当作「没有限制」 */
async function readBucketRow(
    api: NavigationAPI,
    key: string,
    bucket: string
): Promise<BucketRow> {
    const db = bucketStoreOf(api);
    if (!db) return emptyBucketRow();
    try {
        const row = await db
            .prepare("SELECT count, until, seen FROM rate_limit_bucket WHERE bucket_key = ? AND bucket = ?")
            .bind(key, bucket)
            .first<{ count?: unknown; until?: unknown; seen?: unknown }>();
        if (!row) return emptyBucketRow();
        return {
            count: toSafeCount(row.count),
            until: Number(row.until) > 0 && Number.isFinite(Number(row.until)) ? Number(row.until) : 0,
            seen: toSafeCount(row.seen),
        };
    } catch {
        return emptyBucketRow();
    }
}

/**
 * 原子 +1：一条 upsert 拿回「加完之后」的 count / until。
 *
 * 这是整个 C1 的收益所在 —— 一次失败尝试只需要这一条语句（+ 需要锁定时一条 UPDATE），
 * 不再读整块 JSON、不再 serialize、不再 CAS 重试。`count = rate_limit_bucket.count + 1`
 * 在 SQL 里是原子的，所以并发请求各算各的，一次都不会丢。
 *
 * 返回 null 表示「这个存储层给不出这一行」（表不存在 / 驱动不认识 RETURNING / 写失败）——
 * 调用方按 fail-open 处理，绝不因此把请求打回去。
 */
async function bumpBucketRow(
    api: NavigationAPI,
    key: string,
    bucket: string,
    nowMs: number
): Promise<BucketRow | null> {
    const db = bucketStoreOf(api);
    if (!db) return null;
    try {
        const row = await db
            .prepare(
                `INSERT INTO rate_limit_bucket (bucket_key, bucket, count, until, seen)
                 VALUES (?, ?, 1, 0, ?)
                 ON CONFLICT(bucket_key, bucket) DO UPDATE SET
                     count = rate_limit_bucket.count + 1,
                     seen  = excluded.seen
                 RETURNING count, until`
            )
            .bind(key, bucket, nowMs)
            .first<{ count?: unknown; until?: unknown }>();
        if (!row) return null;
        const count = toSafeCount(row.count);
        // count 为 0 说明 driver 没按 RETURNING 回行（形状不对），当作写失败更安全
        if (count <= 0) return null;
        const until = Number(row.until);
        return { count, until: Number.isFinite(until) && until > 0 ? until : 0, seen: nowMs };
    } catch {
        return null;
    }
}

/**
 * 把一行桶的 `until` 抬起来（锁定）。
 *
 * 只有 `lockMs > 0` 时才发这一条 —— 正常（未超额）的失败尝试只有一条 upsert，
 * 不会多花一次往返。并发下谁先写谁生效，都是同一个 `now + lockMs`，
 * 差异只有几毫秒，对「等多久」没有意义。
 */
async function lockBucketRow(
    api: NavigationAPI,
    key: string,
    bucket: string,
    untilMs: number
): Promise<boolean> {
    const db = bucketStoreOf(api);
    if (!db) return false;
    try {
        await db
            .prepare("UPDATE rate_limit_bucket SET until = ? WHERE bucket_key = ? AND bucket = ?")
            .bind(untilMs, key, bucket)
            .run();
        return true;
    } catch {
        return false;
    }
}

/**
 * 绝对写回一行（count / until / seen 全给）。`writeXxxGuard` 那条路用它 ——
 * 那些调用方本来就有确定的终值，不需要读-改-写。
 */
async function writeBucketRow(
    api: NavigationAPI,
    key: string,
    bucket: string,
    state: BucketRow
): Promise<boolean> {
    const db = bucketStoreOf(api);
    if (!db) return false;
    try {
        await db
            .prepare(
                `INSERT INTO rate_limit_bucket (bucket_key, bucket, count, until, seen)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(bucket_key, bucket) DO UPDATE SET
                     count = excluded.count,
                     until = excluded.until,
                     seen  = excluded.seen`
            )
            .bind(key, bucket, state.count, state.until, state.seen)
            .run();
        return true;
    } catch {
        return false;
    }
}

/**
 * 行的「值等 CAS」写入：只有这一行还是我们读到的样子才写。
 *
 * 只给「`next` 不是简单 +1」的场景用（锁定期续 seen / 按窗口衰减重置）。
 * `WHERE` 里带上旧的 count/until/seen 三个值 —— 等于把原来「整块 JSON 的 CAS」
 * 缩小到这一行：别人改的是**别的桶**时不会把我们挤掉，只有同桶并发才会重试。
 */
async function casWriteBucketRow(
    api: NavigationAPI,
    key: string,
    bucket: string,
    prev: BucketRow,
    next: BucketRow
): Promise<boolean> {
    const db = bucketStoreOf(api);
    if (!db) return false;
    try {
        const updated = await db
            .prepare(
                `UPDATE rate_limit_bucket SET count = ?, until = ?, seen = ?
                  WHERE bucket_key = ? AND bucket = ? AND count = ? AND until = ? AND seen = ?
                  RETURNING count`
            )
            .bind(next.count, next.until, next.seen, key, bucket, prev.count, prev.until, prev.seen)
            .first();
        if (updated) return true;
        // 行还不存在（第一次见到这个来源）→ 插入。并发插入由主键冲突兜住：
        // DO NOTHING 之后拿不到 RETURNING 行 = 别人抢先建了 → 交给外层重试。
        const inserted = await db
            .prepare(
                `INSERT INTO rate_limit_bucket (bucket_key, bucket, count, until, seen)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(bucket_key, bucket) DO NOTHING
                 RETURNING count`
            )
            .bind(key, bucket, next.count, next.until, next.seen)
            .first();
        return inserted != null;
    } catch {
        return false;
    }
}

/** 清零一行（分享口令「猜对了」用）。删行比写 0 更省，读出来的语义完全一样 */
async function resetBucketRow(api: NavigationAPI, key: string, bucket: string): Promise<void> {
    const db = bucketStoreOf(api);
    if (!db) {
        // 极简假 api：退回 JSON 老路，写一个清零的桶（而不是删键，语义一致）
        await legacyMutateGuard(api, key, bucket, () => ({ count: 0, until: 0, seen: Date.now() }));
        return;
    }
    try {
        await db
            .prepare("DELETE FROM rate_limit_bucket WHERE bucket_key = ? AND bucket = ?")
            .bind(key, bucket)
            .run();
    } catch {
        // 清不掉不影响放行：下一次读取拿到的还是旧计数，最多让「猜对了」之后
        // 多留一会儿额度，不会把人锁死
    }
}

/**
 * 裁桶：把「太久没动静」的和「超出上限最久没动静」的桶删掉。
 *
 * 两条 SQL 都是**锁定中的桶一律跳过**（`until <= now` 这个条件）：
 * 裁掉一个正在锁定期里的桶 = 把正在等解锁的人提前放出来，比不裁危险得多。
 *
 * ⚠️ 只能在**非热路径**调它（见 `pruneBucketRowsIfDue` 与 worker/cron.ts）：
 * 它对本键做一次索引范围扫，跟「记一次失败」不是一回事。
 */
async function pruneBucketRows(api: NavigationAPI, key: string, nowMs: number): Promise<void> {
    const db = bucketStoreOf(api);
    if (!db) return;
    try {
        // ① 空闲超时：24 小时没动静、且不在锁定期
        await db
            .prepare(
                "DELETE FROM rate_limit_bucket WHERE bucket_key = ? AND until <= ? AND seen <= ?"
            )
            .bind(key, nowMs, nowMs - BUCKET_IDLE_MS)
            .run();
        // ② 桶太多时丢掉最久没动静的那些，始终给新来的来源留位置（MAX_BUCKETS 语义不变）。
        //    「最新的 MAX_BUCKETS 个」之外的行才删 —— 锁定中的桶靠 until <= ? 兜住。
        await db
            .prepare(
                `DELETE FROM rate_limit_bucket
                  WHERE bucket_key = ? AND until <= ?
                    AND bucket NOT IN (
                        SELECT bucket FROM rate_limit_bucket
                         WHERE bucket_key = ?
                         ORDER BY seen DESC
                         LIMIT ?
                    )`
            )
            .bind(key, nowMs, key, MAX_BUCKETS)
            .run();
    } catch {
        // 裁桶失败无害（下次再裁）：它只是控制表的体积，不参与任何放行判断
    }
}

/** 本 isolate 上一次裁桶的时刻（模块级：Workers 每个 isolate 各自一份，正是想要的粒度） */
let lastBucketPruneAt = 0;
/** 热路径上最多每小时裁一次 */
const BUCKET_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 热路径上的「到点才裁」：距上次裁桶不足一小时就直接返回。
 *
 * 放在这里而不是每次 bump 都裁，是因为裁剪的代价（两次 DELETE）跟「记一次失败」
 * 完全不是一个量级，而桶的增长速度是「每次登录失败一行」，一小时裁一次足够。
 */
async function pruneBucketRowsIfDue(api: NavigationAPI, key: string): Promise<void> {
    const now = Date.now();
    if (now - lastBucketPruneAt < BUCKET_PRUNE_INTERVAL_MS) return;
    lastBucketPruneAt = now;
    await pruneBucketRows(api, key, now);
}

/**
 * 仅供测试：把「上次裁桶时刻」清零，让下一次 bump 必定走到裁剪。
 * （与 resetMigrationCacheForTests 同一个套路：模块级状态在同一个测试进程里会跨用例存活）
 */
export function resetRateLimitPruneThrottleForTests(): void {
    lastBucketPruneAt = 0;
}

/**
 * 把十把锁的所有桶各裁一遍（worker/cron.ts 的清理任务调用）。
 *
 * 热路径上的裁剪是「每 isolate 每小时、且只裁当前这把锁」—— 没人登录的那几把锁
 * 就永远轮不到。cron 每天扫全量，兜住这一块。
 */
export async function pruneAllRateLimitBuckets(api: NavigationAPI): Promise<void> {
    const now = Date.now();
    for (const key of RATE_LIMIT_GUARD_KEYS) {
        await pruneBucketRows(api, key, now);
    }
    lastBucketPruneAt = now;
}

// ---------------- JSON 老路径（没有 db 的存储层） ----------------
//
// 线上走不到这里：真 D1 与自托管适配器都有 db。留着它是为了
// `api.getConfig/setConfig` 这种最小存储桩（测试里大量使用）还能照旧工作，
// 以及万一有个把部署把 db 摘掉了也不至于让登录直接崩。

/** 取某个限速键的全部桶。取不到就当「没有限制」—— 存储异常不该把正常用户挡在门外 */
async function legacyReadGuardStore(api: NavigationAPI, key: string): Promise<GuardStore> {
    try {
        return parseGuardStore(await api.getConfig(key));
    } catch {
        return {};
    }
}

/**
 * 读-改-写单个限速桶（JSON 老路径）。
 *
 * 基于「读到的原始字符串」做 CAS：重算出新值后发现底层已被别人改过，就丢弃这次
 * 结果重新读一次（`parseGuardStore` → `mutate`），最多重试 CAS_MAX_ATTEMPTS 次。
 * 因为 mutate 只动目标桶，别人的桶在重读时会被完整捡回来，不会被我们的写盖掉。
 */
async function legacyMutateGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    mutate: (prev: GuardState) => GuardState
): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        let raw: string | null;
        try {
            raw = await api.getConfig(key);
        } catch {
            // ⚠️ 读不出来就**不要写**：把整份 JSON 当成空存储再写回去，
            // 等于把别人刚攒的计数整个抹掉（这也是 enforceWriteGuard 原来的做法）。
            return false;
        }
        const store = parseGuardStore(raw);
        store[bucket] = mutate(store[bucket] ?? { count: 0, until: 0, seen: Date.now() });
        if (await casWrite(api, key, raw, serializeGuardStore(store))) return true;
        if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
    }
    return false;
}

/**
 * 递增某个限速桶（JSON 老路径），语义与新的 `bumpGuard` 完全一致。
 * 只在「存储层没有 db」时才会被调用。
 */
async function legacyBumpGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    next: (prev: GuardState) => GuardState
): Promise<LoginGuard | null> {
    // 读到的状态本来就在锁定期时记一份：下面万一写不进去，也要把它如实返回 ——
    // 「这次没能记上数」不该顺手把一把**已知有效**的锁解开（放行才是自相矛盾）。
    // 这是 enforceWriteGuard 非 CAS 分支原先就有的行为，统一入口时不能丢。
    let knownLock: LoginGuard | null = null;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        let raw: string | null;
        try {
            raw = await api.getConfig(key);
        } catch {
            // 同 legacyMutateGuard：读不出来就别写 —— 这份 JSON 是**整块覆盖**的，
            // 拿「空存储」去覆盖会把别人刚攒的失败次数一起抹掉。
            return null;
        }
        const store = parseGuardStore(raw);
        const now = Date.now();
        const prev = store[bucket] ?? { count: 0, until: 0, seen: 0 };
        const updated = next(prev);
        const result: LoginGuard = {
            count: Number.isFinite(updated.count) ? updated.count : 0,
            until: Number.isFinite(updated.until) ? updated.until : 0,
        };
        if ((prev.until ?? 0) > now) knownLock = result;
        store[bucket] = { ...result, seen: now };
        try {
            if (await casWrite(api, key, raw, serializeGuardStore(store))) return result;
        } catch {
            return null;
        }
        if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
    }
    return knownLock;
}

// ---------------- 统一入口 ----------------

/**
 * 读某个桶的完整状态（含 seen，导出 / 写操作那两把锁按「离上次动多久」衰减要用）。
 * 存储异常一律当「没有限制」（fail-open）。
 */
async function readGuardState(
    api: NavigationAPI,
    key: string,
    bucket: string
): Promise<GuardState> {
    if (!bucketStoreOf(api)) {
        const store = await legacyReadGuardStore(api, key);
        return store[bucket] ?? { count: 0, until: 0, seen: 0 };
    }
    return await readBucketRow(api, key, bucket);
}

/** 只对外暴露 count / until 的那部分（登录 / 初始化 / 注册 / 找回 / 分享四把锁的契据） */
function toLoginGuard(state: GuardState): LoginGuard {
    return {
        count: toSafeCount(state.count),
        until: toSafeCount(state.until),
    };
}

/** 多带一个 seen 的那部分（导出 / 写操作） */
function toExportGuard(state: GuardState): ExportGuard {
    return { ...toLoginGuard(state), seen: toSafeCount(state.seen) };
}

/**
 * 绝对写回一个桶（`writeXxxGuard` 用）。
 *
 * 这些调用方在外面已经算好了终值（清零 / 只记锁定时刻），所以不需要读-改-写；
 * 并发时后写的赢，与改动前「各自 CAS 重试同一个确定值」的结果一样。
 */
async function mutateGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    mutate: (prev: GuardState) => GuardState
): Promise<boolean> {
    if (!bucketStoreOf(api)) return await legacyMutateGuard(api, key, bucket, mutate);
    const now = Date.now();
    const prev = await readBucketRow(api, key, bucket);
    const wanted = mutate(prev);
    return await writeBucketRow(api, key, bucket, {
        count: toSafeCount(wanted.count),
        until: toSafeCount(wanted.until),
        seen: now,
    });
}

/**
 * 递增某个限速桶，并把「递增之后的那份状态」返回给调用方。
 *
 * 与 `writeXxxGuard` 的区别是**在哪里算数**：后者在外面把 count 算好传进来，
 * 并发时后写入的那份会把前一个的增量整个盖掉（实测：同桶两次固定 count=1，
 * 最终还是 1），爆破于是可以一直续杯。这里把计算放进存储层：
 *   · 热路径（`next` 只是把 count +1）→ **一条原子 upsert**，并发下也不会丢计数；
 *   · 其它（锁定期续 seen / 按窗口衰减重置）→ 行的「值等 CAS」，抢不到就重读重算。
 *
 * 返回值是真正写进去的那份（调用方拿它算「还剩几次 / 要等多久」，文案才不会撒谎）；
 * 写不进去返回 null —— 计数记不上不等于请求该失败，调用方按「没记上」继续处理。
 */
export async function bumpGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    next: (prev: GuardState) => GuardState
): Promise<LoginGuard | null> {
    if (!bucketStoreOf(api)) return await legacyBumpGuard(api, key, bucket, next);

    // 与 legacyBumpGuard 同一个约定：读到的状态本来在锁定期，就一定把它如实返回，
    // 哪怕这次写不进去（理由见那边的注释）。
    let knownLock: LoginGuard | null = null;
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        const now = Date.now();
        const prev = await readBucketRow(api, key, bucket);
        const updated = next(prev);
        const result: LoginGuard = {
            count: toSafeCount(updated.count),
            until: toSafeCount(updated.until),
        };
        if (prev.until > now) knownLock = { count: result.count, until: result.until };

        // 热路径：`next` 恰好是「计数 +1」（新来源的第一次、以及额度内每多一次失败）。
        // 这种情况不必「读-算-写」：`count = count + 1` 本身就是原子的，
        // 并发请求各算各的，一次都不会丢。
        if (result.count === prev.count + 1) {
            const bumped = await bumpBucketRow(api, key, bucket, now);
            if (bumped) {
                let finalUntil = bumped.until;
                // 这次刚好越过了失败阈值 → 补一条 UPDATE 把锁抬起来
                if (result.until > bumped.until) {
                    await lockBucketRow(api, key, bucket, result.until);
                    finalUntil = result.until;
                }
                await pruneBucketRowsIfDue(api, key);
                return { count: bumped.count, until: finalUntil };
            }
            // 原子 upsert 不可用（表不存在 / 驱动不回 RETURNING）→ 落到下面按 CAS 再试一次
        }

        const written = await casWriteBucketRow(api, key, bucket, prev, {
            count: result.count,
            until: result.until,
            seen: now,
        });
        if (written) {
            await pruneBucketRowsIfDue(api, key);
            return result;
        }
        if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
    }
    return knownLock;
}

/** 读某个来源当前的限速状态 */
export async function readLoginGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    return toLoginGuard(await readGuardState(api, LOGIN_GUARD_KEY, bucket));
}

export async function writeLoginGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, LOGIN_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

// ============ 初始化接口限速 ============
// /api/init 未鉴权，限频挡掉「反复打接口探测行为」的扫描。
// 已初始化（alreadyInitialized）的请求不计次 —— 正常回源探测不会被锁。
export const INIT_GUARD_KEY = "auth.initGuard";
export const INIT_FREE_ATTEMPTS = 20;
export const INIT_BASE_LOCK_MS = 30_000; // 第 21 次起锁 30 秒
export const INIT_MAX_LOCK_MS = 10 * 60_000; // 最多 10 分钟

export async function readInitGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    return toLoginGuard(await readGuardState(api, INIT_GUARD_KEY, bucket));
}

export async function writeInitGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, INIT_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

// ============ 注册接口限速 ============
// /api/auth/register 是唯一不需要任何凭据就能写数据库的入口，之前三个公开入口
// （login / init / recover）都有限速、唯独它裸奔：
//   - 每次失败都要写一条审计日志，等于拿 D1 写入次数当沙袋打；
//   - 每次成功必然跑一次 PBKDF2 十万次哈希，是最贵的 CPU 放大面；
//   - 「该账号名已被占用」的回显还能拿来枚举账号名。
// 计数规则与登录不同：**成功也不清零**。注册成功同样消耗了上面那些资源，
// 清零会让「注册 → 清零 → 再注册」无限循环，限速就形同虚设。
// 但阈值放宽到 10 —— 一个出口 IP 下几个人各自注册是正常场景，不该被误伤。
export const REGISTER_GUARD_KEY = "auth.registerGuard";
export const REGISTER_FREE_ATTEMPTS = 10;
export const REGISTER_BASE_LOCK_MS = 60_000; // 第 11 次起锁 1 分钟
export const REGISTER_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

export async function readRegisterGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    return toLoginGuard(await readGuardState(api, REGISTER_GUARD_KEY, bucket));
}

export async function writeRegisterGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, REGISTER_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

// ============ 恢复令牌接口限速 ============
// /api/auth/recover 是公网暴露的「找回密码」入口：虽需私钥签名，但私钥一旦泄露，
// 攻击者就能拿着它反复重置（每次成功都 bump 令牌版本）。这里按来源 IP 分桶设一道短时熔断，
// 挡住「泄露私钥后的高频重试」。复用上面的桶存储与计数算法。
export const RECOVER_GUARD_KEY = "auth.recoverGuard";
export const RECOVER_FREE_ATTEMPTS = 10;
export const RECOVER_BASE_LOCK_MS = 60_000; // 第 11 次起锁 1 分钟
export const RECOVER_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

export async function readRecoverGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    return toLoginGuard(await readGuardState(api, RECOVER_GUARD_KEY, bucket));
}

export async function writeRecoverGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, RECOVER_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

// ============ 导出接口限速 ============
// /api/export 一次就把整站数据打包带走（站点密码还是解密后的明文），
// 是「拿到会话之后收益最大」的一个接口 —— 没有任何限频时，一个有效令牌能在几秒内
// 反复把全站拖走。按「账号 + 来源 IP」分桶：同一个人在自己机器上手动备份，
// 一小时点十次绰绰有余；换台机器、换个出口 IP 各算各的，不会互相牵连。
// 与注册同理：**成功也计数**（每次导出都是一次全量读取 + 逐条解密，成本实打实）。
export const EXPORT_GUARD_KEY = "auth.exportGuard";
export const EXPORT_FREE_ATTEMPTS = 10;
export const EXPORT_BASE_LOCK_MS = 5 * 60_000; // 第 11 次起锁 5 分钟
export const EXPORT_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

/** 导出限速的桶：账号 + 来源 IP（未登录 / 取不到 uid 时按匿名算） */
export function exportBucket(
    request: Request,
    uid: number | null,
    trustXFF = false,
    trustXRealIp = false
): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF, trustXRealIp)}`;
}

/** 导出限速的状态：比 LoginGuard 多一个「上次动它的时刻」，用来判断计数该不该重置 */
export interface ExportGuard extends LoginGuard {
    /** 该桶最后一次被写入的时刻（毫秒）；读不到就当 0 */
    seen?: number;
}

/**
 * 计数多久没动就归零（1 小时）。
 *
 * 不能像登录那样「成功就清零」——那会让「导出 → 清零 → 再导出」无限循环，限速形同虚设；
 * 也**不能永不衰减**：正常用户每天手动备份一次，攒到第 11 天开始每次都被锁几分钟，
 * 越往后锁越久，那是把正常用法当成攻击在打。所以按「离上次导出多久」衰减：
 * 隔开一小时以上就从第 1 次重新数，短时间连着拉才会逐级变严。
 */
export const EXPORT_COUNT_RESET_MS = 60 * 60 * 1000;

/**
 * 按「离上次动作多久」衰减地算出「这次该记第几次」。
 *
 * 不能「成功就清零」（那会让「操作 → 清零 → 再操作」无限循环，限速形同虚设），
 * 也**不能永不衰减**（正常用户天天点，攒够了每次都被锁几分钟，等于把正常用法当攻击打）。
 * 所以：隔开一个窗口以上就从第 1 次重新数，短时间连着打才会逐级变严。
 */
export function nextDecayedCount(
    guard: ExportGuard,
    windowMs: number,
    now = Date.now()
): number {
    const idle = guard.seen ? now - guard.seen : Infinity;
    return (idle > windowMs ? 0 : guard.count) + 1;
}

/** 下一次导出该记第几次：离上次导出超过一小时就从头数（见上面那段说明） */
export function nextExportCount(guard: ExportGuard, now = Date.now()): number {
    return nextDecayedCount(guard, EXPORT_COUNT_RESET_MS, now);
}

export async function readExportGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<ExportGuard> {
    return toExportGuard(await readGuardState(api, EXPORT_GUARD_KEY, bucket));
}

export async function writeExportGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, EXPORT_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

// ============ 写操作限速 ============
// 上面五把锁全在**未鉴权**的公开入口上（login / init / register / recover）或全量导出上，
// 而分组 / 站点的增删改、批量删除、导入这些**已登录**的写接口一把锁都没有：
//   - 令牌一旦泄露（比如设备丢了、cookie 被抄走），攻击者能在几秒内把站点改个遍、
//     或者反复丢大备份文件进来把 D1 的写入配额打光；
//   - 导入是最贵的一个：整批 INSERT 再整批 DELETE，中途失败还要回滚，一次能写几千行。
// 所以给写接口也加一道，按「账号 + 来源 IP」分桶（与导出同构，互不影响）。
//
// 阈值刻意放宽：正常用法里拖拽排序、批量移动会连着发好几个请求，
// 一次整理二十来张卡片也就二十来次 —— 一分钟 120 次远在这之上，误伤不到人。
// 成功也计数（每次写都是实打实的 D1 写入），但一分钟没动静就重新数。
export const WRITE_GUARD_KEY = "auth.writeGuard";
export const WRITE_FREE_ATTEMPTS = 120;
export const WRITE_BASE_LOCK_MS = 30_000; // 第 121 次起锁 30 秒
export const WRITE_MAX_LOCK_MS = 10 * 60_000; // 最多 10 分钟
export const WRITE_COUNT_RESET_MS = 60 * 1000;

/** 写操作限速的桶：账号 + 来源 IP（未登录 / 取不到 uid 时按匿名算） */
export function writeBucket(
    request: Request,
    uid: number | null,
    trustXFF = false,
    trustXRealIp = false
): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF, trustXRealIp)}`;
}

export async function readWriteGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<ExportGuard> {
    return toExportGuard(await readGuardState(api, WRITE_GUARD_KEY, bucket));
}

export async function writeWriteGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, WRITE_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

/**
 * 检查并登记一次写操作。
 *
 * 返回 `null` 表示放行；否则是已经填好 `Retry-After` 的 429 响应，路由直接 return 它。
 * 计数与锁定时长沿用登录那套指数退避（`computeLockAfterFailure`），
 * 只是窗口与阈值换成写接口自己的。
 *
 * ⚠️ 这里**不再自己写一份 CAS 循环**（C1 顺手收掉的重复）：那段逻辑与 `enforceGuard`
 * 逐字同构，两份并存的结果是改一处漏一处（S04 修「计数必须在 CAS 内重算」时就漏过一遍）。
 * 现在两者共用同一条实现，差别只剩阈值与文案。
 *
 * 故障策略与登录锁保持一致：**记不上数就放行**。看起来是开个口子，但站不住脚：
 * 计数与真正的写入用的是同一个 D1，库读不出来时后面的 createSite / importData
 * 自己就会失败，放行并不会让任何一次写入真的成功；反过来若在这里 503，
 * 会把「参数不合法」这类 400 也盖成 503，白白丢掉正确的错误码。
 */
export async function enforceWriteGuard(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    return await enforceGuard(api, WRITE_GUARD_KEY, bucket, {
        free: WRITE_FREE_ATTEMPTS,
        baseLockMs: WRITE_BASE_LOCK_MS,
        maxLockMs: WRITE_MAX_LOCK_MS,
        resetMs: WRITE_COUNT_RESET_MS,
        message: "操作太频繁",
    });
}

// ============ 配置写 / WebDAV 备份：这两类端点原本一把锁都没有 ============
//
// 写操作那把锁只挂在 data 路由（分组 / 站点 CRUD）上，而这两类一直在裸奔，
// 且它们的成本结构与 CRUD 完全不是一回事，不该共用一把：
//
//   1. 配置写（configs/batch、configs/{key}）：一次能改掉全站外观、WebDAV 凭据、
//      巡检开关。频率低但**影响面大** —— 令牌泄露后改配置是攻击者最省事的持久化手段。
//   2. WebDAV 备份（上传 / 下载 / 列目录 / 删远端）：每个都要**出网到用户自己的
//      网盘**，还要整份 gzip + 加密，是全站最贵的一类请求。既吃 Worker 出网配额，
//      也把用户的网盘账号往外打 —— 拿它当「帮我刷这个地址」的代理比图标代理贵得多。
//
// 所以两把锁都比 CRUD 严：配置一分钟 30 次（正常改配置远不到），
// WebDAV 一分钟 10 次（一分钟内备份十次，要么是脚本要么是手抖）。
//
// 故障策略与写操作一致：**记不上数就放行**。它们同样依赖那个 D1，
// 库读不出来时真正干活那一步（setConfig / 出网请求）自己就会失败。

export const CONFIG_GUARD_KEY = "auth.configGuard";
export const CONFIG_FREE_ATTEMPTS = 30;
export const CONFIG_BASE_LOCK_MS = 30_000;
export const CONFIG_MAX_LOCK_MS = 10 * 60_000;
export const CONFIG_COUNT_RESET_MS = 60 * 1000;

export const DAV_GUARD_KEY = "auth.davGuard";
export const DAV_FREE_ATTEMPTS = 10;
export const DAV_BASE_LOCK_MS = 60_000;
export const DAV_MAX_LOCK_MS = 30 * 60_000;
export const DAV_COUNT_RESET_MS = 60 * 1000;

/** 这两类端点的桶：账号 + 来源 IP，与写操作同构（互不影响） */
export function endpointBucket(
    request: Request,
    uid: number | null,
    trustXFF = false,
    trustXRealIp = false
): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF, trustXRealIp)}`;
}

/**
 * 通用闸门：按给定的 key 与阈值检查并登记一次。
 *
 * 抽出来是因为三把锁除了阈值和文案完全同构 —— 各写一份的话，
 * 迟早会在某一把上漏掉「计数必须在 CAS 内重算」这条（S04 修的就是这个）。
 */
async function enforceGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    opts: {
        free: number;
        baseLockMs: number;
        maxLockMs: number;
        resetMs: number;
        message: string;
    }
): Promise<Response | null> {
    const limited = (until: number, now: number) => {
        const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
        return errorResponse(ApiError.rateLimited(`${opts.message}，请 ${retryAfter} 秒后再试`), { headers: { "Retry-After": String(retryAfter) } });
    };

    const result = await bumpGuard(api, key, bucket, prev => {
        const now = Date.now();
        // 还在锁定期就只续「见到过」，不动计数 —— 否则锁会越滚越长
        if (prev.until > now) return { ...prev, seen: now };
        const count = nextDecayedCount(prev, opts.resetMs, now);
        const lockMs = computeLockAfterFailure(
            count,
            opts.free,
            opts.baseLockMs,
            opts.maxLockMs
        );
        return { count, until: lockMs > 0 ? now + lockMs : 0, seen: now };
    });
    // 记不上（存储不可用）→ 放行：真正干活那一步自己会失败，不该在这里把错误码盖成 503
    if (!result) return null;
    const now = Date.now();
    return result.until > now ? limited(result.until, now) : null;
}

/** 配置写操作闸门 */
export async function enforceConfigGuard(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    return await enforceGuard(api, CONFIG_GUARD_KEY, bucket, {
        free: CONFIG_FREE_ATTEMPTS,
        baseLockMs: CONFIG_BASE_LOCK_MS,
        maxLockMs: CONFIG_MAX_LOCK_MS,
        resetMs: CONFIG_COUNT_RESET_MS,
        message: "配置修改过于频繁",
    });
}

/** WebDAV 备份操作闸门 */
export async function enforceDavGuard(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    return await enforceGuard(api, DAV_GUARD_KEY, bucket, {
        free: DAV_FREE_ATTEMPTS,
        baseLockMs: DAV_BASE_LOCK_MS,
        maxLockMs: DAV_MAX_LOCK_MS,
        resetMs: DAV_COUNT_RESET_MS,
        message: "备份操作过于频繁",
    });
}

// ============ 分享口令：公开入口里唯一还能被反复试密码的地方 ============
//
// 登录 / 注册 / 找回 / 初始化四个公开入口都有限速，**唯独分享口令没有**：
// `/api/note-shares/<token>` 与 `/api/group-shares/<token>` 的 POST 只要带着
// 一个 password 字段就能无限次猜。危害有两层：
//
//   1) 暴力破解。分享口令通常是「发到群里的一串数字」，本身就是弱口令；
//   2) CPU 放大。校验走的是 PBKDF2-SHA256（Workers 侧 10 万次迭代），
//      每猜一次都是实打实的 CPU。一条**不需要任何凭据**的公开端点被当成
//      算力放大器，比单纯破解分享内容更贵。
//
// 分桶粒度是 **来源 IP + 分享 token**，这是刻意的：
//   · 只按 IP 分桶 → 一个人狂试 A 的分享，会把同一出口 IP（NAT / 公司网）
//     下所有人在**别的**分享上的正常访问一起锁掉；
//   · 只按 token 分桶 → 换一个分享就能从零重来，挡不住横向扫。
//   两者都取：同一 IP 对**同一个**分享猜 5 次就锁；换分享要重新积累。
//   正常用户不会连着试同一个分享 5 次以上，误伤面很小。
//
// ⚠️ 与其它五把锁的关键差异：**只有失败才计数**。
// 别的闸门是「一次操作 = 记一次」，而这里是「一次**猜错** = 记一次」——
// 公开页第一次渲染时的 GET（根本没带口令）不该算失败，
// 否则一个人打开分享页看两眼就被锁了。
// 所以这里不给 enforceGuard 那种「检查+登记」一体化接口，
// 而是拆成「先查锁 → 失败才登记 → 成功清零」三步。
export const SHARE_GUARD_KEY = "auth.shareGuard";
export const SHARE_FREE_ATTEMPTS = 5;
export const SHARE_BASE_LOCK_MS = 5 * 60_000; // 第 6 次起锁 5 分钟
export const SHARE_MAX_LOCK_MS = 60 * 60_000; // 最多 1 小时
export const SHARE_COUNT_RESET_MS = 15 * 60_000; // 15 分钟没动静就重新数

/**
 * 分享口令的桶：来源 IP + 分享 token 前 16 位。
 *
 * token 是 64 位 hex，截 16 位（64 bit）做桶名足够区分，也避免把完整 token
 * 写进 configs 表 —— 那份记录虽然带 `auth.` 前缀不外泄，但没必要留可用的凭据。
 */
export function shareBucket(
    request: Request,
    token: string,
    trustXFF = false,
    trustXRealIp = false
): string {
    return `${clientBucket(request, trustXFF, trustXRealIp)}:s${token.slice(0, 16)}`;
}

export async function readShareGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    return toLoginGuard(await readGuardState(api, SHARE_GUARD_KEY, bucket));
}

export async function writeShareGuard(
    api: NavigationAPI,
    guard: LoginGuard,
    bucket = "legacy"
): Promise<void> {
    await mutateGuard(api, SHARE_GUARD_KEY, bucket, () => ({ ...guard, seen: Date.now() }));
}

/**
 * 前置检查：还在锁定期就返回 429，**连 PBKDF2 都不跑**。
 * 这是这条限速真正省钱的地方 —— 只在失败之后登记、却在校验之前拦住。
 */
export async function shareGuardLocked(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    const guard = await readShareGuard(api, bucket);
    const now = Date.now();
    if (guard.until <= now) return null;
    const retryAfter = Math.max(1, Math.ceil((guard.until - now) / 1000));
    return errorResponse(
        ApiError.rateLimited(`口令尝试次数过多，请 ${retryAfter} 秒后再试`),
        { headers: { "Retry-After": String(retryAfter) } }
    );
}

/**
 * 登记一次**口令猜错**。若这次刚好触发锁定，直接返回 429（调用方 return 它）。
 *
 * 计数在 CAS 循环里算（bumpGuard）：外面算好再传进去，并发时后写的那份
 * 会把前一个请求的增量盖掉，爆破就能一直续杯 —— 与登录那把锁是同一个坑。
 */
export async function bumpShareGuardFailure(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    const bumped = await bumpGuard(api, SHARE_GUARD_KEY, bucket, prev => {
        const now = Date.now();
        // 已锁就不再累加计数，否则锁会越滚越长（与 enforceGuard 同一个处理）
        if (prev.until > now) return { ...prev, seen: now };
        const count = nextDecayedCount(prev, SHARE_COUNT_RESET_MS, now);
        const lockMs = computeLockAfterFailure(
            count,
            SHARE_FREE_ATTEMPTS,
            SHARE_BASE_LOCK_MS,
            SHARE_MAX_LOCK_MS
        );
        return { count, until: lockMs > 0 ? now + lockMs : 0, seen: now };
    });
    // 记不上（存储不可用）→ 不锁：真正校验口令那一步自己会失败，
    // 不该在这里把「口令错」的 401 盖成 429
    if (!bumped) return null;
    const now = Date.now();
    if (bumped.until <= now) return null;
    const retryAfter = Math.max(1, Math.ceil((bumped.until - now) / 1000));
    return errorResponse(
        ApiError.rateLimited(`口令尝试次数过多，请 ${retryAfter} 秒后再试`),
        { headers: { "Retry-After": String(retryAfter) } }
    );
}

/** 口令对了：清零，别让之前的手滑一直累积 */
export async function clearShareGuard(api: NavigationAPI, bucket: string): Promise<void> {
    // 清零 = 删掉这一行（读出来的语义与 {count:0,until:0} 完全一致，还省得留垃圾）
    await resetBucketRow(api, SHARE_GUARD_KEY, bucket);
}

// ============ 校验当前密码：改密 / 注销前的那道身份复核 ============
//
// 「拿着会话改密码」这条链路上真正的门槛是**当前密码**那一问：拿到会话（或设备没锁屏）
// 的人想把主人锁在门外，必须先过这一问，而它此前一条独立限速都没有 ——
// 登录那把锁管的是「还没拿到会话的人」，管不到这里。
//
// 分桶刻意按**账号**而不是来源 IP：攻击者是从会话里来的，换 IP / 换 UA 成本为零，
// 按 IP 分桶等于没锁；按账号则无论从哪台机器来都记在同一个人身上。
//
// ⚠️ 与分享口令那把锁相反：**连正确的也计数**。猜对同样要跑一次 PBKDF2
// （十万次迭代，是全站最贵的一档 CPU），只记失败的话「1 次对 + 4 次错」循环
// 就能一直把算力吃满。代价是 10 分钟内连改 6 次密码会被锁 —— 那本来也不是正常用法。
export const VERIFY_PW_GUARD_KEY = "auth.verifyPasswordGuard";
export const VERIFY_PW_FREE_ATTEMPTS = 5;
export const VERIFY_PW_BASE_LOCK_MS = 10 * 60_000; // 第 6 次起锁 10 分钟
export const VERIFY_PW_MAX_LOCK_MS = 10 * 60_000; // 封顶也是 10 分钟：不叠指数退避，10 分钟足够
export const VERIFY_PW_COUNT_RESET_MS = 10 * 60_000; // 10 分钟没动静就重新数

/** 按账号分桶（拿不到账号时归到 anon，与写操作锁的口径一致） */
export function credentialBucket(uid: number | null): string {
    return `u${uid ?? "anon"}`;
}

export interface GuardDecision {
    /** true = 已被限流，这次不该再往下走 */
    limited: boolean;
    /** 还要等多少秒才解锁（未限流时是 0），给调用方写提示语 */
    retryAfter: number;
}

/**
 * 检查并登记一次「校验当前密码」。
 *
 * 走的是登录锁那套 D1 CAS 计数（bumpGuard），不是内存计数器：
 * Workers 多实例各有各的内存，内存计数在冷启动 / 换实例时归零，
 * 对着它猜密码等于限速形同虚设（rateLimit.ts 那个内存滑动窗口是为
 * 「高频低价值」的公开端点准备的，这里不能用）。
 *
 * 存储不可用时（bumpGuard 返回 null）**放行**：真正校验密码那一步自己会失败，
 * 不该在这里把「密码不对」的 401 盖成 429。
 */
export async function enforceCredentialGuard(
    api: NavigationAPI,
    bucket: string
): Promise<GuardDecision> {
    const bumped = await bumpGuard(api, VERIFY_PW_GUARD_KEY, bucket, prev => {
        const now = Date.now();
        // 还在锁定期就只续「见到过」，不动计数 —— 否则锁会越滚越长
        if (prev.until > now) return { ...prev, seen: now };
        const count = nextDecayedCount(prev, VERIFY_PW_COUNT_RESET_MS, now);
        const lockMs = computeLockAfterFailure(
            count,
            VERIFY_PW_FREE_ATTEMPTS,
            VERIFY_PW_BASE_LOCK_MS,
            VERIFY_PW_MAX_LOCK_MS
        );
        return { count, until: lockMs > 0 ? now + lockMs : 0, seen: now };
    });
    if (!bumped) return { limited: false, retryAfter: 0 };
    const now = Date.now();
    if (bumped.until <= now) return { limited: false, retryAfter: 0 };
    return { limited: true, retryAfter: Math.max(1, Math.ceil((bumped.until - now) / 1000)) };
}

// ============ 十把锁的键清单（裁桶 / 迁移要按它遍历） ============
/**
 * 所有限速桶所属的 configs 键（= 新表里的 bucket_key）。
 *
 * 为什么要有这份清单：旧存储是「一把锁一条 configs 记录」，新表是十把锁共表，
 * 于是「按锁清理过期桶」与「把旧 JSON 搬进新表」都需要知道全集。
 * 新增一把锁时**必须往这里加一条**，否则它的桶永远不会被裁（只会慢慢涨）。
 *
 * ⚠️ 顺序与声明顺序一致，仅为可读；没有任何逻辑依赖顺序。
 */
export const RATE_LIMIT_GUARD_KEYS: readonly string[] = [
    LOGIN_GUARD_KEY,
    INIT_GUARD_KEY,
    REGISTER_GUARD_KEY,
    RECOVER_GUARD_KEY,
    EXPORT_GUARD_KEY,
    WRITE_GUARD_KEY,
    CONFIG_GUARD_KEY,
    DAV_GUARD_KEY,
    SHARE_GUARD_KEY,
    VERIFY_PW_GUARD_KEY,
];
