// worker/icon.ts

import { safeFetch } from "./safeFetch";
import { securityHeaders } from "./util";

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
 *
 * ⚠️ 这里还有一个必须自己守的点：**content-type 绝不能照抄上游**。
 * 这个路由是公开的（浏览器用 <img> 拉图标带不上凭据），谁都能让它去取一个
 * 自己服务器上的地址。如果上游返回 `image/svg+xml` 我们就原样透传，那么
 * 受害者直接打开 `/api/icon?u=https://evil.example/x.svg` 时，浏览器会把它当
 * 作**同源文档**渲染 —— SVG 里内联的 <script> 随之执行，同源意味着它能直接
 * fetch('/api/export') 拿走全部站点数据（Cookie 会跟着带上）。
 * 因此：不在白名单上的类型一律换成 application/octet-stream + 附件下载，
 * 同时用 CSP sandbox 再封一层「即使被当成文档打开也不许跑脚本」。
 */
const ALLOWED_ICON_TYPES = [
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/png",
    "image/apng",
    "image/gif",
    "image/jpeg",
    "image/webp",
    "image/bmp",
] as const;

/** 取 content-type 的主类型部分（去掉 ;charset=... 之类的参数）并转小写 */
function mimeOf(contentType: string): string {
    return (contentType.split(";")[0] || "").trim().toLowerCase();
}

export async function proxyIcon(request: Request): Promise<Response> {
    const target = request.url.includes("?")
        ? new URL(request.url).searchParams.get("u")
        : null;

    if (!target) {
        return new Response("缺少 u 参数", {
            status: 400,
            headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
        });
    }

    let targetUrl: URL;
    try {
        targetUrl = new URL(target);
    } catch {
        return new Response("图标地址不合法", {
            status: 400,
            headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
        });
    }

    const fetched = await safeFetch(targetUrl, {
        timeoutMs: 0,
        headers: { Accept: "image/*,*/*;q=0.8" },
    });
    if (!fetched.ok) {
        return new Response(fetched.message, {
            status: fetched.status,
            headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
        });
    }
    const upstream = fetched.response;

    try {
        if (!upstream.body) {
            return new Response("上游取不到图标", {
                status: 404,
                headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
            });
        }

        const body = await upstream.arrayBuffer();
        if (body.byteLength > 512 * 1024) {
            return new Response("图标过大", {
                status: 413,
                headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
            });
        }

        const upstreamType = mimeOf(upstream.headers.get("content-type") || "");
        // 只放行真正的图片类型。svg / xml / html 这些能被浏览器当文档渲染的类型
        // 一律不认（尤其是 svg，它是可执行脚本的文档），改成纯下载而不是原样返回
        if (!(ALLOWED_ICON_TYPES as readonly string[]).includes(upstreamType)) {
            return new Response(body, {
                status: 200,
                headers: securityHeaders({
                    "Content-Type": "application/octet-stream",
                    "Content-Disposition": 'attachment; filename="icon"',
                    "Cache-Control": "private, max-age=300",
                    "X-Icon-Target": targetUrl.hostname,
                }),
            });
        }

        return new Response(body, {
            status: 200,
            headers: securityHeaders({
                "Content-Type": upstreamType,
                // 即便是白名单里的图片类型，也用 CSP sandbox 再封一层：
                // 万一将来有绕过白名单的路径，被当成文档打开时脚本也不会执行
                "Content-Security-Policy": "default-src 'none'; sandbox",
                // 图标基本不会变，浏览器端缓存一年；前端还会再存一份 blob
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Icon-Target": targetUrl.hostname,
            }),
        });
    } catch {
        return new Response("取图标失败", {
            status: 502,
            headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
        });
    }
}
