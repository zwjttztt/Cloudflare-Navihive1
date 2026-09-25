// src/utils/linkHealth.ts
// 站点可达性探测：给卡片标出「可能已失效」的链接。
// 跨域拿不到真实状态码，这里用 no-cors 请求能否发出去作为「是否还活着」的近似判断。

const KEY = "navihive:deadLinks";
const TIMEOUT_MS = 6000;

export type DeadLinks = Record<string, number>; // 站点链接 -> 判定失效的时间戳

const hostOf = (url: string) => {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
};

export function readDeadLinks(): DeadLinks {
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") return {};
        const clean: DeadLinks = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number") clean[k] = v;
        }
        return clean;
    } catch {
        return {};
    }
}

function writeDeadLinks(map: DeadLinks) {
    try {
        localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
        // 忽略写入失败
    }
}

/** 标记一个链接失效（值为失效时间戳）；alive=true 时清除标记 */
export function markLink(url: string, alive: boolean): DeadLinks {
    const map = readDeadLinks();
    if (alive) {
        delete map[url];
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

/** 批量探测：限制并发，避免一次打出几十个请求 */
export async function probeLinks(
    urls: string[],
    concurrency = 5,
    onProgress?: (done: number, total: number) => void
): Promise<DeadLinks> {
    let map = readDeadLinks();
    const queue = [...new Set(urls.filter(Boolean))];
    let done = 0;

    const worker = async () => {
        while (queue.length) {
            const url = queue.shift();
            if (!url) return;
            const alive = await probeLink(url);
            map = markLink(url, alive);
            done += 1;
            onProgress?.(done, urls.length);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker)
    );
    return map;
}
