// server/entry.ts
// 自托管（方案 B）的 Node 入口。
//
// 做的事只有一件：把 worker/index.ts 的 fetch 接到 node:http 上，业务路由一行不改。
// 另外补上 Cloudflare 平台原本替我们做的三件事：
//   1) 静态资源：wrangler.jsonc 的 assets 绑定（含 SPA fallback 与 _headers 规则）；
//   2) 定时任务：wrangler.jsonc 的 triggers.crons（每小时一条）；
//   3) 绑定与密钥：D1 / KV / wrangler secret → SQLite 文件 / 本地目录 / 环境变量。
//
// 跑法（先 npm run build 产出 dist/client，再 npm run build:server 打包本文件）：
//   npm run start:selfhost
// 配置全部走环境变量（.env 或 systemd EnvironmentFile），见文件底部的 CONFIG。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdir, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import handler from "../worker/index";
import { runScheduledTasks } from "../worker/cron";
import { makeSqliteD1 } from "./sqlite-d1";
import { makeFileKv } from "./file-kv";
import { parseHeaderRules, serveStatic, type HeaderRule } from "./static";
import type { Env } from "../worker/types";

// ============ CONFIG ============

const env = (key: string, fallback: string): string => process.env[key] || fallback;

const PORT = Number(env("NAVIHIVE_PORT", "8787"));
const HOST = env("NAVIHIVE_HOST", "127.0.0.1");
const DB_FILE = env("NAVIHIVE_DB", "./data/navihive.db");
const FILES_DIR = env("NAVIHIVE_FILES", "./data/files");
const STATIC_DIR = path.resolve(env("NAVIHIVE_STATIC_DIR", "./dist/client"));
/** 进程内定时任务开关。多副本部署时必须关（每个副本都会跑一遍），改走 POST /__cron */
const CRON_IN_PROCESS = env("NAVIHIVE_CRON", "1") !== "0";
/** POST /__cron 的 bearer token。不配 = 该端点关闭 */
const CRON_TOKEN = process.env.NAVIHIVE_CRON_TOKEN ?? "";
/** 与 wrangler.jsonc 的 triggers.crons 保持一致（各任务在代码里自判是否到点） */
const CRON_EXPR = "0 * * * *";
/**
 * 是否信任 X-Forwarded-For / X-Forwarded-Proto。
 * 默认开：自托管的标准形态是前面挡一层 Nginx，由它老实填这两个头。
 * 直接把端口暴露到公网时必须设成 "0" —— 否则客户端随手改 XFF 就能换一个限速桶，
 * 把登录爆破限速绕过去（worker/loginGuard.ts 的 clientBucket 注释有完整说明）。
 */
const TRUST_XFF = env("NAVIHIVE_TRUST_XFF", "1");

// 环境变量白名单透传。只放 worker/src 真正会读的键，避免把 PATH 之类无关变量
// 泄进 env 对象（worker 侧只认这些名字，多给了也不会用，但白名单更好查）。
const PASSTHROUGH_KEYS = [
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "AUTH_SECRET",
    "AUTH_RECOVERY_PUBLIC_KEY",
    "DATA_ENCRYPTION_KEY",
    "JWT_SECRET",
    "JWT_SECRET_OLD",
    "NAVIHIVE_COOKIE_SECURE",
    "NAVIHIVE_SESSION_FAIL_OPEN_ON_ERROR",
] as const;

// worker/types.ts 的 Env 没带这三个（那边是 Cloudflare 部署视角），自托管要能配
type ServerEnv = Env & {
    DATA_ENCRYPTION_KEY?: string;
    JWT_SECRET?: string;
    JWT_SECRET_OLD?: string;
};

// ============ 启动 ============

await mkdir(path.dirname(path.resolve(DB_FILE)), { recursive: true });
await mkdir(path.resolve(FILES_DIR), { recursive: true });

const db = makeSqliteD1(DB_FILE);
const kv = makeFileKv(FILES_DIR);

const passthrough: Record<string, string> = {};
for (const key of PASSTHROUGH_KEYS) {
    const value = process.env[key];
    // 空串一律当没配：AUTH_ENABLED="" 该落到默认的 "true"，而不是把鉴权关掉
    if (value) passthrough[key] = value;
}

const serverEnv: ServerEnv = {
    DB: db,
    FILES_KV: kv,
    // wrangler.jsonc 的 vars 里只有这一项，默认值与它对齐
    AUTH_ENABLED: env("AUTH_ENABLED", "true"),
    NAVIHIVE_TRUST_XFF: TRUST_XFF,
    ...passthrough,
};

// ============ 静态资源（顶掉 assets 绑定） ============
// 规则解析与文件服务在 ./static.ts（import 本文件会把 HTTP 服务拉起来，单测只要那段纯逻辑）

let headerRules: HeaderRule[] = [];
try {
    headerRules = parseHeaderRules(await readFile(path.join(STATIC_DIR, "_headers"), "utf8"));
} catch {
    console.warn(`⚠️ 没读到 ${path.join(STATIC_DIR, "_headers")}：静态响应将不带 CSP 等安全头（先跑 npm run build）`);
}

/** 无正文状态码：这些状态码带 body 是协议错误，Node 会直接报错 */
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);

// ============ 请求桥接 ============

// 逐跳头不能转发给 worker 的 Request（传给 undici 也会被按规范丢掉，这里显式删掉，
// 顺便留下说明）。content-length 故意保留：附件上传靠它做超大的早期拒绝
// （worker/routes/data.ts 的 declared > ATTACHMENT_MAX_BYTES 分支）。
const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
]);

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
    if (value === undefined) return undefined;
    const raw = Array.isArray(value) ? value[0] : value;
    return raw.split(",")[0].trim();
}

async function proxyToWorker(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const trustXFF = serverEnv.NAVIHIVE_TRUST_XFF === "1";
    // 用反代给的 scheme 拼 URL：requestIsSecure() 在没有 CF-Visitor 时只认
    // X-Forwarded-Proto，且要求 trustXFF 为真 —— 两者齐了 cookie 才会带 Secure。
    // 不信任 XFF 时一律按 http 拼，客户端改头也骗不到我们。
    const forwarded = firstHeaderValue(req.headers["x-forwarded-proto"]);
    const proto = trustXFF && (forwarded === "https" || forwarded === "http") ? forwarded : "http";
    const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        // Node 已经把重复头用 ", " 拼好了（set-cookie 除外，请求里没有意义）
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }

    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
    } as RequestInit);

    // worker 的默认导出是 satisfies ExportedHandler 的对象字面量，TS 推断出的 fetch
    // 只收 (request, env) 两个参数（ctx 全仓库没人用，waitUntil 零调用），这里按推断的传。
    const response = await handler.fetch(request, serverEnv);

    const outHeaders: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
        outHeaders[name] = value;
    });
    // ⚠️ 多条 Set-Cookie 必须展开成数组：登录会同时下发 navihive_token +
    // navihive_session 两条，forEach 会把它们用 ", " 粘成一条，浏览器只认第一条
    // →「登录 200 但下一个请求 401、页面弹回登录页」。
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outHeaders["set-cookie"] = cookies;

    res.writeHead(response.status, outHeaders);
    if (BODYLESS_STATUS.has(response.status) || method === "HEAD" || !response.body) {
        res.end();
        return;
    }
    // node:stream 的 fromWeb 收 node 侧的 ReadableStream，而 DOM lib 下 Response.body
    // 的类型参数是 ArrayBuffer（node 侧是 ArrayBufferLike）—— 运行时是同一种对象，断言一次。
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(res);
}

// ============ 定时任务 ============

function cronTokenOk(req: IncomingMessage): boolean {
    if (!CRON_TOKEN) return false;
    const auth = req.headers.authorization ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(CRON_TOKEN);
    // 长度不同时 timingSafeEqual 会抛，先比长度（长度不是秘密）
    return a.length === b.length && timingSafeEqual(a, b);
}

let cronTimer: NodeJS.Timeout | undefined;
function scheduleCron(): void {
    // 对齐到下一个 UTC 整点（epoch 本身就是 UTC 基准，cron 表达式按 UTC 解释）
    const delay = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 3_600_000 - Date.now();
    cronTimer = setTimeout(() => {
        runScheduledTasks(serverEnv, undefined, CRON_EXPR).catch(error => {
            console.error("定时任务异常:", error);
        });
        scheduleCron();
    }, delay);
}

// ============ HTTP 服务 ============

const server = createServer((req, res) => {
    const started = Date.now();
    const finish = (): void => {
        const ms = Date.now() - started;
        if (ms > 1000) console.warn(`慢请求 ${req.method} ${new URL(req.url ?? "/", "http://x").pathname} ${res.statusCode} ${ms}ms`);
    };
    res.on("finish", finish);

    void (async () => {
        try {
            const pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
            const method = req.method ?? "GET";
            const isApi = pathname === "/api" || pathname.startsWith("/api/");

            // POST /__cron：给外部定时器（systemd timer / crontab）用的触发口
            if (pathname === "/__cron" && method === "POST") {
                if (!cronTokenOk(req)) {
                    res.writeHead(CRON_TOKEN ? 401 : 404, { "Content-Type": "text/plain; charset=utf-8" });
                    res.end(CRON_TOKEN ? "Unauthorized" : "Not Found");
                    return;
                }
                await runScheduledTasks(serverEnv, undefined, CRON_EXPR);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end('{"ok":true}');
                return;
            }

            // GET/HEAD 且不是 /api/ → 静态资源（含 SPA fallback）。
            // 其余（/api/、非 GET/HEAD）一律进 worker，与 CF 上 assets 绑定之后的行为一致。
            if (!isApi && (method === "GET" || method === "HEAD")) {
                if (await serveStatic(STATIC_DIR, headerRules, pathname, method, res)) return;
            }

            // 只记 API 的访问日志：静态资源一跳一条太吵，而且对排障没用
            if (isApi) console.log(`${method} ${pathname}`);
            await proxyToWorker(req, res);
        } catch (error) {
            console.error("请求处理异常:", error);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error");
            } else {
                res.destroy();
            }
        }
    })();
});

server.listen(PORT, HOST, () => {
    console.log("NaviHive 自托管服务已启动");
    console.log(`  监听       http://${HOST}:${PORT}`);
    console.log(`  数据库     ${path.resolve(DB_FILE)}`);
    console.log(`  附件目录   ${path.resolve(FILES_DIR)}`);
    console.log(`  静态目录   ${STATIC_DIR}`);
    console.log(`  定时任务   ${CRON_IN_PROCESS ? "进程内每小时（NAVIHIVE_CRON=0 关闭，改用 POST /__cron）" : "关闭（用 POST /__cron 外部触发）"}`);
    console.log(`  XFF 信任   ${TRUST_XFF === "1" ? "开（取 X-Forwarded-For 作为真实 IP）" : "关（限速共用一个 unknown 桶）"}`);
    if (serverEnv.AUTH_ENABLED === "true" && !process.env.AUTH_SECRET) {
        console.warn("⚠️ AUTH_ENABLED=true 但没配 AUTH_SECRET：令牌签发/校验会 fail-closed，登录必然失败。请通过 .env 或 systemd EnvironmentFile 提供。");
    }
    if (serverEnv.AUTH_ENABLED !== "true") {
        console.warn("⚠️ AUTH_ENABLED 不是 true：站点当前无需登录即可读写，仅建议内网调试时这么用。");
    }
});

if (CRON_IN_PROCESS) scheduleCron();

// ============ 收尾 ============

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        if (closing) return;
        closing = true;
        console.log(`\n收到 ${signal}，正在收尾…`);
        if (cronTimer) clearTimeout(cronTimer);
        server.close(() => {
            try {
                db.close(); // 不关的话 WAL 尾段不 checkpoint，别的进程读到的是旧快照
            } catch (error) {
                console.error("关库失败:", error);
            }
            process.exit(0);
        });
        server.closeIdleConnections();
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
