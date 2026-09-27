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
    const whitelist = new Set(snapshot.white);
    return sites
        .filter(site => {
            if (!site.url || whitelist.has(site.url)) return false;
            const last = snapshot.probe[site.url] ?? snapshot.dead[site.url] ?? 0;
            return now - last >= freshWindowMs;
        })
        .sort((a, b) => (snapshot.probe[a.url] ?? 0) - (snapshot.probe[b.url] ?? 0))
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
    const next: LinkHealthSnapshot = {
        v: 1,
        dead: { ...snapshot.dead },
        probe: { ...snapshot.probe },
        white: snapshot.white,
    };
    if (alive) {
        next.probe[url] = now;
    } else {
        next.dead[url] = Math.max(next.dead[url] ?? 0, now);
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
