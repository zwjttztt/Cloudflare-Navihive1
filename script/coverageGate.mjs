// script/coverageGate.mjs
// 覆盖率门禁的**判定**部分：只回答「这一轮该不该红、退出码多少、红在哪」。
//
// 为什么要把判定从 coverage.mjs 里抽出来（2026-11-04，审查项 R13）：
//   原来的 coverage.mjs 把「判定」揉在「跑 esbuild / 起 c8 子进程 / 打印表格」的
//   流程中间，于是判定本身**没法被测**。后果是它有两条**静默放行**的路径，而且一直
//   没人发现 —— 因为它们只在「没有数据」的时候生效，而当时代码把「没有数据」当成了
//   「没问题」：
//     1. `require.resolve("c8/bin/c8.js")` 失败（依赖没装）时走 `process.exit(gateFailed ? 1 : 0)`
//        —— 只要第 1 层过，门禁照过，第 2 层根本没跑也没人知道；
//     2. `reportLayer2()` 读不到 / 读坏 coverage-summary.json 时 `return { failed: false }`
//        —— 单测跑挂了导致没产物，反而算「通过」。
//   门禁在「量不到」的时候放行，等于没有门禁：真出问题的那一轮恰好就是量不到的那一轮。
//
// 现在这里只有一个纯函数（无 fs、无 console、无 process），判据全部 fail-closed：
//   **任何一个「量不到」的分支都是退出码 1，并把原因写进 reasons 让人看见。**
// 唯一能跳第 2 层的口子是显式开关 --layer1-only（见 parseCoverageArgs），
// 它不放松第 1 层，只少判一层，且必须在输出里标注「本轮只判 import 覆盖」——
// 免得有人拿它当默认值把门禁掏空。
//
// 逻辑与注释以本文件为准；类型声明见 script/coverageGate.d.mts（给 tests/ 的 TS 用例用）。

/** 唯一认识的 CLI 开关：只跑第 1 层（import 触及率），跳过 c8 行覆盖率 */
export const LAYER1_ONLY_FLAG = "--layer1-only";

/**
 * 解析 CLI 参数。
 *
 * 不认识的 `-x` / `--x` 一律收进 `unknown` 让调用方报错退出 —— 否则把
 * `--layer1_only`（下划线打错）当成默默忽略，人会以为「已经只跑第 1 层了」，
 * 实际两层全跑了一遍（几分钟），还得不出他想要的结论。
 *
 * @param {readonly string[]} argv 已去掉 node 与脚本路径的参数表
 * @returns {{ layer1Only: boolean, unknown: string[] }}
 */
export function parseCoverageArgs(argv = []) {
    const parsed = { layer1Only: false, unknown: [] };
    if (!Array.isArray(argv)) return parsed;
    for (const arg of argv) {
        if (typeof arg !== "string") continue;
        if (arg === LAYER1_ONLY_FLAG) parsed.layer1Only = true;
        else if (arg.startsWith("-")) parsed.unknown.push(arg);
    }
    return parsed;
}

/**
 * 覆盖率门禁的唯一判定入口。
 *
 * 所有入参都是「事实」，不是「结论」：调用方负责跑 esbuild / c8 / 读文件，
 * 这里只负责把它们翻译成退出码与原因。这样判定就能被表驱动用例钉住。
 *
 * fail-closed 判据（`layer1Only` 为 false 时，任一命中即退出码 1）：
 *   - c8 没装（`c8Missing`）—— 这一轮没有行覆盖率数据；
 *   - summary 文件不存在（`summaryMissing`）；
 *   - summary 读不出来 / JSON.parse 失败（`summaryReadError`）；
 *   - 聚合后 `linesTotal === 0` —— 一条行统计都没有，等于没测到；
 *   - 第 2 层任何一条跌破地板（`l2Breaches`）。
 * 另外第 1 层（`l1Failed`）无论哪种模式都必须过。
 *
 * @param {{
 *   l1Failed?: boolean,
 *   c8Missing?: boolean,
 *   summaryMissing?: boolean,
 *   summaryReadError?: string | null,
 *   linesTotal?: number,
 *   l2Breaches?: readonly string[],
 *   layer1Only?: boolean,
 * }} [input]
 * @returns {{ exitCode: 0 | 1, reasons: string[], notes: string[], layer1Only: boolean }}
 */
export function decideCoverageExit(input = {}) {
    const {
        l1Failed = false,
        c8Missing = false,
        summaryMissing = false,
        summaryReadError = null,
        linesTotal = 0,
        l2Breaches = [],
        layer1Only = false,
    } = input ?? {};

    const isLayer1Only = layer1Only === true;
    /** 只放「为什么红」，一条一条印出来让人能照着修 */
    const reasons = [];
    /** 只放「本轮结论的适用范围」，不是失败理由 */
    const notes = [];

    if (isLayer1Only) {
        notes.push(
            `第 2 层（c8 真行覆盖率）已按 ${LAYER1_ONLY_FLAG} 跳过，本轮只判 import 覆盖` +
                `（文件被 import 过 ≠ 跑过多少行，本轮没有行覆盖率数据）。`
        );
        notes.push("第 1 层照常判定：import 触及率不达标照样退出码 1。");
    }

    if (l1Failed) {
        reasons.push("第 1 层（文件触及率）有分层跌破下限 —— 见上面「覆盖率分层门禁未通过」那段。");
    }

    if (!isLayer1Only) {
        if (c8Missing) {
            // 缺 c8 时后面的 summary 检查必然是「不存在」，那是同一件事的后果，
            // 重复报一遍只会让真正的原因埋进噪音里 —— 只说缺 c8。
            reasons.push(
                "c8 没装：这一轮没有行覆盖率数据，门禁不通过（退出码 1）。" +
                    "装依赖后再跑一次：npm i -D c8"
            );
        } else if (summaryReadError) {
            reasons.push(
                `coverage/coverage-summary.json 读不出来或解析失败（${summaryReadError}）：` +
                    "这一轮没有行覆盖率数据，门禁不通过。"
            );
        } else if (summaryMissing) {
            reasons.push(
                "coverage/coverage-summary.json 不存在：这一轮没有行覆盖率数据，门禁不通过" +
                    "（通常是单测本身挂了，看上面 c8 的输出）。"
            );
        } else if (!(typeof linesTotal === "number" && linesTotal > 0)) {
            reasons.push(
                `第 2 层聚合后 lines.total === 0（实得 ${String(linesTotal)}）：` +
                    "一条行统计都没有，等于没测到，门禁不通过。"
            );
        }

        const breachList = Array.isArray(l2Breaches) ? l2Breaches : [];
        for (const breach of breachList) {
            if (typeof breach === "string" && breach.length > 0) reasons.push(breach);
        }
    }

    return {
        exitCode: reasons.length > 0 ? 1 : 0,
        reasons,
        notes,
        layer1Only: isLayer1Only,
    };
}
