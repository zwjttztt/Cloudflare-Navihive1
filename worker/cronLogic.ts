// worker/cronLogic.ts
// 死链巡检的纯逻辑：不碰 fetch / D1 / env，单测可以钉死判定与合并行为。
// worker/cron.ts 的运行时部分（真正发请求、读写 D1）委托给这里的函数，
// 这样「404/410 算死、5xx 算探测失败、HEAD 失败回退 GET、上限 30、新鲜期跳过、
// max 时间戳合并、超长裁剪」这些最容易被改坏、又每周才跑一次没人发现的规则，
// 能像普通纯函数一样被测。

/** Workers 每次调用能发出的 subrequest 数有上限（免费版 50），一轮最多探这么多 */
export const MAX_PROBES_PER_RUN = 30;
/** 单个链接探测超时：HEAD/GET 卡住时靠 AbortController 兜底 */
export const PROBE_TIMEOUT_MS = 6000;
/** 探测结果新鲜期：这个窗口内探过的不再重探（和前端 src/utils/linkHealth.ts 一致） */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 快照里最多留多少个链接：与前端 MAX_ENTRIES 一致，超出丢最旧的 */
export const MAX_SNAPSHOT_ENTRIES = 2000;
/** link.health 快照在 configs 表里的键名 */
export const HEALTH_KEY = "link.health";

/**
 * 探测键归一化：与前端 src/utils/linkHealth.ts 共用同一个实现。
 *
 * 为什么这里也要归一化：客户端写进快照的键是归一化后的（去掉 #hash、host 小写、
 * 去掉根路径尾斜杠），而 cron 手里拿的是 sites 表里的原始 URL。两边口径不一致的话，
 * 白名单豁免和 fresh 窗口会全部命中不上 —— 巡检每周把用户已经纠偏过的站再探一遍，
 * 探测结果还写进第三个键，快照越滚越大。
 */
import { normalizeKey } from "../src/utils/linkKey";

/** 与 src/utils/linkHealth.ts 的 LinkHealthSnapshot 保持同一份结构 */
export interface LinkHealthSnapshot {
    v: 1;
    dead: Record<string, number>;
    probe: Record<string, number>;
    white: string[];
}

/** 巡检只需要站点链接；用最小结构，免得和 http.ts 的 Site 耦合 */
export interface SweepSite {
    id: number;
    url: string;
}

export function emptySnapshot(): LinkHealthSnapshot {
    return { v: 1, dead: {}, probe: {}, white: [] };
}

/** 宽容解析：D1 里可能是 null / 非法 JSON / 缺字段，都退化成空快照 */
export function parseSnapshot(raw: string | null | undefined): LinkHealthSnapshot {
    if (!raw) return emptySnapshot();
    try {
        const parsed = JSON.parse(raw) as Partial<LinkHealthSnapshot>;
        // 版本对不上直接退化：防止以后改结构时读到脏数据（与前端 mergeLinkHealth 的口径一致）
        if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return emptySnapshot();
        return {
            v: 1,
            dead: parsed.dead && typeof parsed.dead === "object" ? parsed.dead : {},
            probe: parsed.probe && typeof parsed.probe === "object" ? parsed.probe : {},
            white: Array.isArray(parsed.white) ? parsed.white : [],
        };
    } catch {
        return emptySnapshot();
    }
}

/**
 * 单个 HTTP 状态码的死活判定：
 *   - 404 / 410 = 资源确实没了 → 失效
 *   - 5xx = 服务器挂了 → 当作探测失败（与前端「能不能连上」口径一致，不冤枉活站点）
 *   - 其余（含登录墙/防盗链的 403、跟随重定向后的 2xx）→ 站点还在 → 活着
 * 注意：redirect: "follow" 下 HEAD/GET 不会把 3xx 抛回来，这里顺带兜住极端情况。
 */
export function isAliveHttpStatus(status: number): boolean {
    if (status === 404 || status === 410) return false;
    return status < 500;
}

/**
 * 挑本轮要探的链接：
 *   - 没 url / 在白名单里（用户手动纠偏过的）→ 跳过
 *   - 距上次探测（probe 或 dead 都算）未超过新鲜期 → 跳过
 *   - 按上次探测时间从旧到新排，截到上限（最久没探的优先）
 */
export function selectSweepCandidates(
    sites: SweepSite[],
    snapshot: LinkHealthSnapshot,
    now: number,
    opts: { maxProbes?: number; freshWindowMs?: number } = {}
): string[] {
    const maxProbes = opts.maxProbes ?? MAX_PROBES_PER_RUN;
    const freshWindowMs = opts.freshWindowMs ?? FRESH_WINDOW_MS;
    // 入站键也归一化：老快照里的白名单可能是原始 URL 写法
    const whitelist = new Set(snapshot.white.map(normalizeKey).filter(Boolean));
    return sites
        .filter(site => {
            if (!site.url) return false;
            const key = normalizeKey(site.url);
            if (whitelist.has(key)) return false;
            const last = snapshot.probe[key] ?? snapshot.dead[key] ?? 0;
            return now - last >= freshWindowMs;
        })
        .sort((a, b) =>
            (snapshot.probe[normalizeKey(a.url)] ?? 0) -
            (snapshot.probe[normalizeKey(b.url)] ?? 0)
        )
        .slice(0, maxProbes)
        .map(site => site.url);
}

/**
 * max 时间戳合并：活着只刷新 probe；失效只刷新 dead，且取 max ——
 * 绝不把客户端/上一轮更新的「更新」记录打回去。
 */
export function applyProbeResult(
    snapshot: LinkHealthSnapshot,
    url: string,
    alive: boolean,
    now: number
): LinkHealthSnapshot {
    const key = normalizeKey(url);
    const next: LinkHealthSnapshot = {
        v: 1,
        dead: { ...snapshot.dead },
        probe: { ...snapshot.probe },
        white: snapshot.white,
    };
    if (alive) {
        next.probe[key] = now;
    } else {
        next.dead[key] = Math.max(next.dead[key] ?? 0, now);
    }
    return next;
}

/** 超长快照裁剪：dead / probe 各保留时间戳最大的 N 条，白名单不动 */
export function trimSnapshot(
    snapshot: LinkHealthSnapshot,
    maxEntries: number = MAX_SNAPSHOT_ENTRIES
): LinkHealthSnapshot {
    const trim = (map: Record<string, number>): Record<string, number> => {
        const entries = Object.entries(map)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxEntries);
        return Object.fromEntries(entries);
    };
    return { v: 1, dead: trim(snapshot.dead), probe: trim(snapshot.probe), white: snapshot.white };
}

// ============ 导航页每周自动备份的到点判定 ============
//
// 为什么单独放一段、还写成纯函数：这条判定原来是一个「每周一 02:00-02:59（UTC）
// 这一小时」的**墙上时钟窗口**，错过不补跑。线上实测的后果是：
//
//   最后一次自动备份停在 2026-10-19；10-26 那一周没有任何产出。
//   而界面上「上次备份」看起来是正常的 —— 因为 10-26 用户手动点了一次备份，
//   `webdav.lastBackupAt` 被刷成了当天，自动备份的死活完全看不出来。
//
// 也就是说：触发器差一分钟、容器重启、部署赶上那一小时，这一周的备份就静默消失，
// 没有任何补偿。改成「距离上次**成功**的自动备份 ≥ 6.5 天就跑」之后，任何触发频率
// 下都能自愈：晚了一小时就下一小时补，晚了一整天就明天补。

/** 自动备份的间隔：一周（7 天）留出半天的余量，避免「刚好 7 天」被时钟抖动永远卡住 */
export const NAV_BACKUP_INTERVAL_MS = 6.5 * 86400_000;

/**
 * 从自动备份文件名里解析出它的 UTC 时间戳（毫秒）。解析不出来返回 null。
 *
 * 存量兼容用：老库里没有 `webdav.lastAutoBackupAt` 这个键（这个键是 2026-10-29 才加的），
 * 但文件名一直带着精确时间 —— `navihive-backup-auto-20261019-020000-005.json.gz`
 * 里的 `20261019-020000-005` 就是 `2026-10-19T02:00:00.005Z`（UTC，末段是毫秒）。
 *
 * 为什么不宽松匹配（比如随便找 8 位数字）：文件名是用户网盘里能看见、也能被别的
 * 工具改写的东西，宽松解析会把 `navihive-backup-auto-2026-10-19-1.json.gz` 这种
 * 猜成某个时间，进而算出错误的「还有几天才到点」。
 */
export function parseAutoBackupFileTime(filename: string | null | undefined): number | null {
    if (!filename || typeof filename !== "string") return null;
    const m = /^navihive-backup-auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})\.json\.gz$/.exec(
        filename
    );
    if (!m) return null;
    const [, y, mo, d, h, mi, s, ms] = m;
    const stamp = Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
        Number(ms)
    );
    return Number.isFinite(stamp) ? stamp : null;
}

/**
 * 这次触发要不要跑导航页的自动备份。
 *
 * 判据是「距离上次**成功**的自动备份多久了」，不再是墙上时钟窗口：
 *   - 从来没备份过（两种记录都没有）→ 跑；
 *   - `lastAutoAt` 有值 → 用它（首选，它是成功时刻的权威记录）；
 *   - `lastAutoAt` 缺失 / 坏掉 → 回退解析 `lastAutoBackupFile` 的文件名（存量兼容）；
 *   - 两样都拿不到可用时间 → 跑（宁可多备份一次，也不能因为读不懂时间就永远不备份）；
 *   - 距上次 < 6.5 天 → 跳过（每小时触发时这是常态）。
 *
 * @param lastAutoAt `webdav.lastAutoBackupAt`（ISO 字符串，可能为 null / 空 / 脏数据）
 * @param nowMs 当前时间（毫秒），由调用方传，纯函数才好测
 * @param lastAutoBackupFile `webdav.lastAutoBackup`（文件名），仅在上面那个缺失时用来兜底
 */
export function shouldRunNavBackup(
    lastAutoAt: string | null | undefined,
    nowMs: number,
    lastAutoBackupFile?: string | null
): boolean {
    const stored = lastAutoAt ? Date.parse(lastAutoAt) : NaN;
    const last = Number.isFinite(stored) ? stored : parseAutoBackupFileTime(lastAutoBackupFile);
    // 从没备份过 / 读不出时间：配了就跑，别让一个坏字段把备份永久关掉
    if (last === null || !Number.isFinite(last)) return true;
    // 时间戳落在未来（改过系统时间、网盘里的文件名被人动过）：不能信它，
    // 否则「还差 N 天才到点」会一直成立，备份永久静默 —— 正是这次要修的那类 bug
    if (last > nowMs + 86400_000) return true;
    return nowMs - last >= NAV_BACKUP_INTERVAL_MS;
}
