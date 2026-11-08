// 用户主动发起的批量检查：只在点击检测时下载，不改变探测或持久化规则。
import {
    linkCheckStorage,
    normalizeKey,
    probeLink,
    readDeadLinks,
    readProbeTimes,
    readSuspectTimes,
    readWhitelist,
    type DeadLinks,
} from "./linkHealth";

export interface LinkCheckSummary {
    text: string;
    severity: "info" | "success";
    offerFilter: boolean;
}

/** 生成检测提示，未知结果不宣称全部可访问。 */
export function describeLinkCheck(deadCount: number, skipped = 0, suspectCount = 0): LinkCheckSummary {
    const skipNote = skipped > 0 ? `（${skipped} 个近期检测过，已跳过）` : "";
    const suspectNote = suspectCount > 0
        ? `；另有 ${suspectCount} 个暂时无法确认（网络、访问限制或超时），未判为失效`
        : "";
    if (deadCount > 0) {
        return {
            text: `检测完成，${deadCount} 个链接疑似失效${skipNote}${suspectNote}`,
            severity: "info",
            offerFilter: true,
        };
    }
    return {
        text: suspectCount > 0
            ? `检测完成，未发现明确失效链接${skipNote}${suspectNote}`
            : `检测完成，所有链接都能访问${skipNote}`,
        severity: suspectCount > 0 ? "info" : "success",
        offerFilter: false,
    };
}

/** 依首次出现顺序收集、归一化去重检测链接。 */
export function collectCheckUrls(groups: { sites?: { url?: string }[] }[] | null | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const group of groups || []) {
        for (const site of group.sites || []) {
            const url = (site.url || "").trim();
            if (!url) continue;
            const key = normalizeKey(url);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(url);
        }
    }
    return out;
}

export interface ProbeOptions {
    concurrency?: number;
    skipFreshMs?: number;
    onProgress?: (done: number, total: number) => void;
}

export interface ProbeResult {
    dead: DeadLinks;
    probed: number;
    skipped: number;
    /** 首次明确失败及无法确认的链接数量。 */
    suspect: number;
}

/** 并发探测，按同一请求键复用证据，不把路径404传播给同域资源。 */
export async function probeLinks(urls: string[], options: ProbeOptions = {}): Promise<ProbeResult> {
    const { concurrency = 5, skipFreshMs = 0, onProgress } = options;
    const whitelist = new Set(readWhitelist());
    const probes = readProbeTimes();
    const now = Date.now();
    const rawDead = linkCheckStorage.readDeadTimes();
    const rawSuspect = readSuspectTimes();
    const uniq = [...new Set(urls.map(u => (u || "").trim()).filter(Boolean))];
    const pending: string[] = [];
    let skipped = 0;
    for (const url of uniq) {
        const key = normalizeKey(url);
        if (whitelist.has(key) || (skipFreshMs > 0 && probes[key] && now - probes[key] < skipFreshMs)) {
            delete rawDead[key];
            delete rawSuspect[key];
            skipped += 1;
            continue;
        }
        pending.push(url);
    }
    if (skipped > 0) {
        linkCheckStorage.writeDeadLinks(rawDead);
        linkCheckStorage.writeSuspectTimes(rawSuspect);
    }
    const byHost = new Map<string, string[]>();
    for (const url of pending) {
        const host = normalizeKey(url);
        const list = byHost.get(host) ?? [];
        list.push(url);
        byHost.set(host, list);
    }
    const queue = [...byHost.values()].map(list => list[0]);
    let done = skipped;
    let suspectCount = 0;
    const worker = async () => {
        while (queue.length) {
            const url = queue.shift();
            if (!url) return;
            const alive = await probeLink(url);
            const host = normalizeKey(url);
            const group = byHost.get(host) ?? [url];
            const nextProbes = readProbeTimes();
            const nextDead = linkCheckStorage.readDeadTimes();
            const nextSuspect = readSuspectTimes();
            const at = Date.now();
            for (const u of group) {
                const key = normalizeKey(u);
                if (alive === null) {
                    suspectCount += 1;
                } else if (alive) {
                    delete nextDead[key];
                    delete nextSuspect[key];
                    nextProbes[key] = at;
                } else if (linkCheckStorage.isConfirmedFailure(nextSuspect[key], at)) {
                    delete nextSuspect[key];
                    nextDead[key] = at;
                } else {
                    nextSuspect[key] = at;
                    suspectCount += 1;
                }
            }
            linkCheckStorage.writeDeadLinks(nextDead);
            linkCheckStorage.writeProbeTimes(nextProbes);
            linkCheckStorage.writeSuspectTimes(nextSuspect);
            done += group.length;
            onProgress?.(Math.min(done, uniq.length), uniq.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), queue.length || 1) }, worker));
    linkCheckStorage.emitChange();
    return { dead: readDeadLinks(), probed: pending.length, skipped, suspect: suspectCount };
}
