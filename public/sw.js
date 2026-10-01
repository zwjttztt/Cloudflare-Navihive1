// service worker：只做「离线可用 + 静态资源加速」，绝不缓存 API 数据。
// 策略：
//   - 页面导航：网络优先，离线时回退到缓存的首页（保证断网也能打开壳）
//   - 核心静态资源（core）：install 时预缓存 —— 只有首屏真正要用的那些
//   - 懒加载块（lazy）：**用到时才缓存**，不在后台偷偷下载（离线增强需用户显式开启）
//   - /api/*：一律走网络，不缓存，避免看到过期数据
//
// 缓存名带构建版本：新版本一上线旧缓存整体作废，不再出现「改了代码用户还看旧的」。
// 版本从 precache-manifest.json 里读（vite 构建时写入），读不到就退回固定名。
const CACHE_PREFIX = "navihive-";
const FALLBACK_CACHE = `${CACHE_PREFIX}shell-v4`;
const APP_SHELL = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/favicon.svg",
    "/icons/icon-192.png",
];
const PRECACHE_MANIFEST = "/precache-manifest.json";

// ---- 缓存治理上限 ----
/** 缓存里最多留多少个条目：长期 hash 资源 + 跨域图标会一直堆，不设上限就是无底洞 */
const MAX_ENTRIES = 300;
/** 跨域图标（opaque 响应）单独限一个更小的数：它们最杂、最容易堆 */
const MAX_ICON_ENTRIES = 120;
/** 超过这个时间的条目视为过期（跨域图标按它回收） */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 一张图最多缓存多大：动图 / 异常大图不进缓存 */
const MAX_CACHE_BYTES = 2 * 1024 * 1024;

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
 * 缓存整理：条目数超限 / 跨域图标超龄时回收最旧的。
 * 只在写缓存之后顺手跑一次，不做定时器 —— SW 随时可能被杀掉，定时器靠不住。
 */
async function trimCache(cache) {
    try {
        const keys = await cache.keys();
        if (keys.length <= MAX_ENTRIES) return;

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

/** 超龄的跨域图标单独清一遍（时间维度，数量没超也可能该清了） */
async function trimStaleIcons(cache) {
    try {
        const keys = await cache.keys();
        const deadline = Date.now() - MAX_AGE_MS;
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
                    const targets = [...APP_SHELL, ...core];
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

    // 页面导航：网络优先，失败时用缓存里的首页兜底
    if (req.mode === "navigate") {
        event.respondWith(
            fetch(req)
                .then(res => {
                    // 只缓存「真的是页面」的响应：错误页 / 重定向到登录页的
                    // SPA fallback 之外的东西不该被当壳存下来
                    if (res && res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
                        const copy = res.clone();
                        event.waitUntil(
                            resolveCacheName()
                                .then(name => caches.open(name))
                                .then(cache => putWithTimestamp(cache, "/", copy))
                                .catch(() => {})
                        );
                    }
                    return res;
                })
                .catch(() =>
                    caches.match("/").then(cached => cached || caches.match("/index.html"))
                )
        );
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
                                            ).then(() => trimCache(cache));
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
