// src/utils/linkHealth.ts
// 站点可达性探测：给卡片标出「可能已失效」的链接。
// 跨域拿不到真实状态码，这里用 no-cors 请求能否发出去作为「是否还活着」的近似判断。
//
// 三份本机数据：
// - deadLinks：判为失效的链接 -> 时间戳（UI 读它来标红）
// - probeTimes：最近一次探测成功的链接 -> 时间戳（用来跳过近期刚测过的，避免每次全量重跑）
// - whitelist：用户手动标记「其实能访问」的链接（误判纠偏，之后不再探测）

const KEY = "navihive:deadLinks";
const PROBE_KEY = "navihive:linkProbe";
const WHITELIST_KEY = "navihive:linkWhitelist";
const TIMEOUT_MS = 6000;

/** 默认「多久内探测过就不再重复探测」：7 天 */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type DeadLinks = Record<string, number>; // 站点链接 -> 判定失效的时间戳

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
};

const readNumberMap = (key: string): Record<string, number> => {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return {};
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number") clean[k] = v;
        }
        return clean;
    } catch {
        return {};
    }
};

const writeJson = (key: string, value: unknown) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // 忽略写入失败
    }
};

export function readDeadLinks(): DeadLinks {
    return readNumberMap(KEY);
}

/** 最近一次探测成功的时间（url -> 时间戳） */
export function readProbeTimes(): Record<string, number> {
    return readNumberMap(PROBE_KEY);
}

/** 用户手动标记「能访问」的链接 */
export function readWhitelist(): string[] {
    try {
        const raw = localStorage.getItem(WHITELIST_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) ? parsed.filter(v => typeof v === "string") : [];
    } catch {
        return [];
    }
}

function writeWhitelist(list: string[]) {
    writeJson(WHITELIST_KEY, [...new Set(list)]);
}

function writeDeadLinks(map: DeadLinks) {
    writeJson(KEY, map);
}

function writeProbeTimes(map: Record<string, number>) {
    writeJson(PROBE_KEY, map);
}

/** 标记一个链接失效（值为失效时间戳）；alive=true 时清除标记并记录本次探测成功 */
export function markLink(url: string, alive: boolean): DeadLinks {
    const map = readDeadLinks();
    if (alive) {
        delete map[url];
        const probes = readProbeTimes();
        probes[url] = Date.now();
        writeProbeTimes(probes);
    } else {
        map[url] = Date.now();
    }
    writeDeadLinks(map);
    return map;
}

export function clearDeadLinks(): DeadLinks {
    writeDeadLinks({});
    return {};
}

/**
 * 用户手动纠偏：这个链接其实能访问。
 * 清掉失效标记、记一次探测成功，并加进白名单（之后不再探测它）。
 */
export function markLinkAlive(url: string): DeadLinks {
    if (!url) return readDeadLinks();
    const list = readWhitelist();
    if (!list.includes(url)) writeWhitelist([...list, url]);
    return markLink(url, true);
}

/** 探测单个链接是否还能访问 */
export async function probeLink(url: string): Promise<boolean> {
    if (!url || !hostOf(url)) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        await fetch(url, {
            method: "GET",
            mode: "no-cors",
            cache: "no-store",
            signal: controller.signal,
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export interface ProbeOptions {
    /** 并发数，默认 5 */
    concurrency?: number;
    /**
     * 「多久内探测过就跳过」的毫秒数，默认 0（每次都测）。
     * 传 FRESH_WINDOW_MS 即为增量检测：近期测过且成功的链接不再重复请求。
     */
    skipFreshMs?: number;
    onProgress?: (done: number, total: number) => void;
}

export interface ProbeResult {
    /** 判定失效的链接（含本次之前就失效、但这次没重新探测的） */
    dead: DeadLinks;
    /** 本次需要探测的链接数（已排除跳过的） */
    probed: number;
    /** 因「近期测过」或「用户标记过正常」而跳过的链接数 */
    skipped: number;
}

/**
 * 批量探测：限制并发，避免一次打出几十个请求。
 * 两层减负：
 * 1) 白名单 / 近期探测成功的链接直接跳过
 * 2) 同一域名只探第一个，结果同步给该域名下的其它链接
 */
export async function probeLinks(
    urls: string[],
    options: ProbeOptions = {}
): Promise<ProbeResult> {
    const { concurrency = 5, skipFreshMs = 0, onProgress } = options;

    const whitelist = new Set(readWhitelist());
    const probes = readProbeTimes();
    const now = Date.now();

    const map = readDeadLinks();
    const uniq = [...new Set(urls.map(u => (u || "").trim()).filter(Boolean))];

    // 第一层：白名单 / 近期探测成功 → 直接判定存活，不再发请求
    const pending: string[] = [];
    let skipped = 0;
    for (const url of uniq) {
        if (
            whitelist.has(url) ||
            (skipFreshMs > 0 && probes[url] && now - probes[url] < skipFreshMs)
        ) {
            if (map[url]) delete map[url];
            skipped += 1;
            continue;
        }
        pending.push(url);
    }
    if (skipped > 0) writeDeadLinks(map);

    // 第二层：同一域名只探代表链接，结果复用给该域名下的其它链接
    const byHost = new Map<string, string[]>();
    for (const url of pending) {
        const host = hostOf(url) || url;
        const list = byHost.get(host) ?? [];
        list.push(url);
        byHost.set(host, list);
    }

    const queue = [...byHost.values()].map(list => list[0]);
    let done = skipped;

    const worker = async () => {
        while (queue.length) {
            const url = queue.shift();
            if (!url) return;
            const alive = await probeLink(url);
            const host = hostOf(url) || url;
            const group = byHost.get(host) ?? [url];

            const nextProbes = readProbeTimes();
            for (const u of group) {
                if (alive) {
                    delete map[u];
                    nextProbes[u] = Date.now();
                } else {
                    map[u] = Date.now();
                }
            }
            writeDeadLinks(map);
            writeProbeTimes(nextProbes);

            done += group.length;
            onProgress?.(Math.min(done, uniq.length), uniq.length);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(Math.max(concurrency, 1), queue.length || 1) }, worker)
    );

    return { dead: map, probed: pending.length, skipped };
}
