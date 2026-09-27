// worker/icon.ts

import { safeFetch } from "./safeFetch";

/**
 * 图标代理：把第三方 favicon 抓回来当同源响应发出去。
 *
 * 为什么需要它：跨域图片的响应是不透明的（opaque），前端读不到内容，
 * IndexedDB 里没法存成 blob，只能靠 Service Worker 缓存原始响应；
 * 走代理之后浏览器当成同源资源，前端的 blob 缓存就能生效。
 *
 * 安全限制（集中在 worker/safeFetch.ts）：
 *   - scheme/port/host 黑名单 + 手动重定向每跳重验（详见 safeFetch 注释）
 *   - 响应超过 512KB 直接丢掉，避免有人拿它当图床
 *   - 图标代理不设 fetch 超时（timeoutMs=0）：大文件 / 慢站点偶尔会触发误杀
 */
export async function proxyIcon(request: Request): Promise<Response> {
    const target = request.url.includes("?")
        ? new URL(request.url).searchParams.get("u")
        : null;

    if (!target) return new Response("缺少 u 参数", { status: 400 });

    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        return new Response("图标地址不合法", { status: 400 });
    }

    const fetched = await safeFetch(targetUrl, {
        timeoutMs: 0,
        headers: { Accept: "image/*,*/*;q=0.8" },
    });
    if (!fetched.ok) {
        return new Response(fetched.message, { status: fetched.status });
    }
    const upstream = fetched.response;

    try {
        if (!upstream.body) {
            return new Response("上游取不到图标", { status: 404 });
        }

        const body = await upstream.arrayBuffer();
        if (body.byteLength > 512 * 1024) {
            return new Response("图标过大", { status: 413 });
        }

        const contentType = upstream.headers.get("content-type") || "";
        return new Response(body, {
            status: 200,
            headers: {
                "Content-Type": contentType.startsWith("image/")
                    ? contentType
                    : "image/x-icon",
                // 图标基本不会变，浏览器端缓存一年；前端还会再存一份 blob
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Icon-Target": targetUrl.hostname,
            },
        });
    } catch {
        return new Response("取图标失败", { status: 502 });
    }
}
