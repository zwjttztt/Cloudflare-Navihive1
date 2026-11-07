/// <reference types="vite/client" />

/** Structured context is passed through without serializing errors or other values. */
export interface LogFields {
    component?: string;
    action?: string;
    rid?: string;
    /**
     * 稳定事件名（`notes.import.partial` 等），取值**只能**来自 shared/failureEvents.ts
     * 的 `FAILURE_EVENTS`。
     *
     * 为什么是独立字段而不是拼进 message：message 是给人读的一句话（可以改文案、
     * 可以带数字），event 是给机器与告警规则用的稳定标识（文案改了也不能变）。
     * 两者混在一起的话，任何一次文案调整都会静默打断按字符串匹配的检索与告警。
     */
    event?: string;
    [key: string]: unknown;
}

type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * 当前请求的 rid 提供者（2026-11，P1-4）。
 *
 * 存在的意义：全仓 80 多处 `logger.warn/error` 都是「只传 message + 一点上下文」，
 * 没有 rid —— 线上排查时一条日志对不上它是哪个请求产生的，只能靠时间戳猜。
 * 与其改 80 个调用点（漏一个就是一个盲区），不如在**发射口**统一补。
 *
 * ⚠️ 为什么是「提供者」而不是直接 `bindRequestContext(rid)` 存一个模块级变量：
 *   Node 侧是并发的（单线程 + 大量交错 await），模块级变量会被后一个请求覆盖，
 *   日志就会挂上**别人的** rid —— 那比没有 rid 更坏（错误线索）。
 *   所以真正的并发隔离交给调用方（server/entry.ts 用 AsyncLocalStorage 注入），
 *   本模块只负责「发射时问一句」。worker 侧不注入：它每请求自带 rid，
 *   而 workerd 里也没有 async_hooks。
 */
let ridProvider: (() => string | undefined) | undefined;

/** 注入 / 清除 rid 提供者。传 undefined 即恢复「不自动补 rid」。 */
export function setRidProvider(provider: (() => string | undefined) | undefined): void {
    ridProvider = provider;
}

/** 深度上限：够钻进 `{ ctx: { err } }` 这种一层包裹，又不至于把大对象整个走一遍 */
const SERIALIZE_DEPTH = 2;

/**
 * 是不是一个「像 Error 的东西」。
 *
 * ⚠️ 为什么不能只写 `value instanceof Error`：跨 realm 时 `instanceof` 会假 ——
 * VM 沙箱（tests/logger.test.ts 就在 `runInNewContext` 里跑本模块）、iframe、
 * 以及某些 polyfill 场景下，对方那个 Error 的原型链和这里的不是同一个。
 * 只看结构没有这个盲区，代价是「手工构造的 {name,message,stack} 也会被当 Error」，
 * 而那恰好也是我们想要的输出形状。
 */
function isErrorLike(value: unknown): value is Error {
    if (value instanceof Error) return true;
    if (value === null || typeof value !== "object") return false;
    const probe = value as { name?: unknown; message?: unknown; stack?: unknown };
    return typeof probe.message === "string" && typeof probe.name === "string" && typeof probe.stack === "string";
}

/**
 * `Error` → 可序列化的普通对象。
 *
 * 为什么非做不可：`console.error("x", { err })` 打出来的是宿主自己的 inspect 格式
 * （多行、带类型前缀），既不能 `jq` 也不能按字段检索；而自托管的访问日志与审计都是
 * 结构化 JSON —— 一条 Error 混在里面等于两套格式并存。
 */
function serializeError(err: Error): Record<string, unknown> {
    const out: Record<string, unknown> = { name: err.name, message: err.message };
    if (typeof err.stack === "string") out.stack = err.stack;
    // Node 的常见附加字段：`code`（ENOENT/EACCES…）与升级链路上的 `helperExitCode`
    const extra = err as Error & { code?: unknown; helperExitCode?: unknown; cause?: unknown };
    if (extra.code !== undefined) out.code = extra.code;
    if (extra.helperExitCode !== undefined) out.helperExitCode = extra.helperExitCode;
    if (extra.cause !== undefined) {
        out.cause = isErrorLike(extra.cause) ? serializeError(extra.cause) : extra.cause;
    }
    return out;
}

/**
 * 递归把 Error 转成普通对象。
 *
 * ⚠️ 只下钻**普通对象与数组**：Request / Response / Date / Buffer 这类宿主对象一律
 * 原样留下 —— 它们有自己的 inspect 表示，硬拆成一堆内部字段既慢又没用
 * （Buffer 拆开就是几千个数字）。
 */
function serializeValue(value: unknown, depth: number): unknown {
    if (isErrorLike(value)) return serializeError(value);
    if (depth <= 0) return value;
    if (Array.isArray(value)) return value.map(item => serializeValue(item, depth - 1));
    if (value !== null && typeof value === "object") {
        const proto = Object.getPrototypeOf(value) as unknown;
        if (proto !== Object.prototype && proto !== null) return value;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = serializeValue(item, depth - 1);
        }
        return out;
    }
    return value;
}

/** 发射前整理字段：Error 序列化 + 缺 rid 时向提供者要一个 */
function prepareFields(fields?: LogFields): LogFields | undefined {
    if (fields === undefined) {
        // 调用方一个字段都没传也要能补 rid，否则「无上下文的 warn」照样对不上请求
        const rid = readRid();
        return rid === undefined ? undefined : { rid };
    }
    const out: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
        out[key] = serializeValue(value, SERIALIZE_DEPTH);
    }
    if (out.rid === undefined) {
        const rid = readRid();
        if (rid !== undefined) out.rid = rid;
    }
    return out;
}

function readRid(): string | undefined {
    if (ridProvider === undefined) return undefined;
    try {
        const rid = ridProvider();
        return typeof rid === "string" && rid.length > 0 ? rid : undefined;
    } catch {
        // 提供者本身出错绝不能让日志炸掉请求
        return undefined;
    }
}

/** Logging must never interrupt a request, including when console is unavailable. */
function emit(level: LogLevel, message: string, fields?: LogFields): void {
    try {
        const prepared = prepareFields(fields);
        console[level](message, ...(prepared === undefined ? [] : [prepared]));
    } catch {
        // Console getters and implementations can throw in embedded hosts and tests.
    }
}

// Vite replaces this property with a literal; the standalone esbuild server does
// not inject it. An unknown build environment therefore defaults to warn/error.
// Keeping the condition at each method lets production builds remove emit calls.
export const logger = {
    debug(message: string, fields?: LogFields): void {
        try {
            if (import.meta.env?.PROD === false) emit("debug", message, fields);
        } catch { /* Environment access must not break a request. */ }
    },
    info(message: string, fields?: LogFields): void {
        try {
            if (import.meta.env?.PROD === false) emit("info", message, fields);
        } catch { /* Environment access must not break a request. */ }
    },
    warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
    error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};
