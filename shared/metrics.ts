// shared/metrics.ts
// 最小运行时指标：请求数 / 5xx / 429 / 慢请求（P1-4 的「4 个计数」）。
//
// 为什么只有 4 个：这几条是「站点现在是不是不健康」的最短判据，且**零依赖** ——
// 不需要 Prometheus 客户端、不需要外部服务、不需要在 workerd 里塞一个 OpenTelemetry SDK。
// 更细的分布（p50/p95、按路由拆）留给真正的 APM，别在这里长成一个半成品监控系统。
//
// ⚠️ 语义边界（读数字之前必须先读这段）：
//   · **Cloudflare 形态**：模块级状态活在单个 isolate 里。isolate 会被平台随时回收、
//     也会按地域/负载开新的，所以这里的数字是「**本 isolate 自冷启动以来**」，不是全站总量。
//     它回答「这个实例近来怎么样」，不能当计费或容量依据。
//   · **自托管形态**：单进程长驻，数字就是「本进程自启动以来」的累计，语义更接近直觉。
//   两种形态都不做持久化 —— 进程/isolate 一换就清零，这是有意的（写 D1 会让
//   「统计」变成「故障放大器」：库挂了连日志都写不进去）。

/** 一次快照。字段名刻意短且稳定 —— 它会出现在 `/api/ops/metrics` 的响应里。 */
export interface MetricsSnapshot {
    /** 处理的请求总数（进入本进程/isolate 的全部 HTTP 请求，含静态资源） */
    requests: number;
    /** 状态码 ≥ 500 的响应数（含未处理异常兜出来的 500） */
    serverErrors: number;
    /** 状态码 429 的响应数（限速命中：登录爆破 / 写操作 / 导出…） */
    rateLimited: number;
    /** 耗时超过阈值的响应数（阈值见 `SLOW_REQUEST_MS`） */
    slowRequests: number;
    /** 计数起点（epoch ms）。与 `now - startedAt` 一起算「每多少秒几个」 */
    startedAt: number;
}

/**
 * 「慢」的阈值。1s 与 `server/entry.ts` 访问日志里的 `slow` 判据**同一个数** ——
 * 两边不一致的话，同一批请求会出现「日志说慢、指标说没慢」的诡异对账差异。
 */
export const SLOW_REQUEST_MS = 1000;

interface Counters {
    requests: number;
    serverErrors: number;
    rateLimited: number;
    slowRequests: number;
}

const counters: Counters = { requests: 0, serverErrors: 0, rateLimited: 0, slowRequests: 0 };
const startedAt = Date.now();

/**
 * 记一次请求。在响应出口调用（拿到状态码与耗时之后）。
 *
 * 纯副作用、不抛异常：埋点绝不能反过来把请求搞挂。
 */
export function recordRequest(status: number, durationMs: number): void {
    counters.requests += 1;
    if (status >= 500) counters.serverErrors += 1;
    if (status === 429) counters.rateLimited += 1;
    if (durationMs > SLOW_REQUEST_MS) counters.slowRequests += 1;
}

/** 读快照（返回副本，调用方改不动计数器） */
export function metricsSnapshot(): MetricsSnapshot {
    return {
        requests: counters.requests,
        serverErrors: counters.serverErrors,
        rateLimited: counters.rateLimited,
        slowRequests: counters.slowRequests,
        startedAt,
    };
}

/**
 * 清零。**只给测试用** —— 模块级计数器会跨用例累计，不重置就没法断言具体数字。
 * 生产代码里没有任何地方该调它（真要清零就重启进程/让 isolate 自然回收）。
 */
export function resetMetricsForTest(): void {
    counters.requests = 0;
    counters.serverErrors = 0;
    counters.rateLimited = 0;
    counters.slowRequests = 0;
}
