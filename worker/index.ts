/**
 * Worker 入口：API 路由分发。
 *
 * 这个文件只负责三件事：算好请求级上下文 → 按固定顺序问各路由模块 → 统一兜底（404 / 500）。
 * 分支实现都在 ./routes/ 下：
 *   public      公开路由（图标 / CSP 上报 / 错误上报 / 登录 / 注册 / 恢复 / 初始化）
 *   middleware  鉴权中间件（验令牌、绑账号、查账号存活、挡跨站写）
 *   account     账号（身份 / 邀请码 / 凭据 / 恢复密钥 / 账号管理 / 退出）
 *   ops         审计日志与回收站
 *   data        分组 / 站点 CRUD、批量删除、批量排序、首屏 bootstrap
 *   config      configs 读写
 *   backup      导出 / 导入 / WebDAV
 *
 * ⚠️ 顺序是有讲究的，别随手挪：
 *   - 公开路由必须在鉴权中间件**之前** —— 还没登录的人才需要登录、注册、恢复；
 *     图标与上报是浏览器 <img> / report-only 发的，压根带不上 Authorization。
 *   - 受保护路由必须在鉴权中间件**之后**，且排在「强制改密」闸门之后。
 */
import { API_ERROR_CODES, ApiError, errorResponse } from "./lib/apiError";
import { BodyLimitError, readBoundedBytes } from "./util";
import { createMemoryLimiter } from "./rateLimit";
import {
    REQUEST_ID_HEADER,
    REQUEST_ID_LEN,
    REQUEST_ID_PATTERN,
} from "../shared/requestId";
import { ATTACHMENT_MAX_BYTES } from "./attachments";
import { NavigationAPI } from "../src/API/navigationApi";
import { runScheduledTasks } from "./cron";
import {
    clientIp,
    requestIsSecure,
    TEXT_HEADERS,
    withSecurityHeaders,
} from "./httpUtils";
import { handleAccountRoutes } from "./routes/account";
import { handleAiRoutes } from "./routes/ai";
import { handleBackupRoutes } from "./routes/backup";
import { handleConfigRoutes } from "./routes/config";
import { handleDataRoutes } from "./routes/data";
import { handleVaultRoutes } from "./routes/vault";
import { enforceAuth, enforceMaintenance, type TokenSession } from "./routes/middleware";
import { handleOpsRoutes } from "./routes/ops";
import { handlePublicRoutes } from "./routes/public";
import type { RouteCtx } from "./routes/types";
import type { Env, ExportedHandler, ScheduledController } from "./types";
import { isSpaRoute, looksLikeAsset } from "../shared/spaRoutes";

// 原来散在别处的导出，测试与别的文件还在引，从这儿原样转出去
export { requestIsSecure } from "./httpUtils";

/**
 * 受保护路由的处理链：过了鉴权中间件之后按这个顺序问，第一个认领（返回非 null）的说了算。
 * 它们之间没有路径重叠，所以顺序不影响结果 —— 列在这里是为了让「哪些路由要登录」
 * 一眼看得见，新增路由时也知道该往哪儿加。
 */
export const PROTECTED_ROUTES = [
    handleAccountRoutes,
    handleOpsRoutes,
    handleDataRoutes,
    handleVaultRoutes,
    handleConfigRoutes,
    handleBackupRoutes,
    handleAiRoutes,
];

/**
 * 服务端错误落库的节流（按 pathname 分桶，10 秒 20 条）。
 *
 * 为什么需要：一个坏掉的部署（迁移失败、D1 配额耗尽、驱动异常）会让**每个**请求
 * 都 500 —— 不节流就是每个请求往 audit_log 写一行，审计表被自己刷爆，还有写入配额。
 * 这与 client-error 上报同一个顾虑（见 worker/errorReport.ts 的限流段），
 * 只是那边按 IP 分桶、这边按端点分桶：某个端点炸了不该吃掉别的端点的配额。
 * 内存窗口跨实例不共享，但服务端错误本来就是「所有人同时中招」，够用了。
 */
const serverErrorLimiter = createMemoryLimiter({ windowMs: 10_000, max: 20, maxKeys: 500 });

/**
 * 取 / 生成本次请求的 rid。
 *
 * 自托管侧由 server/entry.ts 在入口生成并注入 x-request-id；Cloudflare 侧没有中间层
 * 可以注头，由这里自生成 —— 平台日志里的 cf-ray 与本值并存，两者能对上同一次请求。
 *
 * ⚠️ 头是客户端也能写的，所以先过白名单字符与长度：否则一个带换行的值就能把伪造的
 * 一整条日志塞进日志文件（日志注入），审计里也会混进伪造的 rid。
 */
function requestRid(request: Request): string {
    const incoming = request.headers.get(REQUEST_ID_HEADER);
    if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
    return crypto.randomUUID().slice(0, REQUEST_ID_LEN);
}

/**
 * 服务端未处理错误落一条审计：action = "server-error"，detail 是一小段 JSON
 * （method / path / code / message / rid）。
 *
 * 谁能看到：owner 在「审计流水」对话框与 GET /api/audit 里能直接看到这个动作名
 * （getAuditLog 不按 action 过滤，只要 actionLabel 里有映射就是中文标签）。
 * **不在** GET /api/ops/client-errors 里 —— 那条视图是写死 `action = 'client-error'`
 * 的聚合（按 source + message 归并），服务端错误的字段形状与它不同，硬塞进去
 * 会让归并结果出现空来源的空行。要按 rid 串起两边，用审计流水 / 日志即可。
 *
 * ⚠️ **不落 stack**：体积大，且可能含容器内路径与局部变量值；stack 只留在 console，
 * 靠 rid 把两边对上（同样是为了不把内部结构写进长期保留的表）。
 * ⚠️ 落库失败不能影响响应 —— 整段 try/catch，失败只 warn。
 * ⚠️ 不先 migrate()：能走到这里的 500 有一类正是「迁移本身失败」，
 * 再迁一次只会把同一个异常再抛一遍。写入失败由 writeAudit 自己吞掉。
 */
async function recordServerError(
    env: Env,
    rid: string,
    request: Request,
    pathname: string,
    error: unknown
): Promise<void> {
    if (!serverErrorLimiter.allow(pathname)) return;
    try {
        const detail = JSON.stringify({
            method: request.method,
            path: pathname,
            code: API_ERROR_CODES.internal,
            message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
            rid,
        });
        const api = new NavigationAPI(env);
        // actor 用 "system"：这不是某个用户做的动作，是服务端自己出错（与 cron 事件同一条链）
        await api.writeAudit("server-error", "system", clientIp(request), detail);
    } catch (logError) {
        console.warn("[api] server-error 落库失败", rid, logError);
    }
}

async function handleRequest(request: Request, env: Env, rid: string): Promise<Response> {
    const url = new URL(request.url);

    // 自托管时是否信任 X-Forwarded-For 作为限速分桶依据（仅当 Worker 位于可信反代之后、
    // 反代会老实填 XFF 时才打开，否则攻击者随便改 XFF 就能绕过爆破限速）。
    // 默认关闭：Cloudflare 部署走 CF-Connecting-IP（不可伪造），不受此开关影响。
    const trustXFF = env && env.NAVIHIVE_TRUST_XFF === "1";
    // cookie 是否带 Secure：按浏览器真实 scheme 判断（见 requestIsSecure）。
    // NAVIHIVE_COOKIE_SECURE=0 是逃生舱 —— 反代连 X-Forwarded-Proto 都不传、
    // 又确实只能用 http 访问时，用它强制去掉 Secure，否则令牌 cookie 存不上、登录必掉线。
    const secureCookie =
        env?.NAVIHIVE_COOKIE_SECURE !== "0" && requestIsSecure(request, url, trustXFF);

    // 非 API 路径：交给静态资产层做 SPA 回退（not_found_handling=single-page-application）。
    // ⚠️ 两个环境共用同一份 worker/index.ts，靠 env.ASSETS 是否存在区分 Cloudflare / 自托管：
    //   - Cloudflare（wrangler.jsonc）显式 `binding: "ASSETS"` + `run_worker_first: true`：
    //     所有请求先进 Worker，非 API 的 GET/HEAD 全部转发 env.ASSETS.fetch()。
    //       · 真实静态资产（路径带扩展名，如 /assets/xxx.js、/index.html）：原样转发，资产层直出
    //         （命中真实资产，不触发 SPA 回退/再入保护），避免拿到整页 HTML 顶替脚本导致白屏。
    //       · SPA 路由（无扩展名，如 /s/<token>、/sg/<token>）：Cloudflare 在 run_worker_first 下若
    //         转发「原始路径」会触发 SPA 回退再入保护、抛平台级 1101（Worker 未处理异常→500）；改为
    //         显式取确定存在的入口资产 /index.html，由资产层直接吐出、不触发回退/再入，规避 1101。
    //         SPA 靠 window.location 自行路由，路径无关——/s/<token>、/sg/<token> 因此在非浏览器客户端
    //         也 200，与 home 一致。
    //       · POST / 等非 GET/HEAD 非 API 路径：Worker 直接回 404，与自托管 server/entry.ts 对齐。
    //   - 自托管（server/entry.ts）无 ASSETS 绑定：GET/HEAD 非 API 由 serveStatic 兜（含 SPA 回退
    //     index.html），Worker 只收非 GET/HEAD 非 API（如 POST /）→ 404。`if (assets && …)` 恒 false
    //     时落到下面 404，两侧行为一致。
    //   扩展名判定与「哪些路由该回退」都取自 shared/spaRoutes.ts（单一事实来源）：
    //   looksLikeAsset 与 server/static.ts 用的是同一个函数，isSpaRoute 是前端路由表。
    //   （历史坑：① run_worker_first=false「资产层先服务+Worker 兜底」——非导航 /s/<token> 进 Worker
    //   兜底后仍转发原始路径触发 1101；② run_worker_first=true 但不区分扩展名、对真实资产也转发原始
    //   /s/<token> 同样 1101。两坑均已避开。）
    //
    // ⚠️ P2-8：回退条件从「无扩展名一律回退」收紧成「命中路由表才回退」。以前
    //   /notes、/wp-login.php、/.git/config 这类无扩展名的未知路径一律 200 吐整页 HTML，
    //   扫描器看到的是「什么都存在」，而真实业务根本没有这些路由（前端没有
    //   react-router，URL 上只有 /、/s/<token>、/sg/<token>）。现在它们回 404。
    //   表在 shared/spaRoutes.ts —— 新增前端 URL 路由必须同步加进去，否则两端都 404。
    if (!url.pathname.startsWith("/api/")) {
        const assets = env.ASSETS;
        if (assets && (request.method === "GET" || request.method === "HEAD")) {
            // 真实静态资产（带扩展名）→ 原样转发，资产层直出，不触发 SPA 回退/再入保护
            if (looksLikeAsset(url.pathname)) {
                try {
                    return await assets.fetch(request);
                } catch {
                    return new Response("Not Found", { status: 404, headers: TEXT_HEADERS() });
                }
            }
            // 命中前端路由表 → 显式取 /index.html（不能转发原始路径，会触发 1101）
            if (!isSpaRoute(url.pathname)) {
                return new Response("Not Found", { status: 404, headers: TEXT_HEADERS() });
            }
            try {
                return await assets.fetch(new Request(new URL("/index.html", request.url)));
            } catch {
                return new Response("Not Found", { status: 404, headers: TEXT_HEADERS() });
            }
        }
        // 非 GET/HEAD 的非 API 路径（如 POST /）→ 404，与自托管 server/entry.ts 对齐
        return new Response("Not Found", {
            status: 404,
            headers: TEXT_HEADERS(),
        });
    }

    try {
        // 所有 API 写入统一在解析前限制实际流量，不依赖可缺失的 Content-Length。
        if (!["GET", "HEAD"].includes(request.method)) {
            // ⚠️ 附件上传**必须单独放额度**（2026-10-08 修「图片传上去却看不见」）：
            // 它送的是**原始图片字节**，而通用额度只有 256KB —— 一张手机截图就
            // 轻松超过，readBoundedBytes 直接抛 413，上传压根没进路由。
            // 前端拿到 413 只提示一句「上传失败」，用户看到的就是「图传上去了但
            // 预览里没有」。额度与 worker/attachments.ts 的单文件上限一致。
            const attachment =
                request.method === "POST" && url.pathname === "/api/notes/attachments";
            const large = /\/api\/(import|webdav\/upload)$/.test(url.pathname);
            const report = /\/api\/(report-error|csp-report)$/.test(url.pathname);
            const maxBytes = attachment
                ? ATTACHMENT_MAX_BYTES
                : large
                  ? 10 * 1024 * 1024
                  : report
                    ? 8192
                    : 256 * 1024;
            const bytes = await readBoundedBytes(request.body, maxBytes);
            // ⚠️ 这里不能写 `new Request(request, { body })`（拿旧 Request 当模板）：
            // Node 的 undici 在 init.body 为 null 时要从 input 继承 body，而此时
            // input 的 body 流已被 readBoundedBytes 消费 → 抛
            // "Cannot construct a Request with a Request object that has already been used"。
            // 表现：所有「无请求体的写请求」（DELETE、空体 PUT/POST）在自托管端一律 500，
            // 带 body 的反而没事（init.body 非空时 undici 不碰 input 的 body）——
            // 所以 CRUD 大多正常，唯独 DELETE /api/configs/webdav.backupPassword 这类
            // 空体删除炸出来（2026-10-15 实测）。Cloudflare 的 runtime 没有这条检查，
            // 线上从不出错，只在自托管暴露。
            // 改成 url + method + headers 重建，两个 runtime 行为一致。
            request = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: bytes.byteLength ? bytes : null,
            });
        }
        const api = new NavigationAPI(env);
        const ctx: RouteCtx = {
            request,
            env,
            url,
            path: url.pathname.replace("/api/", ""),
            method: request.method,
            api,
            ip: clientIp(request),
            trustXFF,
            secureCookie,
            // 下面两个要等鉴权中间件验完令牌才知道，先占位
            currentJti: "",
            currentTokenExp: 0,
        };

        // 1) 公开路由：必须排在鉴权之前（理由见文件头）
        const publicResponse = await handlePublicRoutes(ctx);
        if (publicResponse) return publicResponse;

        // 2) 鉴权中间件：没过就直接把 401 / 403 回给客户端
        const session: TokenSession = { jti: "", exp: 0 };
        const denied = await enforceAuth(ctx, session);
        if (denied) return denied;
        // 退出登录 / 注销账号要把「当前这张令牌」拉黑，靠这两个值
        ctx.currentJti = session.jti;
        ctx.currentTokenExp = session.exp;

        // 3) 维护模式：写操作拦下（读操作放行，owner 豁免）。排在迁移之前 ——
        //    迁库本身也是维护动作，别让维护中的写请求先落到旧结构上。
        const maintaining = await enforceMaintenance(ctx);
        if (maintaining) return maintaining;

        // 4) 确保数据库结构是最新的（迁移结果缓存在模块作用域，同一 isolate 内只执行一次）
        await api.migrate();

        // 4) 首次部署强制改密：种子凭据来自部署变量，等同半公开。
        //    改密 / 重置 / 退出 三个口子必须留着，其余写操作一律拦下。
        if (
            api.isAuthEnabled() &&
            ctx.method !== "GET" &&
            ctx.method !== "HEAD" &&
            ctx.path !== "auth/credentials" &&
            ctx.path !== "auth/recover" &&
            ctx.path !== "auth/recovery-status" &&
            ctx.path !== "logout" &&
            (await api.mustChangePassword())
        ) {
            return errorResponse(ApiError.forbidden("请先修改管理员密码后再进行其它操作"));
        }

        // 5) 受保护路由
        for (const handle of PROTECTED_ROUTES) {
            const response = await handle(ctx);
            if (response) return response;
        }

        return new Response("API路径不存在", {
            status: 404,
            headers: TEXT_HEADERS(),
        });
    } catch (error) {
        if (error instanceof BodyLimitError) return new Response(error.message, { status: error.status, headers: TEXT_HEADERS() });
        // 请求体不是合法 JSON（非法字符 / 空体）时 request.json() 抛 SyntaxError：
        // 这是客户端输入错误，应回 400 而不是 500（两环境对照 e2e 的 A4 错误密码登录、
        // B6 空 body 建分组都曾 500）。各路由的 request.json() 没有逐个包 try/catch，
        // 在这里统一兜底最省事、也最全（覆盖所有写接口）。
        if (error instanceof SyntaxError) {
            return errorResponse(ApiError.badRequest("请求体不是合法的 JSON"));
        }
        // 统一错误出口：路由里抛的 ApiError 按 code/status 翻译成结构化 JSON；
        // 未预料的错误在 errorResponse 里回 500，**不把堆栈/内部细节透给客户端**
        // （以前回纯文本，客户端解析不出结构化错误，只能显示一句笼统的话）。
        //
        // ⚠️ 意外错误（= 5xx）的日志与落库**必须在这里**做，不能塞进 errorResponse：
        // 那是个纯函数，拿不到 env.DB，也拿不到 method / path / ip。
        // 以前它只打一行「[api] 未处理的错误: …」，线上报「某个操作 500」时
        // 根本不知道是哪个请求、哪个地址、哪个账号 —— 现在这一行带 rid + method + path，
        // 并且按 rid 落一条审计，能和客户端上报里的 requestId 对上同一次请求。
        if (!(error instanceof ApiError)) {
            console.error("[api]", rid, request.method, url.pathname, error);
            await recordServerError(env, rid, request, url.pathname, error);
        }
        // logged: true —— 上面已经带上下文打过了，别再让统一出口重复打一行没有上下文的
        return errorResponse(error, { logged: true });
    }
}

/**
 * 鉴权开着却没配密钥 → **整个站点拒绝服务**（2026-10-21，质量评估 4.4 的另一半）。
 *
 * 原先只在「登录」与「换钥」那两条路上 fail-closed，剩下的路照常跑 ——
 * 其中最难察觉的是**凭据加密**：`createKeyring` 在 AUTH_SECRET 为空时会注册
 * 一把由 `PBKDF2("")` 派生的钥匙（那是升级前的老行为，为了不让已有密文突然解不开）。
 * 也就是说漏配的部署里，webdav 密码这类字段的「加密」等于人人可算。
 *
 * 自托管侧早就是启动即中止（`assertAuthConfigOrExit`）；Workers 没有「启动」这个概念，
 * 所以把同一道闸放在入口：与其带着等价于明文的密钥继续服务，不如明确报错让人去补配置。
 * 只在真正缺密钥时开火 —— 配了任一把就不影响。
 */
export function missingAuthSecret(
    // 只依赖这两个字段：收窄参数类型，单测就不必造一整套 Env（DB / ASSETS …）
    env: Pick<Env, "AUTH_ENABLED"> & { AUTH_SECRET?: string }
): boolean {
    if (env.AUTH_ENABLED !== "true") return false;
    // 判据只看 AUTH_SECRET：凭据加密的源密钥就是它（`keyring.legacySecret`），
    // 配了 JWT_SECRET 也补不上这个洞 —— 那种部署的 JWT 能签，但密文照样人人可算。
    return !env.AUTH_SECRET;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        // 一次请求一个 rid：日志、审计、响应头、浏览器上报共用同一个值。
        const rid = requestRid(request);
        if (missingAuthSecret(env)) {
            // 走统一错误出口（errorCodeMigration 那条守卫：worker/ 下不许裸写 Response.json({error})）。
            // 用 serviceUnavailable 而不是新造一个码：客户端只显示 message，
            // 503 也已经在前端的兜底分支里，没必要为一次性配置错误扩散错误码表。
            const denied = withSecurityHeaders(
                errorResponse(
                    ApiError.serviceUnavailable(
                        "站点鉴权已开启，但没有配置 AUTH_SECRET。" +
                            "缺少密钥时凭据加密等价于明文，因此本站拒绝服务。" +
                            "请在部署环境里设置 AUTH_SECRET（openssl rand -hex 32）后重新部署。"
                    ),
                    { headers: { "Cache-Control": "no-store" } }
                )
            );
            denied.headers.set(REQUEST_ID_HEADER, rid);
            return denied;
        }
        const response = withSecurityHeaders(await handleRequest(request, env, rid));
        // ⚠️ 所有响应都回写 rid（不只是 500）：路由 / 中间件直接抛出的 4xx 也走各自的
        // errorResponse，那些出口没有 rid 可带。统一在这里补，前端 errorReporter 才能
        // 把「用户看到的这句报错」和日志 / 审计里的同一行对上。
        // withSecurityHeaders 返回的是**重建过的可变副本**（见它的注释），set 不会踩 immutable。
        response.headers.set(REQUEST_ID_HEADER, rid);
        return response;
    },
    /**
     * 定时任务（wrangler.jsonc 的 triggers.crons 触发；免费版账号全账号只有 5 个
     * cron 触发器，所以只有每小时这一条，见 cron.ts 顶上的说明）。
     * 实现在 ./cron.ts：导航页每周备份（代码里按 UTC 周一 02 点窗口判定）+
     * 记事本自动备份调度（各账号频率配置判定）+ 死链巡检等。
     * 把本次命中的 cron 表达式传下去：表达式缺省 / 不是每小时那条时保持老行为
     * （验证脚本与 cron-e2e 的通配表达式每次触发都全量跑）。
     */
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        await runScheduledTasks(env, undefined, controller.cron);
    },
} satisfies ExportedHandler;
