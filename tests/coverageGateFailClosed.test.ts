// tests/coverageGateFailClosed.test.ts
// R13 的守卫：覆盖率门禁必须 **fail-closed** —— 「量不到」一律算不过。
//
// 这条用例存在的理由是一次真实的静默放行（2026-11-04 审查发现）：
//   script/coverage.mjs 里有两处「没有数据 → 当作通过」的分支
//     · 缺 c8：`process.exit(gateFailed ? 1 : 0)`（只要第 1 层过就绿）
//     · 读不到 coverage-summary.json：`return { failed: false }`
//   后果是门禁只在「测得好」的时候有效 —— 真出问题的那一轮恰好就是量不到的那一轮。
//
// 所以这里不用「扫源码字符串」当守卫（那种守卫在重构后要么误报要么被顺手删掉），
// 而是直接对抽取出来的纯函数 decideCoverageExit 做表驱动断言：
// 判定搬到哪里、脚本怎么重排，只要判据还在，这些用例就还有意义。
//
// 逻辑与注释以 script/coverageGate.mjs 为准。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    decideCoverageExit,
    parseCoverageArgs,
    LAYER1_ONLY_FLAG,
    type CoverageGateInput,
} from "../script/coverageGate.mjs";

interface Case {
    /** 打印在用例名里的编号 + 情形 */
    name: string;
    input: CoverageGateInput;
    /** 期望退出码 */
    exitCode: 0 | 1;
    /** reasons 里必须有一条命中它（通过时为 undefined） */
    mustMention?: RegExp;
}

// 八个分支：五个「量不到 / 不达标」，两个「只跳第 2 层」，一个「全过」。
const CASES: Case[] = [
    {
        name: "① 缺 c8（依赖没装）→ 不过",
        input: { c8Missing: true },
        exitCode: 1,
        mustMention: /c8 没装/,
    },
    {
        name: "② summary 文件不存在 → 不过",
        input: { summaryMissing: true, linesTotal: 0 },
        exitCode: 1,
        mustMention: /coverage-summary\.json 不存在/,
    },
    {
        name: "③ summary 不是合法 JSON（JSON.parse 失败）→ 不过",
        input: { summaryReadError: "JSON.parse 失败（Unexpected token <）", linesTotal: 0 },
        exitCode: 1,
        mustMention: /读不出来或解析失败/,
    },
    {
        name: "④ 聚合后 lines.total === 0（一条行统计都没有）→ 不过",
        input: { linesTotal: 0 },
        exitCode: 1,
        mustMention: /lines\.total === 0/,
    },
    {
        name: "⑤ 第 2 层跌破地板 → 不过",
        input: {
            linesTotal: 98620,
            l2Breaches: ["lines 84.0% < 地板 85%", "src/utils 函数覆盖 88.1% < 地板 90%"],
        },
        exitCode: 1,
        mustMention: /地板 85%/,
    },
    {
        name: "⑥ 两层全过 → 通过",
        input: { linesTotal: 98620, l1Failed: false },
        exitCode: 0,
    },
    {
        name: "⑦ 只跳第 2 层（--layer1-only）但第 1 层红 → 不过",
        input: { layer1Only: true, l1Failed: true },
        exitCode: 1,
        mustMention: /第 1 层/,
    },
    {
        name: "⑧ 只跳第 2 层（--layer1-only）且第 1 层绿 → 通过（但必须标注只判了第 1 层）",
        input: { layer1Only: true, l1Failed: false },
        exitCode: 0,
    },
];

for (const { name, input, exitCode, mustMention } of CASES) {
    test(`decideCoverageExit：${name}`, () => {
        const result = decideCoverageExit(input);
        assert.equal(
            result.exitCode,
            exitCode,
            `${name} —— 期望退出码 ${exitCode}，实得 ${result.exitCode}；` +
                `reasons = ${JSON.stringify(result.reasons)}`
        );
        if (exitCode === 1) {
            assert.ok(
                result.reasons.length > 0,
                `${name} —— 判红了却没给出任何原因，等于让人无从下手`
            );
            assert.ok(
                result.reasons.some(reason => mustMention?.test(reason) === true),
                `${name} —— reasons 里没有命中 ${String(mustMention)}：${JSON.stringify(result.reasons)}`
            );
        } else {
            assert.deepEqual(result.reasons, [], `${name} —— 通过时不该留下失败原因`);
        }
    });
}

// ---------------- 几条容易写错、一旦写错就静默放行的细节 ----------------

test("缺 c8 时只报「缺 c8」，不堆一堆同样源于它的 summary 报错", () => {
    // c8 没装 → 根本没跑 → summary 必然不存在。把这两件事都报出来，
    // 真正的原因（装依赖）会被埋在「summary 不存在」的噪音后面。
    const result = decideCoverageExit({ c8Missing: true, summaryMissing: true, linesTotal: 0 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.reasons.length, 1, `reasons = ${JSON.stringify(result.reasons)}`);
    assert.match(result.reasons[0], /c8 没装/);
});

test("--layer1-only 时第 2 层的数据一律不参与判定（跳了就不该被它弄红）", () => {
    // 传了 layer1Only 却又带着第 2 层的失败数据，是调用方接线错了。
    // 这时判定不能因为「上一轮残留的 breaches」变红 —— 否则「只跑第 1 层」永远跑不绿，
    // 人就会去改判定，最后把严格的那一侧也改松。
    const result = decideCoverageExit({
        layer1Only: true,
        c8Missing: true,
        summaryMissing: true,
        summaryReadError: "boom",
        linesTotal: 0,
        l2Breaches: ["lines 1% < 地板 85%"],
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.reasons, []);
});

test("--layer1-only 的结论必须自带「本轮只判 import 覆盖」标注", () => {
    const result = decideCoverageExit({ layer1Only: true });
    assert.equal(result.layer1Only, true);
    assert.ok(
        result.notes.some(note => note.includes(LAYER1_ONLY_FLAG)),
        `notes 里必须点名 ${LAYER1_ONLY_FLAG} 才看得出这轮结论的适用范围：${JSON.stringify(result.notes)}`
    );
    assert.ok(
        result.notes.some(note => note.includes("只判 import 覆盖")),
        `notes 里必须写明「只判 import 覆盖」：${JSON.stringify(result.notes)}`
    );
});

test("非 --layer1-only 时不该出现任何「跳过第 2 层」的标注", () => {
    // 反过来也要钉：万一有一天有人把 layer1Only 默认设成 true，
    // 上面那条会因为 notes 为空而红 —— 这条是它的对称面。
    const result = decideCoverageExit({ linesTotal: 98620 });
    assert.equal(result.layer1Only, false);
    assert.deepEqual(result.notes, []);
});

test("多个失败原因同时成立时全部列出（不藏后一条）", () => {
    const result = decideCoverageExit({
        l1Failed: true,
        linesTotal: 100,
        l2Breaches: ["lines 84.0% < 地板 85%", "worker 函数覆盖 86.0% < 地板 87%"],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.reasons.length, 3, `reasons = ${JSON.stringify(result.reasons)}`);
});

test("reason 为 undefined / null 的 breach 被忽略，不会变成一条空原因", () => {
    const result = decideCoverageExit({
        linesTotal: 10,
        // 故意塞脏数据：调用方拼 breaches 时混进 undefined 不该导致「一条空原因」
        l2Breaches: [undefined as unknown as string, "", "worker 函数覆盖 86.0% < 地板 87%"],
    });
    assert.deepEqual(result.reasons, ["worker 函数覆盖 86.0% < 地板 87%"]);
});

test("不传参数也不崩（默认值全 fail-safe：没有数据就是不过）", () => {
    const noArg = decideCoverageExit();
    assert.equal(noArg.exitCode, 1, "什么都不传 = 什么都没量到 = 不过");
    const undefinedArg = decideCoverageExit(undefined);
    assert.equal(undefinedArg.exitCode, 1);
});

test("linesTotal 传负数 / NaN / 字符串也按「没测到」处理", () => {
    for (const bad of [-1, Number.NaN, "98620" as unknown as number]) {
        const result = decideCoverageExit({ linesTotal: bad });
        assert.equal(result.exitCode, 1, `linesTotal=${String(bad)} 必须判不过`);
    }
});

// ---------------- CLI：--layer1-only 是唯一的开关 ----------------

test("parseCoverageArgs：没有参数 = 两层都跑", () => {
    const parsed = parseCoverageArgs([]);
    assert.equal(parsed.layer1Only, false);
    assert.deepEqual(parsed.unknown, []);
});

test(`parseCoverageArgs：认出 ${LAYER1_ONLY_FLAG}`, () => {
    const parsed = parseCoverageArgs([LAYER1_ONLY_FLAG]);
    assert.equal(parsed.layer1Only, true);
    assert.deepEqual(parsed.unknown, []);
});

test("parseCoverageArgs：打错的开关进 unknown（不能被默默忽略）", () => {
    // --layer1_only / --layer1only 这类手误如果被忽略，人会以为「已经只跑第 1 层了」，
    // 实际两层全跑一遍（几分钟），最后拿到一个他没想过的结论。
    const parsed = parseCoverageArgs(["--layer1_only"]);
    assert.equal(parsed.layer1Only, false);
    assert.deepEqual(parsed.unknown, ["--layer1_only"]);
});

test("parseCoverageArgs：非字符串参数被跳过，不抛", () => {
    const parsed = parseCoverageArgs([null, 42, LAYER1_ONLY_FLAG] as unknown as string[]);
    assert.equal(parsed.layer1Only, true);
    assert.deepEqual(parsed.unknown, []);
});
