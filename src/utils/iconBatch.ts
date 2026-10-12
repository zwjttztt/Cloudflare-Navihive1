// src/utils/iconBatch.ts
// 一次请求拿一批图标：/api/icons?u=a&u=b&u=c
//
// 为什么需要它：这条链路上**每个请求都要付 1~3 秒的固定往返**（实测一个 10 字节的
// 接口 TTFB 3.85 秒）。而首屏一上来就是十几个 <img> 各发一次 /api/icon ——
// 图标本身都很小（几 KB），真正贵的是那十几次往返。合并成一个请求之后，
// 十几次往返塌缩成一次 + 一次稍大的下载。
//
// ---------------------------------------------------------------------------
// 关键设计一：**登记必须在渲染期同步完成**
// ---------------------------------------------------------------------------
// 只是「后台偷偷预热」是不够的：<img> 的 src 是在**渲染时**就定下来的，
// 浏览器随即发请求；等到 useEffect 再想去等批量，那一次请求早就发出去了 ——
// 结果同一批图标被下两遍（批量一份 + 卡片一份），请求数一点没少，字节还翻倍。
// 所以卡片在**渲染期**调 queueIconWarmup 同步占住「在途」，<img> 看到在途就把
// src 留空等着（见 useSiteIcon 的 iconWaiting）。
//
// ---------------------------------------------------------------------------
// 关键设计二：一帧内的候选合成**一个**请求
// ---------------------------------------------------------------------------
// React 渲染是同步的：一帧里所有卡片渲染完，才轮到微任务。所以登记只放进队列，
// 真正的请求在 queueMicrotask 里发 —— 那时这一帧所有卡片的候选都到齐了。
//
// 失败一律退化成老行为：批量请求挂了 / 超时 / 某条没取到，卡片照常自己发请求。
import { putIconBlob, unproxied } from "./iconCache";

/** 与服务端 MAX_BATCH 对齐：一次最多问这么多条 */
const BATCH_SIZE = 30;
/**
 * 卡片等这一批的上限。
 * 不是「接口超时」而是「图标最多空多久」：超过这个时间就不等了，自己发请求。
 * 批量正常时是**一个**请求，通常比卡片各发各的快得多；这个上限只在异常
 * （批量挂住不返回）时才会走到，5 秒是「宁可慢也不让图标一直空着」的取值。
 */
const BATCH_TIMEOUT_MS = 5000;

/** 代理地址 -> 这一批什么时候见分晓 */
const inflight = new Map<string, Promise<void>>();

/** 这一帧攒起来的候选（代理地址 -> 原始地址） */
const queued = new Map<string, string>();
/**
 * 本次会话已经批量取过的地址。
 *
 * 为什么需要：数据是**分阶段**到达的（init → bootstrap → 各域数据），每批落地都会
 * 让卡片重渲染一次，于是同一批图标被登记好几回。在途表管不到这种「上一批已经结束、
 * 新一批又登记同样的地址」的情况 —— 本地实测首屏因此发了 3 次 /api/icons。
 * 成或败都记下：批量只是加速手段，失败一次就交给卡片自己发（它成功时会写回缓存）。
 */
const warmed = new Set<string>();
/** 这一帧那批的「完成信号」：渲染期就建好，微任务里发出去，完成后放行 */
let frameGate: Promise<void> | null = null;
let releaseFrame: (() => void) | null = null;
let flushScheduled = false;

function takeFrameGate(): { promise: Promise<void>; release: () => void } {
    const gate = frameGate ?? new Promise<void>(r => { releaseFrame = r; });
    const release = releaseFrame ?? (() => {});
    frameGate = null;
    releaseFrame = null;
    return { promise: gate, release };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>(resolve => {
        const timer = setTimeout(() => resolve(null), ms);
        work.then(v => {
            clearTimeout(timer);
            resolve(v);
        }).catch(() => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}

/**
 * data URL -> Blob。
 *
 * ⚠️ **不能用 fetch 去取 data 协议的 URL**：本站 CSP 的 connect-src 是 `'self' https:`，
 * **不含 `data:`**，那样写会被 CSP 直接拒掉 —— 本地实测控制台一条
 * `Failed to fetch`，而且是**静默**的：批量接口明明 200 了，一张图标都没进缓存，
 * 卡片照常自己发请求，请求数一点没少，从外面看就像「批量没生效」。
 * 纯 JS 解 base64 一样拿得到 Blob，还不经过网络栈（也更快）。
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
    const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl);
    if (!m) return null;
    const type = (m[1] || "").trim().toLowerCase();
    // 只收图片：图标代理回别的类型一律当没取到，不能塞进缓存
    if (!type.startsWith("image/")) return null;
    if (m[2] !== ";base64") return null;
    try {
        const bin = atob(m[3] || "");
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!bytes.length) return null;
        return new Blob([bytes], { type });
    } catch {
        return null;
    }
}

/** 候选地址 -> [代理地址, 原始地址]；只要需要代理的那些 */
function collect(candidateUrls: readonly string[]): [string, string][] {
    const out: [string, string][] = [];
    const seen = new Set<string>();
    for (const candidate of candidateUrls) {
        if (!candidate || seen.has(candidate)) continue;
        const raw = unproxied(candidate);
        if (!raw) continue; // 同源自带的 / 相对路径：直连就行，塞进批量是浪费
        seen.add(candidate);
        out.push([candidate, raw]);
    }
    return out;
}

async function fetchBatch(entries: [string, string][]): Promise<void> {
    try {
        // 按**原始地址**问：服务端也是按原始地址回的（见 worker/icon.ts 的 proxyIcons）
        const query = entries.map(([, raw]) => `u=${encodeURIComponent(raw)}`).join("&");
        const res = await fetch(`/api/icons?${query}`, { credentials: "omit" });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { icons?: Record<string, string> } | null;
        const icons = body?.icons;
        if (!icons) return;
        // 服务端按原始地址回，这里按**代理地址**存 —— key 必须和卡片读的时候一致
        const byProxy = new Map(entries.map(([proxy, raw]) => [raw, proxy]));
        for (const [raw, dataUrl] of Object.entries(icons)) {
            const proxy = byProxy.get(raw);
            if (!proxy) continue;
            if (!dataUrl || typeof dataUrl !== "string") continue;
            const blob = dataUrlToBlob(dataUrl);
            if (blob) await putIconBlob(proxy, blob);
        }
    } catch {
        // 断网 / CSP / JSON 解析失败：退化成「卡片自己发」，不往上抛
    }
}

/**
 * 发一批并占住「在途」。gate 由调用方给（攒批那一帧的信号），
 * 或者在这里现建一个（立即预热时用）。
 */
async function runWarmup(
    entries: [string, string][],
    gate?: { promise: Promise<void>; release: () => void }
): Promise<void> {
    const g = gate ?? takeFrameGate();
    // 登记要在**发请求之前**：晚一步，同一帧里后渲染的卡片就看不到在途了
    for (const [proxy] of entries) inflight.set(proxy, g.promise);
    try {
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
            await fetchBatch(entries.slice(i, i + BATCH_SIZE));
        }
    } finally {
        // 先放行等着的卡片，再摘在途：卡片被唤醒后读缓存时，缓存已经写好了
        g.release();
        for (const [proxy] of entries) {
            inflight.delete(proxy);
            warmed.add(proxy);
        }
    }
}

/**
 * 立即预热一批（跳过已经在途的）。给「数据到位就想先下手」的场景用，
 * 测试也直接盯这个入口。卡片自己走 queueIconWarmup —— 那个会在渲染期登记。
 */
export async function warmIcons(candidateUrls: readonly string[]): Promise<void> {
    const wanted = collect(candidateUrls).filter(([proxy]) => !inflight.has(proxy) && !warmed.has(proxy));
    if (!wanted.length) return;
    await runWarmup(wanted);
}

/**
 * **渲染期**登记候选（卡片用）：同步占住「在途」，真正的请求在微任务里发，
 * 于是同一帧内所有卡片的候选合成一个请求。
 *
 * 幂等：已经在途 / 已经排队的会跳过，所以可以在渲染函数里放心调用
 * （React 严格模式会双渲染，重复调用不会多发请求）。
 */
export function queueIconWarmup(candidateUrls: readonly string[]): void {
    for (const [proxy, raw] of collect(candidateUrls)) {
        if (inflight.has(proxy) || queued.has(proxy) || warmed.has(proxy)) continue;
        queued.set(proxy, raw);
        // 同步占住：用的是这一帧的 gate，微任务里发出去，完成后放行
        if (!frameGate) frameGate = new Promise<void>(r => { releaseFrame = r; });
        inflight.set(proxy, frameGate);
    }
    if (!queued.size || flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flushQueue);
}

function flushQueue(): void {
    flushScheduled = false;
    const entries = [...queued.entries()];
    queued.clear();
    if (!entries.length) return;
    const gate = takeFrameGate();
    void runWarmup(entries, gate);
}

/** 卡片用（渲染期同步查）：这一批是不是正在路上？ */
export function pendingWarmup(proxyUrl: string): Promise<void> | null {
    return inflight.get(proxyUrl) ?? null;
}

/**
 * 等一批（带上限）。
 * 循环是因为「在途」可能被换过一次：渲染期登记的是这一帧的 gate，
 * 微任务里 runWarmup 会换成本批次的 gate（同一个对象，但保险起见重新取）。
 * 次数上限防止异常时原地打转。
 */
export async function awaitWarmup(proxyUrl: string): Promise<void> {
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    for (let i = 0; i < 8; i++) {
        const p = pendingWarmup(proxyUrl);
        if (!p) return; // 见分晓了（成功或失败都行）
        const left = deadline - Date.now();
        if (left <= 0) return;
        await withTimeout(p, left);
    }
}

/** 仅供测试：清空在途与队列 */
export function resetIconBatchForTest(): void {
    inflight.clear();
    queued.clear();
    warmed.clear();
    frameGate = null;
    releaseFrame = null;
    flushScheduled = false;
}
