// server/static.ts
// 静态资源 + _headers 规则 + SPA fallback，顶掉 wrangler.jsonc 的 assets 绑定。
//
// 从 entry.ts 抽出来单放一个文件，纯粹为了可测：serveStatic 要吃一个
// ServerResponse，而 import entry.ts 的代价是把整个 HTTP 服务也拉起来
// （监听端口、开数据库、跑迁移）——单测要的只是这段纯逻辑。

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createGzip, gzipSync, constants as zlibConstants } from "node:zlib";
import path from "node:path";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { isSpaRoute, looksLikeAsset } from "../shared/spaRoutes";

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

// ============ 压缩与条件请求（P3：自托管不再全靠反代的 gzip on） ============
//
// 以前这里直接 createReadStream 裸传，既没有 Content-Encoding 也没有 ETag，
// 首屏那几百 KB 全靠反代压；反代没开（Docker 直接暴露端口、本机调试）就是裸传。

/**
 * 哪些 Content-Type 值得压：文本类。
 *
 * **不压**的那一半更重要：图片（png/jpg/webp/avif/gif）、字体（woff2/ttf）、
 * 音视频这些格式内部已经压过了，再 gzip 一遍几乎压不动，白烧一次 CPU；
 * `application/octet-stream` 保守起见也不压（里面可能是 zip / 已是压缩包）。
 */
function isCompressible(contentType: string): boolean {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (mime.startsWith("text/")) return true;
    return (
        mime === "application/javascript" ||
        mime === "application/json" ||
        mime === "application/xml" ||
        mime === "application/manifest+json" ||
        mime === "application/x-javascript" ||
        mime === "image/svg+xml"
    );
}

/** 客户端是否接受 gzip：按 token 逐个看，**认 q 值**（`gzip;q=0` 是不接受） */
export function acceptsGzip(headers?: IncomingHttpHeaders): boolean {
    const raw = headers?.["accept-encoding"];
    if (raw === undefined) return false;
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    let best = 0;
    for (const part of value.split(",")) {
        const [token, ...params] = part.trim().split(";");
        if (token.trim().toLowerCase() !== "gzip") continue;
        const q = params.map(p => p.trim()).find(p => p.startsWith("q="));
        const weight = q ? Number(q.slice(2)) : 1;
        if (Number.isFinite(weight) && weight > best) best = weight;
    }
    return best > 0;
}

/**
 * 带内容 hash 的构建产物（`assets/index-DkWk3ZQk.js`）：内容永不改变，
 * 压一次就能一直用；没带 hash 的（index.html）每次都要现压。
 */
function isHashedAsset(filePath: string): boolean {
    return /-[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/.test(path.basename(filePath));
}

/** 压缩缓存条数上限：构建产物就那么多个，超了按插入顺序丢最早的 */
const GZIP_CACHE_LIMIT = 200;
/** key = 路径 + size + mtime：任一变了（重新构建、换版本）缓存自动失效 */
const gzipCache = new Map<string, Buffer>();

function rememberGzip(key: string, body: Buffer): void {
    if (gzipCache.size >= GZIP_CACHE_LIMIT) {
        const oldest = gzipCache.keys().next();
        if (!oldest.done) gzipCache.delete(oldest.value);
    }
    gzipCache.set(key, body);
}

/**
 * 弱 ETag。
 *
 * 没复用 worker/util.ts 的 `weakEtag`：那个函数吃的是**正文字符串**，而这里
 * 是不缓冲地流式直出（index.html 也走流式），为了算哈希把整个文件读进内存不划算。
 * size + mtime 已经足以判断「内容有没有变」，且是弱 ETag（W/ 前缀），
 * 允许「字节不完全相同但语义等价」—— 压缩前后共用同一个值正是它的用途。
 */
function weakEtagFor(size: number, mtimeMs: number): string {
    return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

/** If-None-Match 的弱比较：两边都剥掉 W/ 与引号再比，`*` 也算命中 */
export function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
    if (header === undefined) return false;
    const value = Array.isArray(header) ? header.join(",") : header;
    const strip = (v: string): string => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    const wanted = strip(etag);
    return value.split(",").some(v => v.trim() === "*" || strip(v) === wanted);
}

/** 把 Accept-Encoding 追加进 Vary（保留规则里可能已有的值） */
function addVary(headers: Record<string, string>): void {
    const existing = headers["Vary"];
    headers["Vary"] = existing
        ? `${existing}, Accept-Encoding`
        : "Accept-Encoding";
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
// 判定搬到 shared/spaRoutes.ts（worker 与前端共用同一份），这里只做转出——
// 老调用方 import 的是这个名字，别让它们跟着改。
export { looksLikeAsset } from "../shared/spaRoutes";

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
 * 但**只对命中前端路由表的路径**回退 index.html（分享短链 /sg/<token> 靠这个）——
 * 带扩展名的未命中请求回 404（理由见 looksLikeAsset），无扩展名但不在路由表里的
 * 未知路径同样回 404（P2-8，理由见函数内注释）。路由表在 shared/spaRoutes.ts。
 */
/** 统一写 404：规则照旧按**请求路径**套（与 CF 上 assets 的响应一致） */
function writeNotFound(
    rules: HeaderRule[],
    pathname: string,
    method: string,
    res: ServerResponse
): void {
    const missHeaders: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
    };
    applyHeaderRules(rules, pathname, missHeaders);
    res.writeHead(404, missHeaders);
    if (method === "HEAD") res.end();
    else res.end("Not Found");
}

export async function serveStatic(
    staticDir: string,
    rules: HeaderRule[],
    pathname: string,
    method: string,
    res: ServerResponse,
    /**
     * 请求头。不传就退回 `res.req.headers`（Node 在 ServerResponse 上留的反向引用）——
     * 这样 `server/entry.ts` 那个既有的 5 参调用点不用改，压缩立刻生效；
     * 想显式传的调用方（以及未来的单测）也可以直接给。
     */
    reqHeaders?: IncomingHttpHeaders
): Promise<boolean> {
    const headersIn = reqHeaders ?? res.req?.headers;
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
            writeNotFound(rules, pathname, method, res);
            return true;
        }
        // ⚠️ P2-8：无扩展名也不再一律回退 —— 只有命中前端路由表（shared/spaRoutes.ts
        // 的 /、/s/<token>、/sg/<token>）才回 index.html。前端没有 react-router，
        // URL 上不存在别的路由，所以 /notes、/wp-login.php、/.git/config 这类
        // 未知无扩展名路径一律 404（以前是 200 吐整页 HTML，扫描器眼里什么都存在）。
        if (!isSpaRoute(decoded)) {
            writeNotFound(rules, pathname, method, res);
            return true;
        }
        // SPA fallback
        filePath = path.join(staticDir, "index.html");
        info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) return false; // 压根没构建过，交给 worker 回它的 404
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": String(info.size),
    };
    applyHeaderRules(rules, pathname, headers);

    // 带 hash 的构建产物自己就有 immutable 强缓存，再给 ETag 是白搭；
    // 没带 hash 的（index.html、/s/<token> 落到的那份）才靠 ETag 让条件请求成立。
    const hashed = isHashedAsset(filePath);
    const etag = hashed ? undefined : weakEtagFor(info.size, info.mtimeMs);
    if (etag) headers["ETag"] = etag;

    if (etag && ifNoneMatchHits(headersIn?.["if-none-match"], etag)) {
        // 304：不带正文，也不带 Content-Length（否则严格些的客户端会等一个永远不来的 body）
        const notModified = { ...headers };
        delete notModified["Content-Length"];
        delete notModified["Content-Encoding"];
        res.writeHead(304, notModified);
        res.end();
        return true;
    }

    const canGzip =
        acceptsGzip(headersIn) && isCompressible(contentType) && !headers["Content-Encoding"];

    if (canGzip) {
        addVary(headers);
        headers["Content-Encoding"] = "gzip";
    }

    if (canGzip && hashed) {
        // 内容不变 → 压一次缓存起来（用最高压缩比，反正只压一次）
        const cacheKey = `${filePath}|${info.size}|${Math.round(info.mtimeMs)}`;
        let body = gzipCache.get(cacheKey);
        if (!body) {
            try {
                body = gzipSync(await readFile(filePath), { level: zlibConstants.Z_BEST_COMPRESSION });
                rememberGzip(cacheKey, body);
            } catch (error) {
                console.error(`静态资源压缩失败，退回不压缩直出 ${filePath}:`, error);
                body = undefined;
            }
        }
        if (body) {
            headers["Content-Length"] = String(body.length);
            res.writeHead(200, headers);
            if (method === "HEAD") res.end();
            else res.end(body);
            return true;
        }
        // 压失败就把压缩相关的头撤掉，走下面那条不压缩的路
        delete headers["Content-Encoding"];
        headers["Content-Length"] = String(info.size);
        if (headers["Vary"] === "Accept-Encoding") delete headers["Vary"];
    }

    if (canGzip && !hashed) {
        // 流式压：不缓冲整个文件，代价是拿不到压缩后的长度（交给 chunked）
        delete headers["Content-Length"];
        res.writeHead(200, headers);
        if (method === "HEAD") {
            res.end();
            return true;
        }
        const source = createReadStream(filePath);
        const gzip = createGzip();
        const fail = (error: Error): void => {
            console.error(`静态资源读取/压缩失败 ${filePath}:`, error);
            res.destroy();
        };
        source.on("error", fail);
        gzip.on("error", fail);
        source.pipe(gzip).pipe(res);
        return true;
    }

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
