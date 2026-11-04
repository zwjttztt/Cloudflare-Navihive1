// script/bundleBudgetGate.d.mts
// bundleBudgetGate.mjs 的类型声明。
//
// 为什么需要它：判据本身是 .mjs（node 直接跑、里面不能写 TS 标注），
// 而 tests/bundleBudget.test.ts 与 tests/bundleBudgetGate.test.ts 要 import 它 ——
// 没有这份声明，strict 模式下会报 TS7016（implicit any）。
// 逻辑与注释以 .mjs 为准，这里只描述形状。

/** 显式打开 strict 的环境变量名 */
export declare const STRICT_ENV_FLAG: "NAVIHIVE_BUDGET_STRICT";
/** npm 跑 `check:budget` 这个 script 时自动注入的 lifecycle 名 */
export declare const STRICT_LIFECYCLE_EVENT: "check:budget";

/** strict 是被谁打开的；null = 非 strict */
export declare function strictModeSource(
    env?: Record<string, string | undefined> | null
): string | null;

/** 当前是否 strict 模式 */
export declare function isStrictMode(env?: Record<string, string | undefined> | null): boolean;

/** 从 index.html 取出首屏必下的资产名（去重、保序） */
export declare function assetRefsFromHtml(html?: string | null): string[];

export interface FirstScreenFile {
    name: string;
    rawKb: number;
    gzipKb: number;
}

export interface FirstScreenMeasure {
    htmlMissing: boolean;
    refs: string[];
    files: FirstScreenFile[];
    missingAssets: string[];
    rawKb: number;
    gzipKb: number;
}

export interface MeasureFirstScreenIo {
    html: string | null | undefined;
    readAsset: (name: string) => Buffer | Uint8Array | null | undefined;
    gzip?: (buf: Buffer) => number;
}

/** 量一次首屏；IO 全部由调用方注入，便于用假 fs 走 strict 的失败分支 */
export declare function measureFirstScreen(io: MeasureFirstScreenIo): FirstScreenMeasure;

/** 量不了时返回一句能直接照做的话；量得全返回 null */
export declare function firstScreenProblem(measure: FirstScreenMeasure): string | null;

export type BudgetGateAction = "measure" | "fail" | "skip";

export interface BudgetGateVerdict {
    /** measure = 量全了；fail = strict 下量不到（不许跳过）；skip = 非 strict 下量不到 */
    action: BudgetGateAction;
    /** 量不到的原因（action === "measure" 时为 null） */
    reason: string | null;
    strict: boolean;
    /** strict 是被谁打开的（null = 非 strict），用于失败信息 */
    strictSource: string | null;
}

/** 体积门禁的唯一判定入口：量全了？量不到时该跳过还是该红？ */
export declare function decideBudgetGate(
    measure: FirstScreenMeasure,
    env?: Record<string, string | undefined> | null
): BudgetGateVerdict;
