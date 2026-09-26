// src/utils/linkHealth.ts
// 站点可达性探测：给卡片标出「可能已失效」的链接。
// 跨域拿不到真实状态码，这里用 no-cors 请求能否发出去作为「是否还活着」的近似判断。
//
// 三份数据：
// - probe：最近一次探测**成功**的链接 -> 时间戳
// - dead：最近一次探测**失败**的链接 -> 时间戳
// - whitelist：用户手动标记「其实能访问」的链接（误判纠偏，之后不再探测）
//
// 「是否失效」不再由一个布尔字段决定，而是从两个时间戳推导：
//   dead[url] > probe[url] 才算失效。
// 这样多端合并时各键只要取最大时间戳即可，不用处理「谁删了谁的标记」这种冲突。
//
// 存放位置：默认 localStorage（本机）；开启 `link.healthSync` 后同步到服务端 configs，
// 换设备不用重新测一遍。

const KEY = "navihive:deadLinks";
const PROBE_KEY = "navihive:linkProbe";
const WHITELIST_KEY = "navihive:linkWhitelist";
const TIMEOUT_MS = 6000;

/** 默认「多久内探测过就不再重复探测」：7 天 */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type DeadLinks = Record<string, number>; // 站点链接 -> 判定失效的时间戳

/** 同步到服务端的快照格式；v 是版本号，以后改结构好做兼容 */
export interface LinkHealthSnapshot {
    v: 1;
    dead: DeadLinks;
    probe: Record<string, number>;
    white: string[];
}

/** 快照里最多留多少个链接：多了既占 D1 也占流量，超出时丢最旧的 */
const MAX_ENTRIES = 2000;

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
        // 忽略写入失败（隐私模式下 localStorage 可能不可写）
    }
};

/** 从「最后一次成功 / 最后一次失败」两份时间戳推导出当前失效清单 */
function computeDead(): DeadLinks {
    const dead = readNumberMap(KEY);
    const probe = readNumberMap(PROBE_KEY);
    const white = new Set(readWhitelist());

    const out: DeadLinks = {};
    for (const [url, ts] of Object.entries(dead)) {
        // 用户手动纠偏过的、或之后又探测成功的，都不算失效
        if (white.has(url)) continue;
        if ((probe[url] ?? 0) >= ts) continue;
        out[url] = ts;
    }
    return out;
}

export function readDeadLinks(): DeadLinks {
    return computeDead();
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

// ---------- 云端同步钩子 ----------

type ChangeListener = () => void;
let changeListener: ChangeListener | null = null;

/**
 * 注册「数据变了」的回调，App 用它做防抖上传。
 * 只在开了同步时才需要挂；不挂的话行为跟原来完全一致（纯本机）。
 */
export function onLinkHealthChange(listener: ChangeListener | null) {
    changeListener = listener;
}

const emitChange = () => {
    try {
        changeListener?.();
    } catch {
        // 上传失败不该影响探测结果
    }
};

/** 超出上限时丢掉最旧的一半，保证快照体积可控 */
function capEntries(map: Record<string, number>): Record<string, number> {
    const keys = Object.keys(map);
    if (keys.length <= MAX_ENTRIES) return map;
    const kept = keys.sort((a, b) => (map[b] ?? 0) - (map[a] ?? 0)).slice(0, MAX_ENTRIES);
    const out: Record<string, number> = {};
    for (const k of kept) out[k] = map[k];
    return out;
}

/** 导出一份可上传的快照 */
export function exportLinkHealth(): LinkHealthSnapshot {
    return {
        v: 1,
        dead: capEntries(readNumberMap(KEY)),
        probe: capEntries(readProbeTimes()),
        white: [...new Set(readWhitelist())].slice(0, MAX_ENTRIES),
    };
}

/**
 * 合并服务端下发的快照。
 * 规则：时间戳取两边较大值，白名单取并集。因为「失效」是从两个时间戳推导的，
 * 取最大值等价于「以最近一次探测结果为准」，不需要额外的冲突处理。
 */
export function mergeLinkHealth(snapshot: LinkHealthSnapshot | null | undefined): void {
    if (!snapshot || snapshot.v !== 1) return;

    const mergeMap = (key: string, incoming: Record<string, number> | undefined) => {
        if (!incoming || typeof incoming !== "object") return;
        const local = readNumberMap(key);
        let changed = false;
        for (const [url, ts] of Object.entries(incoming)) {
            if (typeof ts !== "number") continue;
            if ((local[url] ?? 0) < ts) {
                local[url] = ts;
                changed = true;
            }
        }
        if (changed) writeJson(key, local);
    };

    mergeMap(KEY, snapshot.dead);
    mergeMap(PROBE_KEY, snapshot.probe);

    if (Array.isArray(snapshot.white) && snapshot.white.length > 0) {
        const local = readWhitelist();
        const merged = [
            ...new Set([...local, ...snapshot.white.filter(v => typeof v === "string")]),
        ];
        if (merged.length !== local.length) writeWhitelist(merged);
    }
}

/** 标记一个链接失效（值为失效时间戳）；alive=true 时清除标记并记录本次探测成功 */
export function markLink(url: string, alive: boolean): DeadLinks {
    const map = readNumberMap(KEY);
    if (alive) {
        delete map[url];
        const probes = readProbeTimes();
        probes[url] = Date.now();
        writeProbeTimes(probes);
    } else {
        map[url] = Date.now();
    }
    writeDeadLinks(map);
    emitChange();
    return computeDead();
}

export function clearDeadLinks(): DeadLinks {
    // 清空失效标记的同时记一次「探测成功」，否则下次合并还会把云端的旧失效记录带回来
    const probes = readProbeTimes();
    const now = Date.now();
    for (const url of Object.keys(readNumberMap(KEY))) probes[url] = now;
    writeProbeTimes(probes);
    writeDeadLinks({});
    emitChange();
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

    // 这里直接操作两张原始表，最后统一推导一次失效清单
    const rawDead = readNumberMap(KEY);
    const uniq = [...new Set(urls.map(u => (u || "").trim()).filter(Boolean))];

    // 第一层：白名单 / 近期探测成功 → 直接判定存活，不再发请求
    const pending: string[] = [];
    let skipped = 0;
    for (const url of uniq) {
        if (
            whitelist.has(url) ||
            (skipFreshMs > 0 && probes[url] && now - probes[url] < skipFreshMs)
        ) {
            delete rawDead[url];
            skipped += 1;
            continue;
        }
        pending.push(url);
    }
    if (skipped > 0) writeDeadLinks(rawDead);

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
            const nextDead = readNumberMap(KEY);
            for (const u of group) {
                if (alive) {
                    delete nextDead[u];
                    nextProbes[u] = Date.now();
                } else {
                    nextDead[u] = Date.now();
                }
            }
            writeDeadLinks(nextDead);
            writeProbeTimes(nextProbes);

            done += group.length;
            onProgress?.(Math.min(done, uniq.length), uniq.length);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(Math.max(concurrency, 1), queue.length || 1) }, worker)
    );

    emitChange();
    return { dead: computeDead(), probed: pending.length, skipped };
}
