// src/utils/errorReporter.ts
//
// 把 App.tsx 的 14 处 console.error 与 ErrorBoundary 的 componentDidCatch 集中到一个出口，
// 通过 navigator.sendBeacon 上报到 /api/report-error（不进 fetch queue、不阻塞 UI）。
//
// 上报前 sanitize：去掉 password / token / cookie / Authorization 等敏感字段，
// URL 字段只保留 origin+pathname（去掉 query 里的搜索关键字、token、临时参数）。
//
// 用 sendBeacon 而不是 fetch：
//   - 失败也不抛（页面已经在崩，不该再加一个未捕获异常）
//   - 不进页面 fetch 队列（不阻塞导航、不抢 worker）
//   - 即便在 pagehide / 卸载时也能发出
//
// 失败兜底：sendBeacon 自己失败不重试——上线时只关心「能收到」，不要让客户端变成 DDoS。

/** 后端路由前缀（与 worker/index.ts 对齐） */
const REPORT_PATH = "/api/report-error";

/** 单条上报体积上限（与 worker/errorReport.ts 对齐） */
const MAX_BODY_BYTES = 8 * 1024;

/** 同源多次同错误只在最近 N 秒内上报一次：避免循环触发的错把日志塞爆 */
const SAME_ERROR_DEDUPE_MS = 10_000;

const lastSentAt = new Map<string, number>();

/** 客户端键名黑名单（大小写不敏感），命中就整字段剔除 */
const SENSITIVE_KEYS = new Set([
    "password",
    "passwd",
    "pwd",
    "token",
    "cookie",
    "authorization",
    "secret",
    "apikey",
    "api_key",
    "auth",
]);

/** URL 类字段：去掉 query / hash / userinfo，只留 origin + pathname */
const URL_KEYS = new Set(["url", "href", "location", "src"]);

/** 同步清洗字符串 */
export function cleanStr(value: unknown, maxLen = 2000): string {
    if (typeof value !== "string") return "";
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, maxLen);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 递归 sanitize（与 worker/errorReport.ts 同口径） */
export function sanitize(input: unknown, depth = 0): unknown {
    if (depth > 4) return null;
    if (input == null) return null;
    if (typeof input === "string") return cleanStr(input);
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (Array.isArray(input)) return input.slice(0, 50).map((v) => sanitize(v, depth + 1));
    if (isPlainObject(input)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
            const lower = k.toLowerCase();
            if (
                SENSITIVE_KEYS.has(lower) ||
                lower.endsWith("token") ||
                lower.endsWith("password")
            ) {
                out[k] = "[redacted]";
                continue;
            }
            if (URL_KEYS.has(k)) {
                if (typeof v === "string") {
                    try {
                        const u = new URL(v, "https://placeholder.local");
                        out[k] = `${u.protocol}//${u.host}${u.pathname}`;
                    } catch {
                        out[k] = "";
                    }
                }
                continue;
            }
            out[k] = sanitize(v, depth + 1);
        }
        return out;
    }
    return null;
}

/** 把 Error 对象归一化成 sanitize 后的字段 */
export function normalizeError(error: unknown): { name: string; message: string; stack: string } {
    if (error instanceof Error) {
        return {
            name: cleanStr(error.name, 64),
            message: cleanStr(error.message, 512),
            stack: cleanStr(error.stack, 4000),
        };
    }
    return {
        name: "NonError",
        message: cleanStr(typeof error === "string" ? error : JSON.stringify(error), 512),
        stack: "",
    };
}

/**
 * 真正发出上报：
 *   - sendBeacon 失败返回 false；这里不重试
 *   - 不抛错（错误上报本身不能再抛）
 */
function send(body: string): void {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
        // 旧浏览器降级到 fetch（仍不阻塞）：keepalive 让它在 unload 时也能发
        try {
            void fetch(REPORT_PATH, {
                method: "POST",
                body,
                headers: { "Content-Type": "application/json" },
                keepalive: true,
            }).catch(() => {});
        } catch {
            /* ignore */
        }
        return;
    }
    try {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(REPORT_PATH, blob);
    } catch {
        /* ignore */
    }
}

/**
 * 上报一个错误。三个来源都是同一个入口：
 *   - App.tsx 的 try/catch 末尾
 *   - ErrorBoundary.componentDidCatch
 *   - 未捕获 Promise 拒绝（setupGlobalHandlers 接管）
 *
 * source 字段用作简单分类（"auth" / "save" / "render" / "unhandled"），便于后端 grep。
 */
export function reportError(
    error: unknown,
    options: { source?: string; context?: Record<string, unknown> } = {}
): void {
    // 同错误节流：避免循环触发（比如 setState 失败 → 上报 → 触发 setState 失败……）
    const norm = normalizeError(error);
    const fingerprint = `${norm.name}|${norm.message}|${options.source || ""}`;
    const now = Date.now();
    const last = lastSentAt.get(fingerprint) || 0;
    if (now - last < SAME_ERROR_DEDUPE_MS) return;
    lastSentAt.set(fingerprint, now);
    // 防止 map 无限增长：60 秒后清理过期项
    if (lastSentAt.size > 200) {
        for (const [k, t] of lastSentAt) {
            if (now - t > 60_000) lastSentAt.delete(k);
        }
    }

    const body = JSON.stringify({
        name: norm.name,
        message: norm.message,
        stack: norm.stack,
        source: cleanStr(options.source || "unknown", 64),
        path:
            typeof window !== "undefined" && window.location
                ? cleanStr(window.location.pathname, 256)
                : "",
        timestamp: new Date().toISOString(),
        context: sanitize(options.context || {}),
    });

    // 体积硬截断（与后端 8KB 对齐；超过就只发名字 + 提示）
    let trimmed = body;
    if (trimmed.length > MAX_BODY_BYTES) {
        trimmed = JSON.stringify({
            name: norm.name,
            message: "[truncated]",
            source: cleanStr(options.source || "unknown", 64),
            path:
                typeof window !== "undefined" && window.location
                    ? cleanStr(window.location.pathname, 256)
                    : "",
            timestamp: new Date().toISOString(),
        });
    }

    send(trimmed);
}

/**
 * 接管未捕获的 window.onerror 与 unhandledrejection。
 * 只在 main.tsx 启动时调用一次，避免重复覆盖。
 */
export function setupGlobalHandlers(): void {
    if (typeof window === "undefined") return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener("error", (event) => {
        reportError(event.error || event.message, {
            source: "window.error",
            context: {
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
            },
        });
    });

    window.addEventListener("unhandledrejection", (event) => {
        reportError(event.reason, { source: "unhandledrejection" });
    });
}