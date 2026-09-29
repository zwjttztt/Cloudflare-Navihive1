// worker/loginGuard.ts

import type { NavigationAPI } from "../src/API/http";

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

async function readStore(api: NavigationAPI, key: string): Promise<GuardStore> {
    try {
        const raw = await api.getConfig(key);
        if (!raw) return {};
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
        // 读不出来就当没有限制：不能因为存储异常把正常用户挡在门外
        return {};
    }
}

async function writeStore(api: NavigationAPI, key: string, buckets: GuardStore): Promise<void> {
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

    try {
        await api.setConfig(key, JSON.stringify({ version: 2, buckets: Object.fromEntries(entries) }));
    } catch {
        // 写失败只影响限速强度，不影响登录本身
    }
}

/** 读某个来源当前的限速状态 */
export async function readLoginGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<LoginGuard> {
    const store = await readStore(api, LOGIN_GUARD_KEY);
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
    const store = await readStore(api, LOGIN_GUARD_KEY);
    store[bucket] = { ...guard, seen: Date.now() };
    await writeStore(api, LOGIN_GUARD_KEY, store);
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
    const store = await readStore(api, INIT_GUARD_KEY);
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
    const store = await readStore(api, INIT_GUARD_KEY);
    store[bucket] = { ...guard, seen: Date.now() };
    await writeStore(api, INIT_GUARD_KEY, store);
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
    const store = await readStore(api, REGISTER_GUARD_KEY);
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
    const store = await readStore(api, REGISTER_GUARD_KEY);
    store[bucket] = { ...guard, seen: Date.now() };
    await writeStore(api, REGISTER_GUARD_KEY, store);
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
    const store = await readStore(api, RECOVER_GUARD_KEY);
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
    const store = await readStore(api, RECOVER_GUARD_KEY);
    store[bucket] = { ...guard, seen: Date.now() };
    await writeStore(api, RECOVER_GUARD_KEY, store);
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

/** 下一次导出该记第几次：离上次导出超过一小时就从头数（见上面那段说明） */
export function nextExportCount(guard: ExportGuard, now = Date.now()): number {
    const idle = guard.seen ? now - guard.seen : Infinity;
    return (idle > EXPORT_COUNT_RESET_MS ? 0 : guard.count) + 1;
}

export async function readExportGuard(
    api: NavigationAPI,
    bucket = "legacy"
): Promise<ExportGuard> {
    const store = await readStore(api, EXPORT_GUARD_KEY);
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
    const store = await readStore(api, EXPORT_GUARD_KEY);
    store[bucket] = { ...guard, seen: Date.now() };
    await writeStore(api, EXPORT_GUARD_KEY, store);
}
