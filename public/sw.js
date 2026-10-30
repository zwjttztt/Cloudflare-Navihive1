// service worker：只做「离线可用 + 静态资源加速」，绝不缓存 API 数据。
// 策略：
//   - 页面导航 / HTML：**网络优先**，且**完全绕开浏览器 HTTP 缓存**（见 shellRequest）。
//     只有网络失败（离线 / 源站挂了）时才回落到 Cache Storage 里的外壳。
//   - 核心静态资源（core）：install 时预缓存 —— 只有首屏真正要用的那些
//   - 懒加载块（lazy）：**用到时才缓存**，不在后台偷偷下载（离线增强需用户显式开启）
//   - /api/*：一律走网络，不缓存，避免看到过期数据
//
// 缓存名带构建版本：新版本一上线旧缓存整体作废，不再出现「改了代码用户还看旧的」。
// 版本从 precache-manifest.json 里读（vite 构建时写入），读不到就退回固定名。
//
// ⚠️ 外壳（HTML）为什么必须「绕开 HTTP 缓存」（2026-10-29，线上「界面一直不动」的真因）：
//   `/` 与 `/index.html` 在 _headers 里带 `max-age=60, stale-while-revalidate=60`，
//   CF 边缘还有 2 分钟 TTL。只写 `fetch(req)` 的话，「网络优先」取的是**浏览器 HTTP
//   缓存里的那份**，发版后那两三分钟里拿回的仍是旧外壳 —— 而它引用的 chunk 名已经被
//   新版删掉了：chunk 404 → 主模块不执行 → React 从不挂载 → 内联骨架 #boot-skeleton
//   永久停留。public/boot-guard.js 能在 15 秒后清缓存 + 注销 SW + reload 救回来，
//   但那是**症状级兜底**：每次发版都可能让一部分用户先空屏 15 秒。
//   把外壳这条路径收紧成「一定回源」之后，boot-guard.js 才降回它本该在的位置
//   —— 最后一道防线，而不是主路径。
//
// ⚠️ 为什么是 `"reload"` 而不是 `"no-cache"`（两者都能「不拿旧外壳」，但确定性不同）：
//   · 缺省        → 直接命中 HTTP 缓存：max-age 60 秒 + SWR 60 秒 + CF 边缘 2 分钟，
//                   发版后这段窗口里喂的全是旧外壳。这就是要修的东西。
//   · "no-cache"  → 语义是「可以用缓存，但必须回源校验，校验通过才用」。
//                   问题在于 `stale-while-revalidate` 允许缓存**先把旧的吐出来**再后台刷新：
//                   请求指令是 `max-age=0` 时各家缓存对「要不要先吐旧的」实现并不一致，
//                   浏览器 / CDN 任一层选择「先吐旧的」就又回到空屏那条路上。
//   · "reload"    → 跳过 HTTP 缓存的**读取**，一定回源。代价是每次导航都要下完整的
//                   index.html（几 KB，没有 304 可省），换来的是「拿到的必然是这一版」。
//   选它就是因为第 10 项唯一的目的（不再出现发版后 15 秒空屏）容不下「大概会校验」。
//   大件不受影响：chunk / CSS 是构建期内容指纹 + immutable，仍走下面的缓存优先。
const CACHE_PREFIX = "navihive-";
// v5：外壳的取法从「默认 HTTP 缓存」改成「回源校验」（见上面的说明）。换号是为了让
// 老客户端 activate 时把 v4 那份可能已经在引用已删 chunk 的外壳一起清掉。
const FALLBACK_CACHE = `${CACHE_PREFIX}shell-v5`;
const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/icons/icon-192.png",
];
const PRECACHE_MANIFEST = "/precache-manifest.json";

/**
 * 不进预缓存的「核心壳」条目：katex 的 CSS（约 30 KB）。
 *
 * vite 的清单插件把**所有** .css 都算进 core（CSS 没有 chunk 图可走），于是
 * 只有渲染数学公式时才用得上的 katex CSS 也被 install 时预下载了 ——
 * 不读数学内容的用户每次装新版都要为它付一次流量。
 *
 * 它改成跟 katex 的 JS 块一样「用到时才缓存」：MathNode 里的 `import("katex")`
 * 触发时会顺带把这条 CSS 以 <link> 插进来，走下面的 fetch 处理
 * （destination === "style"）→ 缓存 miss → 取回来顺手存进 Cache Storage，
 * 之后再打开任何公式都是本地命中。
 *
 * ⚠️ 只过滤 CSS，别把 katex 的 JS 块也拦了：那个块本来就在 lazy 里，不归这条管。
 */
const EXCLUDED_FROM_PRECACHE = /\/assets\/katex-[^/]*\.css$/i;

// ---- 缓存治理上限 ----
/** 缓存里最多留多少个条目：长期 hash 资源 + 跨域图标会一直堆，不设上限就是无底洞 */
const MAX_ENTRIES = 300;
/** 跨域图标（opaque 响应）单独限一个更小的数：它们最杂、最容易堆 */
const MAX_ICON_ENTRIES = 120;
/** 超过这个时间的条目视为过期（跨域图标按它回收） */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 一张图最多缓存多大：动图 / 异常大图不进缓存 */
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
/** 超龄图标扫描的最小间隔：别每次命中缓存都去遍历一遍 Cache Storage */
const STALE_SWEEP_INTERVAL_MS = 60 * 1000;

let cacheNamePromise = null;

/**
 * 解析出本次部署该用的缓存名。
 * 只认 precache-manifest 里的 version —— 构建产物一变 version 就变，
 * 于是「这一版的所有资源」共享同一个缓存名，换版时整体作废。
 */
function resolveCacheName() {
    if (cacheNamePromise) return cacheNamePromise;
    cacheNamePromise = fetch(PRECACHE_MANIFEST)
        .then(res => (res.ok ? res.json() : null))
        .then(manifest => {
            const version = manifest && manifest.version;
            return version ? `${CACHE_PREFIX}${version}` : FALLBACK_CACHE;
        })
        .catch(() => FALLBACK_CACHE);
    return cacheNamePromise;
}

function readManifest() {
    return fetch(PRECACHE_MANIFEST)
        .then(res => (res.ok ? res.json() : null))
        .catch(() => null);
}

/** 旧格式的清单（只有 files）也认：那是拆分 core/lazy 之前的版本 */
function normalizeManifest(manifest) {
    if (!manifest) return { core: [], lazy: [] };
    const core = Array.isArray(manifest.core) ? manifest.core : [];
    const lazy = Array.isArray(manifest.lazy) ? manifest.lazy : [];
    if (!core.length && Array.isArray(manifest.files)) {
        return { core: manifest.files, lazy: [] };
    }
    return { core, lazy };
}

const isIconRequest = req =>
    req.destination === "image" || /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(req.url);

/**
 * 是不是「外壳」请求：页面导航，或者任何以文档身份取回来的 HTML。
 *
 * 只判 `mode === "navigate"` 会漏掉 `destination === "document"` 的那一路
 * （预取、iframe、以及某些浏览器对 /index.html 的直接请求）—— 它们下面是静态资源
 * 那条「缓存优先」的分支，而 HTML 绝不能走缓存优先。所以两个条件都收进来，
 * 并且这一支排在静态资源**之前**。
 */
const isHtmlNavigation = req =>
    req.mode === "navigate" || req.destination === "document" || req.destination === "iframe";

/**
 * 外壳（HTML）那一次网络请求：**必须从 URL 重建，不能从原请求继承**。
 *
 * ⚠️ 这是整个第 10 项最容易写成「单测全绿、线上照挂」的一行。
 * `new Request(req, { cache: ... })` 与 `fetch(req, { cache: ... })` 在 **req.mode 是
 * "navigate"** 时会在 Chrome 上**直接抛**：
 *   TypeError: Failed to execute 'fetch' on 'ServiceWorkerGlobalScope':
 *   Cannot construct a Request with a Request whose mode is 'navigate' and a non-empty RequestInit
 * （Fetch 规范：navigate 是浏览器导航专用的 mode，脚本不能拿它配非空 init 造新请求。）
 * 而页面导航恰恰**就是** navigate —— 于是每次进站都抛出去了：
 * `respondWith` 根本没被调用，浏览器按「SW 没拦截」处理，外壳既不回源也不入缓存，
 * 离线能力一起丢；控制台每导航抛一次，页面看着却是好的。
 *
 * 从 `req.url` 重建就没有 navigate 这个 mode 了（新请求是普通的 cors），`cache: "reload"`
 * 才生效。带上原 headers 是为了保住 `Accept: text/html,...`（内容协商）；
 * forbidden headers 会被构造函数静默丢掉，不用管。
 */
function shellRequest(req) {
    try {
        return new Request(req.url, {
            cache: "reload",
            method: "GET",
            headers: req.headers,
        });
    } catch {
        // 极端环境连从 URL 构造都失败：退回原请求。最坏只是没有回源校验，
        // 绝不能让「导航」本身失败 —— 那比拿到旧外壳更糟（直接打不开）。
        return req;
    }
}

/**
 * 离线兜底：把缓存里的外壳取回来。
 *
 * ⚠️ 只在**当前版本**那一个缓存里找，不用 `caches.match()`（它会遍历同源**全部**
 * Cache Storage，命中顺序不保证）。跨缓存捞的后果正是这次要修的那个：
 * `FALLBACK_CACHE` 是常量，当 `precache-manifest.json` 读不到时它跨版本复用 ——
 * 那份缓存里可能就躺着上一版的外壳，引用着已经被删掉的 chunk。
 * 本版本缓存里那份是 install 时预缓存 / 上次导航时写进去的，一定是这一版的。
 *
 * 无论如何都不回 undefined（respondWith 收到 undefined 会直接把这次导航判成失败，
 * 连错误页都不给）。
 */
async function readCachedShell(cache) {
    try {
        const cached = await cache.match("/");
        if (cached) return cached;
        const byFileName = await cache.match("/index.html");
        return byFileName || Response.error();
    } catch {
        return Response.error();
    }
}

/**
 * 外壳（HTML）：**先走网络，网络失败才回落到缓存**。
 *
 * 两条实现上的讲究，改的时候别顺手改回去：
 *
 * 1. 缓存句柄与外壳请求**同时**发起。写成 `await resolveCacheName()` 再去 fetch，
 *    等于给每次导航多加一次 precache-manifest.json 的往返 —— 离线回落要用缓存名，
 *    但没必要让它挡在网络请求前面。
 * 2. 写缓存走 `event.waitUntil`，不能在返回响应前 await：SW 随时可能被回收，
 *    而 put 的成败不该让用户多等。
 *
 * ⚠️ 缓存键统一是 `"/"`：SPA 下任何路由拿回来的都是同一份 index.html，
 * 离线时也只有「首页」这一个形态可回。缓存名本身带版本，换版即整体作废，
 * 所以不需要额外的失效逻辑（也不会滑到「永远命中旧网」那一头）。
 */
async function serveShell(event, req) {
    const cachePromise = resolveCacheName()
        .then(name => caches.open(name))
        .catch(() => null);
    const netPromise = fetch(shellRequest(req));

    let res;
    try {
        res = await netPromise;
    } catch {
        // 网络失败（离线 / 源站挂了）→ 用缓存里的外壳把页面撑起来
        const cache = await cachePromise;
        return cache ? await readCachedShell(cache) : Response.error();
    }

    // 只缓存「真的是页面」的响应：错误页 / 重定向到登录页的
    // SPA fallback 之外的东西不该被当壳存下来
    if (res && res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
        const copy = res.clone();
        event.waitUntil(
            cachePromise
                .then(cache => (cache ? putWithTimestamp(cache, "/", copy) : undefined))
                .catch(() => {})
        );
    }
    return res;
}

/**
 * 缓存整理：条目数超限 / 跨域图标超龄时回收最旧的。
 * 只在写缓存之后顺手跑一次，不做定时器 —— SW 随时可能被杀掉，定时器靠不住。
 *
 * ⚠️ 以前这里上来就是 `if (keys.length <= MAX_ENTRIES) return`：
 * 只要总条目没超过 300，哪怕图标已经堆到 200 条也不会走到下面的图标配额，
 * `MAX_ICON_ENTRIES` 形同虚设。现在两类配额各自独立判 —— 互不遮挡。
 */
async function trimCache(cache) {
    try {
        const keys = await cache.keys();
        if (keys.length <= MAX_ENTRIES) {
            // 图标配额是独立的一条限制：总数没超，图标也可能早已堆过头
            const iconKeys = keys.filter(isIconRequest);
            if (iconKeys.length <= MAX_ICON_ENTRIES) return;
            const dropIcons = iconKeys.slice(0, iconKeys.length - MAX_ICON_ENTRIES);
            await Promise.all(dropIcons.map(req => cache.delete(req)));
            return;
        }

        // 按「加入顺序」淘汰：Cache Storage 的 keys() 天然是插入序，
        // 但为了保险还是按 url 分组，图标单独走更严的配额。
        const icons = [];
        const others = [];
        for (const req of keys) {
            (isIconRequest(req) ? icons : others).push(req);
        }

        const drop = [];
        if (icons.length > MAX_ICON_ENTRIES) {
            drop.push(...icons.slice(0, icons.length - MAX_ICON_ENTRIES));
        }
        const overflow = keys.length - drop.length - MAX_ENTRIES;
        if (overflow > 0) {
            drop.push(...others.slice(0, overflow));
        }
        await Promise.all(drop.map(req => cache.delete(req)));
    } catch {
        // 整理失败不影响服务
    }
}

/**
 * 超龄的跨域图标单独清一遍（时间维度，数量没超也可能该清了）。
 *
 * 调用点要覆盖多条路径，漏一条都会积灰：以前只在「缓存 miss → 写入」那条路上跑，
 * 于是天天命中的那些图标永远等不到清理 —— 常访问的站点反而一直挂着陈图。
 *
 * 加了节流：每次都全量遍历 Cache Storage 在读多写少的场景里纯属浪费
 * （keys() 之后还要逐个 match() 才能读到时间戳，全是 I/O）。
 */
let lastStaleSweepAt = 0;
async function trimStaleIcons(cache) {
    try {
        const now = Date.now();
        if (now - lastStaleSweepAt < STALE_SWEEP_INTERVAL_MS) return;
        lastStaleSweepAt = now;

        const keys = await cache.keys();
        const deadline = now - MAX_AGE_MS;
        const stale = [];
        for (const req of keys) {
            if (!isIconRequest(req)) continue;
            const res = await cache.match(req);
            const cachedAt = res ? Number(res.headers.get("sw-cached-at")) : 0;
            if (!cachedAt || cachedAt < deadline) stale.push(req);
        }
        // 一次最多清 30 条，别为了整理把这一次请求拖太久
        await Promise.all(stale.slice(0, 30).map(req => cache.delete(req)));
    } catch {
        // 忽略
    }
}

/** 给响应打上缓存时间戳（跨域 opaque 响应不能改头，只能另存一份可改的副本） */
async function putWithTimestamp(cache, req, res) {
    // opaque 响应（no-cors 跨域）头不可读也不可改，直接存原样
    if (res.type === "opaque") {
        await cache.put(req, res.clone());
        return;
    }
    const headers = new Headers(res.headers);
    headers.set("sw-cached-at", String(Date.now()));
    const body = await res.blob();
    if (body.size > MAX_CACHE_BYTES) return;
    await cache.put(req, new Response(body, { status: res.status, headers }));
}

self.addEventListener("install", event => {
    event.waitUntil(
        resolveCacheName()
            .then(name =>
                Promise.all([caches.open(name), readManifest()]).then(([cache, manifest]) => {
                    const { core } = normalizeManifest(manifest);
                    // 只预缓存核心壳；懒加载块等用户真的点开那个功能再缓存
                    // （katex CSS 例外地在这里被剔除，见 EXCLUDED_FROM_PRECACHE）
                    const targets = [
                        ...APP_SHELL,
                        ...core.filter(url => !EXCLUDED_FROM_PRECACHE.test(url)),
                    ];
                    return cache
                        .addAll(targets)
                        .catch(() => {
                            // 个别资源取不到不影响安装
                        })
                        .then(() => cache);
                })
            )
            .then(cache => trimCache(cache))
            .catch(() => {})
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        resolveCacheName().then(name =>
            caches.keys().then(keys =>
                Promise.all(
                    keys
                        // 只清理**本项目**的旧缓存：同源下可能还挂着别的应用/别的版本，
                        // 一把全删会把它们一起干掉
                        .filter(k => k.startsWith(CACHE_PREFIX) && k !== name)
                        .map(k => caches.delete(k))
                )
            )
        )
    );
    self.clients.claim();
});

// ---- 离线增强：用户显式开启才把懒加载块也预下来 ----
self.addEventListener("message", event => {
    const data = event.data || {};
    if (data.type !== "precache-lazy") return;

    event.waitUntil(
        Promise.all([resolveCacheName(), readManifest()])
            .then(([name, manifest]) => {
                const { lazy } = normalizeManifest(manifest);
                if (!lazy.length) return 0;
                return caches.open(name).then(async cache => {
                    // 一条条加而不是 addAll：某一条失败不该让前面成功的也作废
                    // （addAll 是全有全无，几十个块里挂一个就全白下）
                    let done = 0;
                    for (const url of lazy) {
                        try {
                            await cache.add(url);
                            done++;
                        } catch {
                            // 单个块失败无所谓，用到时会再取
                        }
                    }
                    await trimCache(cache);
                    return done;
                });
            })
            .then(done => {
                if (event.source && "postMessage" in event.source) {
                    event.source.postMessage({ type: "precache-lazy-done", done });
                }
            })
            .catch(() => {})
    );
});

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // API 请求：只走网络，保证数据永远是最新的
    if (url.pathname.startsWith("/api/")) {
        event.respondWith(fetch(req));
        return;
    }

    // 页面导航 / HTML：网络优先，离线时才用缓存里的外壳兜底
    if (isHtmlNavigation(req)) {
        event.respondWith(serveShell(event, req));
        return;
    }

    // 静态资源：缓存优先 + 后台补充
    if (["style", "script", "image", "font"].includes(req.destination)) {
        event.respondWith(
            resolveCacheName()
                .then(name => caches.open(name))
                .then(cache =>
                    cache.match(req).then(cached => {
                        if (cached) {
                            // 后台静默更新，下次生效。
                            // waitUntil 必须包住：SW 可能在 fetch 回来之前就被回收，
                            // 那时 put 会静默丢失，缓存永远停在旧版本。
                            event.waitUntil(
                                fetch(req)
                                    .then(res => {
                                        if (res && (res.ok || res.type === "opaque")) {
                                            return putWithTimestamp(
                                                cache,
                                                req,
                                                res.clone()
                                            )
                                                .then(() => trimCache(cache))
                                                // 命中路径也要走超龄回收：老图标被反复命中时，
                                                // miss 那条路永远轮不到它们
                                                .then(() => trimStaleIcons(cache));
                                        }
                                    })
                                    .catch(() => {})
                            );
                            return cached;
                        }
                        return fetch(req)
                            .then(res => {
                                // 跨域图标是 no-cors 请求，响应是 opaque（status 0、ok=false），
                                // 这类响应照样能存进 Cache Storage，断网时也能取回来用
                                if (res && (res.ok || res.type === "opaque")) {
                                    event.waitUntil(
                                        putWithTimestamp(cache, req, res.clone())
                                            .then(() => trimCache(cache))
                                            .then(() => trimStaleIcons(cache))
                                            .catch(() => {})
                                    );
                                }
                                return res;
                            })
                            .catch(() => cached);
                    })
                )
        );
    }
});
