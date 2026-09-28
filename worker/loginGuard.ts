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

/** 取客户端标识。CF-Connecting-IP 由 Cloudflare 注入，伪造不了。 */
export function clientBucket(request: Request): string {
    const ip =
        request.headers.get("CF-Connecting-IP") ||
        (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
        "unknown";
    return ip.slice(0, 64);
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
