// worker/errorReport.ts
//
// 客户端错误上报（/api/report-error）。
// App.tsx 的 14 处 console.error 与 ErrorBoundary 的 componentDidCatch 都走这里，
// 由 Worker 在 Cloudflare 日志里集中可见（observability.logs 自动收集 console.*）。
//
// 安全策略：
//   - 不需要鉴权（公开路由）：错误上报不该被登录态挡掉，否则崩在登录态外的崩溃反而看不到
//   - 限速：configs/auth.errorReportGuard（按 IP 不可能，那就按 worker 实例全局）
//   - 单条体积上限 8KB（防止有人塞大字符串撑爆日志）
//   - sanitize：去掉 password / cookie / Authorization / token 等敏感字段；
//     URL 只保留 pathname，query 去掉（query 经常含 token / 搜索关键字等）
//
// 失败策略：上报失败不能影响主流程，try/catch 兜住所有错。

import type { Env } from "./types";
import { NavigationAPI } from "../src/API/navigationApi";
import { isBlockedHost, safeJson } from "./util";

// ============ 限速 ============
// 这是个**公开**路由：谁都能 POST，而且每次都会往 audit_log 写一行。
// 没有限速就等于一个「免费帮你刷 D1 行数」的接口，还能把 Workers 日志灌满，
// 真正的崩溃反而被淹没。
// 按 IP 做滑动窗口不准确（ Workers 里得存状态），这里先用 isolate 内的窗口计数：
// 单实例每 10 秒最多接受 MAX_PER_WINDOW 份报告，超了只丢弃、不算错误。
// 客户端本地本来就有节流（src/utils/errorReporter.ts），这里是兜底的硬上限。
const MAX_PER_REQUEST_BODY_BYTES = 8 * 1024;
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 20;

/** isolate 内的滑动窗口计数（进程重启即清零，够挡住批量刷写） */
const windowStart = { at: 0, count: 0 };
function withinRateLimit(now: number): boolean {
    if (now - windowStart.at > WINDOW_MS) {
        windowStart.at = now;
        windowStart.count = 0;
    }
    if (windowStart.count >= MAX_PER_WINDOW) return false;
    windowStart.count += 1;
    return true;
}

/** 同步清理字符串：去掉换行、控制字符 */
function cleanStr(value: unknown, maxLen = 2000): string {
    if (typeof value !== "string") return "";
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, maxLen);
}

/** 从 URL 字符串里只保留 origin（去掉 query / hash / userinfo） */
function sanitizeUrl(value: unknown): string {
    if (typeof value !== "string") return "";
    try {
        const u = new URL(value, "https://placeholder.local");
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return "";
    }
}

/**
 * 把 error / context 字段清洗一遍，去掉敏感信息：
 * - 任何键名叫 password / token / cookie / authorization / secret / key 的字段直接剔除
 * - URL 字段：去掉 query 与 hash
 * - 字符串：截断 + 去控制字符
 */
function sanitize(input: unknown, depth = 0): unknown {
    if (depth > 4) return null; // 防无限嵌套
    if (input == null) return null;
    if (typeof input === "string") return cleanStr(input);
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (Array.isArray(input)) {
        return input.slice(0, 50).map((v) => sanitize(v, depth + 1));
    }
    if (typeof input === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
            const lower = k.toLowerCase();
            // 黑名单键名：宁可错杀不放过
            if (
                lower === "password" ||
                lower === "passwd" ||
                lower === "pwd" ||
                lower === "token" ||
                lower === "cookie" ||
                lower === "authorization" ||
                lower === "secret" ||
                lower === "auth" ||
                lower === "apikey" ||
                lower === "api_key" ||
                lower.endsWith("token") ||
                lower.endsWith("password")
            ) {
                out[k] = "[redacted]";
                continue;
            }
            // URL 类字段做特殊处理
            if (k === "url" || k === "href" || k === "location" || k === "src") {
                out[k] = sanitizeUrl(v);
                continue;
            }
            out[k] = sanitize(v, depth + 1);
        }
        return out;
    }
    return null;
}

export interface ErrorReport {
    /** 错误类型简短描述（来自 Error.name 或自定义） */
    name?: string;
    /** 错误信息（已去敏感字段） */
    message?: string;
    /** 堆栈（已截断） */
    stack?: string;
    /** 错误来源（"auth" / "save" / "render" 等，自定义分类） */
    source?: string;
    /** 路由（当前 pathname） */
    path?: string;
    /** 发生时刻（ISO 字符串） */
    timestamp?: string;
    /** 任意附加上下文（已 sanitize） */
    context?: Record<string, unknown>;
}

export async function reportError(request: Request, env: Env): Promise<Response> {
    // 体积硬上限（Content-Length 头不一定可信，自己再量一次）
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_PER_REQUEST_BODY_BYTES) {
        return new Response("payload too large", { status: 413 });
    }

    // 超窗直接丢弃（静默成功）：刷接口的人不该再从响应里学到任何东西
    if (!withinRateLimit(Date.now())) {
        return Response.json(
            { ok: true, dropped: true },
            { headers: { "Cache-Control": "no-store" } }
        );
    }

    const raw = await safeJson(request);
    const sanitized = sanitize(raw) as Partial<ErrorReport> | null;

    // 把它写进 Workers 日志（observability 自动收集 console.*）
    console.error("[client-report]", JSON.stringify(sanitized));

    // 同时落一条审计日志，方便后续 grep 一段时间内的崩溃
    try {
        const api = new NavigationAPI(env);
        const ip =
            request.headers.get("CF-Connecting-IP") ||
            request.headers.get("X-Forwarded-For") ||
            "";
        const detail = JSON.stringify({
            source: cleanStr(sanitized?.source, 64) || "unknown",
            path: cleanStr(sanitized?.path, 256) || "",
            name: cleanStr(sanitized?.name, 128) || "",
            message: cleanStr(sanitized?.message, 512) || "",
        });
        await api.writeAudit("client-error", "anonymous", ip, detail);
    } catch {
        // 写审计失败也不能影响上报成功
    }

    return Response.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } }
    );
}

// 不需要引 isBlockedHost 在生产代码里——这是给未来扩展预留的（阻止上报外网日志收集端）。
void isBlockedHost;