// service worker：只做「离线可用 + 静态资源加速」，绝不缓存 API 数据。
// 策略：
//   - 页面导航：网络优先，离线时回退到缓存的首页（保证断网也能打开壳）
//   - 静态资源（js/css/图片/字体）：缓存优先，后台静默更新
//   - /api/*：一律走网络，不缓存，避免看到过期数据
const CACHE = "navihive-shell-v1";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest", "/vite.svg"];

self.addEventListener("install", event => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then(cache => cache.addAll(APP_SHELL))
            .catch(() => {
                // 个别资源取不到不影响安装
            })
    );
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches
            .keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
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
                    const copy = res.clone();
                    caches.open(CACHE).then(cache => cache.put("/", copy)).catch(() => {});
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
            caches.match(req).then(cached => {
                if (cached) {
                    // 后台静默更新，下次生效
                    fetch(req)
                        .then(res => {
                            if (res && res.ok) {
                                caches.open(CACHE).then(cache => cache.put(req, res.clone()));
                            }
                        })
                        .catch(() => {});
                    return cached;
                }
                return fetch(req)
                    .then(res => {
                        // 跨域图标是 no-cors 请求，响应是 opaque（status 0、ok=false），
                        // 这类响应照样能存进 Cache Storage，断网时也能取回来用
                        if (res && (res.ok || res.type === "opaque")) {
                            const copy = res.clone();
                            caches.open(CACHE).then(cache => cache.put(req, copy));
                        }
                        return res;
                    })
                    .catch(() => cached);
            })
        );
    }
});
