// src/utils/lazyWarm.ts
// v37.3.0：登录后空闲期，把「笔记相关」懒块的字节提前灌进 Service Worker 的 Cache Storage。
//
// 为什么需要它：笔记弹窗 / 编辑器那批 chunk 是 immutable 的 /assets/*，点开时 SW 本来就会
// 走缓存优先（isVersionedChunk 命中直接返回）。但第一次点开时缓存是 miss 的，于是要现场发
// 十几个 chunk 请求 —— 在「每请求固定 1~3 秒」的链路上就是数秒空窗。登录后闲着也是闲着，
// 把这几块提前灌进当前版本缓存，点开即命中、0 请求。
//
// 为什么必须是纯懒块、绝不静态进首屏：首屏 index chunk 离 5% 棘轮线只剩约 1 KiB，
// 任何静态 import 都会把它顶破。这个模块只在 NavigationCenterDialog（本身是登录后 idle
// 预取的懒块）里用动态 import() 触发；本文件不 import 任何首屏模块，也不读 App 的状态。
//
// 与 SW 的分工：本文件只负责「挑哪些 URL + 什么时候把消息发给 SW」，真正的 cache.add
// 在 public/sw.js 的 warm-lazy 分支里做。两边用同一套 URL 白名单正则，绝不放任意 URL 进缓存。

/** SW/客户端共用的 URL 白名单口径：/assets/ 下带内容指纹（8+ 位 hash）的 js/css */
const ASSET_URL_RE = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css)$/;

/**
 * 笔记相关的懒块前缀（对照 dist/client/precache-manifest.json 的 lazy 列表）。
 * 只有这些才预热 —— 笔记点开时要下的就是这一组。
 */
const NOTE_ALLOW_RE =
    /^\/assets\/(?:Notes|NotesOverlay|NotesLoadingFallback|note-editor|markdown|markdownToReact|katex|SiteNoteDialog|PublicNotePage)-/;

/**
 * 明确排除的沙箱 / 图表块：它们跟笔记无关且体量大（elk 是 MB 级），
 * 不该为笔记预热；tests/elkChunkGuard.test.ts 还盯着首屏，误灌只会添乱。
 */
const NOTE_DENY_RE = /^\/assets\/(?:mermaidSandbox|elk|mermaid-parser\.core)-/;

/** 一次最多灌 24 条：够覆盖笔记那十来块，又不至于在慢链路上一口气发几十个请求 */
const WARM_MAX_URLS = 24;

/**
 * 从 manifest 的 lazy 列表里挑出要预热的笔记相关 URL。
 *
 * 三层过滤：① /assets/ 前缀 + 带 hash 的 .js/.css 白名单（与 SW 同一正则口径，挡住
 * 外域 / /api/ / 无 hash / 非字符串）；② 明确排除沙箱与图表；③ 只留笔记前缀。
 * 再去重、最多 24 条。空数组（或全是非法的）返回空数组。
 *
 * 纯函数：不读全局、不发请求，便于单测逐条钉。
 */
export function pickWarmUrls(lazy: string[]): string[] {
    if (!Array.isArray(lazy)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const url of lazy) {
        if (typeof url !== "string") continue;
        if (!url.startsWith("/assets/")) continue;
        if (!ASSET_URL_RE.test(url)) continue;
        if (NOTE_DENY_RE.test(url)) continue;
        if (!NOTE_ALLOW_RE.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
        if (out.length >= WARM_MAX_URLS) break;
    }
    return out;
}

/**
 * 该不该跳过预热：离线 / 省流量 / 慢网时别灌字节，别跟用户抢带宽。
 * 参数可注入，方便单测覆盖整个矩阵（生产里从 navigator 读）。
 */
export function shouldSkipWarm(env?: {
    onLine?: boolean;
    saveData?: boolean;
    effectiveType?: string;
}): boolean {
    if (!env) return false;
    if (env.onLine === false) return true;
    if (env.saveData === true) return true;
    if (env.effectiveType === "slow-2g" || env.effectiveType === "2g") return true;
    return false;
}

// ---- 以下只被 startLazyWarm 用到：全局都经 globalThis 读，方便测试注入替身 ----

interface NavLike {
    onLine?: boolean;
    connection?: { saveData?: boolean; effectiveType?: string };
    serviceWorker?: {
        ready?: Promise<{ active?: { postMessage?: (data: unknown) => void } | null } | null>;
    };
}
interface WarmGlobals {
    window?: { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    navigator?: NavLike;
    fetch?: (url: string) => Promise<{ json: () => Promise<unknown> }>;
}
const globals = (): WarmGlobals => globalThis as unknown as WarmGlobals;

/**
 * 给 serviceWorker.ready 套一层超时：SW 没注册时 ready 可能永远不 settle，
 * 不能让这个后台任务一直挂着（也别留下一个永久 pending 的 Promise）。
 * 用 Promise.race，超时后把 timer 清掉，异常交给上层 .catch 静默吞掉。
 */
function raceSwReady<T>(ready: Promise<T>, ms: number): Promise<T> {
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("warm-lazy: SW ready 超时")), ms);
    });
    return Promise.race([ready, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    });
}

/**
 * 真正干活的一段：空闲回调里跑。全程 async，任何一步失败都由调用方的 .catch 静默吞掉
 * —— 预热是纯优化，绝不能冒泡成未处理 rejection 或影响界面。
 *
 * 顺序：先 shouldSkipWarm 守卫（离线 / 省流量 / 慢网直接返回）→ 用**默认缓存策略**
 * 读 manifest（线上 max-age=60，够新鲜又不回源）→ pickWarmUrls 挑 URL → 空则直接返回
 * → 等 serviceWorker.ready（5 秒超时）→ 拿 reg.active 发 warm-lazy 消息。
 */
async function runWarm(): Promise<void> {
    const g = globals();
    const nav = g.navigator;
    const conn = nav?.connection;
    if (
        shouldSkipWarm({
            onLine: nav?.onLine,
            saveData: conn?.saveData,
            effectiveType: conn?.effectiveType,
        })
    ) {
        return;
    }

    const fetchFn = g.fetch;
    if (typeof fetchFn !== "function") return;
    const res = await fetchFn("/precache-manifest.json");
    const manifest = (await res.json()) as { version?: unknown; lazy?: unknown } | null;
    const lazyRaw = manifest?.lazy;
    const lazy = Array.isArray(lazyRaw) ? (lazyRaw as string[]) : [];
    const urls = pickWarmUrls(lazy);
    if (!urls.length) return;
    const version = manifest?.version;

    const ready = nav?.serviceWorker?.ready;
    if (!ready) return;
    const reg = await raceSwReady(ready, 5000);
    reg?.active?.postMessage?.({ type: "warm-lazy", urls, version });
}

/** 模块级幂等标志：不管被重复调用多少次，只调度一次 */
let scheduled = false;

/**
 * 调度一次笔记懒块预热。刻意放在模块被动态 import() 进来时就调用（见
 * NavigationCenterDialog.tsx 顶层），而不是组件 useEffect —— 那样要等用户真的打开中心才跑。
 *
 * 首屏加载期绝不开始灌字节：优先 requestIdleCallback（timeout 8000，空闲才动），
 * 不可用时退回 setTimeout(cb, 6000) 错峰。所有 Promise 链都 .catch(() => {})。
 */
export function startLazyWarm(): void {
    if (scheduled) return;
    scheduled = true;
    const g = globals();
    const run = () => {
        void runWarm().catch(() => {});
    };
    if (typeof g.requestIdleCallback === "function") {
        g.requestIdleCallback(run, { timeout: 8000 });
    } else if (g.window && typeof g.window.requestIdleCallback === "function") {
        g.window.requestIdleCallback(run, { timeout: 8000 });
    } else {
        setTimeout(run, 6000);
    }
}
