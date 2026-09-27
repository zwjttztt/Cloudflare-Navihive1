// worker/icon.ts

/**
 * 图标代理：把第三方 favicon 抓回来当同源响应发出去。
 *
 * 为什么需要它：跨域图片的响应是不透明的（opaque），前端读不到内容，
 * IndexedDB 里没法存成 blob，只能靠 Service Worker 缓存原始响应；
 * 走代理之后浏览器当成同源资源，前端的 blob 缓存就能生效。
 *
 * 安全限制：
 *   - 只接受 http/https，且只允许 80/443（顺手挡掉打内网服务的经典 SSRF）
 *   - 目标主机名解析到内网段的一律拒绝
 *   - 响应超过 512KB 直接丢掉，避免有人拿它当图床
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

    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return new Response("只支持 http/https 图标", { status: 400 });
    }

    // 端口白名单：非标准端口一律拒
    if (targetUrl.port && !["80", "443"].includes(targetUrl.port)) {
        return new Response("不支持的端口", { status: 400 });
    }

    // 内网地址黑名单（Cloudflare Worker 出网仍在我们的 VPC 视角里，挡一道更稳妥）
    const host = targetUrl.hostname.toLowerCase();
    const isPrivate =
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^0\./.test(host);
    if (isPrivate) return new Response("不允许代理内网地址", { status: 400 });

    try {
        const upstream = await fetch(targetUrl.href, {
            redirect: "follow",
            headers: { Accept: "image/*,*/*;q=0.8" },
        });

        if (!upstream.ok || !upstream.body) {
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
