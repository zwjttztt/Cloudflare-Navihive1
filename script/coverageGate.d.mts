// script/coverageGate.d.mts
// coverageGate.mjs 的类型声明。
//
// 为什么需要它：判定逻辑本身是 .mjs（node 直接跑、里面不能写 TS 标注），
// 而 tests/coverageGateFailClosed.test.ts 要 import 它的纯函数做表驱动断言 ——
// 没有这份声明，strict 模式下测试会报 TS7016（implicit any）。
// 逻辑与注释以 .mjs 为准，这里只描述形状。

/** 唯一认识的 CLI 开关：只跑第 1 层（import 触及率），跳过 c8 行覆盖率 */
export declare const LAYER1_ONLY_FLAG: "--layer1-only";

export interface CoverageArgs {
    layer1Only: boolean;
    unknown: string[];
}

/** 解析 CLI 参数；不认识的 `-x` 收进 unknown，由调用方报错退出 */
export declare function parseCoverageArgs(argv?: readonly string[]): CoverageArgs;

export interface CoverageGateInput {
    /** 第 1 层（任一分层触及率跌破下限） */
    l1Failed?: boolean;
    /** c8 没装 */
    c8Missing?: boolean;
    /** coverage-summary.json 不存在 */
    summaryMissing?: boolean;
    /** 读不出来 / JSON.parse 失败的原因（有值即失败） */
    summaryReadError?: string | null;
    /** 聚合后的行统计总数（0 视为「没测到」） */
    linesTotal?: number;
    /** 第 2 层跌破地板的描述列表 */
    l2Breaches?: readonly string[];
    /** 显式 `--layer1-only`：跳过第 2 层判定，并在 notes 里标注 */
    layer1Only?: boolean;
}

export interface CoverageGateResult {
    /** 0 = 通过；1 = 不过 */
    exitCode: 0 | 1;
    /** 失败原因（每条可直接印出来让人照着修） */
    reasons: string[];
    /** 本轮结论的适用范围说明（不是失败理由） */
    notes: string[];
    layer1Only: boolean;
}

/** 覆盖率门禁的唯一判定入口（纯函数：不改文件、不打印、不读 process） */
export declare function decideCoverageExit(input?: CoverageGateInput): CoverageGateResult;
