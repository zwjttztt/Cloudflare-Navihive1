// worker/loginGuard.ts

import type { NavigationAPI } from "../src/API/navigationApi";

// ============ 登录失败限速 ============
// 连续输错会越等越久，避免密码被无限次猜。
// 计数存在 configs 表的 auth.loginGuard 里 —— auth. 前缀既不返回给前端、也不进备份文件。
export const LOGIN_GUARD_KEY = "auth.loginGuard";
// 前 5 次给手滑留余地，之后每次等待时间翻倍
export const LOGIN_FREE_ATTEMPTS = 5;
export const LOGIN_BASE_LOCK_MS = 60_000; // 第 6 次起锁 1 分钟
export const LOGIN_MAX_LOCK_MS = 30 * 60_000; // 最多 30 分钟

// 该端点每天不限 developments —— 但过去这把锁是**全站一把**：
// 任何人只要连着输错 5 次，站点主人自己也登不进去了（最长 30 分钟）。
// 多账号上线后这条从「防爆破」变成了「DoS 入口」：陌生人动动手指就能把所有人挡在门外。
// 现在按来源 IP 分桶：A 乱猜只会锁住 A 自己。
// 桶数设上限 + 清理长时间不活动的桶，避免有人用一堆代理 IP 把这条 configs 记录撑爆。
const MAX_BUCKETS = 2_000;
/** 桶多久没动静就丢掉（24 小时）。注意：处于锁定期的桶不在此列，必须留到解锁。 */
const BUCKET_IDLE_MS = 24 * 60 * 60 * 1000;

export interface LoginGuard {
    count: number;
    /** 解锁时刻（毫秒时间戳）；0 表示当前不在锁定期 */
    until: number;
}

/** 存储结构：扁平的 {count, until} 是旧格式（全站一把锁），新格式按桶名索引 */
interface GuardState extends LoginGuard {
    /** 该桶最后一次被写入的时刻（毫秒），用于清理长期不活动的桶 */
    seen?: number;
}
type GuardStore = Record<string, GuardState>;

/**
 * 取客户端标识（限速分桶用）。
 *
 * Cloudflare 部署下 `CF-Connecting-IP` 由平台注入、客户端伪造不了，直接用。
 * 自托管（没有 CF-Connecting-IP）时，**默认不再信任 `X-Forwarded-For`**：
 * 否则攻击者每次换一个 XFF 首段就能换一个新桶，把爆破限速彻底绕过去。
 * 只有在「明确把 Worker 放在可信反代后面、反代会老实填 XFF」的部署里，
 * 才把 `NAVIHIVE_TRUST_XFF=1` 打开、显式允许读 XFF 首段。
 * 不信任且又拿不到真实 IP 时所有来源共用一个 `unknown` 桶 —— 最多只是限速粒度变粗，
 * 不会失守。
 */
export function clientBucket(request: Request, trustXForwardedFor = false): string {
    const cf = request.headers.get("CF-Connecting-IP");
    if (cf) return cf.slice(0, 64);
    if (trustXForwardedFor) {
        const xff = (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim();
        if (xff) return xff.slice(0, 64);
    }
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

/** 解析存储内容；读不出来 / 格式不对都当「没有限制」（不能因为存储异常把正常用户挡在门外） */
function parseGuardStore(raw: string | null): GuardStore {
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
 */
const CAS_MAX_ATTEMPTS = 3;
/** 重试前的退避（毫秒），给抢先那一方留出写完的时间 */
const CAS_BACKOFF_MS = 10;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 条件写入：只有存储值还是 expected 时才写 next。
 *
 * 早先是「读整条 → 改 → 整条写回」：两个请求同时读到旧值，各自算完再写，
 * 后写的那份会把前一份**整个盖掉**。放在限速上就是「别人的写入把攻击者积累的
 * 失败次数冲回小值」，爆破可以一直续杯 —— 这是真实的防护失效，不是洁癖。
 * 现在比较和写入合为一条 SQL（`configs.compareAndSetConfig`），抢不到就重算一次。
 * 没有 CAS 能力的存储层（测试桩）退回普通写入，行为与改动前一致。
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

/**
 * 读-改-写单个限速桶。
 *
 * 基于「读到的原始字符串」做 CAS：重算出新值后发现底层已被别人改过，就丢弃这次
 * 结果重新读一次（`parseGuardStore` → `mutate`），最多重试 CAS_MAX_ATTEMPTS 次。
 * 因为 mutate 只动目标桶，别人的桶在重读时会被完整捡回来，不会被我们的写盖掉。
 */
async function mutateGuard(
    api: NavigationAPI,
    key: string,
    bucket: string,
    mutate: (prev: GuardState) => GuardState
): Promise<boolean> {
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        let raw: string | null = null;
        try {
            raw = await api.getConfig(key);
        } catch {
            raw = null; // 读不出来当作空存储，至少让 mutate 能跑完
        }
        const store = parseGuardStore(raw);
        store[bucket] = mutate(store[bucket] ?? { count: 0, until: 0, seen: Date.now() });
        if (await casWrite(api, key, raw, serializeGuardStore(store))) return true;
        if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
    }
    return false;
}

/** 取某个限速键的全部桶。取不到就当「没有限制」—— 存储异常不该把正常用户挡在门外 */
async function readGuardStore(api: NavigationAPI, key: string): Promise<GuardStore> {
    try {
        return parseGuardStore(await api.getConfig(key));
    } catch {
        return {};
    }
}

/**
 * 递增某个限速桶，并把「递增之后的那份状态」返回给调用方。
 *
 * 与 `writeXxxGuard` 的区别是**在哪里算数**：后者在外面把 count 算好传进来，
 * CAS 抢不到时重试的仍是那个旧数字 —— 两个请求并发时，后写入的那份会把前一个
 * 的增量整个盖掉（实测：同桶两次固定 count=1，最终还是 1），爆破于是可以一直续杯。
 * 这里把计算放进 CAS 循环里：每次重读都用最新的值重算，并发不会互相抹掉。
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
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
        let raw: string | null = null;
        try {
            raw = await api.getConfig(key);
        } catch {
            raw = null;
        }
        const store = parseGuardStore(raw);
        const now = Date.now();
        const updated = next(store[bucket] ?? { count: 0, until: 0, seen: 0 });
        const result: LoginGuard = {
            count: Number.isFinite(updated.count) ? updated.count : 0,
            until: Number.isFinite(updated.until) ? updated.until : 0,
        };
        store[bucket] = { ...result, seen: now };
        try {
            if (await casWrite(api, key, raw, serializeGuardStore(store))) return result;
        } catch {
            return null;
        }
        if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
    }
    return null;
}

/** 读某个来源当前的限速状态 */
export async function readLoginGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    const store = await readGuardStore(api, LOGIN_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
    };
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
    const store = await readGuardStore(api, INIT_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
    };
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
    const store = await readGuardStore(api, REGISTER_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
    };
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
    const store = await readGuardStore(api, RECOVER_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
    };
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
export function exportBucket(request: Request, uid: number | null, trustXFF = false): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF)}`;
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
    const store = await readGuardStore(api, EXPORT_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0, seen: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
        seen: typeof found.seen === "number" ? found.seen : 0,
    };
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
export function writeBucket(request: Request, uid: number | null, trustXFF = false): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF)}`;
}

export async function readWriteGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<ExportGuard> {
    const store = await readGuardStore(api, WRITE_GUARD_KEY);
    const found = store[bucket];
    if (!found) return { count: 0, until: 0, seen: 0 };
    return {
        count: typeof found.count === "number" && found.count > 0 ? found.count : 0,
        until: typeof found.until === "number" && found.until > 0 ? found.until : 0,
        seen: typeof found.seen === "number" ? found.seen : 0,
    };
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
 */
export async function enforceWriteGuard(
    api: NavigationAPI,
    bucket: string
): Promise<Response | null> {
    const limited = (until: number, now: number) => {
        const retryAfter = Math.max(1, Math.ceil((until - now) / 1000));
        return Response.json(
            { success: false, message: `操作太频繁，请 ${retryAfter} 秒后再试` },
            { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
    };
    // 计数必须在每次 CAS 重读后计算，不能重试一个外部算好的固定值。
    //
    // 故障策略与登录锁保持一致：**记不上数就放行**。看起来是开个口子，但站不住脚：
    // 计数与真正的写入用的是同一个 D1，库读不出来时后面的 createSite / importData
    // 自己就会失败，放行并不会让任何一次写入真的成功；反过来若在这里 503，
    // 会把「参数不合法」这类 400 也盖成 503，白白丢掉正确的错误码。
    if (typeof api.compareAndSetConfig === "function") {
        for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
            try {
                const raw = await api.getConfig(WRITE_GUARD_KEY);
                const store = parseGuardStore(raw);
                const guard = store[bucket] ?? { count: 0, until: 0, seen: 0 };
                const now = Date.now();
                if (guard.until > now) return limited(guard.until, now);
                const count = nextDecayedCount(guard, WRITE_COUNT_RESET_MS, now);
                const lockMs = computeLockAfterFailure(
                    count, WRITE_FREE_ATTEMPTS, WRITE_BASE_LOCK_MS, WRITE_MAX_LOCK_MS
                );
                const until = lockMs > 0 ? now + lockMs : 0;
                store[bucket] = { count, until, seen: now };
                if (await api.compareAndSetConfig(WRITE_GUARD_KEY, raw, serializeGuardStore(store))) {
                    return until > now ? limited(until, now) : null;
                }
            } catch {
                return null;
            }
            if (attempt < CAS_MAX_ATTEMPTS - 1) await sleep(CAS_BACKOFF_MS * (attempt + 1));
        }
        return null;
    }

    // 没有 CAS 能力的存储层：退回改动前的读-改-写，行为与旧版一致
    try {
        const guard = await readWriteGuard(api, bucket);
        const now = Date.now();
        if (guard.until > now) return limited(guard.until, now);
        const count = nextDecayedCount(guard, WRITE_COUNT_RESET_MS, now);
        const lockMs = computeLockAfterFailure(
            count,
            WRITE_FREE_ATTEMPTS,
            WRITE_BASE_LOCK_MS,
            WRITE_MAX_LOCK_MS
        );
        const until = lockMs > 0 ? now + lockMs : 0;
        await writeWriteGuard(api, { count, until }, bucket);
        return until > now ? limited(until, now) : null;
    } catch {
        return null;
    }
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
export function endpointBucket(request: Request, uid: number | null, trustXFF = false): string {
    return `u${uid ?? "anon"}:${clientBucket(request, trustXFF)}`;
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
        return Response.json(
            { success: false, message: `${opts.message}，请 ${retryAfter} 秒后再试` },
            { status: 429, headers: { "Retry-After": String(retryAfter) } }
        );
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
