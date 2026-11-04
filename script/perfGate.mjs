// script/perfGate.mjs
// 首屏体感门禁的**判据**：只回答「这次该不该红、红在哪一条」，不采样、不打印、不退出进程。
//
// 为什么抽出来（2026-11-04，审查项 R14「性能首访证据不足」）：
//   原来的 `perf-audit.mjs` 把采样、判据、打印、退出码揉在一个 `main()` 里，后果是三件事：
//     ① 冷启动与回访混在一份中位数里 —— 同一个浏览器会话连跑多轮，HTTP 缓存首轮就预热了，
//        中位数反映的是「回访」体感，却又不完全是（首轮冷态也被算进了中位数）；
//     ② CLS 只打印不断言，而且取的是**最后一轮**的值 —— 最差那一轮恰好被漏掉；
//     ③ `--json` 模式下 `if (failures.length && !JSON_ONLY)` 把失败输出整段跳过，
//        退出码还是 0 —— JSON 模式等于静默成功，而这恰恰是自动化最常用的那档。
//   判据抽成纯函数之后，上面每一条都能被 `tests/perfAuditGate.test.ts` 表驱动钉住，
//   不需要起浏览器、不需要 dist 产物。
//
// 逻辑与注释以本文件为准；类型声明见 `script/perfGate.d.mts`（给 tests/ 的 TS 用例用）。

/**
 * 允许的采样模式。
 *   · `cold`：冷启动。每轮导航前清空 HTTP 缓存 + Service Worker / Cache Storage；
 *   · `warm`：回访。保留缓存，**首轮只作预热**、不计入中位数；
 *   · `both`：两组各出一份结果（默认）。
 */
export const PERF_MODES = ["cold", "warm", "both"];

/** 默认两组都跑：只报一组的话，另一组退步了也看不见 */
export const DEFAULT_PERF_MODE = "both";

/** 组名 → 中文标签（打印与失败信息共用，避免「冷/热」两种叫法漂开） */
export const GROUP_LABELS = { cold: "冷启动", warm: "回访" };

/** 用法文本：非法参数时原样打印，不做静默回退 */
export const PERF_USAGE = [
    "用法：node script/perf-audit.mjs [--mode=cold|warm|both] [--json] [--report-only]",
    "",
    "  --mode=cold     冷启动：每轮导航前清空 HTTP 缓存 + Service Worker / Cache Storage，",
    "                  量的是「第一次来的用户」看到的速度",
    "  --mode=warm     回访：保留 HTTP 缓存，首轮只作预热不计入统计，",
    "                  量的是「第二次及以后」的稳态体感",
    "  --mode=both     两组都跑、各自一份预算（默认）",
    "  --json          只把结果写成 JSON（失败**仍然**以非零退出码表示）",
    "  --report-only   报告模式：列出未达标项但退出码 0（必须显式传，不传就是会拦）",
    "",
    "环境变量：PERF_ROUNDS=1..9（默认 3）· CHROME_PATH（指定 Chrome 路径）",
].join("\n");

/**
 * 从 argv 里解析 `--mode`。
 *
 * 三种写法都认：`--mode=cold`、`--mode cold`、不写（用默认值）。
 * **非法值直接返回 ok:false** —— 不做静默回退。理由很实在：`--mode=coll` 这种手误
 * 一旦回退成默认的 `both`，跑出来的是一份「看起来没问题」的报告，而人以为自己量的是冷启动。
 * 大小写不敏感（`COLD` 也收），但归一化后必须落在 PERF_MODES 里。
 *
 * @param {string[]} argv 进程参数（通常就是 process.argv）
 * @returns {{ ok: true, mode: string, source: string } | { ok: false, error: string }}
 */
export function parsePerfMode(argv) {
    const args = Array.isArray(argv) ? argv.map(String) : [];
    let raw = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--mode") {
            const next = args[i + 1];
            // `--mode` 后面跟另一个开关：这不是「没给值」，是给错了，别猜
            if (next === undefined || next === "" || next.startsWith("-")) {
                return { ok: false, error: "--mode 后面缺少值（应为 cold / warm / both）" };
            }
            raw = next;
            i++;
            continue;
        }
        if (arg.startsWith("--mode=")) {
            raw = arg.slice("--mode=".length);
            continue;
        }
    }
    if (raw === null) return { ok: true, mode: DEFAULT_PERF_MODE, source: "默认值" };
    const mode = raw.trim().toLowerCase();
    if (!PERF_MODES.includes(mode)) {
        return { ok: false, error: `--mode 的值非法：${JSON.stringify(raw)}（应为 ${PERF_MODES.join(" / ")}）` };
    }
    return { ok: true, mode, source: "--mode" };
}

/**
 * 中位数（对 CI 偶发的 GC / 调度抖动不敏感）。
 * 空数组返回 0 —— 调用方靠 0 认出「量不到」，不要返回 NaN 让比较静默失效。
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
    const nums = (Array.isArray(values) ? values : []).map(toNumber).filter(v => Number.isFinite(v));
    if (nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** 把任何输入变成有限数字；不是有限数字就给 0 */
function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 错误去重（保序）。
 *
 * 为什么要去重：`pageErrors` 来自 CDP 的 `Runtime.exceptionThrown` / `console.error`，
 * 是**跨导航累积**的。同一个错误在每一轮都会重放一次，flatMap 之后就成了「页面有 7 条运行时报错」
 * —— 数字被轮数放大，看的人只会以为出了 7 个不同的问题。
 * 去重口径用完全相同的字符串：同一个错误的堆栈在同一个构建里是稳定的，
 * 不做模糊匹配（模糊匹配会把两个真的不同的错误并成一个，那是另一种失真）。
 *
 * @param {unknown[]} errors
 * @returns {string[]} 去重后的错误，保持首次出现顺序
 */
export function dedupeErrors(errors) {
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(errors) ? errors : []) {
        const text = String(raw ?? "").trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

/**
 * 把一组逐轮采样汇总成「这一组的一组数字」。
 *
 * 口径（**这里是 R14 的核心，改之前先读完整段**）：
 *   · `fcp` / `lcp`：**只统计计入轮次**（回访组的第一轮是预热，剔掉）的中位数。
 *     理由：首轮冷态与后续轮次不是同一个分布，混在一起取中位数，
 *     得到的既不是冷启动也不是回访 —— 那正是审查说的「偏回访又不完全是回访」。
 *   · `cls`：**该组所有轮次的最大值**（含预热轮）。CLS 是「最差一次」指标，
 *     不是「稳态」指标；丢掉最差那一轮等于把门禁最该抓的东西扔掉。
 *     同时给出 `clsCounted`（只算计入轮次的最大值）作参考，两个数都在报告里。
 *   · `pageErrors`：所有轮次（含预热轮）去重后的并集。页面坏没坏与缓存冷热无关，
 *     预热轮抛的错也是错。
 *   · 参考项（TTFB / DCL / 传输量 / 请求数）取**最后一个计入轮次**的值 —— 它们是
 *     快照量，不参与判定，取哪个都行，取最后一轮与「稳态」语义一致。
 *
 * @param {Array<object>} rounds 逐轮采样（`{ round, fcp, lcp, cls, ttfb, domContentLoaded, transferredKb, resources, pageErrors }`）
 * @param {{ dropWarmup?: boolean }} [options] `dropWarmup:true` 时首轮只作预热
 * @returns {object} 汇总结果（形状见 script/perfGate.d.mts 的 PerfGroupResult）
 */
export function summarizeGroup(rounds, options = {}) {
    const all = (Array.isArray(rounds) ? rounds : []).filter(r => r && typeof r === "object");
    const dropWarmup = options.dropWarmup === true;
    // 只有 1 轮时「剔掉预热」会把唯一的样本剔没 —— 宁可保留它并把标记置为 false，
    // 让报告自己说出「这次没剔预热」，也不要产出一组空数字（空数字长得像「全过」）。
    const canDrop = dropWarmup && all.length > 1;
    const warmup = canDrop ? all[0] : null;
    const counted = canDrop ? all.slice(1) : all;

    const fcpSeries = counted.map(r => toNumber(r.fcp));
    const lcpSeries = counted.map(r => toNumber(r.lcp));
    const clsAllSeries = all.map(r => toNumber(r.cls));
    const clsCountedSeries = counted.map(r => toNumber(r.cls));
    const last = counted.length > 0 ? counted[counted.length - 1] : {};

    // 最差 CLS 落在第几轮 —— 只报最大值时人没法回查那一轮的明细
    let clsWorstRound = null;
    if (clsAllSeries.length > 0) {
        let worstIdx = 0;
        for (let i = 1; i < clsAllSeries.length; i++) {
            if (clsAllSeries[i] > clsAllSeries[worstIdx]) worstIdx = i;
        }
        clsWorstRound = all[worstIdx].round ?? worstIdx + 1;
    }

    return {
        /** 计入统计的轮数（回访组 = 导航轮数 - 1） */
        rounds: counted.length,
        /** 实际导航轮数（含预热轮） */
        sampledRounds: all.length,
        /** 是否真的剔掉了预热轮（只有 1 轮时为 false） */
        warmupDropped: canDrop,
        /** 被剔掉的预热轮原始数据（没剔就是 null），以便回查 */
        warmupRound: warmup,
        fcp: median(fcpSeries),
        lcp: median(lcpSeries),
        fcpMin: fcpSeries.length ? Math.min(...fcpSeries) : 0,
        fcpMax: fcpSeries.length ? Math.max(...fcpSeries) : 0,
        lcpMin: lcpSeries.length ? Math.min(...lcpSeries) : 0,
        lcpMax: lcpSeries.length ? Math.max(...lcpSeries) : 0,
        /** 门禁用的 CLS：所有轮次（含预热轮）的最大值 */
        cls: clsAllSeries.length ? Math.max(...clsAllSeries) : 0,
        /** 参考值：只算计入轮次的最大值 */
        clsCounted: clsCountedSeries.length ? Math.max(...clsCountedSeries) : 0,
        /** 最差 CLS 出现在第几轮 */
        clsWorstRound,
        ttfb: toNumber(last.ttfb),
        domContentLoaded: toNumber(last.domContentLoaded),
        transferredKb: toNumber(last.transferredKb),
        resources: toNumber(last.resources),
        pageErrors: dedupeErrors(all.flatMap(r => (Array.isArray(r.pageErrors) ? r.pageErrors : []))),
        /** 逐轮明细（只列计入轮次），给报告里的 details 表用 */
        rows: counted.map(r => ({
            round: r.round ?? 0,
            fcp: toNumber(r.fcp),
            lcp: toNumber(r.lcp),
            cls: toNumber(r.cls),
        })),
    };
}

/**
 * 校验一组预算是否可用。返回问题描述，没问题返回 null。
 *
 * 预算缺失时**必须红**：`undefined > 5000` 是 false，一条写成 undefined 的预算
 * 会让门禁静默放行 —— 与「JSON 模式静默成功」是同一类错误。
 *
 * @param {unknown} budget
 * @returns {string | null}
 */
function budgetProblem(budget) {
    if (!budget || typeof budget !== "object") return "预算对象缺失";
    for (const key of ["fcp", "lcp", "cls"]) {
        const value = budget[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            return `预算 ${key} 不是正数（拿到 ${JSON.stringify(value)}）`;
        }
    }
    // CLS 是无量纲的比值，超过 1 基本等于「整页在跳」；这个上限是为了拦住
    // 「把 CLS 预算写成 100 等于没设」这类放水
    if (budget.cls >= 1) return `预算 cls=${budget.cls} 不小于 1，等于没有门禁（CLS 是无量纲比值）`;
    return null;
}

/**
 * 首屏体感门禁的**唯一判定入口**。
 *
 * @param {{
 *   mode: string,
 *   cold?: object | null,
 *   warm?: object | null,
 *   budgets: Record<string, { fcp: number, lcp: number, cls: number }>,
 *   reportOnly?: boolean,
 * }} input
 * @returns {{ exitCode: number, failures: string[], notes: string[] }}
 *   · `exitCode`：0 = 放行；1 = 拦下
 *   · `failures`：未达标项（`reportOnly` 下**照样列出**，只是不换算成退出码）
 *   · `notes`：口径说明与「本轮不阻断」这类告知，不参与判定
 */
export function decidePerf(input) {
    const data = input && typeof input === "object" ? input : {};
    const mode = typeof data.mode === "string" ? data.mode : "";
    const budgets = data.budgets && typeof data.budgets === "object" ? data.budgets : {};
    const reportOnly = data.reportOnly === true;
    const failures = [];
    const notes = [];

    // ---- ① 模式本身非法：用法错误，与预算无关，reportOnly 也不放行 ----
    // 这一条排在 reportOnly 之前，是刻意的：`--report-only --mode=coll` 是**参数给错了**，
    // 不是「这次先不拦」。参数错却退出 0，等于把人手误藏进绿里。
    if (!PERF_MODES.includes(mode)) {
        failures.push(
            `--mode 非法或缺失：${JSON.stringify(mode)}（应为 ${PERF_MODES.join(" / ")}）` +
                `\n${PERF_USAGE}`
        );
        return { exitCode: 1, failures, notes };
    }

    /** 这次要判定哪几组 */
    const groups = mode === "both" ? ["cold", "warm"] : [mode];
    notes.push(`判定模式：${mode}（${groups.map(g => GROUP_LABELS[g]).join(" + ")}）`);

    for (const group of groups) {
        const label = GROUP_LABELS[group];
        const result = group === "cold" ? data.cold : data.warm;
        const budget = budgets[group];

        // ---- ② 预算必须可用（缺了就是缺了，不许当成「没超」）----
        const badBudget = budgetProblem(budget);
        if (badBudget) {
            failures.push(`${label}组${badBudget}`);
            continue;
        }

        // ---- ③ 结果必须真的采到了 ----
        if (!result || typeof result !== "object") {
            failures.push(
                `没有${label}组的采样结果（--mode=${mode} 要求这一组必须有数据）——` +
                    `采样失败时不许当作通过`
            );
            continue;
        }

        // 量不到 FCP / LCP 与「超预算」是两件事：前者说明观察器没装上或页面没渲染内容，
        // 后者说明真的慢。分开报，看到的人才知道该去查哪里。
        if (!Number.isFinite(result.fcp) || result.fcp <= 0) {
            failures.push(`${label}组量不到 FCP（观察器没装上，或页面根本没渲染内容）`);
        } else if (result.fcp > budget.fcp) {
            failures.push(`${label}组 FCP 中位数 ${result.fcp}ms 超过预算 ${budget.fcp}ms`);
        }
        if (!Number.isFinite(result.lcp) || result.lcp <= 0) {
            failures.push(`${label}组量不到 LCP（页面没有可测的大块内容，或观察器没装上）`);
        } else if (result.lcp > budget.lcp) {
            failures.push(`${label}组 LCP 中位数 ${result.lcp}ms 超过预算 ${budget.lcp}ms`);
        }
        if (!Number.isFinite(result.cls)) {
            failures.push(`${label}组没有 CLS 采样`);
        } else if (result.cls > budget.cls) {
            failures.push(
                `${label}组 CLS 最大值 ${result.cls} 超过预算 ${budget.cls}` +
                    `${result.clsWorstRound ? `（最差在第 ${result.clsWorstRound} 轮）` : ""}`
            );
        }
        // 页面自己是坏的（抛异常）时，FCP/LCP 可能很好看 —— 那是假绿。
        // 两个既有审计脚本（a11y / visual）也拿 pageErrors 当判据，这里保持一致。
        const pageErrors = Array.isArray(result.pageErrors) ? result.pageErrors : [];
        if (pageErrors.length > 0) {
            failures.push(`${label}组页面有 ${pageErrors.length} 条运行时报错：${pageErrors[0]}`);
        }

        if (result.warmupDropped === true) {
            notes.push(`${label}组：首轮作缓存预热，未计入中位数（计入 ${result.rounds} 轮）`);
        } else if (result.rounds > 0) {
            notes.push(`${label}组：${result.rounds} 轮全部计入中位数（无预热轮）`);
        }
    }

    // ---- ④ reportOnly 只改退出码，不改结论 ----
    // failures 照样列全：报告模式的用途是「先看数字」，不是「当没发生」。
    if (reportOnly) {
        notes.push(
            `--report-only 生效：本轮不阻断（${failures.length} 项未达标只列不判，退出码 0）`
        );
    }
    const exitCode = failures.length > 0 && !reportOnly ? 1 : 0;
    return { exitCode, failures, notes };
}
