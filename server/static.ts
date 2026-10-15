// server/static.ts
// 静态资源 + _headers 规则 + SPA fallback，顶掉 wrangler.jsonc 的 assets 绑定。
//
// 从 entry.ts 抽出来单放一个文件，纯粹为了可测：serveStatic 要吃一个
// ServerResponse，而 import entry.ts 的代价是把整个 HTTP 服务也拉起来
// （监听端口、开数据库、跑迁移）——单测要的只是这段纯逻辑。

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

export interface HeaderRule {
    match: RegExp;
    set: Array<[string, string]>;
    drop: string[];
}

/**
 * 解析 dist/client/_headers（Cloudflare 静态资源的响应头规则文件）。
 * 格式：顶格是路径规则，缩进是 `名称: 值`，`! 名称` 是删除；
 * 规则按顺序生效，同名头后面覆盖前面（文件开头自己写了这条语义）。
 * 支持 `*` 通配（转成 .*），没有 * 的按精确匹配。
 *
 * 为什么不把规则硬编码在 entry.ts：那份文件是 CF 部署的单一事实来源，
 * 抄一份必然漂移；CSP 差一条（比如漏了 trusted-types navihive-sw）
 * 表现为 Service Worker 注册静默失败、离线能力没了，很难查。
 *
 * ⚠️ 真文件里 `/*` 规则底下混着大段 `  # 中文注释`（缩进的注释），
 * 必须先 trim 再判 #，否则整段会被当成畸形头行。
 */
export function parseHeaderRules(text: string): HeaderRule[] {
    const rules: HeaderRule[] = [];
    let current: HeaderRule | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;
        if (!/^\s/.test(rawLine)) {
            const pattern = line
                .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, ".*");
            current = { match: new RegExp(`^${pattern}$`), set: [], drop: [] };
            rules.push(current);
            continue;
        }
        if (!current) continue;
        if (line.startsWith("!")) {
            current.drop.push(line.slice(1).trim());
            continue;
        }
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        current.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
    }
    return rules;
}

export const MIME_TYPES: Record<string, string> = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

/** 解析后的路径必须留在静态目录里（防 ../ 穿越） */
export function isInside(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    if (rel.length === 0) return true; // 根目录本身，交给后面的 index.html 逻辑
    return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * 未命中的路径是否「像静态资源」：最后一节带扩展名（.js / .css / .png / .woff2 …）就算。
 *
 * ⚠️ 为什么必须有这条：早期实现是「任何没命中文件的路径都回 index.html」，
 * 于是浏览器按缓存里的旧 index.html 去请求一个**早已被新版本删掉**的 chunk 时，
 * 拿到的是 200 + `Content-Type: text/html` 的一整页 HTML。浏览器对 module script
 * 有严格 MIME 检查，直接拒绝执行并报
 *   "Failed to load module script: Expected a JavaScript module script but the
 *    server responded with a MIME type of text/html"
 * —— 表现为「发版后有几率白屏」，而刷新也不一定救得回来（Service Worker 可能
 * 已经把这个 HTML 当成脚本缓存下来了）。
 *
 * 顺带这也才是 Cloudflare 的真行为：官方对 `single-page-application` 的描述是
 * 「为**导航请求**（带 Sec-Fetch-Mode: navigate）回 index.html」，
 * 脚本/样式/图片这类子资源请求照样 404。
 *
 * 只按路径判断、不看 Sec-Fetch-Mode：分享短链（/sg/<64 位 hex>）常被
 * curl / 抓预览的机器人 / 微信内置浏览器直接打开，它们未必带那个头，
 * 一刀切会让分享页在这些客户端上变成 404。而带扩展名的路径不可能是业务路由。
 */
const ASSET_EXT_RE = /\.[a-z0-9]{1,8}$/i;

export function looksLikeAsset(pathname: string): boolean {
    const last = pathname.split("/").pop() ?? "";
    return ASSET_EXT_RE.test(last);
}

export function applyHeaderRules(rules: HeaderRule[], pathname: string, headers: Record<string, string>): void {
    for (const rule of rules) {
        if (!rule.match.test(pathname)) continue;
        for (const name of rule.drop) delete headers[name];
        for (const [name, value] of rule.set) headers[name] = value;
    }
}

/**
 * 静态资源 + SPA fallback。返回 false 表示「这事不归我管」（目录不存在等），
 * 调用方接着把请求交给 worker —— 与 CF 上「非 GET/HEAD 落给 Worker」的行为一致。
 * SPA fallback 对齐 wrangler.jsonc 的 assets.not_found_handling = "single-page-application"，
 * 但**只对不像静态资源的路径**回退 index.html（分享短链 /sg/<token> 靠这个）——
 * 带扩展名的未命中请求回 404，理由见 looksLikeAsset。
 */
export async function serveStatic(
    staticDir: string,
    rules: HeaderRule[],
    pathname: string,
    method: string,
    res: ServerResponse
): Promise<boolean> {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad Request");
        return true;
    }

    const target = path.join(staticDir, decoded);
    if (!isInside(staticDir, target)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
        return true;
    }

    let filePath = target;
    let info = await stat(target).catch(() => null);
    if (info?.isDirectory()) {
        filePath = path.join(target, "index.html");
        info = await stat(filePath).catch(() => null);
    }
    if (!info?.isFile()) {
        // 像静态资源（带扩展名）就直接 404 —— 用一整页 HTML 顶替脚本 / 样式 / 图片
        // 是 MIME 事故，理由见 looksLikeAsset 的注释。
        if (looksLikeAsset(decoded)) {
            const missHeaders: Record<string, string> = {
                "Content-Type": "text/plain; charset=utf-8",
            };
            applyHeaderRules(rules, pathname, missHeaders);
            res.writeHead(404, missHeaders);
            if (method === "HEAD") res.end();
            else res.end("Not Found");
            return true;
        }
        // SPA fallback
        filePath = path.join(staticDir, "index.html");
        info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) return false; // 压根没构建过，交给 worker 回它的 404
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        "Content-Length": String(info.size),
    };
    applyHeaderRules(rules, pathname, headers);

    res.writeHead(200, headers);
    if (method === "HEAD") {
        res.end();
        return true;
    }
    const stream = createReadStream(filePath);
    stream.on("error", error => {
        console.error(`静态资源读取失败 ${filePath}:`, error);
        res.destroy();
    });
    stream.pipe(res);
    return true;
}
