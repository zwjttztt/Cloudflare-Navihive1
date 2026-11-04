// script/perfGate.d.mts
// perfGate.mjs 的类型声明。
//
// 为什么需要它：判据本身是 .mjs（node 直接跑、里面不能写 TS 标注），
// 而 `tests/perfAuditGate.test.ts` 要 import 它 —— 没有这份声明，strict 模式下
// 会报 TS7016（implicit any）。与 `script/bundleBudgetGate.d.mts` 同一套做法。
// 逻辑与注释以 `script/perfGate.mjs` 为准，这里只描述形状。

/** 允许的采样模式 */
export declare const PERF_MODES: readonly ["cold", "warm", "both"];

/** 默认模式：两组都跑 */
export declare const DEFAULT_PERF_MODE: "both";

/** 组名 → 中文标签 */
export declare const GROUP_LABELS: { readonly cold: "冷启动"; readonly warm: "回访" };

/** 用法文本（非法参数时原样打印） */
export declare const PERF_USAGE: string;

/** 逐轮采样（由 perf-audit.mjs 采集后交给 summarizeGroup） */
export interface PerfRound {
    round: number;
    fcp: number;
    lcp: number;
    cls: number;
    ttfb: number;
    domContentLoaded: number;
    transferredKb: number;
    resources: number;
    pageErrors: string[];
}

/** 一组的汇总结果 */
export interface PerfGroupResult {
    /** 计入统计的轮数 */
    rounds: number;
    /** 实际导航轮数（含预热轮） */
    sampledRounds: number;
    /** 是否真的剔掉了预热轮 */
    warmupDropped: boolean;
    /** 被剔掉的预热轮原始数据 */
    warmupRound: PerfRound | null;
    fcp: number;
    lcp: number;
    fcpMin: number;
    fcpMax: number;
    lcpMin: number;
    lcpMax: number;
    /** 门禁用的 CLS：所有轮次（含预热轮）的最大值 */
    cls: number;
    /** 参考值：只算计入轮次的最大值 */
    clsCounted: number;
    /** 最差 CLS 出现在第几轮 */
    clsWorstRound: number | null;
    ttfb: number;
    domContentLoaded: number;
    transferredKb: number;
    resources: number;
    pageErrors: string[];
    rows: { round: number; fcp: number; lcp: number; cls: number }[];
}

/** 一组的预算（毫秒 / 无量纲） */
export interface PerfBudget {
    fcp: number;
    lcp: number;
    cls: number;
}

/** 冷热各自的预算表 */
export interface PerfBudgets {
    cold: PerfBudget;
    warm: PerfBudget;
}

export interface ParsePerfModeOk {
    ok: true;
    mode: "cold" | "warm" | "both";
    source: string;
}

export interface ParsePerfModeError {
    ok: false;
    error: string;
}

/** 从 argv 解析 `--mode`（非法值返回 ok:false，不静默回退默认值） */
export declare function parsePerfMode(argv: readonly string[]): ParsePerfModeOk | ParsePerfModeError;

/** 中位数；空数组返回 0 */
export declare function median(values: readonly number[]): number;

/** 错误去重（保序） */
export declare function dedupeErrors(errors: readonly unknown[] | undefined | null): string[];

/** 把逐轮采样汇总成一组数字 */
export declare function summarizeGroup(
    rounds: readonly Partial<PerfRound>[] | undefined | null,
    options?: { dropWarmup?: boolean }
): PerfGroupResult;

export interface DecidePerfInput {
    mode: string;
    cold?: PerfGroupResult | null;
    warm?: PerfGroupResult | null;
    budgets: Partial<Record<"cold" | "warm", PerfBudget>>;
    reportOnly?: boolean;
}

export interface DecidePerfVerdict {
    /** 0 = 放行；1 = 拦下 */
    exitCode: number;
    /** 未达标项（reportOnly 下照样列出，只是不换算成退出码） */
    failures: string[];
    /** 口径说明与「本轮不阻断」这类告知，不参与判定 */
    notes: string[];
}

/** 门禁的唯一判定入口 */
export declare function decidePerf(input: DecidePerfInput): DecidePerfVerdict;
