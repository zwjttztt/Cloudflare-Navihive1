// worker/meta.ts

// ============ 站点信息抓取（/api/meta） ============

/** 目标页面最多读多少字符：再往后基本都是脚本和页脚，白占内存 */
const META_MAX_CHARS = 200_000;
const META_TIMEOUT_MS = 8000;

/** 内网 / 本机地址黑名单：抓取和图标代理共用一套，别让我们的 Worker 被当跳板 */
function isBlockedHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (
        host === "localhost" ||
        host === "::1" ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^0\./.test(host) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    );
}

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
 * - 只放行 http(s)，且过一遍内网黑名单 —— 这是外部可控的 URL，不做防护就是 SSRF。
 * - 有超时（8s）：很多站点对 Worker 的 UA 响应极慢，不能让前端一直转圈。
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
    if (target.protocol !== "http:" && target.protocol !== "https:") {
        return Response.json({ error: "只支持 http/https" }, { status: 400 });
    }
    if (target.port && !["80", "443"].includes(target.port)) {
        return Response.json({ error: "不支持的端口" }, { status: 400 });
    }
    if (isBlockedHost(target.hostname)) {
        return Response.json({ error: "不允许抓取内网地址" }, { status: 400 });
    }

    try {
            // 手动跟随重定向，每一跳都重新过内网黑名单：redirect:"follow" 不会重验目标，
            // 攻击者可借 302 把 Worker 引到 169.254.169.254 / 内网（SSRF）。上限 4 跳防无限循环。
            const MAX_META_REDIRECTS = 4;
            let current = target;
            let upstream: Response | null = null;
            for (let hop = 0; hop <= MAX_META_REDIRECTS; hop++) {
                if (current.protocol !== "http:" && current.protocol !== "https:") {
                    return Response.json({ error: "只支持 http/https" }, { status: 400 });
                }
                if (current.port && !["80", "443"].includes(current.port)) {
                    return Response.json({ error: "不支持的端口" }, { status: 400 });
                }
                if (isBlockedHost(current.hostname)) {
                    return Response.json({ error: "不允许抓取内网地址" }, { status: 400 });
                }

                const res = await fetch(current.href, {
                    redirect: "manual",
                    signal: AbortSignal.timeout(META_TIMEOUT_MS),
                    headers: {
                        // 不少站点对无 UA 的请求直接 403
                        "User-Agent":
                            "Mozilla/5.0 (compatible; NavihiveBot/1.0; +https://github.com/zwjttztt/Cloudflare-Navihive1)",
                        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
                        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                    },
                });

                if (res.status >= 300 && res.status < 400) {
                    const loc = res.headers.get("location");
                    if (!loc || hop === MAX_META_REDIRECTS) {
                        return Response.json({ error: "抓取重定向次数过多或被跳板" }, { status: 502 });
                    }
                    try {
                        current = new URL(loc, current.href);
                        continue;
                    } catch {
                        return Response.json({ error: "抓取重定向地址不合法" }, { status: 502 });
                    }
                }

                upstream = res;
                break;
            }

            if (!upstream || !upstream.ok || !upstream.body) {
                return Response.json({ error: `目标站点返回 ${upstream?.status ?? ""}` }, { status: 502 });
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
