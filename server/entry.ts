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
import { readdirSync, statSync } from "node:fs";
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
import { recordUpgradeAudit, type UpgradeOutcome } from "./upgradeAudit";
import { UPGRADE_IMAGE, dockerAvailable } from "./upgrade/dockerApi";
import { readSpoolState, reportRollbackOnce, requestUpgradeViaSpool, spoolEnabled } from "./upgrade/spool";
import { cleanupUpgraderContainer, dockerEnsureRunning, dockerUpgradeSelf, upgradeStatus } from "./upgrade/selfUpgrade";
import { classifyHelperExitCode, rollbackTerminalEvent } from "./upgradeHealth";
import { NavigationAPI } from "../src/API/navigationApi";
import { isPublicHost, normalizeRemoteAddress } from "./net";
import { setEgressResolver, setFetchImpl } from "../worker/safeFetch";
import { installEgressDispatcher } from "./egressDispatch";
import { isBlockedHost } from "../worker/util";
import { REAL_IP_HEADER } from "../worker/httpUtils";
import { REQUEST_ID_HEADER, REQUEST_ID_LEN } from "../shared/requestId";
import { logger, setRidProvider } from "../shared/logger";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../worker/types";
// 透传白名单的唯一真源在 shared/env.ts（worker 侧也要能读到同一份约束）。
// 这份清单由那边的**编译期断言**守着：`Env` 里新增一个非绑定键却忘了加进去，
// `tsc -b` 会直接红 —— 不然就是「自托管设了变量、代码读不到、日志一行不报」
// 的那种静默失效（ALLOW_PLAINTEXT_SECRETS 就是这么漏掉的）。
import { PASSTHROUGH_KEYS } from "../shared/env";

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
 * 默认**关**（"0"）：裸跑 / 端口直接暴露公网时，客户端随手改 XFF 就能换一个限速桶，
 * 把登录爆破限速绕过去（worker/loginGuard.ts 的 clientBucket 注释有完整说明）。
 * 前面确实挡了一层 Nginx（由它老实覆盖这两个头）时才设 "1" —— docker-compose.yml
 * 的默认值也是 0，部署前请按 deploy/selfhost.md 确认（P2-19）。
 */
const TRUST_XFF = env("NAVIHIVE_TRUST_XFF", "0");
/** P1-2 强告警的去重标志：每进程只警告一次「有 XFF 但没开 TRUST_XFF」 */
let xffMismatchWarned = false;
/**
 * 是否信任反代**覆盖写入**的 `X-Real-IP`。
 * 默认**关**（"0"），与 TRUST_XFF 独立：TRUST_XFF=1 只说明这层反代老实写 XFF，
 * 不代表它写了 X-Real-IP（Caddy / Traefik 默认不写）。那种部署里客户端自带的
 * `X-Real-IP` 会原样透传，每请求换一个就是一个全新限速桶 —— 登录 / 注册 / 找回 /
 * 分享口令 / 写操作五类限速同时失效，且每次尝试仍要跑一遍 PBKDF2。
 * 用本仓 deploy/nginx 模板（覆盖写 X-Real-IP $remote_addr）时把它和 TRUST_XFF 都设 1。
 */
const TRUST_X_REAL_IP = env("NAVIHIVE_TRUST_X_REAL_IP", "0");

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
// ⚠️ 上面这道复核**本身**仍是缓解（lookup 与 fetch 内部再解析之间有窗口）——
//    下面紧接着的 installEgressDispatcher 才是闭环。
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

// ============ 出站连接绑定校验后的 IP（R06，DNS rebinding 闭环） ============
//
// 上面那道复核有个天生的窗口：safeFetch 校验时解析一次，`fetch()` 发请求时**又解析
// 一次**。两次之间把域名的 A 记录换成 127.0.0.1 就是经典的 DNS rebinding，
// 校验全绿、连接却落在内网。
//
// 这里装上「连接也用这份解析结果」的通道：undici Agent 的 `connect.lookup` 是
// net.connect 唯一会用的解析入口，我们在这个函数里先拿全部 A/AAAA、逐个过
// isBlockedHost，**全是公网**才把地址交回去连接；任何一个命中内网就整次拒绝。
// SNI / Host 头仍是原域名，所以对上游服务端无感（实测 `Host: example.invalid:9988`）。
//
// 细节在 server/egressDispatch.ts。这里只关心降级：
//   · undici 是运行期唯一的非打包依赖（Dockerfile 运行阶段单独 COPY 它）；
//   · 拿不到 undici（npm 直跑缺依赖 / 裁剪过的镜像）→ 不阻断启动，
//     退回「出站前复核」的缓解模式，并把风险明说在启动日志里。
await (async () => {
    const egress = await installEgressDispatcher({
        setFetchImpl,
        // info 不接：成功那行由下面的启动横幅统一打，避免同一件事两行日志
        logger: { warn: (message: string) => console.warn(message) },
    });
    if (egress.installed) {
        console.log("出站连接已绑定校验后的 IP（undici dispatcher）");
        return;
    }
    console.warn(
        "⚠️ 出站连接未绑定校验后的 IP：退回「出站前复核」的缓解模式 —— " +
            "DNS rebinding 在「复核」与「连接」之间仍有窗口。" +
            "装回 undici 即可恢复闭环（见 Dockerfile 运行阶段那行 COPY）。"
    );
})();

// 环境变量白名单透传。只放 worker/src 真正会读的键，避免把 PATH 之类无关变量
// 泄进 env 对象（worker 侧只认这些名字，多给了也不会用，但白名单更好查）。
// ⚠️ 清单本身在 shared/env.ts：那边有编译期断言钉住「Env 里的配置键一个不漏」，
// 这里只负责逐条照搬（见文件顶部的 import 注释）。
// worker/types.ts 的 Env 现在已带上 DATA_ENCRYPTION_KEY / JWT_SECRET / JWT_SECRET_OLD，
// 下面这个交叉类型因此**冗余但无害**（保留是为了让 ServerEnv 这个名字继续指代
// 「自托管侧补过东西的 Env」，以后真需要放宽/收窄时改这一处）。
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
    NAVIHIVE_TRUST_X_REAL_IP: TRUST_X_REAL_IP,
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
    /** 读取覆盖写入的 X-Real-IP 需要**第二个**独立开关（理由见下面那段信任模型） */
    const trustXRealIp = serverEnv.NAVIHIVE_TRUST_X_REAL_IP === "1";

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
    //
    // 信任模型（2026-11-02 拆开关后）：X-Real-IP 与 XFF 各有一个开关，互不背书。
    //   - TRUST_X_REAL_IP=1 且 TRUST_XFF=1 时，worker 侧才读 X-Real-IP 这一档
    //     （部署模板要求 Nginx 以覆盖模式写它，客户端带来的值到不了应用）；
    //   - TRUST_XFF=1 时保留 X-Forwarded-For / -Proto。**原样保留**客户端的 XFF 是
    //     有意为之：XFF 可能是一条更长的反代链（Nginx 前面还有 CDN / WAF），
    //     只有最外层知道完整链路；应用侧已经把可伪造的追加式首段降为次优先级。
    //   - 两个开关**任一为假**就删 x-real-ip：它是一个普通的客户端可填头，
    //     无法从请求本身判断是反代覆盖写的还是客户端自带的 —— 只跟着 TRUST_XFF
    //     放行的话，Caddy / Traefik（默认不写这条）后面客户端带来的值会原样透传，
    //     每请求换一个就是全新限速桶。漏删就等于伪造它能污染审计 IP、绕过五类限速。
    headers.delete("cf-connecting-ip");
    headers.delete("cf-visitor");
    if (!trustXFF) {
        // P1-2 强告警：请求里带着 XFF 却没声明信任它 —— 十有八九是「挡了反代但 .env
        // 没设 NAVIHIVE_TRUST_XFF=1」。后果：限速只能落在 socket 对端（回环）上，
        // 所有真实用户共享一个登录桶。自 2026-11 起登录侧对这种情况改用共享桶软节流
        // （worker/loginGuard.ts 的 LOGIN_GLOBAL_BUCKET），但正确的解法仍是开 TRUST_XFF，
        // 让限速、审计、会话列表都拿到真实来源。每进程只警告一次，别把日志刷爆。
        if (req.headers["x-forwarded-for"] && !xffMismatchWarned) {
            xffMismatchWarned = true;
            logger.warn(
                "检测到 X-Forwarded-For，但 NAVIHIVE_TRUST_XFF=0（未信任该头）：限速与审计将退化为按回环地址共享一个桶。" +
                    "若前面确有可信反代（用本仓 deploy/nginx 模板），请在 .env 设 NAVIHIVE_TRUST_XFF=1 并按需设 NAVIHIVE_TRUST_X_REAL_IP=1；" +
                    "若端口直接暴露公网，请保持 0 并删掉反代。本告警每进程只出现一次。",
                { component: "server", count: 1 }
            );
        }
        headers.delete("x-forwarded-for");
        headers.delete("x-forwarded-proto");
    }
    if (!trustXFF || !trustXRealIp) {
        headers.delete("x-real-ip");
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
        runServerCron().catch(error => {
            console.error("定时任务异常:", error);
        });
        scheduleCron();
    }, delay);
}

/**
 * audit_log 清理：删除早于 365 天的审计记录，避免该表无限制增长拖慢查询。
 *
 * 用参数化 DELETE；时间窗口是 SQL 函数（`datetime('now','-365 days')`），非用户输入，
 * 无注入风险。fail-safe：清理失败只记日志、绝不抛出 —— 不能因为归档清理失败就把
 * 整轮定时任务带崩（worker 的 cron 有各自的留痕机制，server 这边同样不让清理误伤主流程）。
 *
 * 为什么单独挂这一条：worker 侧的保留清理走 D1 的 cleanupExpiredRows，自托管（server）
 * 用的是 SQLite，audit_log 在 server 端此前没有任何清理路径，纯增不减。
 */
async function cleanupAuditLog(): Promise<void> {
    try {
        await serverEnv.DB.prepare(
            "DELETE FROM audit_log WHERE created_at < datetime('now','-365 days')"
        ).run();
        console.log("审计日志清理完成（保留 365 天内记录）");
    } catch (error) {
        console.error("审计日志清理失败（已跳过，不影响定时任务）:", error);
    }
}

/** 自托管侧定时入口：复用 Worker 的定时任务，并补上 server 端特有的审计日志清理。 */
async function runServerCron(): Promise<void> {
    await runScheduledTasks(serverEnv, undefined, CRON_EXPR).catch(error => {
        console.error("定时任务异常:", error);
    });
    await cleanupAuditLog();
}

// ============ HTTP 服务 ============

// ============ 网页端直接升级 ============
//
// 实现在 server/upgrade/*。2026-11 从本文件拆出：原 entry.ts 1500+ 行里 Docker 自升级
// 占了七成，而其中「compose 坐标解析」「helper 命令拼装」本来是纯函数，却因为和
// 「连 socket」的代码混在一个文件里，单测碰不到 —— 覆盖率 0/0/0。
//   · dockerApi.ts   —— Docker Engine API 最小客户端 + 目标容器/镜像坐标 + 可用性判据
//   · spool.ts       —— 零 daemon 权限的请求文件通道（应用容器根本不碰 sock 的形态）
//   · compose.ts     —— 从容器标签读部署坐标、拼 helper 命令（纯函数，有单测）
//   · selfUpgrade.ts —— 拉镜像 / 起 helper / 重建 / 健康门禁后的状态机
// 本文件只保留：路由编排、审计落库、客户端 IP 口径。**行为与拆分前完全等价**。
/**
 * 访问日志里的客户端地址，与 worker 侧同口径：
 * 信任反代（NAVIHIVE_TRUST_XFF=1）时取 XFF 首段，否则只认 socket 对端
 * （XFF 是客户端能随便写的，直接暴露到公网时拿它当来源等于自欺）。
 */
function accessIp(req: IncomingMessage): string {
    const forwarded = TRUST_XFF === "1" ? firstHeaderValue(req.headers["x-forwarded-for"]) : undefined;
    return normalizeRemoteAddress(forwarded || req.socket?.remoteAddress || "");
}

/**
 * 升级审计的唯一落库口。
 *
 * 直接 `new NavigationAPI(serverEnv)` 再调 writeAudit —— 与 worker/index.ts 的
 * recordServerError 同一个骨架：审计只有这一个写入口，自托管侧也**不该**为它新开一个
 * HTTP 端点（那等于把「往审计表写任意一行」暴露成一个 API）。
 *
 * ⚠️ 「记不记、记成什么」全在 ./upgradeAudit 的纯函数里判定，这里只负责落库：
 * 那部分没有容器也能被用例逐格钉住，而这里的 docker / spool 分支没法脱离真容器测。
 * ⚠️ 失败一律吞在 recordUpgradeAudit 里：这个端点是「先响应再升级」，
 * 审计写失败绝不允许反过来把「升级已提交」这个响应搞挂。
 */
async function writeUpgradeAudit(outcome: UpgradeOutcome, ip: string): Promise<void> {
    await recordUpgradeAudit(outcome, ip, (action, actor, auditIp, detail) =>
        new NavigationAPI(serverEnv).writeAudit(action, actor, auditIp, detail)
    );
}

/**
 * 请求上下文（P1-4 ②）：让全仓 80 多处 `logger.warn/error` 自动带上 rid。
 *
 * 为什么是 AsyncLocalStorage 而不是模块级 `let currentRid`：Node 是单线程 + 大量交错
 * await，模块级变量会被后一个请求覆盖 —— 日志就会挂上**别人的** rid，那比没有 rid
 * 更坏（它会把人引到错误的请求上）。ALS 按异步调用链隔离，`ridStore.run(rid, fn)`
 * 之后由这次请求派生的整条 Promise 链都能读回自己的 rid。
 *
 * ⚠️ 注入点为什么在这里：`shared/logger.ts` 同时被 worker（Cloudflare）使用，而
 * workerd 里没有 `node:async_hooks` —— 所以那边留的是可注入的 provider 钩子，
 * Node 侧在这里把 ALS 接上去。worker 侧不注入：它每请求自带 rid 字段。
 */
const ridStore = new AsyncLocalStorage<string>();
setRidProvider(() => ridStore.getStore());

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

    // P1-4：整条请求链跑在 rid 上下文里 —— 期间任何 logger.warn/error 都会自动带上它，
    // 不用改 80 多个调用点（那既繁琐又必然漏）。隔离机制见 ridStore 的定义处。
    void ridStore.run(rid, async () => {
        try {
            // POST /__cron：给外部定时器（systemd timer / crontab）用的触发口
            if (pathname === "/__cron" && method === "POST") {
                if (!cronTokenOk(req)) {
                    res.writeHead(CRON_TOKEN ? 401 : 404, { "Content-Type": "text/plain; charset=utf-8" });
                    res.end(CRON_TOKEN ? "Unauthorized" : "Not Found");
                    return;
                }
                await runServerCron();
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
            // ③ 闸门的每一次判定都落审计（动作名 system-upgrade / .failed / .denied，
            //    判定与文案在 ./upgradeAudit.ts）—— 2026-10-28 的教训：容器被换掉、
            //    镜像也对，但 audit_log 一条没有，「谁在什么时候换的生产」事后无从查起。
            // ⚠️ 执行顺序：**先响应再升级** —— 动的是这个容器自己，命令跑起来后
            // 本进程随时会被杀，响应发不出去用户就什么都看不到。1.5s 后再动手。
            if (pathname === "/api/system/upgrade" && method === "POST") {
                // 审计与访问日志同一个 IP 口径（TRUST_XFF 时取 XFF 首段，否则只认 socket 对端）
                const upgradeIp = accessIp(req);
                const meRes = await handler.fetch(
                    new Request("http://internal/api/auth/me", { method: "GET", headers: toHeaders(req) }),
                    serverEnv
                );
                const me = meRes.ok
                    ? ((await meRes.json()) as { role?: string; username?: string })
                    : null;
                if (!me || me.role !== "owner") {
                    // 已登录的非 owner = 一次越权尝试，留痕（actor 是那个账号，才追得下去）；
                    // 连身份都拿不到（盲扫 / 令牌过期）不记 —— 理由见 server/upgradeAudit.ts。
                    await writeUpgradeAudit(
                        me ? { kind: "denied", username: me.username || "", role: me.role || "" } : { kind: "anonymous" },
                        upgradeIp
                    );
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: false, error: "只有站点所有者可以执行升级" }));
                    return;
                }
                if (spoolEnabled()) {
                    // 交给升级器：本进程只写请求文件，绝不碰 daemon
                    try {
                        requestUpgradeViaSpool("owner");
                        // ⚠️ 审计在**响应之前**落库，且等它写完：宿主上的升级器可能下一秒
                        // 就把本容器换掉，写在响应之后（不 await）会留一个「升级成功但审计丢了」
                        // 的窗口 —— 那正是这次事故的形状（容器换了，表里查不到）。
                        // 一次 SQLite 插入是毫秒级，客户端感知不到这点延迟。
                        await writeUpgradeAudit(
                            { kind: "accepted", trigger: "spool", image: UPGRADE_IMAGE },
                            upgradeIp
                        );
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
                        // 提交都没成功也要留痕：否则用户报「点了升级没反应」时，审计里
                        // 一条对应记录都没有，只剩会被轮转掉的 console 日志。
                        await writeUpgradeAudit(
                            { kind: "submit-failed", image: UPGRADE_IMAGE, message },
                            upgradeIp
                        );
                        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                        res.end(JSON.stringify({ ok: false, error: `提交升级请求失败：${message}` }));
                    }
                    return;
                }
                if (!dockerAvailable()) {
                    // 501 是部署形态的静态事实（没 spool 目录、也没挂 docker.sock），
                    // 不是一次变更 —— 判定函数会返回「不记」，这里仍显式走一遍，
                    // 让「升级被拒时到底记不记」只在一处决定（server/upgradeAudit.ts）。
                    await writeUpgradeAudit({ kind: "unsupported", image: UPGRADE_IMAGE }, upgradeIp);
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
                // 同样在响应之前落库：这条路径虽然要等 1.5s 才动手，但写在这里能让
                // 「受理」与「开始执行」在审计里保持先后一致，也不依赖 timer 一定跑到。
                await writeUpgradeAudit({ kind: "accepted", trigger: "docker-api", image }, upgradeIp);
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
                            const helperCode =
                                error instanceof Error
                                    ? (error as Error & { helperExitCode?: number }).helperExitCode
                                    : undefined;
                            // helper 以 40/41 退出 = 健康门禁没过、已走回滚。如实报同款相位，
                            // 前端 upgradeWait 对这两个相位有显式否决，绝不能再落到「完成」。
                            const rollbackPhase =
                                typeof helperCode === "number" ? classifyHelperExitCode(helperCode) : null;
                            upgradeStatus.phase = rollbackPhase ?? "failed";
                            upgradeStatus.error = message;
                            upgradeStatus.finishedAt = Date.now();
                            // 只有「走过门禁、回滚过」的失败才发结构化事件；普通 failed
                            // （拉不动镜像 / 重建失败）不是回滚，别混进同一个事件名。
                            // 纯观测：相位、响应体、后续 restart 流程都不受影响。
                            if (rollbackPhase) {
                                const event = rollbackTerminalEvent(rollbackPhase, {
                                    reason: message,
                                    toVersion: upgradeStatus.image || UPGRADE_IMAGE,
                                });
                                logger[event.level](event.message, event.fields);
                            }
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
                    // 回滚终态在这里才被看见（本进程没参与那次判定）：去重后补一条结构化事件。
                    // 纯观测，响应体与状态码不受影响。
                    reportRollbackOnce(state);
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
            // P1-4：改走 logger —— Error 会在发射口转成 {name,message,stack,cause}，
            // 与访问日志/审计同一套结构化格式；rid 也已由 ALS 上下文带上（这里显式再给一次，
            // 因为 catch 分支是最需要它的地方，不能依赖上下文是否还活着）。
            logger.error("[server] 请求处理异常", {
                component: "server.entry",
                rid,
                m: method,
                p: pathname,
                err: error,
            });
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Internal Error");
            } else {
                res.destroy();
            }
        }
    });
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
    console.log(`  X-Real-IP 信任 ${TRUST_X_REAL_IP === "1" ? "开（需反代覆盖写入）" : "关（只按 XFF / socket 对端分桶）"}`);
    if (TRUST_X_REAL_IP === "1" && TRUST_XFF !== "1") {
        console.warn("⚠️ 设了 NAVIHIVE_TRUST_X_REAL_IP=1 但 NAVIHIVE_TRUST_XFF=0：X-Real-IP 只在两个开关都开时才读，当前设置无效（入口也会把该头删掉）。");
    }
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
    // ---- 启动自检：本地快照是否太久没更新（DATA-10 配套，非阻塞）----
    // 只在「已经有快照、但最新一份超过阈值」时才 warn，不阻断启动。
    // 没有快照文件 = 静默（操作者可能还没到备份这一步，或压根不放本目录）。
    // 扫描目录默认是数据库所在目录（scripts/backup-sqlite.mjs 默认也把快照放这儿），
    // 可用 NAVIHIVE_BACKUP_DIR 指向你 crontab 实际写备份的目录；
    // 阈值用 NAVIHIVE_BACKUP_WARN_DAYS（默认 30）。详情见 deploy/selfhost.md 第七节。
    {
        const warnDays = Number(process.env.NAVIHIVE_BACKUP_WARN_DAYS || "30");
        const scanDir = process.env.NAVIHIVE_BACKUP_DIR || path.dirname(path.resolve(DB_FILE));
        try {
            const stem = path.basename(DB_FILE).replace(/\.[^.]+$/, "");
            const re = new RegExp(
                "^" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-.+\\.db$"
            );
            const files = readdirSync(scanDir).filter((f) => re.test(f));
            if (files.length > 0) {
                const newest = Math.max(
                    ...files.map((f) => statSync(path.join(scanDir, f)).mtimeMs)
                );
                const days = Math.floor((Date.now() - newest) / 86_400_000);
                if (days >= warnDays) {
                    console.warn(
                        `⚠️ 距上次本地快照已 ${days} 天（阈值 ${warnDays} 天）：建议运行 node scripts/backup-sqlite.mjs 备份，` +
                            `或检查定时任务是否还在跑。`
                    );
                }
            }
        } catch {
            // 目录不存在 / 无权限都静默跳过：自检失败绝不能阻断启动
        }
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
