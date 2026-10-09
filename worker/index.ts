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
import { BodyLimitError, readBoundedBytes } from "./util";
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
import { enforceAuth, type TokenSession } from "./routes/middleware";
import { handleOpsRoutes } from "./routes/ops";
import { handlePublicRoutes } from "./routes/public";
import type { RouteCtx } from "./routes/types";
import type { Env, ExportedHandler, ScheduledController } from "./types";

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
    handleConfigRoutes,
    handleBackupRoutes,
    handleAiRoutes,
];

async function handleRequest(request: Request, env: Env): Promise<Response> {
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

    // 非 API 路径（静态资源由 assets 兜底），走到这儿就是没匹配上
    if (!url.pathname.startsWith("/api/")) {
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
            request = new Request(request, { body: bytes.byteLength ? bytes : null });
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

        // 3) 确保数据库结构是最新的（迁移结果缓存在模块作用域，同一 isolate 内只执行一次）
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
            return Response.json(
                { success: false, message: "请先修改管理员密码后再进行其它操作" },
                { status: 403 }
            );
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
        // 安全处理错误，不暴露内部细节
        console.error(`API错误: ${error instanceof Error ? error.message : "未知错误"}`);
        return new Response(`处理请求时发生错误`, {
            status: 500,
            headers: TEXT_HEADERS(),
        });
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        return withSecurityHeaders(await handleRequest(request, env));
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
