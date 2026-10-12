// worker/icon.ts

import { safeFetch } from "./safeFetch";
import { createMemoryLimiter } from "./rateLimit";
import { securityHeaders, readBoundedBytes, BodyLimitError } from "./util";
import { ApiError, errorResponse } from "./lib/apiError";

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
 *   - 图标代理也有 8 秒超时：这个端点会替客户端出网，挂住的连接会一直占着
 *     出网配额，慢站点宁可放弃这一次抓取（前端有占位图标兜底）
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

/** 批量接口一次最多取几个：再大就变成「帮人批量抓 URL」了，出网配额扛不住 */
const MAX_BATCH = 30;

function bytesToBase64(bytes: Uint8Array): string {
    // 分块喂给 fromCharCode：一次展开几十万个参数会把调用栈撑爆（RangeError），
    // 而单个图标最多 512KB —— 不分段的话正好踩在爆点上。
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// ============ 图标代理限速 ============
// 这个端点**公开且会替客户端出网**：谁都能让它去取任何一个地址（成本：一次外网请求 +
// 50MB 级带宽上限里的一份）。没有限流时，它就是一个免费的「帮我抓这个 URL」接口，
// 还能顺手把 Worker 的出网配额耗光 —— 正常用法下一分钟顶多刷几十个图标。
// 与 errorReport 同理，用 isolate 内的滑动窗口（跨实例不共享，但足以挡住单实例刷量）。
const iconLimiter = createMemoryLimiter({
    windowMs: 60_000,
    max: 60,
    maxKeys: 2_000,
});

/** 测试用：清空窗口计数（生产不会调） */
export function resetIconRateLimitForTest(): void {
    iconLimiter.reset();
}

/** 单个图标抓取的结果：拿到字节才算成功，没拿到也带上原因（批量接口要分条说） */
interface IconFetchResult {
    // ⚠️ 必须是 Uint8Array<ArrayBuffer> 而不是 Uint8Array：后者（ArrayBufferLike）
    // 不能当 Response 的 body 用，TS 会报 TS2345 —— 而 <ArrayBuffer> 这份收窄
    // 正好是 readBoundedBytes 的返回类型，顺手就对上了。
    bytes: Uint8Array<ArrayBuffer> | null;
    type: string | null;
    message?: string;
    status: number;
}

/**
 * 抓一个图标并做类型/体积检查。单条与批量两条路共用同一套限制，
 * 免得「批量」变成绕过白名单与出网配额的后门。
 */
async function fetchIconBytes(targetUrl: URL): Promise<IconFetchResult> {
    const fetched = await safeFetch(targetUrl, {
        timeoutMs: 8000,
        headers: { Accept: "image/*,*/*;q=0.8" },
    });
    if (!fetched.ok) return { bytes: null, type: null, message: fetched.message, status: fetched.status };

    const upstream = fetched.response;
    try {
        if (!upstream.body) return { bytes: null, type: null, message: "上游取不到图标", status: 404 };
        const body = await readBoundedBytes(upstream.body, 512 * 1024, 8000);
        if (body.byteLength > 512 * 1024) return { bytes: null, type: null, message: "图标过大", status: 413 };

        const upstreamType = mimeOf(upstream.headers.get("content-type") || "");
        // 只放行真正的图片类型（理由见文件头），批量接口同样照做 ——
        // 不过批量一律走 base64 data URL，浏览器不会把它当文档渲染，
        // 所以这里只用它判断「要不要收进结果」，不存在照抄 content-type 的风险。
        const allowed = (ALLOWED_ICON_TYPES as readonly string[]).includes(upstreamType);
        return { bytes: body, type: allowed ? upstreamType : null, status: 200 };
    } catch (error) {
        return {
            bytes: null,
            type: null,
            message: "取图标失败",
            status: error instanceof BodyLimitError ? error.status : 502,
        };
    }
}

export async function proxyIcon(
    request: Request,
    clientKey = request.headers.get("CF-Connecting-IP") || "unknown"
): Promise<Response> {
    if (!iconLimiter.allow(clientKey)) {
        return new Response("图标请求过于频繁，请稍后再试", {
            status: 429,
            headers: securityHeaders({
                "Content-Type": "text/plain; charset=utf-8",
                "Retry-After": "60",
            }),
        });
    }

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

    const result = await fetchIconBytes(targetUrl);
    if (!result.bytes) {
        return new Response(result.message || "取图标失败", {
            status: result.status,
            headers: securityHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
        });
    }

    if (!result.type) {
        // 非白名单类型：改成纯下载而不是原样返回（svg 会被当同源文档执行脚本）
        return new Response(result.bytes, {
            status: 200,
            headers: securityHeaders({
                "Content-Type": "application/octet-stream",
                "Content-Disposition": 'attachment; filename="icon"',
                "Cache-Control": "private, max-age=300",
                "X-Icon-Target": targetUrl.hostname,
            }),
        });
    }

    return new Response(result.bytes, {
        status: 200,
        headers: securityHeaders({
            "Content-Type": result.type,
            // 即便是白名单里的图片类型，也用 CSP sandbox 再封一层：
            // 万一将来有绕过白名单的路径，被当成文档打开时脚本也不会执行
            "Content-Security-Policy": "default-src 'none'; sandbox",
            // 靠 HTTP 缓存挡掉重复抓取（CDN / 浏览器都会认），不再叠一层自己的缓存。
            // 缓的是 7 天而不是「一年 immutable」：站点换 favicon 是常事，
            // 一年不回源等于把老图标钉死；stale-while-revalidate 让回源发生在后台，
            // 用户这边不会因为缓存过期而白等一次网络。
            "Cache-Control": "public, max-age=604800, stale-while-revalidate=604800",
            "X-Icon-Target": targetUrl.hostname,
        }),
    });
}

/**
 * 一次请求拿多个图标：/api/icons?u=a&u=b&u=c
 *
 * 为什么要有它：这条链路上**每个请求都要付 1~3 秒的固定往返**（实测 10 字节的
 * 接口 TTFB 3.85 秒），而首屏一上来就是十几个 <img> 各发一次 /api/icon。
 * 合并成一个请求之后，这十几次往返塌缩成一次 + 一次稍大的下载。
 *
 * 安全与配额：与单条接口共用 fetchIconBytes（同样的 host 黑名单、8 秒超时、
 * 512KB 上限、图片类型白名单）；限速按**条数**计，批量不等于免检。
 */
export async function proxyIcons(
    request: Request,
    clientKey = request.headers.get("CF-Connecting-IP") || "unknown"
): Promise<Response> {
    const url = new URL(request.url);
    const targets = url.searchParams.getAll("u").map(v => v.trim()).filter(Boolean);

    if (!targets.length) {
        return errorResponse(ApiError.badRequest("缺少 u 参数"), {
            headers: securityHeaders({ "Cache-Control": "no-store" }),
        });
    }
    if (targets.length > MAX_BATCH) {
        return errorResponse(ApiError.badRequest(`一次最多取 ${MAX_BATCH} 个图标`), {
            headers: securityHeaders({ "Cache-Control": "no-store" }),
        });
    }

    // 限速按条数计：批量接口一次能替客户端出网几十次，不按条数算就成了
    // 「刷配额的捷径」—— 单条一窗口 60 次，这里 30 条要一次性扣掉 30 次。
    for (let i = 0; i < targets.length; i++) {
        if (!iconLimiter.allow(clientKey)) {
            return errorResponse(ApiError.rateLimited("图标请求过于频繁，请稍后再试"), {
                headers: securityHeaders({ "Cache-Control": "no-store", "Retry-After": "60" }),
            });
        }
    }

    const parsed = targets.map(t => {
        try {
            return { raw: t, url: new URL(t) };
        } catch {
            return { raw: t, url: null };
        }
    });

    const icons: Record<string, string> = {};
    const failed: Record<string, string> = {};

    await Promise.all(
        parsed.map(async ({ raw, url: targetUrl }) => {
            if (!targetUrl) {
                failed[raw] = "图标地址不合法";
                return;
            }
            try {
                const result = await fetchIconBytes(targetUrl);
                if (!result.bytes || !result.type) {
                    failed[raw] = result.message || "取不到可用图标";
                    return;
                }
                icons[raw] = `data:${result.type};base64,${bytesToBase64(result.bytes)}`;
            } catch {
                // 单个失败不该让整批作废：其它图标照样能用
                failed[raw] = "取图标失败";
            }
        })
    );

    return Response.json({ icons, failed }, {
        status: 200,
        headers: securityHeaders({
            // 响应用的是**这个用户**的站点列表，不能进共享缓存（否则别人能顺带
            // 看出你收藏了哪些站点）；但本人浏览器缓存一天是合适的 ——
            // 刷新页面时卡片直接命中前端的 blob 缓存，连这一个请求都省了。
            "Cache-Control": "private, max-age=86400",
            "Vary": "Cookie",
        }),
    });
}
