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
/** 首次明确404/410证据暂存；网络/CSP/限流等未知不累计失败次数。 */
const SUSPECT_KEY = "navihive:linkSuspect";
const TIMEOUT_MS = 6000;

/** 默认「多久内探测过就不再重复探测」：7 天 */
export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 明确资源不存在证据的有效期：7天内两次可读的404/410才升级失效。
 * no-cors opaque响应只能证明服务有响应；fetch异常可能是CSP、网络、超时，
 * 无论重复多少次都保持未知，不能通过「两次失败」推断资源不存在。
 */
export const SUSPECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type DeadLinks = Record<string, number>; // 站点链接 -> 判定失效的时间戳

/** 同步到服务端的快照格式；v 是版本号，以后改结构好做兼容 */
export interface LinkHealthSnapshot {
    v: 1;
    dead: DeadLinks;
    probe: Record<string, number>;
    white: string[];
    /**
     * 「疑似失效」表（v1 之后追加的可选字段）。
     * 老快照没有它 —— 缺了就当没有，最多是「下一个第一次失败又被记成疑似」，
     * 不会丢数据。刻意不升版本号：升了的话老客户端会把整份快照当成不认识而丢弃。
     */
    suspect?: Record<string, number>;
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

/**
 * 为什么要有键归一化：白名单与「失效 / 探测成功」两张表都是按 URL 字符串当键的。
 * 用户标了「可访问」之后改一下 URL（补个尾斜杠、带个锚点），精确匹配就失效了 ——
 * 白名单还在，但这个链接又被当成新链接重新探测一遍，甚至重新贴「失效」。
 *
 * 实现放在 ./url（无 DOM 依赖），这样 worker 侧的死链巡检能共用同一套口径；
 * 这里再转出一次，调用方仍只需认 linkHealth 这一个入口。
 */
import { classifyLinkStatus, deriveDeadLinks, normalizeKey } from "./linkKey";
export { deriveDeadLinks, normalizeKey };

const readNumberMap = (key: string): Record<string, number> => {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return {};
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v !== "number") continue;
            const nk = normalizeKey(k);
            if (!nk) continue;
            // 老数据里可能同一个链接存成「带尾斜杠 / 带锚点」两条，取较新的那条
            if ((clean[nk] ?? 0) < v) clean[nk] = v;
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
    return deriveDeadLinks(readNumberMap(KEY), readProbeTimes(), readWhitelist());
}

export function readDeadLinks(): DeadLinks {
    return computeDead();
}

/** 最近一次探测成功的时间（url -> 时间戳） */
export function readProbeTimes(): Record<string, number> {
    return readNumberMap(PROBE_KEY);
}

/** 用户手动标记「能访问」的链接（已归一化去重） */
export function readWhitelist(): string[] {
    try {
        const raw = localStorage.getItem(WHITELIST_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const list = Array.isArray(parsed) ? parsed.filter(v => typeof v === "string") : [];
        return [...new Set(list.map(normalizeKey).filter(Boolean))];
    } catch {
        return [];
    }
}

function writeWhitelist(list: string[]) {
    writeJson(WHITELIST_KEY, [...new Set(list.map(normalizeKey).filter(Boolean))]);
}

function writeDeadLinks(map: DeadLinks) {
    writeJson(KEY, map);
}

function writeProbeTimes(map: Record<string, number>) {
    writeJson(PROBE_KEY, map);
}

/** 「疑似失效」表：url -> 第一次失败的时间戳 */
export function readSuspectTimes(): Record<string, number> {
    return readNumberMap(SUSPECT_KEY);
}

function writeSuspectTimes(map: Record<string, number>) {
    writeJson(SUSPECT_KEY, map);
}

/**
 * 这次失败够不够格把链接判成失效。
 * 只有「上次的疑似还在有效期内」才算连续两次失败 —— 隔了半个月才再失败一次，
 * 中间很可能早就恢复了，不该拿旧账算数。
 */
function isConfirmedFailure(previousSuspectAt: number | undefined, now: number): boolean {
    return typeof previousSuspectAt === "number" && now - previousSuspectAt < SUSPECT_WINDOW_MS;
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
        suspect: capEntries(readSuspectTimes()),
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
        const local = readNumberMap(key); // 读的时候顺带归一化过一遍
        let changed = false;
        for (const [rawUrl, ts] of Object.entries(incoming)) {
            if (typeof ts !== "number") continue;
            // 入站键也要归一化：老版本客户端存的是原始 URL（带 #hash / 尾斜杠 / 大写
            // host），不归一化的话它和本机同一条链接会被算成两条，fresh 窗口和
            // 「失效 vs 探测成功」的推导都对不上，跨设备同步等于白同步。
            const url = normalizeKey(rawUrl);
            if (!url) continue;
            if ((local[url] ?? 0) < ts) {
                local[url] = ts;
                changed = true;
            }
        }
        if (changed) writeJson(key, local);
    };

    mergeMap(KEY, snapshot.dead);
    mergeMap(PROBE_KEY, snapshot.probe);
    // 可选字段：老快照没有，缺了就跳过（见接口上的注释）
    mergeMap(SUSPECT_KEY, snapshot.suspect);

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
    const key = normalizeKey(url);
    const map = readNumberMap(KEY);
    if (alive) {
        delete map[key];
        const probes = readProbeTimes();
        probes[key] = Date.now();
        writeProbeTimes(probes);
        // 探测成功过，之前那次「疑似」就不作数了
        const suspects = readSuspectTimes();
        delete suspects[key];
        writeSuspectTimes(suspects);
    } else {
        // 人工标记失效：用户的判断比探测可靠，不需要凑够两次
        map[key] = Date.now();
        const suspects = readSuspectTimes();
        delete suspects[key];
        writeSuspectTimes(suspects);
    }
    writeDeadLinks(map);
    emitChange();
    return computeDead();
}

/** 旧判据留下的失效标记降级到哪一刻为止（存的是首次迁移的时间戳） */
const MIGRATION_KEY = "navihive:linkHealthEvidenceDemotedAt";

const readMigrationBaseline = (): number => {
    try {
        const raw = localStorage.getItem(MIGRATION_KEY);
        if (!raw) return 0;
        const n: unknown = JSON.parse(raw);
        return typeof n === "number" && Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
};

/**
 * 把旧判据留下的「失效」降级成「疑似」。
 *
 * 背景：旧规则把一次/两次网络未知当失效。改用明确HTTP证据后，需要再次降级
 * 旧版本留下的标记。迁移键独立于以前的“两次失败”迁移，保证升级后执行一次。
 * 旧规则留下的标记还躺在 dead 表里 —— 不处理的话，用户升级完
 * 打开页面，那几个天天在用的站照样挂着「失效」，只会觉得这功能没救了。
 *
 * 为什么用「基线时间戳」而不是「迁移过没有」的布尔标记：
 * - 布尔标记跑一次就不能再跑。而失效记录是可以从云端合并回来的（mergeLinkHealth
 *   取两边较大值），本机降级完、下次启动云端那份旧的又并回来，标记却已经写了，
 *   于是永远清不掉。
 * - 基线时间戳天然幂等：时间戳早于基线的（也就是迁移那一刻就已经存在的）一律降级，
 *   迁移之后新判定的一律不碰。云端回填多少次都会被下一次启动再降级一次。
 *
 * 取舍：人工「标记为失效」且发生在迁移之前的，也会被降级 —— 光看两张表区分不出
 * 「人工标的」和「一次失败标的」（两者都是 dead 有、suspect 无）。重新检测时只接受
 * 明确HTTP失效证据；旧疑似超过7天时，需要在有效窗口内重新取得两次404/410才标失效。
 *
 * @returns 本次降级了多少条；0 表示没有可降级的（也就不会触发上传）
 */
export function demoteLegacyDeadMarks(now: number = Date.now()): number {
    let baseline = readMigrationBaseline();
    if (baseline <= 0) {
        baseline = now;
        writeJson(MIGRATION_KEY, baseline);
    }

    const dead = readNumberMap(KEY);
    const suspects = readSuspectTimes();
    let moved = 0;
    for (const [url, ts] of Object.entries(dead)) {
        if (ts >= baseline) continue; // 迁移之后判定的保留；旧记录云端回填后仍会被降级
        delete dead[url];
        // 只在已有疑似更旧时才覆盖：把时间戳往前推会让「连续两次」更容易成立
        if ((suspects[url] ?? 0) < ts) suspects[url] = ts;
        moved += 1;
    }
    if (moved === 0) return 0;

    writeDeadLinks(dead);
    writeSuspectTimes(suspects);
    // 让开了同步的设备把降级后的快照推上去，否则云端那份旧的还会被合并回来
    emitChange();
    return moved;
}

export function clearDeadLinks(): DeadLinks {
    // 清空失效标记的同时记一次「探测成功」，否则下次合并还会把云端的旧失效记录带回来
    const probes = readProbeTimes();
    const now = Date.now();
    for (const url of Object.keys(readNumberMap(KEY))) probes[url] = now;
    writeProbeTimes(probes);
    writeDeadLinks({});
    writeSuspectTimes({});
    emitChange();
    return {};
}

/**
 * 用户手动纠偏：这个链接其实能访问。
 * 清掉失效标记、记一次探测成功，并加进白名单（之后不再探测它）。
 */
export function markLinkAlive(url: string): DeadLinks {
    if (!url) return readDeadLinks();
    const key = normalizeKey(url);
    const list = readWhitelist();
    if (!list.includes(key)) writeWhitelist([...list, key]);
    return markLink(url, true);
}

/**
 * 撤销「标记为可访问」：把链接移出白名单，重新纳入批量检测。
 *
 * 为什么还要顺手清掉 probe / suspect 两张表的时间戳：白名单豁免只看 white，
 * 但批量检测还有第二道 fresh 窗口（近期探测成功就跳过）。刚标过「可访问」的链接
 * probe 时间戳必然是新的，不清掉的话点了「重新检测」会被 fresh 窗口直接跳过 ——
 * 界面上就是「点了没反应」，比不撤销更让人困惑。清掉后本轮就能真探一次。
 */
export function unmarkLinkAlive(url: string): DeadLinks {
    if (!url) return readDeadLinks();
    const key = normalizeKey(url);
    const list = readWhitelist();
    if (list.includes(key)) writeWhitelist(list.filter(v => v !== key));
    const probes = readProbeTimes();
    delete probes[key];
    writeProbeTimes(probes);
    const suspects = readSuspectTimes();
    delete suspects[key];
    writeSuspectTimes(suspects);
    emitChange();
    return computeDead();
}

/** 该链接是否被用户标过「可访问」（白名单里） */
export function isLinkWhitelisted(url: string): boolean {
    if (!url) return false;
    return readWhitelist().includes(normalizeKey(url));
}

/** true=HTTP层有响应，false=明确404/410，null=请求或状态无法判定。 */
export async function probeLink(url: string): Promise<boolean | null> {
    if (!url || !hostOf(url)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: "GET",
            mode: "no-cors",
            cache: "no-store",
            signal: controller.signal,
        });
        // no-cors opacity obscures even a real 404. For browser navigation, any received
        // opaque response means the host answered; readable same-origin/test responses
        // still distinguish explicit 404/410 from other statuses.
        return response.type === "opaque" || response.status === 0
            ? true
            : classifyLinkStatus(response.status);
    } catch {
        // CSP、混合内容、CORS、断网和超时在浏览器里都可能只是 TypeError。
        // 重复发生也不能变成「资源不存在」的证据。
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 批量检查专用的窄存储桥接；不接受任意 localStorage 键。 */
export const linkCheckStorage = {
    readDeadTimes: (): Record<string, number> => readNumberMap(KEY),
    writeDeadLinks,
    writeProbeTimes,
    writeSuspectTimes,
    isConfirmedFailure,
    emitChange,
} as const;
