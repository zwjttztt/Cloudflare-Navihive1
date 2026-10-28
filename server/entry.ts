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
import { request as httpRequest, type RequestOptions } from "node:http";
import { Readable } from "node:stream";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import path from "node:path";
import handler from "../worker/index";
import { runScheduledTasks } from "../worker/cron";
import { makeSqliteD1 } from "./sqlite-d1";
import {
    slowQueryEnabled,
    slowQuerySnapshot,
    slowQuerySummary,
    slowQueryThresholdMs,
} from "./slowQuery";
import { makeFileKv } from "./file-kv";
import { parseHeaderRules, serveStatic, type HeaderRule } from "./static";
import { isPublicHost, normalizeRemoteAddress } from "./net";
import { setEgressResolver } from "../worker/safeFetch";
import { isBlockedHost } from "../worker/util";
import { REAL_IP_HEADER } from "../worker/httpUtils";
import { REQUEST_ID_HEADER, REQUEST_ID_LEN } from "../shared/requestId";
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

// ============ 出站解析复核（自托管 SSRF 闭环，2026-10-24） ============
//
// Cloudflare Workers 有平台层 egress 拦截（RFC1918 / loopback / link-local 一律
// 出不去），Node 没有。safeFetch 的 hostname 黑名单判不了 DNS rebinding
// （首次解析是公网、连接时换回内网），所以这里把每个出站 hostname 真解析一遍，
// 逐 IP 过同一套黑名单。死链巡检 / 图标代理 / AI / WebDAV 四条出站路都走
// safeFetch，注册一次全覆盖。
//
// 细节：
//   · ⚠️ 解析失败（NXDOMAIN / DNS 超时 / 解析库异常）→ **拒绝**（fail-closed）。
//     原来是「放行，让 fetch 自己去失败」，但 DNS 恰恰是攻击者能操纵的那一环 ——
//     rebinding 就是让解析结果在「校验」与「连接」之间翻转。查不到结果时
//     「你随便去连吧」等于把这道复核整个交出去，宁可拦下正常的打错字域名，
//     也不能让攻击者靠制造解析失败（DNS 干扰 / 特殊域名）绕过复核；
//   · 60s 缓存：死链巡检一次几十个 URL，同一 host 会重复解析；
//   · 上限 500 条：防长尾域名把 Map 吹大，超了整体清空（清空后本次结果直接用返回值，
//     不会因为它被清掉就误判成不可解析）。
//     ⚠️ 用户 opt-in 的内网 WebDAV（webdav.allowPrivateNetwork）不经过这里 ——
//     worker/webdav/transport.ts 在开了那个开关时会跳过解析复核，所以把这里改严
//     不会把 NAS 备份一起挡掉。
// ⚠️ 仍是缓解不是根治（lookup 与 fetch 内部再解析之间有窗口）—— safeFetch.ts
//    的 setEgressResolver 注释里有完整说明。
const RESOLVE_TTL_MS = 60_000;
const RESOLVE_CACHE_MAX = 500;
const resolvedIps = new Map<string, { ips: string[]; at: number }>();

setEgressResolver(async (hostname: string): Promise<boolean> => {
    const now = Date.now();
    const hit = resolvedIps.get(hostname);
    let ips: string[] | null = hit && now - hit.at <= RESOLVE_TTL_MS ? hit.ips : null;
    if (ips === null) {
        try {
            const rows = await lookup(hostname, { all: true });
            ips = rows.map(r => r.address);
            resolvedIps.set(hostname, { ips, at: now });
            if (resolvedIps.size > RESOLVE_CACHE_MAX) resolvedIps.clear();
        } catch {
            // fail-closed：查不出 IP 就当不通过（理由见上面那段）
            return false;
        }
    }
    // 一条 IP 都没解析出来（缓存被清空的那一瞬）也按不通过：宁可误拒，不误放行
    if (ips.length === 0) return false;
    // 一个都不过才算数：多 A 记录时只要有个内网 IP 就该拒
    return ips.every(ip => !isBlockedHost(ip));
});

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

/** 升级端点的内部鉴权用：只转发浏览器凭证（cookie / Authorization）。
 *  内部问 worker 的 auth/me，复用整套令牌校验 —— server 侧不自己解 session。 */
function toHeaders(req: IncomingMessage): Headers {
    const headers = new Headers();
    const cookie = req.headers.cookie;
    if (cookie) headers.set("cookie", Array.isArray(cookie) ? cookie.join("; ") : cookie);
    const auth = req.headers.authorization;
    if (auth) headers.set("authorization", String(auth));
    return headers;
}

async function proxyToWorker(req: IncomingMessage, res: ServerResponse, rid: string): Promise<void> {
    const method = req.method ?? "GET";
    const trustXFF = serverEnv.NAVIHIVE_TRUST_XFF === "1";

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        // Node 已经把重复头用 ", " 拼好了（set-cookie 除外，请求里没有意义）
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }

    // ============ 客户端能伪造的「平台头 / 代理头」在入口这一层处理掉 ============
    //
    // 自托管前面没有 Cloudflare，而 worker 侧（httpUtils.clientIp、loginGuard.clientBucket、
    // httpUtils.requestIsSecure）以及 icon / csp / errorReport / public 路由都**无条件信任**
    // CF-Connecting-IP 与 CF-Visitor。客户端随手带上这两个头就能：
    //   - 每猜一次密码换一个限速桶 → 登录爆破限速被无限绕过；
    //   - 把自己声明成 http → 骗我们去掉 cookie 的 Secure。
    // 那几个函数必须保持原样（Workers 部署下这两个头由平台注入，且 requestIsSecure
    // 丢了 CF-Visitor 反而会误判成 https），所以在入口删掉最干净 —— 一次删掉也就
    // 覆盖了所有直接读它们的地方，不用逐个文件去改。
    //
    // 这正是 NAVIHIVE_TRUST_XFF 这个开关该起作用的地方：只有明确声明「前面挡着
    // 一层会老实填头的可信反代」时才保留 X-Forwarded-*，否则一律删掉，
    // 真实地址由下面的 socket 对端提供。
    headers.delete("cf-connecting-ip");
    headers.delete("cf-visitor");
    if (!trustXFF) {
        headers.delete("x-forwarded-for");
        headers.delete("x-forwarded-proto");
    }

    // 用反代给的 scheme 拼 URL：requestIsSecure() 在没有 CF-Visitor 时只认
    // X-Forwarded-Proto，且要求 trustXFF 为真 —— 两者齐了 cookie 才会带 Secure。
    // 不信任 XFF 时上面的删除已经生效，一律按 http 拼，客户端改头也骗不到我们。
    const forwarded = trustXFF ? firstHeaderValue(req.headers["x-forwarded-proto"]) : undefined;
    const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
    const url = new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "localhost"}`);

    // 客户端真实 IP：worker 侧只认 CF-Connecting-IP 与 X-Forwarded-For 两个头
    // （worker/httpUtils.ts clientIp、worker/loginGuard.ts clientBucket）。
    // 挡一层 Nginx 时由它填 XFF，一切正常；但**直接把端口暴露出去**时一个头都没有，
    // 于是所有人的 IP 都是 "unknown"：
    //   - 审计日志 / 会话列表里的来源全是 unknown，事后排查无线索；
    //   - 登录爆破限速按 IP 分桶，unknown 意味着全场共用一个桶 ——
    //     一个人试错 5 次，所有人在同一台机器上都跟着被锁。
    // 这里用 socket 地址补上，worker 代码一行不改。已有的 XFF 不覆盖（反代链更长时
    // 由最外层那条说话，worker 侧本来就取逗号分隔的第一段）。
    if (!headers.has("x-forwarded-for")) {
        const remote = req.socket.remoteAddress;
        if (remote) headers.set("x-forwarded-for", normalizeRemoteAddress(remote));
    }
    // 上面那两个头都可能被伪造，所以真实地址**另外**走一条专用头：
    // 一律覆盖写入，客户端带过来的值根本到不了 worker（worker 侧在 CF-* / XFF
    // 都不可用或不可信时才读它）。Workers 部署下没人写这条头。
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress) headers.set(REAL_IP_HEADER, normalizeRemoteAddress(remoteAddress));

    // 请求 ID：由 createServer 入口生成后一路带下来（结构化访问日志用的是同一个值）。
    // ⚠️ 一律覆盖客户端带过来的值 —— 否则伪造一个和别人相同的 rid，就能把两条请求的
    // 日志 / 审计串成一条，反过来也查不清。Workers 部署下这条头由 worker 自己生成。
    headers.set(REQUEST_ID_HEADER, rid);

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

// ============ 网页端直接升级（Docker Engine API over unix socket） ============
//
// 为什么不用 `docker` CLI：镜像是 node:24-slim，里面**没有** docker 二进制；
// 而把宿主机的 /usr/bin/docker 挂进容器要连带挂 cli-plugins（`docker compose`
// 是插件不是内建命令），还要挂 compose 目录，链路长且动态库容易不兼容。
// Docker Engine 的 HTTP API 走 /var/run/docker.sock，Node 原生就能发请求
// （http.request 的 socketPath 选项），零额外依赖、也不需要 compose。
//
// ⚠️ 这个文件在容器里跑，升级的正是**它自己所在的容器**：整条序列必须
// 「先把 200 响应发出去，再动手」，否则 compose 换容器时进程被杀，
// 用户等不到任何反馈。调用方（下面的路由）已保证顺序。
/**
 * Docker daemon 的访问方式。两种，按 `NAVIHIVE_DOCKER_HOST` 是否配置自动选：
 *
 *   1. 没配（默认）—— 走 unix socket `/var/run/docker.sock`
 *      （路径可用 `NAVIHIVE_DOCKER_SOCK` 改）。等价于把宿主机 Docker 的完整控制权
 *      交给这个容器。
 *   2. 配了 —— 走 TCP，接的是 `docker-socket-proxy` 一类的最小权限代理，
 *      只能碰升级必需的几个端点（拉镜像 / 建启删容器 / 读日志），
 *      容器失守也不等于拿到宿主机 root。
 *      compose 片段见 `deploy/docker-socket-proxy.yml`。
 *
 * ⚠️ 代理模式下 helper 容器**不再挂 sock**，改为给它注入 `DOCKER_HOST`，
 * 让里面的 `docker compose` 也走同一个代理（见 runUpgraderContainer）。
 */
const DOCKER_SOCK = process.env.NAVIHIVE_DOCKER_SOCK || "/var/run/docker.sock";
const DOCKER_HOST = (process.env.NAVIHIVE_DOCKER_HOST || "").trim();
/** API 版本写死：不跟着 daemon 版本漂，行为才可预期（v1.47 ≈ Docker 25/26） */
const DOCKER_API_VERSION = "v1.47";

/** 拼 http.request 的连接参数：代理模式给 host/port，否则给 socketPath */
function dockerEndpoint(): RequestOptions {
    if (!DOCKER_HOST) return { socketPath: DOCKER_SOCK };
    // 形如 http://docker-socket-proxy:2375；代理只开 http，端口缺省 2375
    const url = new URL(DOCKER_HOST);
    return { host: url.hostname, port: Number(url.port) || 2375 };
}

/**
 * 给 **docker CLI / compose** 用的 DOCKER_HOST。
 *
 * ⚠️⚠️ CLI 只接受 `unix://` 与 `tcp://` 两种形状，`http://` 会被直接判非法：
 *   `Failed to initialize: unable to resolve docker endpoint:
 *    invalid bind address format: http://docker-socket-proxy:2375`
 *   2026-10-22 网页一键升级就是这么挂的 —— 我把给自己 fetch 用的 http:// 地址
 *   原样塞进了 helper 的 DOCKER_HOST。自己读 api 要 http://，CLI 要 tcp://，
 *   **同一个地址两种写法**，所以这里必须分开派生，不能共用 DOCKER_HOST。
 *
 * ⚠️ https:// 也映射到 tcp://，不带 TLS：socket-proxy 只监听明文 TCP（2375）。
 *    真要上 TLS 得给 CLI 配 --tlsverify 与证书目录，不在当前形态里。
 */
function dockerCliHost(): string {
    if (!DOCKER_HOST) return "";
    return DOCKER_HOST.replace(/^https?:\/\//i, "tcp://");
}

/** 「升级可用」的判据：走代理时不需要本机能看到 sock */
/**
 * spool 模式（2026-10-22）：把「执行重建」挪出本进程。
 *
 * 为什么：原先本进程直接调 Docker API、再起 helper 容器跑 `docker compose up`，
 * 代价是**必须把 /var/run/docker.sock 挂进应用容器** —— 而 sock 等于宿主机 root：
 * 容器一旦被攻破，攻击者能起特权容器、挂宿主目录、读全部数据。
 * 试过用 socket-proxy 收权限（4.5），实测不可行：compose 需要 create/stop/networks/volumes，
 * 而放开 `POST /containers/create` 的那一刻，加固就归零了。
 *
 * 所以变成：应用容器只往共享卷写一个请求文件，由独立的 upgrader 容器
 * （持 sock、不开端口、不跑业务代码、不渲染用户内容）执行 compose。
 * 应用容器从此**零 daemon 权限**。配了 NAVIHIVE_UPGRADE_SPOOL 就启用。
 */
const UPGRADE_SPOOL = (process.env.NAVIHIVE_UPGRADE_SPOOL || "").trim();

interface SpoolState {
    phase?: string;
    image?: string;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
}

function spoolEnabled(): boolean {
    return UPGRADE_SPOOL.length > 0;
}

/** 读升级器写的状态；读不到/坏掉一律当 idle（前端会退化成「看版本号变没变」） */
function readSpoolState(): SpoolState {
    if (!spoolEnabled()) return {};
    try {
        const parsed = JSON.parse(readFileSync(`${UPGRADE_SPOOL}/state.json`, "utf8")) as SpoolState;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * 提交升级请求。
 * ⚠️ 先写临时文件再 rename：升级器可能在同一瞬间读到半截 JSON，
 *    原子替换能保证它要么看到完整文件、要么看不到。
 */
function requestUpgradeViaSpool(by: string): void {
    const tmp = `${UPGRADE_SPOOL}/request.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), by }), "utf8");
    renameSync(tmp, `${UPGRADE_SPOOL}/request`);
}

function dockerAvailable(): boolean {
    // spool 模式：重建由升级器容器做，本进程不需要 daemon
    if (spoolEnabled()) return true;
    return DOCKER_HOST ? true : existsSync(DOCKER_SOCK);
}
const UPGRADE_CONTAINER = process.env.NAVIHIVE_CONTAINER_NAME || "navihive";
const UPGRADE_IMAGE = process.env.NAVIHIVE_IMAGE || "ghcr.io/zwjttztt/navihive:latest";

interface DockerCall {
    status: number;
    body: string;
}

/** 打一次 Docker Engine API。socketPath 走 unix socket，不需要 TCP 端口。 */
function dockerApi(
    method: string,
    apiPath: string,
    payload?: unknown,
): Promise<DockerCall> {
    return new Promise((resolve, reject) => {
        const body = payload === undefined ? undefined : JSON.stringify(payload);
        const req = httpRequest(
            {
                ...dockerEndpoint(),
                method,
                path: `/${DOCKER_API_VERSION}${apiPath}`,
                headers: {
                    ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
                    Host: "docker",
                },
            },
            res => {
                const chunks: Buffer[] = [];
                res.on("data", c => chunks.push(c as Buffer));
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
                );
            },
        );
        req.on("error", reject);
        // 拉镜像可能几分钟：别让 socket 级别的超时把它掐了
        req.setTimeout(0);
        if (body) req.write(body);
        req.end();
    });
}

/** 拉镜像。POST /images/create 回的是 NDJSON 进度流，要读到流结束才算拉完。 */
async function dockerPull(image: string): Promise<void> {
    const sep = image.lastIndexOf(":");
    const fromImage = sep > image.lastIndexOf("/") ? image.slice(0, sep) : image;
    const tag = sep > image.lastIndexOf("/") ? image.slice(sep + 1) : "latest";
    await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
            {
                ...dockerEndpoint(),
                method: "POST",
                path: `/${DOCKER_API_VERSION}/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
                headers: { Host: "docker" },
            },
            res => {
                if ((res.statusCode ?? 0) >= 300) {
                    res.resume();
                    res.on("end", () => reject(new Error(`拉取镜像失败 HTTP ${res.statusCode}`)));
                    return;
                }
                // 进度流：逐行读，只为把 socket 读完（内容只用于报错）
                let buf = "";
                res.on("data", c => {
                    buf += c.toString();
                    if (buf.length > 1 << 20) buf = buf.slice(-4096);
                });
                res.on("end", () => {
                    if (/"error"\s*:/.test(buf)) reject(new Error("拉取镜像时 daemon 报了错"));
                    else resolve();
                });
            },
        );
        req.on("error", reject);
        req.setTimeout(0);
        req.end();
    });
}

/**
 * 某个镜像引用（`repo:tag`）在当前 daemon 里的镜像 ID（`sha256:…`）。
 *
 * 用来回答一个很实际的问题：**这次拉取真的有新东西吗**。
 * 拉取失败 / 没有这个镜像时返回空串 —— 调用方按「不知道」处理，不拿它拦升级。
 * 路径里的 `/` 与 `:` 原样传：daemon 的 `/images/{name}/json` 认这种写法，
 * 编码成 %2F 反而会被当成镜像名的一部分。
 */
async function dockerImageId(image: string): Promise<string> {
    const res = await dockerApi("GET", `/images/${image}/json`).catch(() => null);
    if (!res || res.status >= 300) return "";
    try {
        const id = (JSON.parse(res.body) as { Id?: string }).Id;
        return typeof id === "string" ? id : "";
    } catch {
        return "";
    }
}

/** 一次性 helper 容器的名字（daemon 里一眼能认出是升级用的，别和主容器混） */
const UPGRADE_HELPER = `${UPGRADE_CONTAINER}-upgrader`;
/** 从建 helper 到它退出的最长等待。重建一个单容器服务只要几秒，2 分钟兜慢盘 */
const UPGRADE_HELPER_TIMEOUT_MS = 120_000;
/** 宿主机 docker CLI 与 compose 插件（`docker compose` 是插件，不是内建命令） */
const HOST_DOCKER_BIN = env("NAVIHIVE_HOST_DOCKER", "/usr/bin/docker");
const HOST_DOCKER_PLUGINS = env("NAVIHIVE_HOST_DOCKER_PLUGINS", "/usr/libexec/docker/cli-plugins");

/**
 * 升级过程的状态。**模块级**：POST 触发、GET 读取，两边必须看到同一份。
 * 进程被 compose 换掉后自然清零（成功后前端靠版本号判断，不靠它）。
 */
const upgradeStatus: {
    phase: "idle" | "pulling" | "recreating" | "failed";
    image: string;
    error: string;
    startedAt: number;
    finishedAt: number;
} = { phase: "idle", image: "", error: "", startedAt: 0, finishedAt: 0 };

/** compose 部署坐标：工程名 / 工作目录 / 配置文件（全部来自容器标签，无需额外配置） */
interface ComposeInfo {
    project: string;
    workingDir: string;
    files: string[];
    /**
     * 本容器所在的网络名。只有代理模式才用得上：helper 必须和 docker-socket-proxy
     * 在同一个网络里才能按名字解析到它（默认 bridge 网里没有 proxy 这个别名）。
     */
    network: string;
}

/**
 * 从容器标签里读出 compose 部署坐标。
 *
 * 为什么不要求用户配 `NAVIHIVE_COMPOSE_DIR`：compose 自己会在容器上打
 * `com.docker.compose.project{,.working_dir,.config_files}` 三个标签，直接读它
 * 比自己猜可靠得多。读不到（纯 `docker run` 起的）→ 返回 null，
 * 由调用方明确报错，不假装成功。
 *
 * ⚠️ `/compose` 是旧版（v4.3.0/v4.3.1）helper 的挂载点：那两版把目录挂在容器内的
 * `/compose`，compose 于是把 `/compose` 写进新容器的 working_dir 标签，宿主机上
 * 并没有这个目录。见到它就说明标签被污染了 —— 照它 bind 只会得到一个空目录，
 * 升级必然失败。此时宁可不升级，把话说明，让用户去宿主机 `docker compose up -d`
 * 把标签改回来（或在 compose 里设 `NAVIHIVE_COMPOSE_DIR`）。
 */
function readComposeInfo(labels: Record<string, string>): ComposeInfo | null {
    const fromEnv = process.env.NAVIHIVE_COMPOSE_DIR || "";
    const workingDir = (fromEnv || labels["com.docker.compose.project.working_dir"] || "").replace(/\/+$/, "");
    // 必须是绝对路径：空串（没标签）/ 相对路径都没法当 bind 源
    if (!workingDir.startsWith("/")) return null;
    if (!fromEnv && workingDir === "/compose") return null;
    return {
        project: labels["com.docker.compose.project"] || UPGRADE_CONTAINER,
        workingDir,
        files: (labels["com.docker.compose.project.config_files"] || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
        network: "",
    };
}

/**
 * helper 里跑 compose 用的路径。**必须和宿主机上的原路径一字不差**。
 *
 * ⚠️⚠️ 这是 v4.3.0/v4.3.1 线上「第一次升级成功、第二次必失败」的根因：
 * compose 会把自己运行时的工作目录写进新容器的
 * `com.docker.compose.project.working_dir` 标签，而那个标签是下一轮升级
 * 读坐标的**唯一**来源。早先把目录挂在 `/compose`（容器内路径），
 * 于是重建后标签变成 `/compose`；下一轮照着它 bind，源就变成宿主机上
 * 并不存在的 `/compose`，docker 还会顺手创建一个**空目录**挂进去 ——
 * compose 找不到配置文件，退出码 1，升级静默失败。
 * 挂在宿主原路径上，compose 记录的才是宿主的真实路径，下一轮才接得上。
 */
function upgraderCommand(info: ComposeInfo): string {
    const dir = info.workingDir;
    const base = `${dir}/`;
    // 只认落在工作目录里的配置文件
    const inside = info.files.filter(f => f.startsWith(base)).map(f => `${dir}/${f.slice(base.length)}`);
    const project = info.project;
    return [
        `CFG="${inside.map(f => `-f ${f}`).join(" ")}"`,
        'if [ -z "$CFG" ]; then',
        `  for f in ${dir}/docker-compose.yml ${dir}/docker-compose.yaml ${dir}/compose.yml ${dir}/compose.yaml; do`,
        `    if [ -f "$f" ]; then CFG="-f $f"; break; fi`,
        "  done",
        "fi",
        `if [ -z "$CFG" ]; then echo "[upgrader] 在 ${dir} 里找不到 compose 配置文件（挂载目录不对？）"; exit 21; fi`,
        'if [ ! -x /usr/bin/docker ]; then echo "[upgrader] 宿主机 docker CLI 不可用：/usr/bin/docker 没挂进来"; exit 22; fi',
        `cd "${dir}"`,
        // 往宿主机的 compose 目录记一笔：重建会把容器自身的日志一起换掉，
        // 出问题时这份文件是最后一份现场
        `LOG="${dir}/.navihive-upgrade.log"`,
        `echo "[upgrader] $(date -u +%FT%TZ) 开始 $CFG -p ${project}" >> "$LOG"`,
        `echo "[upgrader] docker compose $CFG -p ${project} up -d --force-recreate"`,
        // 不用管道：$? 必须来自 docker compose 本身
        `OUT=$(docker compose $CFG -p ${project} up -d --force-recreate 2>&1) ; CODE=$?`,
        'printf "%s\\n" "$OUT"',
        'printf "%s\\n" "$OUT" >> "$LOG"',
        'if [ "$CODE" -ne 0 ]; then',
        `  echo "[upgrader] $(date -u +%FT%TZ) 失败（退出码 $CODE）" >> "$LOG"`,
        '  echo "[upgrader] 重建失败：docker compose 返回非 0 退出码"',
        "  exit 1",
        "fi",
        `echo "[upgrader] $(date -u +%FT%TZ) 成功" >> "$LOG"`,
        'echo "[upgrader] 完成：容器已按新镜像重建"',
    ].join("\n");
}

/** 等 helper 退出。返回退出码；超时（多半是本进程已被换掉）返回 null */
function waitForHelperExit(id: string): Promise<number | null> {
    return new Promise(resolve => {
        let settled = false;
        const done = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(code);
        };
        const timer = setTimeout(() => done(null), UPGRADE_HELPER_TIMEOUT_MS);
        timer.unref?.();
        dockerApi("POST", `/containers/${id}/wait?condition=not-running`).then(
            res => {
                if (res.status >= 300) return done(-1);
                const code = (JSON.parse(res.body) as { StatusCode?: number }).StatusCode;
                done(typeof code === "number" ? code : -1);
            },
            () => done(-1),
        );
    });
}

/** 读 helper 的日志尾巴（失败时把真实原因带给用户，而不是一句「升级失败」） */
async function readHelperLogs(id: string): Promise<string> {
    try {
        const res = await dockerApi("GET", `/containers/${id}/logs?stdout=1&stderr=1&tail=200`);
        if (res.status >= 300) return "";
        // helper 带 Tty 创建：日志是纯文本（非 TTY 才是 8 字节头复用的多路流）
        // 兜掉可能混进来的 NUL（eslint 的 no-control-regex 也不让写正则）
        // ⚠️ 别在这里狠命截断：compose 的报错是排查的唯一线索，截太短等于没留。
        // 上限 4000 字符（前端 Alert 撑得住），且**保留开头**——头几行往往就是原因。
        return res.body.split("\u0000").join("").trim().slice(0, 4000);
    } catch {
        return "";
    }
}

/**
 * 起一个一次性 helper 容器，让它在**容器外面**执行 `docker compose up -d --force-recreate`。
 *
 * 为什么必须是容器外：执行升级的进程就在被升级的这个容器里，任何「自己停/删自己」
 * 的动作都会把它当场杀死（见 dockerUpgradeSelf 的注释）。daemon 侧的 helper 不受影响。
 * 借用的只是新镜像的 `/bin/sh` + 宿主机挂进来的 docker CLI，
 * 所以镜像是 node:slim 也没关系（以前正是「容器里没有 docker 二进制」才走了纯 API）。
 */
async function runUpgraderContainer(image: string, info: ComposeInfo): Promise<void> {
    const name = UPGRADE_HELPER;
    // 上一轮失败留下的 helper：先清掉，否则 create 会 409
    await dockerApi("DELETE", `/containers/${name}?force=true`).catch(() => undefined);
    const created = await dockerApi("POST", `/containers/create?name=${name}`, {
        Image: image,
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: [upgraderCommand(info)],
        WorkingDir: info.workingDir,
        // 和主容器同样的身份：sock 属 root:docker，非 root 连不上
        User: "0:0",
        Tty: true,
        Labels: { "com.navihive.upgrader": "1" },
        // 代理模式：helper 里的 docker CLI 也要走同一个代理，否则它回头去找
        // /var/run/docker.sock（代理模式下根本没挂进去）而连不上 daemon。
        ...(DOCKER_HOST ? { Env: [`DOCKER_HOST=${dockerCliHost()}`] } : {}),
        // 同理，只有代理模式才需要显式加入 proxy 所在的网络（默认 bridge 里没有它）
        ...(DOCKER_HOST && info.network
            ? { NetworkingConfig: { EndpointsConfig: { [info.network]: {} } } }
            : {}),
        HostConfig: {
            AutoRemove: false,
            Binds: [
                // 代理模式下**不挂 sock**：代理的意义就是别把 daemon 的完整控制权交出去
                ...(DOCKER_HOST ? [] : [`${DOCKER_SOCK}:${DOCKER_SOCK}`]),
                // ⚠️ 源和目标写成**同一个宿主路径**：见 upgraderCommand 上方的长注释。
                // 挂在 /compose 会让 compose 把 /compose 写进新容器的 working_dir 标签，
                // 下一轮升级就再也找不到真正的 compose 目录（线上实测：第二次必失败）。
                `${info.workingDir}:${info.workingDir}`,
                `${HOST_DOCKER_BIN}:/usr/bin/docker:ro`,
                `${HOST_DOCKER_PLUGINS}:/usr/libexec/docker/cli-plugins:ro`,
            ],
        },
    });
    if (created.status >= 300) {
        throw new Error(`创建升级容器失败 HTTP ${created.status} ${created.body.slice(0, 200)}`);
    }
    const id = (JSON.parse(created.body) as { Id?: string }).Id || name;
    const started = await dockerApi("POST", `/containers/${id}/start`);
    if (started.status >= 300 && started.status !== 304) {
        throw new Error(`启动升级容器失败 HTTP ${started.status} ${started.body.slice(0, 200)}`);
    }

    const code = await waitForHelperExit(id);
    if (code === null) {
        // 收不到结果：本进程已经在 compose 重建时被换掉了 —— 这正是成功的样子
        return;
    }
    const logs = await readHelperLogs(id);
    await dockerApi("DELETE", `/containers/${id}?force=true`).catch(() => undefined);
    if (code !== 0) {
        throw new Error(`重建容器失败（退出码 ${code}）：${logs || "helper 没有输出"}`);
    }
}

/**
 * 把**这个容器**升级到新镜像：拉镜像 → 交给 compose 用新镜像重建本容器。
 *
 * ⚠️⚠️ 两段都踩过线上坑，别再退回任何一段：
 *
 * ① 「容器内自己 stop → rm → create → start」：执行升级的 Node 进程就在被升级的
 *    容器里。`POST /containers/{name}/stop` 一发出去容器收到 SIGTERM、本进程立刻死，
 *    后面的 DELETE / CREATE / START **一行都不会执行**。线上症状：
 *    点「更新」后长时间无反应、刷新变 502，容器停在 `Exited (0)`。
 *
 * ② 「restart」（2026-10-19 为了绕开①改用）：restart 是 stop + start，由 daemon
 *    完成、不依赖容器内进程活着，看起来完美 —— 但它**按容器创建时记录的 ImageID
 *    启动**，不重新解析 `:latest` 标签。于是 `docker pull` 明明拉到了新镜像、
 *    容器也确实重启了，跑的还是旧代码。线上症状（2026-10-20 用户报）：
 *    「点击更新长时间无反应，刷新后还是原来版本」。
 *
 * 结论：换镜像必须由**容器外面的进程**做 → helper 容器执行 `docker compose up -d
 * --force-recreate`（顺便把 compose 里新增的配置项也带上，restart 做不到这点）。
 *
 * 顺序上先把所有可能失败的都做完（读规格、拉镜像），最后才动容器：
 * 拉取失败、读不到 compose 坐标，都绝不去碰容器，旧容器继续服务。
 */
async function dockerUpgradeSelf(image: string): Promise<void> {
    const name = UPGRADE_CONTAINER;
    const { status, body } = await dockerApi("GET", `/containers/${name}/json`);
    if (status >= 300) throw new Error(`读不到容器 ${name}（HTTP ${status}）`);
    const info = JSON.parse(body) as {
        Config?: { Labels?: Record<string, string> };
        NetworkSettings?: { Networks?: Record<string, unknown> };
        /** 容器当前在跑的镜像 ID（sha256:…）—— 升级成功与否的**唯一硬判据** */
        Image?: string;
    };
    const runningImageId = info.Image || "";
    const labels = info.Config?.Labels ?? {};
    const compose = readComposeInfo(labels);
    if (!compose) {
        // 两种读不到坐标的情况给不同的处方：被旧版污染 vs 根本不是 compose 起的
        const polluted = labels["com.docker.compose.project.working_dir"] === "/compose";
        throw new Error(
            polluted
                ? "compose 目录标签被旧版写成 /compose（v4.3.0/v4.3.1 的已知问题）：" +
                      "请到宿主机进入 compose 目录执行 docker compose up -d --force-recreate 修正标签，" +
                      "或在 compose 的 environment 里加 NAVIHIVE_COMPOSE_DIR 指向真实目录。"
                : "读不到 compose 部署信息（容器标签里没有 com.docker.compose.*）：本容器不是 docker compose 启动的。" +
                      "网页一键升级只支持 compose 部署，请到宿主机执行 docker compose up -d --force-recreate。"
        );
    }
    // 网络名从本容器身上读：helper 要跟它在同一个网里才解析得到代理。
    // 有多个网时取第一个 —— 代理模式的标准形态是单网。
    compose.network = Object.keys(info.NetworkSettings?.Networks ?? {})[0] ?? "";
    if (DOCKER_HOST && !compose.network) {
        throw new Error(
            "配了 NAVIHIVE_DOCKER_HOST 但读不到本容器的网络名：helper 会进默认 bridge，" +
                "解析不到代理地址。请确认本容器在 compose 网络里（docker inspect 看 NetworkSettings.Networks）。"
        );
    }
    upgradeStatus.phase = "pulling";
    await dockerPull(image);

    // ⚠️⚠️ 拉完先比一次镜像 ID（2026-10-21 用户报「点更新又长时间没反应」，线上排查
    // 发现：点了之后容器确实重建过，但**跑的还是旧镜像**，页面等满两分钟才报「没检测到
    // 新版本」）。根因是「有新版本」这个判断来自仓库里的 package.json，而镜像要在
    // GHCR 上构建好几分钟 —— 于是存在一个窗口：
    //   仓库里已经是 5.1.0（前端说「发现新版本」）→ registry 上 :latest 还是上一版 →
    //   pull 拉到的还是旧的 → compose 重建了个一模一样的容器。
    // 白等两分钟还是小事，站点白白抖一次才是。
    // 这种情况**绝不能动容器**：直接如实说「镜像还没更新，容器没动，过几分钟再点」。
    const pulledImageId = await dockerImageId(image);
    if (pulledImageId && runningImageId && pulledImageId === runningImageId) {
        upgradeStatus.phase = "idle";
        throw new Error(
            `镜像没有更新：registry 上的 ${image} 仍是当前运行的这一版。` +
                "「发现新版本」比的是仓库里的 package.json，而镜像要在 GitHub 上构建（本仓库是 " +
                "multi-arch，要模拟 arm64，**通常 10 分钟以上**）—— 版本号先到、镜像后到，这个空档里" +
                "点「更新」只会拉回旧镜像。容器没有重建、站点没受影响；等镜像构建完成（GitHub → " +
                "Actions → docker-publish 变绿）后再点一次。"
        );
    }

    upgradeStatus.phase = "recreating";
    await runUpgraderContainer(image, compose);

    // ⚠️ helper「退出码 0」不等于升级成功：compose 可能认为无须重建直接退 0，
    // `wait` 也可能拿不到结果被当成成功（见 runUpgraderContainer 的 null 分支）。
    // 真正的判据只有一个 —— **容器现在跑的镜像变了没有**。没变就如实报失败，
    // 别让前端去等一个永远不会变的版本号。
    if (runningImageId) {
        const after = await dockerApi("GET", `/containers/${name}/json`).catch(() => null);
        if (after && after.status < 300) {
            const afterImageId = (JSON.parse(after.body) as { Image?: string }).Image || "";
            if (afterImageId && afterImageId === runningImageId) {
                throw new Error(
                    "容器重建后仍在跑旧镜像（compose 没有换成新镜像）。站点仍在服务，" +
                        "请到宿主机 compose 目录执行 docker compose pull && docker compose up -d --force-recreate。"
                );
            }
        }
    }
}

/**
 * 升级后的兜底：确认容器真的在跑，不在就拉起来。
 *
 * 正常路径用不上（helper 失败时 compose 一般还没动到旧容器，我们还活着）；
 * 但「旧容器被停掉、新容器没起来」的那种半途状态只能靠它救 —— 而且只有在
 * 本进程侥幸没被杀（比如 compose 在 stop 之前就报错退出）时才轮得到它。
 * 站点停摆比升级失败严重得多，多这一跳不亏。
 */
async function dockerEnsureRunning(): Promise<void> {
    const name = UPGRADE_CONTAINER;
    const { status, body } = await dockerApi("GET", `/containers/${name}/json`);
    if (status >= 300) throw new Error(`读不到容器 ${name}（HTTP ${status}）`);
    const state = (JSON.parse(body) as { State?: { Running?: boolean } }).State ?? {};
    if (state.Running) return;
    const started = await dockerApi("POST", `/containers/${name}/start`);
    if (started.status >= 300 && started.status !== 304) {
        throw new Error(`启动容器失败 HTTP ${started.status} ${started.body.slice(0, 200)}`);
    }
}

/**
 * 启动时清掉上一轮升级留下的 helper 容器。
 *
 * 成功升级会把本进程连同容器一起换掉，helper 没机会自己收尾 —— 它会留下一个
 * 已退出的 `navihive-upgrader`。下次启动顺手删掉，daemon 里不留垃圾
 * （升级失败时另一条路径已经在 runUpgraderContainer 里删过了）。
 * 只管带 `com.navihive.upgrader=1` 标签、且**不在运行**的容器：
 * 删正在跑的那个会把升级现场弄丢，而删别人的容器是绝对不行的。
 */
async function cleanupUpgraderContainer(): Promise<void> {
    if (!dockerAvailable()) return;
    try {
        const filters = encodeURIComponent(JSON.stringify({ label: ["com.navihive.upgrader=1"] }));
        const { status, body } = await dockerApi("GET", `/containers/json?all=1&filters=${filters}`);
        if (status >= 300) return;
        const list = JSON.parse(body) as { Id: string; State?: string }[];
        for (const item of list) {
            if (item.State === "running") continue;
            await dockerApi("DELETE", `/containers/${item.Id}?force=true`).catch(() => undefined);
            console.log(`[upgrade] 已清理上一轮升级的 helper 容器 ${item.Id.slice(0, 12)}`);
        }
    } catch (error) {
        // 清理是顺手的家务，失败绝不阻断启动
        console.warn("[upgrade] 清理 helper 容器失败（不影响运行）:", error);
    }
}


/**
 * 访问日志里的客户端地址，与 worker 侧同口径：
 * 信任反代（NAVIHIVE_TRUST_XFF=1）时取 XFF 首段，否则只认 socket 对端
 * （XFF 是客户端能随便写的，直接暴露到公网时拿它当来源等于自欺）。
 */
function accessIp(req: IncomingMessage): string {
    const forwarded = TRUST_XFF === "1" ? firstHeaderValue(req.headers["x-forwarded-for"]) : undefined;
    return normalizeRemoteAddress(forwarded || req.socket?.remoteAddress || "");
}

const server = createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? "GET";
    // rid 在入口生成：这一条请求在「浏览器 → Nginx → Node → Worker」全程共用它。
    // Cloudflare 那条链没有本进程可以注头，由 worker/index.ts 在没有这个头时自生成。
    const rid = randomUUID().slice(0, REQUEST_ID_LEN);
    // 解析失败（畸形请求行）就当根路径：访问日志不该在入口把自己炸掉。
    let pathname = "/";
    try {
        pathname = new URL(req.url ?? "/", "http://placeholder").pathname;
    } catch {
        /* 保持 "/" */
    }
    const isApi = pathname === "/api" || pathname.startsWith("/api/");

    // 响应头也回写 rid：浏览器端 errorReporter 从响应头读它，才能把「用户看到的这句
    // 报错」和这份日志 / 审计里的同一行对上。⚠️ 必须在 writeHead 之前设 ——
    // writeHead 会把 setHeader 设过的头合并进去（同名时 writeHead 的参数优先，
    // 而 worker 回的就是同一个值，不打架）。
    // 只给 API 加：静态资源没人读这个头，而反代可能缓存静态响应 ——
    // 那会把「第一次请求的 rid」缓存下来发给所有人，反而是个错误线索。
    if (isApi) res.setHeader(REQUEST_ID_HEADER, rid);

    // 访问日志挪到**响应结束**才打：原来是在 proxyToWorker 之前打，只能证明
    // 「请求进来了」，既没有状态码也没有耗时 —— 99% 的请求就这一行，等于没记。
    res.on("finish", () => {
        const ms = Date.now() - started;
        const slow = ms > 1000;
        if (!isApi) {
            // 静态资源不逐条记（一跳一条太吵、对排障没用），但慢的要留一条 ——
            // 那正是要看的一类（首屏慢往往卡在某个 chunk 上）。
            if (slow) console.warn(`慢请求 ${method} ${pathname} ${res.statusCode} ${ms}ms`);
            return;
        }
        // 一行 JSON = 一条请求：grep / jq / 采样都方便。
        // ⚠️ p 只记 pathname，**不记 fullUrl**：query 里可能带分享口令 / token，
        // 日志是明文落盘的（比客户端上报更危险）。ua 截 60 字符同理 ——
        // compose 的 json-file 只留 30MB×3，每行都比原来长，增量得控住。
        // ⚠️ 慢请求不再单独 warn，改成这一行里带 slow:true：否则同一请求两行日志，
        // 而且 warn 那行没有 rid，反而查不到是哪个请求。
        console.log(
            JSON.stringify({
                t: new Date().toISOString(),
                rid,
                m: method,
                p: pathname,
                s: res.statusCode,
                ms,
                ip: accessIp(req),
                ua: String(req.headers["user-agent"] || "").slice(0, 60),
                ...(slow ? { slow: true } : {}),
            })
        );
    });

    void (async () => {
        try {
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

            // POST /api/system/upgrade：网页端直接升级（2026-10-18 用户要
            // 「加个升级按键直接在网页升级版本」；2026-10-19 再报「改成点击后
            // 直接在网页端升级，不要再复制代码去后台升级」—— 上一版虽已写成
            // 网页触发，但部署侧没挂 docker.sock、又要求 NAVIHIVE_UPGRADE_DIR，
            // 于是端点一律 501，用户看到的仍是「复制命令去后台」）。
            // GET 同一路径 = 查升级进度（2026-10-20 用户报「点击更新长时间无反应」，
            // 前端要能问到「到底走到哪一步、失败在哪」，而不是只转圈）。
            //
            // 实现走 **Docker Engine API（unix socket）**：拉镜像、读规格都由 Node
            // 直接打 sock 完成；只有「换掉镜像重建容器」这一步交给一次性 helper 容器
            // 在容器外执行 compose —— 原因见 dockerUpgradeSelf 的注释
            // （restart 不重新解析 :latest 标签，就是「升级完版本号不变」的根因）。
            //
            // 两道闸：① owner only（复用 worker 的 auth/me）；② docker.sock 可访问。
            // ⚠️ 执行顺序：**先响应再升级** —— 动的是这个容器自己，命令跑起来后
            // 本进程随时会被杀，响应发不出去用户就什么都看不到。1.5s 后再动手。
            if (pathname === "/api/system/upgrade" && method === "POST") {
                const meRes = await handler.fetch(
                    new Request("http://internal/api/auth/me", { method: "GET", headers: toHeaders(req) }),
                    serverEnv
                );
                const me = meRes.ok ? ((await meRes.json()) as { role?: string }) : null;
                if (!me || me.role !== "owner") {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: "只有站点所有者可以执行升级" }));
                    return;
                }
                if (spoolEnabled()) {
                    // 交给升级器：本进程只写请求文件，绝不碰 daemon
                    try {
                        requestUpgradeViaSpool("owner");
                        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(
                            JSON.stringify({
                                ok: true,
                                message:
                                    "升级已提交：由宿主机上的升级器执行重建，约 10–60 秒后页面会自动恢复。",
                            })
                        );
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error("[upgrade] 提交 spool 请求失败:", message);
                        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ ok: false, error: `提交升级请求失败：${message}` }));
                    }
                    return;
                }
                if (!dockerAvailable()) {
                    res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(
                        JSON.stringify({
                            ok: false,
                            reason: "unsupported",
                            error:
                                "当前部署不支持网页直接升级：需要以 Docker 自托管，并把 /var/run/docker.sock " +
                                "挂进容器（见 docker-compose.yml 的 volumes）。可手动执行升级命令。",
                        })
                    );
                    return;
                }
                const image = UPGRADE_IMAGE;
                upgradeStatus.phase = "pulling";
                upgradeStatus.image = image;
                upgradeStatus.error = "";
                upgradeStatus.startedAt = Date.now();
                upgradeStatus.finishedAt = 0;
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                    JSON.stringify({
                        ok: true,
                        message: "升级已启动：正在拉取镜像并重建容器，约 10-30 秒后页面会自动恢复。",
                    })
                );
                setTimeout(() => {
                    void (async () => {
                        try {
                            // 拉取 + 读规格都在动容器之前：拉不动就绝不去碰容器，
                            // 旧代码继续服务。
                            await dockerUpgradeSelf(image);
                            // 能走到这里说明 helper 正常退出且没换掉我们（罕见：
                            // 说明 compose 认为无须重建）。确认在跑再报告成功。
                            await dockerEnsureRunning();
                            upgradeStatus.phase = "idle";
                            upgradeStatus.finishedAt = Date.now();
                            console.log(`[upgrade] 完成：容器已按 ${image} 重建`);
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            upgradeStatus.phase = "failed";
                            upgradeStatus.error = message;
                            upgradeStatus.finishedAt = Date.now();
                            console.error("[upgrade] 失败:", message);
                            // 失败时容器可能停着：确认它活着，不在就拉起来。
                            // 站点停摆是比升级失败严重得多的事故。
                            try {
                                await dockerEnsureRunning();
                                console.log("[upgrade] 已确保容器在跑（仍是原版本）");
                            } catch (restoreError) {
                                console.error("[upgrade] 容器仍未起来，请立即上宿主机执行 docker compose up -d --force-recreate:", restoreError);
                            }
                        }
                    })();
                }, 1500);
                return;
            }

            // GET /api/system/upgrade：升级进度（owner only）。
            // 前端在点完「更新」后轮询它：能读到 failed + 具体原因就不再干等。
            // 成功路径读不到（进程已被换掉，phase 回到 idle）—— 那时靠版本号判断。
            if (pathname === "/api/system/upgrade" && method === "GET") {
                const meRes = await handler.fetch(
                    new Request("http://internal/api/auth/me", { method: "GET", headers: toHeaders(req) }),
                    serverEnv
                );
                const me = meRes.ok ? ((await meRes.json()) as { role?: string }) : null;
                if (!me || me.role !== "owner") {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: "只有站点所有者可以查看升级状态" }));
                    return;
                }
                if (spoolEnabled()) {
                    // 状态由升级器写；形状与旧路径完全一致，前端不用改
                    const state = readSpoolState();
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(
                        JSON.stringify({
                            ok: true,
                            supported: true,
                            phase: typeof state.phase === "string" ? state.phase : "idle",
                            image: typeof state.image === "string" ? state.image : "",
                            error: typeof state.error === "string" ? state.error : "",
                            startedAt: typeof state.startedAt === "number" ? state.startedAt : 0,
                            finishedAt: typeof state.finishedAt === "number" ? state.finishedAt : 0,
                        })
                    );
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                    JSON.stringify({
                        ok: true,
                        supported: dockerAvailable(),
                        phase: upgradeStatus.phase,
                        image: upgradeStatus.image,
                        error: upgradeStatus.error,
                        startedAt: upgradeStatus.startedAt,
                        finishedAt: upgradeStatus.finishedAt,
                    })
                );
                return;
            }

            // GET /api/system/slow-queries：慢查询清单（owner only，2026-10-22 C5）。
            // 日志里只有「哪个接口慢」，这里补上「哪条 SQL 慢、慢多少次、最近一次什么时候」。
            // ⚠️ 只有 owner 能看：SQL 摘要里带着表名与查询形态，属于内部结构。
            // ⚠️ 只回摘要（字面量与绑定值都不落盘），所以没有数据泄露面。
            if (pathname === "/api/system/slow-queries" && method === "GET") {
                const meRes = await handler.fetch(
                    new Request("http://internal/api/auth/me", { method: "GET", headers: toHeaders(req) }),
                    serverEnv
                );
                const me = meRes.ok ? ((await meRes.json()) as { role?: string }) : null;
                if (!me || me.role !== "owner") {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: "只有站点所有者可以查看慢查询" }));
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                    JSON.stringify({
                        ok: true,
                        thresholdMs: slowQueryThresholdMs(),
                        enabled: slowQueryEnabled(),
                        recent: slowQuerySnapshot(50),
                        summary: slowQuerySummary(10),
                    })
                );
                return;
            }

            // GET/HEAD 且不是 /api/ → 静态资源（含 SPA fallback）。
            // 其余（/api/、非 GET/HEAD）一律进 worker，与 CF 上 assets 绑定之后的行为一致。
            if (!isApi && (method === "GET" || method === "HEAD")) {
                if (await serveStatic(STATIC_DIR, headerRules, pathname, method, res)) return;
            }

            // 访问日志在 res.on("finish") 里打（见 createServer 开头）：这里只负责转发，
            // 并把同一个 rid 带进 worker
            await proxyToWorker(req, res, rid);
        } catch (error) {
            // ⚠️ 原来这里只有 console.error("请求处理异常:", error)：pathname / method
            // 声明在 try 里面，catch 拿不到，日志里只剩一个裸异常 —— 不知道是哪个请求。
            // 现在把 rid / method / pathname 一起带上，和访问日志、worker 侧那条 500 对得上。
            console.error("[server]", rid, method, pathname, error);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error");
            } else {
                res.destroy();
            }
        }
    })();
});

/**
 * 启动前的鉴权配置自检（2026-10-20）：`AUTH_ENABLED=true` 却没配 `AUTH_SECRET`
 * **直接退出**，不再只是打一行告警。
 *
 * 为什么从「告警」升级成「拒绝启动」：没配这个变量时令牌签发/校验会 fail-closed，
 * 服务看起来是起来了（端口在听、静态页能开），但**登录永远失败** —— 现象离原因极远，
 * 排查的人会先去查密码、查库、查反代，而不是看一眼启动日志里那行被刷走的告警。
 * 更糟的是「静态页能开」会让人以为部署成功，等到要登录才发现整站不可用。
 *
 * 宁可起不来，也不给一个「起来了但登不进去」的服务 —— 这正是 compose 里
 * `${AUTH_SECRET:?…}` 那条语法的同一个判断，只是把它搬到了不用 compose 的形态
 * （`npm run start:selfhost` / systemd）上，两条路径行为一致。
 *
 * 不设环境变量豁免开关：真要免鉴权就把 `AUTH_ENABLED=false`，那是唯一且明确的入口。
 */
function assertAuthConfigOrExit(): void {
    if (serverEnv.AUTH_ENABLED !== "true") return;
    const secret = process.env.AUTH_SECRET ?? "";
    if (!secret) {
        console.error(
            [
                "",
                "✖ 启动中止：AUTH_ENABLED=true 但没有 AUTH_SECRET。",
                "  没配它时令牌签发/校验会 fail-closed —— 服务能起、页面能开，但登录必然失败，",
                "  而现象离原因极远（会先去查密码/查库/查反代）。所以这里直接退出。",
                "",
                "  生成一个并配上去即可：",
                "    AUTH_SECRET=$(openssl rand -hex 32) npm run start:selfhost",
                "  systemd 用 EnvironmentFile=，Docker 用 .env（compose 里已经是 :? 必填）。",
                "  确实要免鉴权调试就把 AUTH_ENABLED=false —— 那是唯一明确的入口。",
                "",
            ].join("\n")
        );
        process.exit(1);
    }
    // 长度只警告、不拦：HS256 的密钥短了不是「立刻不可用」，而是抗爆破能力弱。
    // 但同样是「配了却配错」的类型，值不当场挡人，值得当场说一句。
    if (secret.length < 16) {
        console.warn(
            `⚠️ AUTH_SECRET 只有 ${secret.length} 个字符：建议至少 16 位随机串（openssl rand -hex 32 给 64 位）。`
        );
    }
}

assertAuthConfigOrExit();

server.listen(PORT, HOST, () => {
    console.log("NaviHive 自托管服务已启动");
    // 顺手清掉上一轮升级留下的 helper（异步、失败静默，不拖启动）
    void cleanupUpgraderContainer();
    console.log(`  监听       http://${HOST}:${PORT}`);
    console.log(`  数据库     ${path.resolve(DB_FILE)}`);
    console.log(`  附件目录   ${path.resolve(FILES_DIR)}`);
    console.log(`  静态目录   ${STATIC_DIR}`);
    console.log(`  定时任务   ${CRON_IN_PROCESS ? "进程内每小时（NAVIHIVE_CRON=0 关闭，改用 POST /__cron）" : "关闭（用 POST /__cron 外部触发）"}`);
    console.log(`  XFF 信任   ${TRUST_XFF === "1" ? "开（取 X-Forwarded-For 作为真实 IP）" : "关（限速共用一个 unknown 桶）"}`);
    // 「配置本身能跑但跑错了」的两类情况，不报错、不阻断启动，只在这里说一句：
    // 它们的共同点是**现象离原因很远**（定时任务悄悄不跑 / 一个人输错密码全站被锁），
    // 等发现时往往已经过了很久。
    if (!CRON_IN_PROCESS && !CRON_TOKEN) {
        console.warn("⚠️ NAVIHIVE_CRON=0 且没配 NAVIHIVE_CRON_TOKEN：定时任务既不在进程内跑、也没有外部触发口，等于全关。二选一：去掉 NAVIHIVE_CRON=0，或配 token 后用 crontab/systemd timer 打 POST /__cron。");
    }
    if (isPublicHost(HOST) && TRUST_XFF === "1") {
        console.warn(`⚠️ 监听地址是 ${HOST}（非回环），而 XFF 信任是开的：客户端随手加一个 X-Forwarded-For 就能换一个限速桶，把登录爆破限速绕过去。前面确实挡了可信反代就忽略本条；直接暴露到公网请设 NAVIHIVE_TRUST_XFF=0。`);
    }
    // AUTH_SECRET 缺失已在启动前 assertAuthConfigOrExit() 挡掉（直接退出），这里不再重复
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
