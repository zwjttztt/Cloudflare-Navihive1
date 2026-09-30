// worker/meta.ts

import { safeFetch, type SafeFetchResult } from "./safeFetch";

/** 重试前的间隔：源站刚抽风时立刻重试多半还是抽风，给它缓一口气 */
const RETRY_DELAY_MS = 300;

/** 单次抓取的请求头 */
const META_HEADERS: Record<string, string> = {
    // 不少站点对无 UA 的请求直接 403
    "User-Agent":
        "Mozilla/5.0 (compatible; NavihiveBot/1.0; +https://github.com/zwjttztt/Cloudflare-Navihive1)",
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

/**
 * 这类上游状态属于「源站临时抽风」，隔一会儿重试一次大概率就过了。
 * 429 是限流（重试只会更糟），501 / 505 是协议级不支持（重试没用），都不重试。
 */
function isRetryableStatus(status: number): boolean {
    if (status === 429 || status === 501 || status === 505) return false;
    return status >= 500;
}

/** 把干巴巴的「目标返回 522」翻译成人能看懂的话，顺带告诉用户该怎么办 */
function describeHttpFailure(status: number): string {
    switch (status) {
        case 401:
        case 403:
            return `目标站点拒绝了抓取请求（HTTP ${status}），可能屏蔽了机器人，请手动填写`;
        case 404:
            return "目标页面不存在（HTTP 404），请检查网址";
        case 429:
            return `目标站点正在限流（HTTP ${status}），请稍后再试或手动填写`;
        case 500:
            return "目标站点内部出错（HTTP 500），可稍后重试或手动填写";
        case 502:
            return "目标站点网关出错（HTTP 502），可稍后重试或手动填写";
        case 503:
            return "目标站点暂时不可用（HTTP 503），可稍后重试或手动填写";
        case 504:
            return "目标站点响应超时（HTTP 504），可稍后重试或手动填写";
        // Cloudflare 专属：源站在，但 CF 连不上它 / 连上了没在超时前回话。
        // 这两个码在自建站里极其常见，几乎都是瞬时故障
        case 522:
            return "目标站点暂时打不开（Cloudflare 522：源站没响应），可稍后重试或手动填写";
        case 524:
            return "目标站点响应超时（Cloudflare 524），可稍后重试或手动填写";
        default:
            return status >= 500
                ? `目标站点暂时不可用（HTTP ${status}），可稍后重试或手动填写`
                : `目标返回 HTTP ${status}`;
    }
}

/**
 * 抓一次；遇到可重试的上游故障就歇一下再抓一次。
 *
 * 之所以要重试：522 / 524 这种 Cloudflare 源站抖动非常普遍，第一次撞上、第二次就好了
 * 的情况占了一大半。补全只是省事功能，多花 300ms 换一次成功是划算的。
 */
async function fetchWithRetry(target: URL): Promise<SafeFetchResult> {
    const first = await safeFetch(target, {
        timeoutMs: 8_000,
        headers: META_HEADERS,
    });
    if (first.ok || first.kind !== "http" || !isRetryableStatus(first.upstreamStatus)) {
        return first;
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    return await safeFetch(target, {
        timeoutMs: 8_000,
        headers: META_HEADERS,
    });
}

// ============ 站点信息抓取（/api/meta） ============

/** 目标页面最多读多少字符：再往后基本都是脚本和页脚，白占内存 */
const META_MAX_CHARS = 200_000;

/** 从一个 meta 标签里取 content（属性顺序不固定，两种写法都要认） */
function metaContent(html: string, attr: string, value: string): string {
    const tagRe = /<meta\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html))) {
        const tag = m[0];
        const keyRe = new RegExp(`${attr}\\s*=\\s*["']?${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\\s]`, "i");
        if (!keyRe.test(tag)) continue;
        const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
        if (content) return decodeEntities(content[1].trim());
    }
    return "";
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#(\d+);/g, (_, d) => {
            const code = Number(d);
            return Number.isFinite(code) && code > 0 && code < 0x110000
                ? String.fromCodePoint(code)
                : "";
        });
}

function stripTags(text: string): string {
    return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * 抓目标站点的标题 / 描述 / 图标，供「新增卡片」一键补全。
 *
 * 几个必须注意的点：
 * - 所有「代发请求」统一走 safeFetch —— 它集中处理 scheme/port/host 黑名单 + 重定向重验
 *   + 超时（详见 worker/safeFetch.ts 注释）。
 * - 只读前 200K 字符：og 标签都在 <head> 里，读完整个页面没有意义。
 * - 解析失败不报错，返回空字段 —— 补全只是省事，不该拦住用户手动填。
 */
export async function fetchSiteMeta(request: Request): Promise<Response> {
    const raw = new URL(request.url).searchParams.get("url") || "";
    if (!raw) return Response.json({ error: "缺少 url 参数" }, { status: 400 });

    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return Response.json({ error: "网址不合法" }, { status: 400 });
    }

    try {
        const fetched = await fetchWithRetry(target);
        if (!fetched.ok) {
            // 拿得到上游状态码时说人话（「源站没响应」比「目标返回 522」有用得多）
            const message =
                fetched.kind === "http"
                    ? describeHttpFailure(fetched.upstreamStatus)
                    : fetched.message;
            return Response.json({ error: message }, { status: fetched.status });
        }
        const upstream = fetched.response;
        if (!upstream.body) {
            return Response.json({ error: "目标站点无响应体" }, { status: 502 });
        }

        // 只读前面一段：og 标签都在 <head>，读完整页既慢又费内存。
        // 先攒原始字节，等拿到 <head> 里的 charset 声明再统一解码 ——
        // 中文站还有相当一部分是 gb2312 / gbk，按 UTF-8 解出来就是一坨乱码。
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (bytes < META_MAX_CHARS) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            bytes += value.length;
        }
        reader.cancel().catch(() => {});

        const all = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
            all.set(chunk, offset);
            offset += chunk.length;
        }

        // 先用 UTF-8 解一小段找 charset 声明，再按声明的编码解全量
        const probe = new TextDecoder("utf-8").decode(all.subarray(0, Math.min(4096, bytes)));
        const charset = /<meta[^>]+charset\s*=\s*["']?([a-z0-9-]+)/i.exec(probe)?.[1] || "utf-8";
        let html: string;
        try {
            html = new TextDecoder(charset).decode(all);
        } catch {
            html = new TextDecoder("utf-8").decode(all);
        }

        // 只留 <head> 之后一点点，后面的正文用不上
        const headEnd = html.search(/<\/head>/i);
        if (headEnd > 0) html = html.slice(0, headEnd + 7);

        const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        const title = titleTag ? stripTags(titleTag[1]) : "";

        const ogTitle = metaContent(html, "property", "og:title") || metaContent(html, "name", "og:title");
        const ogDesc =
            metaContent(html, "property", "og:description") ||
            metaContent(html, "name", "og:description") ||
            metaContent(html, "name", "description") ||
            metaContent(html, "name", "Description");

        const ogImage =
            metaContent(html, "property", "og:image") || metaContent(html, "name", "og:image");

        // 站点自己的 favicon 声明；相对路径要拿目标站点补全
        const iconMatch = /<link\b[^>]*rel\s*=\s*["']?[^"']*icon[^"']*["']?[^>]*>/i.exec(html);
        let icon = "";
        if (iconMatch) {
            const href = /href\s*=\s*["']([^"']+)["']/i.exec(iconMatch[0]);
            if (href) {
                try {
                    icon = new URL(href[1], target.href).href;
                } catch {
                    icon = "";
                }
            }
        }

        return Response.json({
            title: ogTitle || title,
            description: ogDesc,
            image: ogImage,
            icon: icon || `${target.protocol}//${target.host}/favicon.ico`,
        });
    } catch {
        return Response.json({ error: "抓取失败，可能是站点拒绝了请求或超时" }, { status: 502 });
    }
}
