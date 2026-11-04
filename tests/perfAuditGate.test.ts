// tests/perfAuditGate.test.ts
// R14「性能首访证据不足」的守卫：首屏体感门禁的**判据**。
//
// 背景（2026-11-04 审查发现，四条都是「门禁在最该红的时候是绿的」）：
//   ① 冷启动与回访混在一份中位数里（同一会话连跑多轮，HTTP 缓存首轮就预热了），
//      得到的数字既不是冷启动也不是回访；
//   ② CLS 只打印不断言，而且取的是**最后一轮** —— 最差那一轮恰好被漏掉；
//   ③ `--json` 模式下失败输出整段跳过、退出码还是 0 —— 自动化最常用的那档等于静默成功；
//   ④ 量的口径是本地未压缩的静态服务，线上是 Cloudflare gzip —— 数字不可比。
//
// 修法是把判定抽成纯函数（`script/perfGate.mjs`），本文件表驱动地钉住每一条。
// 不起浏览器、不要 dist 产物 —— 所以它在任何机器上都能跑，而「能跑的守卫」才算守卫。
//
// 逻辑与注释以 script/perfGate.mjs 为准。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    decidePerf,
    parsePerfMode,
    summarizeGroup,
    dedupeErrors,
    median,
    PERF_MODES,
    DEFAULT_PERF_MODE,
    GROUP_LABELS,
    type PerfGroupResult,
    type PerfBudgets,
} from "../script/perfGate.mjs";
// auditEnv.mjs 是纯 JS（项目里没给 script/ 配 .d.mts），strict 下 import 会报 TS7016。
// 与 tests/a11yNamedRules.dom.test.tsx 同一处理。
// @ts-expect-error - script/auditEnv.mjs 没有类型声明文件
import { gzipQuality } from "../script/auditEnv.mjs";

// ---------------- 夹具 ----------------

/**
 * 预算取**仓库里真实的标定值**：用例要守的是「判据」，不是「数字」，
 * 但预算一旦和 perf-audit.mjs 里的实际值漂开，这里的断言就退化成测一个不存在的配置。
 * （两边同时改时，这条夹具要跟着改 —— 见文件末尾的一致性用例。）
 */
const BUDGETS: PerfBudgets = {
    cold: { fcp: 3400, lcp: 5800, cls: 0.1 },
    warm: { fcp: 500, lcp: 1700, cls: 0.1 },
};

/** 造一组汇总结果；默认值是「冷启动组实测的那种量级，且全部达标」 */
function group(overrides: Partial<PerfGroupResult> = {}): PerfGroupResult {
    return {
        rounds: 3,
        sampledRounds: 3,
        warmupDropped: false,
        warmupRound: null,
        fcp: 1988,
        lcp: 3424,
        fcpMin: 1924,
        fcpMax: 2028,
        lcpMin: 3176,
        lcpMax: 3548,
        cls: 0.034,
        clsCounted: 0.034,
        clsWorstRound: 1,
        ttfb: 4,
        domContentLoaded: 1893,
        transferredKb: 334,
        resources: 104,
        pageErrors: [],
        rows: [
            { round: 1, fcp: 1988, lcp: 3424, cls: 0.034 },
            { round: 2, fcp: 1976, lcp: 3212, cls: 0.012 },
            { round: 3, fcp: 2028, lcp: 3472, cls: 0.02 },
        ],
        ...overrides,
    };
}

/** 造一组「回访」汇总结果（数值取自实测） */
function warmGroup(overrides: Partial<PerfGroupResult> = {}): PerfGroupResult {
    return group({
        fcp: 208,
        lcp: 848,
        fcpMin: 172,
        fcpMax: 280,
        lcpMin: 728,
        lcpMax: 960,
        cls: 0.034,
        clsWorstRound: 3,
        transferredKb: 4,
        rounds: 3,
        sampledRounds: 4,
        warmupDropped: true,
        warmupRound: {
            round: 1,
            fcp: 5090,
            lcp: 6100,
            cls: 0.05,
            ttfb: 4,
            domContentLoaded: 1900,
            transferredKb: 334,
            resources: 104,
            pageErrors: [],
        },
        ...overrides,
    });
}

// ---------------- parsePerfMode：非法值必须报错，不许静默回退 ----------------

test("parsePerfMode：三种合法写法都认（--mode=x / --mode x / 不写）", () => {
    assert.deepEqual(parsePerfMode(["node", "perf-audit.mjs", "--mode=cold"]), {
        ok: true,
        mode: "cold",
        source: "--mode",
    });
    assert.deepEqual(parsePerfMode(["node", "perf-audit.mjs", "--mode", "warm"]), {
        ok: true,
        mode: "warm",
        source: "--mode",
    });
    assert.deepEqual(parsePerfMode(["node", "perf-audit.mjs"]), {
        ok: true,
        mode: DEFAULT_PERF_MODE,
        source: "默认值",
    });
});

test("parsePerfMode：大小写与两侧空白都容忍（COLD / \" cold \"）", () => {
    // 容忍大小写是为了「让人少踩一次坑」，但归一化之后必须落在 PERF_MODES 里 ——
    // 宽松的是写法，不是判据。
    for (const raw of ["COLD", " cold ", "Both"]) {
        const parsed = parsePerfMode(["node", "x.mjs", `--mode=${raw}`]);
        assert.equal(parsed.ok, true, `${JSON.stringify(raw)} 应被接受`);
        if (parsed.ok) assert.ok(PERF_MODES.includes(parsed.mode), parsed.mode);
    }
});

test("parsePerfMode：非法值返回 ok:false（**不**静默回退成 both）", () => {
    // 手误回退成默认值的后果：跑出来一份「看起来没问题」的报告，
    // 而人以为自己量的是冷启动。这比直接报错糟得多。
    for (const bad of ["coldd", "hot", "", "both,", "co ld"]) {
        const parsed = parsePerfMode(["node", "x.mjs", `--mode=${bad}`]);
        assert.equal(parsed.ok, false, `${JSON.stringify(bad)} 不该被接受`);
        if (!parsed.ok) {
            assert.match(parsed.error, /--mode/);
            assert.ok(parsed.error.includes(JSON.stringify(bad)), `错误里要带原值：${parsed.error}`);
        }
    }
});

test("parsePerfMode：`--mode` 后面没值 / 跟着另一个开关 → 报错，不猜", () => {
    for (const argv of [["--mode"], ["--mode", "--json"], ["--mode", ""]]) {
        const parsed = parsePerfMode(["node", "x.mjs", ...argv]);
        assert.equal(parsed.ok, false, `${JSON.stringify(argv)} 应报错`);
        if (!parsed.ok) assert.match(parsed.error, /缺少值/);
    }
});

// ---------------- median / dedupeErrors：两个容易悄悄失真的小工具 ----------------

test("median：奇数取中间、偶数取中间两个的平均（四舍五入），空数组给 0 而不是 NaN", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 = 2.5 → 3
    assert.equal(median([100]), 100);
    // NaN 会让 `value > budget` 永远 false —— 一条量砸了的采样会被当成「没超预算」。
    // 所以空输入必须给 0（调用方靠 0 认出「量不到」并单独报错）。
    assert.equal(median([]), 0);
    assert.equal(median([Number.NaN, undefined as unknown as number]), 0);
});

test("dedupeErrors：跨轮重复的同一个错误只算一条，且保持首次出现顺序", () => {
    // 原来 `rounds.flatMap(x => x.pageErrors)` 会把同一个错误按轮数放大：
    // 3 轮 × 同一个异常 = 「页面有 3 条运行时报错」，看的人以为出了 3 个问题。
    const deduped = dedupeErrors([
        "TypeError: A 炸了",
        "console.error 一号",
        "TypeError: A 炸了",
        "TypeError: B 炸了",
        "console.error 一号",
    ]);
    assert.deepEqual(deduped, ["TypeError: A 炸了", "console.error 一号", "TypeError: B 炸了"]);
});

test("dedupeErrors：空白/非字符串项被丢掉，不产生空条目", () => {
    assert.deepEqual(dedupeErrors(["", "  ", null, undefined, 42]), ["42"]);
    assert.deepEqual(dedupeErrors(null), []);
    assert.deepEqual(dedupeErrors(undefined), []);
});

// ---------------- summarizeGroup：冷热分离的核心 ----------------

test("summarizeGroup：回访组首轮作预热被剔除，中位数只算后 3 轮", () => {
    // 这就是 R14 的根因用例：首轮是冷态（FCP 5090），后三轮是回访（FCP 200 上下）。
    // 把 4 轮混在一起取中位数会得到 2645 —— 既不是冷启动也不是回访。
    const rounds = [
        { round: 1, fcp: 5090, lcp: 6100, cls: 0.05 },
        { round: 2, fcp: 208, lcp: 848, cls: 0.01 },
        { round: 3, fcp: 176, lcp: 760, cls: 0.034 },
        { round: 4, fcp: 280, lcp: 960, cls: 0.02 },
    ];
    const result = summarizeGroup(rounds, { dropWarmup: true });
    assert.equal(result.warmupDropped, true);
    assert.equal(result.sampledRounds, 4);
    assert.equal(result.rounds, 3);
    assert.equal(result.fcp, 208, `首轮 5090 不该进中位数（拿到 ${result.fcp}）`);
    assert.equal(result.lcp, 848);
    assert.equal(result.rows.length, 3, "明细表也只列计入的轮次");
    // 预热轮的原始数据要留着 —— 报告里要能回查「那一轮到底多慢」
    assert.equal(result.warmupRound?.fcp, 5090);
});

test("summarizeGroup：冷启动组不剔预热，全部轮次计入", () => {
    const result = summarizeGroup(
        [
            { round: 1, fcp: 1988, lcp: 3424, cls: 0.034 },
            { round: 2, fcp: 1976, lcp: 3212, cls: 0.012 },
            { round: 3, fcp: 2028, lcp: 3472, cls: 0.02 },
        ],
        { dropWarmup: false }
    );
    assert.equal(result.warmupDropped, false);
    assert.equal(result.rounds, 3);
    assert.equal(result.fcp, 1988);
    assert.equal(result.lcp, 3424);
    // 区间要报全 —— 「中位数刚好压线、但有一轮爆了」也是退步的信号
    assert.equal(result.fcpMin, 1976);
    assert.equal(result.fcpMax, 2028);
});

test("summarizeGroup：只有 1 轮时剔预热会把样本剔没 —— 宁可保留并如实说明", () => {
    // PERF_ROUNDS=1 时回访组只有 1 次导航。剔掉它 = 一组空数字，而空数字
    // 长得和「全过」一模一样（fcp=0 会被当成量不到，cls=0 会被当成没偏移）。
    const result = summarizeGroup([{ round: 1, fcp: 240, lcp: 900, cls: 0.02 }], { dropWarmup: true });
    assert.equal(result.warmupDropped, false, "没剔就要如实标记，不能嘴上说剔了");
    assert.equal(result.rounds, 1);
    assert.equal(result.fcp, 240);
});

test("summarizeGroup：CLS 取所有轮次的**最大值**（含预热轮），不是最后一轮", () => {
    // 旧实现取的是 `last.cls` —— 最差那一轮只要不在最后就永远看不见。
    const result = summarizeGroup(
        [
            { round: 1, fcp: 5090, lcp: 6100, cls: 0.42 }, // 预热轮，跳得最凶
            { round: 2, fcp: 208, lcp: 848, cls: 0.01 },
            { round: 3, fcp: 200, lcp: 800, cls: 0.02 },
        ],
        { dropWarmup: true }
    );
    assert.equal(result.cls, 0.42, "预热轮也算：CLS 是「最差一次」指标");
    assert.equal(result.clsCounted, 0.02, "只算计入轮次的最大值单独给一份作参考");
    assert.equal(result.clsWorstRound, 1, "要能指出最差落在第几轮");
});

test("summarizeGroup：pageErrors 是全部轮次去重后的并集（预热轮抛的错也是错）", () => {
    const result = summarizeGroup(
        [
            { round: 1, fcp: 5090, lcp: 6100, cls: 0, pageErrors: ["TypeError: X"] },
            { round: 2, fcp: 208, lcp: 848, cls: 0, pageErrors: ["TypeError: X"] },
            { round: 3, fcp: 200, lcp: 800, cls: 0, pageErrors: ["TypeError: Y"] },
        ],
        { dropWarmup: true }
    );
    assert.deepEqual(result.pageErrors, ["TypeError: X", "TypeError: Y"]);
});

test("summarizeGroup：空输入不会抛，也不会编造数字", () => {
    const result = summarizeGroup([], { dropWarmup: true });
    assert.equal(result.rounds, 0);
    assert.equal(result.fcp, 0);
    assert.equal(result.lcp, 0);
    assert.equal(result.cls, 0);
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(summarizeGroup(null).rows, []);
});

// ---------------- decidePerf：表驱动，覆盖审查里点名的六种情形 ----------------

interface Case {
    name: string;
    input: Parameters<typeof decidePerf>[0];
    expectExit: number;
    /** 失败信息里必须出现的片段（每条都要命中） */
    expectFailuresInclude?: string[];
    /** 失败条数（可选，用来钉「不多报也不漏报」） */
    expectFailureCount?: number;
    expectNotesInclude?: string[];
}

const CASES: Case[] = [
    {
        name: "冷启动超预算（冷 LCP 6500 > 5800）、回访正常 → 拦下",
        input: {
            mode: "both",
            cold: group({ lcp: 6500 }),
            warm: warmGroup(),
            budgets: BUDGETS,
        },
        expectExit: 1,
        expectFailureCount: 1,
        expectFailuresInclude: ["冷启动", "LCP", "6500", "5800"],
    },
    {
        name: "冷启动正常、回访也正常 → 放行",
        input: { mode: "both", cold: group(), warm: warmGroup(), budgets: BUDGETS },
        expectExit: 0,
        expectFailureCount: 0,
    },
    {
        name: "回访 FCP 超预算（620 > 500）→ 拦下，且失败信息点明是回访组",
        input: { mode: "both", cold: group(), warm: warmGroup({ fcp: 620 }), budgets: BUDGETS },
        expectExit: 1,
        expectFailureCount: 1,
        expectFailuresInclude: ["回访", "FCP", "620", "500"],
    },
    {
        name: "CLS 超预算（0.34 > 0.1）→ 拦下（旧版只打印不断言）",
        input: { mode: "both", cold: group({ cls: 0.34 }), warm: warmGroup(), budgets: BUDGETS },
        expectExit: 1,
        expectFailureCount: 1,
        expectFailuresInclude: ["冷启动", "CLS", "0.34", "0.1"],
    },
    {
        name: "CLS 差一点超（0.101 > 0.1）也要拦：门禁没有「差不多」",
        input: { mode: "cold", cold: group({ cls: 0.101 }), warm: null, budgets: BUDGETS },
        expectExit: 1,
        expectFailuresInclude: ["CLS"],
    },
    {
        name: "量大不到（FCP=0）→ 拦下，而且报的是「量不到」不是「超预算」",
        input: { mode: "cold", cold: group({ fcp: 0 }), warm: null, budgets: BUDGETS },
        expectExit: 1,
        expectFailureCount: 1,
        expectFailuresInclude: ["量不到 FCP"],
    },
    {
        name: "页面有运行时报错 → 拦下（FCP 好看也可能是假绿）",
        input: {
            mode: "warm",
            cold: null,
            warm: warmGroup({ pageErrors: ["TypeError: 卡片炸了"] }),
            budgets: BUDGETS,
        },
        expectExit: 1,
        expectFailureCount: 1,
        expectFailuresInclude: ["运行时报错", "TypeError: 卡片炸了"],
    },
    {
        name: "report-only：未达标项照样列出，但退出码 0",
        input: { mode: "both", cold: group({ lcp: 6500 }), warm: warmGroup(), budgets: BUDGETS, reportOnly: true },
        expectExit: 0,
        expectFailureCount: 1,
        expectFailuresInclude: ["LCP", "6500"],
        expectNotesInclude: ["--report-only", "本轮不阻断"],
    },
    {
        name: "非法 mode → 退出码 1，且把用法打出来（reportOnly 也不放行）",
        input: { mode: "coll", cold: group(), warm: warmGroup(), budgets: BUDGETS },
        expectExit: 1,
        expectFailuresInclude: ["--mode", "用法"],
    },
    {
        name: "非法 mode + report-only 仍然是 1（参数给错 ≠ 这次先不拦）",
        input: { mode: "coll", cold: group(), warm: warmGroup(), budgets: BUDGETS, reportOnly: true },
        expectExit: 1,
        expectFailuresInclude: ["--mode"],
    },
];

for (const testCase of CASES) {
    test(`decidePerf：${testCase.name}`, () => {
        const verdict = decidePerf(testCase.input);
        assert.equal(verdict.exitCode, testCase.expectExit, `failures=${JSON.stringify(verdict.failures)}`);
        if (testCase.expectFailureCount !== undefined) {
            assert.equal(
                verdict.failures.length,
                testCase.expectFailureCount,
                `失败条数不对：${JSON.stringify(verdict.failures)}`
            );
        }
        for (const fragment of testCase.expectFailuresInclude ?? []) {
            assert.ok(
                verdict.failures.some(f => f.includes(fragment)),
                `失败信息里应包含 ${JSON.stringify(fragment)}：${JSON.stringify(verdict.failures)}`
            );
        }
        for (const fragment of testCase.expectNotesInclude ?? []) {
            assert.ok(
                verdict.notes.some(n => n.includes(fragment)),
                `notes 里应包含 ${JSON.stringify(fragment)}：${JSON.stringify(verdict.notes)}`
            );
        }
    });
}

// ---------------- decidePerf：几条不靠表格说清的边界 ----------------

test("decidePerf：mode=cold 时只看冷启动组（回访组为 null 不算缺数据）", () => {
    const coldOnly = decidePerf({ mode: "cold", cold: group(), warm: null, budgets: BUDGETS });
    assert.equal(coldOnly.exitCode, 0);
    const warmOnly = decidePerf({ mode: "warm", cold: null, warm: warmGroup(), budgets: BUDGETS });
    assert.equal(warmOnly.exitCode, 0);
});

test("decidePerf：mode=both 但缺一组数据 → 拦下，不许当成「那组没问题」", () => {
    const verdict = decidePerf({ mode: "both", cold: group(), warm: null, budgets: BUDGETS });
    assert.equal(verdict.exitCode, 1);
    assert.ok(
        verdict.failures.some(f => f.includes("回访") && f.includes("采样结果")),
        JSON.stringify(verdict.failures)
    );
});

test("decidePerf：预算缺失/写坏时必须拦 —— `undefined > 5000` 是 false，会静默放行", () => {
    const broken = [
        { label: "整组预算缺失", budgets: { cold: undefined, warm: BUDGETS.warm } },
        { label: "fcp 写成 undefined", budgets: { cold: { lcp: 5800, cls: 0.1 } as never, warm: BUDGETS.warm } },
        { label: "cls 预算为 0", budgets: { cold: { fcp: 3400, lcp: 5800, cls: 0 } as never, warm: BUDGETS.warm } },
        { label: "cls 预算 ≥ 1（等于没有门禁）", budgets: { cold: { fcp: 3400, lcp: 5800, cls: 1 } as never, warm: BUDGETS.warm } },
    ];
    for (const { label, budgets } of broken) {
        const verdict = decidePerf({ mode: "cold", cold: group(), warm: null, budgets: budgets as never });
        assert.equal(verdict.exitCode, 1, `${label}：应拦下`);
        assert.ok(
            verdict.failures.some(f => f.includes("预算")),
            `${label}：失败信息要说清是预算问题：${JSON.stringify(verdict.failures)}`
        );
    }
});

test("decidePerf：input 是垃圾时也不抛（门禁自己崩掉比红更糟）", () => {
    for (const bad of [undefined, null, {}, { mode: "both" }]) {
        const verdict = decidePerf(bad as never);
        assert.equal(verdict.exitCode, 1, `input=${JSON.stringify(bad)} 应拦下`);
        assert.ok(Array.isArray(verdict.failures) && verdict.failures.length > 0);
    }
});

test("decidePerf：notes 会说明哪一组剔了预热（报告要能自证口径）", () => {
    const verdict = decidePerf({ mode: "both", cold: group(), warm: warmGroup(), budgets: BUDGETS });
    assert.ok(
        verdict.notes.some(n => n.includes("回访") && n.includes("预热")),
        JSON.stringify(verdict.notes)
    );
    assert.ok(
        verdict.notes.some(n => n.includes("冷启动") && n.includes("全部计入")),
        JSON.stringify(verdict.notes)
    );
});

test("decidePerf：两组都超时两条都报（不要只报第一条就返回）", () => {
    const verdict = decidePerf({
        mode: "both",
        cold: group({ fcp: 9000, lcp: 9000 }),
        warm: warmGroup({ fcp: 900, lcp: 3000 }),
        budgets: BUDGETS,
    });
    assert.equal(verdict.failures.length, 4, JSON.stringify(verdict.failures));
    assert.ok(verdict.failures.some(f => f.includes(GROUP_LABELS.cold)));
    assert.ok(verdict.failures.some(f => f.includes(GROUP_LABELS.warm)));
});

// ---------------- gzip 协商：口径要和线上一致（否则数字不可比） ----------------

test("gzipQuality：常见协商头都按 RFC 的 q 值语义处理", () => {
    const q = (header?: string) => gzipQuality({ headers: header === undefined ? {} : { "accept-encoding": header } });
    assert.equal(q("gzip, deflate, br"), 1, "Chrome 的典型头");
    assert.equal(q("gzip"), 1);
    assert.equal(q("GZIP"), 1, "编码名大小写不敏感");
    assert.equal(q("gzip;q=0.5"), 0.5);
    assert.equal(q("gzip;q=0"), 0, "显式拒绝：不能因为出现了 gzip 这几个字就当接受");
    assert.equal(q("deflate"), 0, "没提 gzip 就不压");
    assert.equal(q(""), 0);
    assert.equal(q(undefined), 0, "连头都没有 = 只保证认 identity");
    assert.equal(q("*"), 1, "`*` 表示什么编码都收");
    assert.equal(q("*;q=0"), 0);
    assert.equal(q("gzip;q=abc"), 0, "q 写坏了按 0 处理：宁可发原文，也不赌读不懂的协商头");
});

test("gzipQuality：`gzip;q=0, *;q=1` 以显式的 gzip 为准（更具体的那条赢）", () => {
    assert.equal(gzipQuality({ headers: { "accept-encoding": "gzip;q=0, *;q=1" } }), 0);
    // 数组形式的头（HTTP/1.1 允许多条同名头）也要能拼起来
    assert.equal(gzipQuality({ headers: { "accept-encoding": ["br", "gzip"] } }), 1);
    assert.equal(gzipQuality(null), 0);
});

// ---------------- 与真实脚本的一致性 ----------------
//
// 单测不跑浏览器，但至少要把「夹具里的预算」和 `perf-audit.mjs` 里真正用的那份对上 ——
// 否则这里的断言守的是一份仓库里不存在的配置，全绿也没意义。

test("一致性：tests 里的预算夹具与 perf-audit.mjs 的 BUDGET_MS 相同", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    /** 从某个起点逐级向上找 package.json（单测打包后位置不固定，两边都试） */
    const findRootFrom = (from: string): string | null => {
        let dir = from;
        for (let i = 0; i < 8; i++) {
            try {
                readFileSync(join(dir, "package.json"), "utf8");
                return dir;
            } catch {
                const parent = dirname(dir);
                if (parent === dir) return null;
                dir = parent;
            }
        }
        return null;
    };
    // ① 用例打包后的位置往上找（正常运行器会把 bundle 放在 script/tmp-tests/ 下）；
    // ② 再退回 cwd —— 万一在别的目录里跑同一份 bundle，也不能「找不到根目录」就静默跳过。
    const root = findRootFrom(dirname(fileURLToPath(import.meta.url))) ?? findRootFrom(process.cwd());
    assert.ok(root, "找不到项目根目录（package.json）");
    const source: string = readFileSync(resolve(root, "script", "perf-audit.mjs"), "utf8");
    for (const [groupName, budget] of Object.entries(BUDGETS)) {
        for (const [key, value] of Object.entries(budget)) {
            assert.ok(
                source.includes(`${key}: ${value}`),
                `perf-audit.mjs 里没有 ${groupName}.${key} = ${value} —— ` +
                    "预算改过了就把这份夹具一起改（两处漂开的话，本文件的断言守的是不存在的配置）"
            );
        }
    }
});
