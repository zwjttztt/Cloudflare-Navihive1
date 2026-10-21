// server/slowQuery.ts
// 慢查询打点（2026-10-22，质量评估 C5）。
//
// 为什么要有它：数据量涨起来之后，「某个页面变慢」的第一现场在数据库里，
// 而自托管只有一个进程、没有 APM。SQL 一慢，页面就卡，但日志里只有
// `GET /api/notes` 一行 —— 不知道是哪条语句、慢多少次、什么时候开始的。
//
// 三条设计取舍：
//
//   1. **只记摘要，绝不记绑定值**。SQL 文本里的字面量会带着笔记正文、邮箱、
//      token 片段进来；绑定参数更是直接就是用户数据。所以：
//      - 摘要把字符串/数字字面量统一换成 `?`；
//      - 绑定值**一个都不落**（只记个数），行数记一个数就够了。
//      慢查询日志是要长期留着给人看的，漏一行敏感数据进去就是事故。
//
//   2. **限流**：同一条摘要不会每次都打日志。批量导入时一条语句慢几百次很正常，
//      每次都 console.log 会把真正的第一现场埋掉（也拖慢本身就慢的路径）。
//      做法是「首次必打，之后每 REPEAT_LOG_EVERY 次打一次并带上累计次数」，
//      所有出现都进环形缓冲，不丢样本。
//
//   3. **环形缓冲而不是无限数组**：进程是长跑的，慢查询会一直攒。
//      只留最近 N 条 —— 排障要看的是「刚刚发生了什么」，不是上个月的。
//
// 阈值默认 50ms（计划里的口径），可用 NAVIHIVE_SLOW_QUERY_MS 覆盖；
// 设为 0 或负数 = 关闭打点（仍然可以用 record 显式调，但没人会）。
export interface SlowQueryEntry {
    /** 归一化后的 SQL 摘要（字面量已替换成 ?，超长截断） */
    sql: string;
    /** 语句类型：select / insert / update / delete / other */
    kind: string;
    /** 本次耗时（毫秒，一位小数） */
    ms: number;
    /** 返回/影响的行数（拿不到就 -1） */
    rows: number;
    /** 绑定参数个数（不记值） */
    params: number;
    /** 打点时刻（Date.now()） */
    at: number;
    /** 这条摘要累计触发的慢查询次数 */
    hits: number;
}

/** 默认阈值：计划口径 >50ms。一次全表扫、一次没有索引的排序都会落进来。 */
const DEFAULT_THRESHOLD_MS = 50;
/** 环形缓冲容量 */
const RING = 50;
/** 同一条摘要打日志的间隔：第 1 次、第 20 次、第 40 次…… */
const REPEAT_LOG_EVERY = 20;

/**
 * 阈值。**每次调用都重新读 env**，不缓存。
 * ⚠️ 为什么不在模块加载时读一次：那样测试没法覆盖「阈值行为」（得靠改进程启动参数），
 *    而这里的行为恰恰是最容易写错的地方（0 是「关闭」还是「全都记」、NaN 怎么办）。
 *    代价只是一条慢查询一次字符串查表 —— 快路径（未越线）根本走不到这里。
 * ⚠️ 语义：>= 阈值才记；阈值 ≤ 0 = 关闭打点（不是「全都记」），
 *    显式设 0 是运维上最常用的「先关掉，回头再说」。
 */
function thresholdMs(): number {
    const raw = process.env.NAVIHIVE_SLOW_QUERY_MS;
    if (raw === undefined) return DEFAULT_THRESHOLD_MS;
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_THRESHOLD_MS;
}

const buffer: SlowQueryEntry[] = [];
/** 摘要 → 累计次数。Map 不设上限：摘要种类受 SQL 文本种类限制，实际至多几百个 */
const hits = new Map<string, number>();
/** 摘要 → 已打过日志的次数（用来限流） */
const logged = new Map<string, number>();

export function slowQueryThresholdMs(): number {
    return thresholdMs();
}

/** 打点是否启用（阈值 > 0） */
export function slowQueryEnabled(): boolean {
    return thresholdMs() > 0;
}

/**
 * SQL → 摘要：
 *   - 折叠空白（源码里带缩进的多行 SQL 会占满一行日志）
 *   - 字符串字面量 → ?（'x' 与 "x"，含转义的 ''）
 *   - 数字字面量 → ?（in (1,2,3) 这类每次都不同，会让「同一条语句」变成几百条）
 *   - 超长截断
 * ⚠️ 不做语法解析：真解析要引 SQL parser，几十 KB 换一个「更好看的摘要」不值。
 *    这里的目的是「认得出这是同一条语句」，不是「还原语义」。
 */
export function sqlDigest(sql: string, maxLen = 160): string {
    const collapsed = sql.replace(/\s+/g, " ").trim();
    const masked = collapsed
        .replace(/'(?:[^']|'')*'/g, "?")
        .replace(/"(?:[^"]|"")*"/g, "?")
        .replace(/\b\d+(?:\.\d+)?\b/g, "?");
    return masked.length > maxLen ? `${masked.slice(0, maxLen - 1)}…` : masked;
}

/** 语句类型：取第一个有意义的词（SQL 前面可能有 WITH / 注释，先剥掉行注释） */
function sqlKind(sql: string): string {
    const head = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const m = head.match(/^(select|insert|update|delete|with|pragma|replace)\b/);
    return m ? m[1] : "other";
}

/**
 * 记一条慢查询。调用方负责先判断耗时是否越线 —— 阈值判断放在这里也行，
 * 但打点是在每条 SQL 的热路径上，多一次函数调用不如让调用方用 `if (ms > t)` 跳过。
 */
export function recordSlowQuery(args: {
    sql: string;
    ms: number;
    rows?: number;
    params?: number;
}): SlowQueryEntry | null {
    if (!slowQueryEnabled()) return null;
    const sql = sqlDigest(args.sql);
    const kind = sqlKind(args.sql);
    const at = Date.now();
    const hitsSoFar = (hits.get(sql) ?? 0) + 1;
    hits.set(sql, hitsSoFar);

    const entry: SlowQueryEntry = {
        sql,
        kind,
        ms: Math.round(args.ms * 10) / 10,
        rows: args.rows ?? -1,
        params: args.params ?? 0,
        at,
        hits: hitsSoFar,
    };
    buffer.push(entry);
    if (buffer.length > RING) buffer.shift();

    // 限流：首次必打；之后每 REPEAT_LOG_EVERY 次打一次
    const loggedSoFar = logged.get(sql) ?? 0;
    if (loggedSoFar === 0 || hitsSoFar - loggedSoFar >= REPEAT_LOG_EVERY) {
        logged.set(sql, hitsSoFar);
        console.warn(
            `[slow-query] ${entry.ms}ms ${kind} rows=${entry.rows} params=${entry.params} ` +
                `hits=${hitsSoFar} :: ${sql}`
        );
    }
    return entry;
}

/** 最近的慢查询（新的在后）。给 /api/system/slow-queries 用，owner only。 */
export function slowQuerySnapshot(limit = 50): SlowQueryEntry[] {
    return buffer.slice(-Math.max(0, Math.min(limit, RING)));
}

/** 汇总视图：按摘要聚合，先看谁最慢/最多 —— 排障时比一条条翻有用 */
export function slowQuerySummary(limit = 10): Array<{
    sql: string;
    kind: string;
    hits: number;
    maxMs: number;
    avgMs: number;
    lastAt: number;
}> {
    const agg = new Map<
        string,
        { sql: string; kind: string; hits: number; maxMs: number; totalMs: number; lastAt: number }
    >();
    for (const e of buffer) {
        const cur = agg.get(e.sql);
        if (!cur) {
            agg.set(e.sql, {
                sql: e.sql,
                kind: e.kind,
                hits: 1,
                maxMs: e.ms,
                totalMs: e.ms,
                lastAt: e.at,
            });
        } else {
            cur.hits += 1;
            cur.maxMs = Math.max(cur.maxMs, e.ms);
            cur.totalMs += e.ms;
            cur.lastAt = Math.max(cur.lastAt, e.at);
        }
    }
    return [...agg.values()]
        .map(a => ({
            sql: a.sql,
            kind: a.kind,
            hits: a.hits,
            maxMs: a.maxMs,
            avgMs: Math.round((a.totalMs / a.hits) * 10) / 10,
            lastAt: a.lastAt,
        }))
        .sort((x, y) => y.maxMs - x.maxMs)
        .slice(0, limit);
}

/** 测试用：清空缓冲与计数器 */
export function resetSlowQueries(): void {
    buffer.length = 0;
    hits.clear();
    logged.clear();
}
