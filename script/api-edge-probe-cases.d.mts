// script/api-edge-probe-cases.d.mts
// api-edge-probe-cases.mjs 的类型声明。
//
// 为什么需要它：case 表本身是 .mjs（node 直接跑，里面不能写 TS 标注），但
// tests/apiEdgeProbeSpec.test.ts 要 import 它做结构守卫 —— 没有这份声明，
// strict 模式下测试会报 TS7016（implicit any）。逻辑与注释以 .mjs 为准，
// 这里只是同一份契约的类型投影。

/** 一条边界探测 case。 */
export interface ProbeCase {
    method: string;
    /** `/api/` 之后的路径（含 query） */
    path: string;
    /** `undefined` = 不带请求体；`null` = 带 JSON `null`（两者语义不同，必须能区分） */
    body?: unknown;
    /** 允许的状态码集合（必填、非空） */
    expect: number[];
    /** 这条在探什么 */
    why: string;
    /** "none" = 故意不带会话 */
    auth?: "none";
    /** 已知的可疑行为 / 顺序依赖，仅作文档 */
    note?: string;
}

/** 造 case 表用的运行期上下文（都可缺省） */
export interface ProbeCaseContext {
    longInput?: string;
    noteId?: number;
}

/** 10 万字符的超长输入 */
export declare const LONG_INPUT: string;

/** 失败时打印的响应体长度上限 */
export declare const BODY_PREVIEW_CHARS: number;

/** 守卫测试用的 case 条数下限 */
export declare const MIN_CASES: number;

/** 故意不带会话的标记值 */
export declare const AUTH_NONE: "none";

/** 造一张 case 表（目前与上下文无关，保留工厂签名供以后注入运行期 id） */
export declare function buildCases(ctx?: ProbeCaseContext): ProbeCase[];
