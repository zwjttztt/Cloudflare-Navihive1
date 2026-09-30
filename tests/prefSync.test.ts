/**
 * 本机偏好同步（A-2）：访问统计的多端合并。
 *
 * 这里只测 `mergeVisitStats` 这个纯函数 —— 它是「换台设备登录后热度还在不在」的关键，
 * 也是最容易写错的地方（相加会虚高，覆盖会丢一边）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeVisitStats, type VisitStat } from "../src/context/UIPrefsContext";

test("mergeVisitStats：本机没有的链接直接采用服务端那份", () => {
    const merged = mergeVisitStats({}, {
        "https://a.example": { count: 3, last: 100, days: { "2026-09-30": 2 } },
    });
    assert.equal(merged["https://a.example"].count, 3);
    assert.equal(merged["https://a.example"].last, 100);
    assert.equal(merged["https://a.example"].days?.["2026-09-30"], 2);
});

test("mergeVisitStats：两边都有时次数与最近时间取较大，不相加", () => {
    const local: Record<string, VisitStat> = {
        "https://a.example": { count: 5, last: 200, days: { "2026-09-30": 3 } },
    };
    const incoming: Record<string, VisitStat> = {
        "https://a.example": { count: 2, last: 900, days: { "2026-09-30": 1 } },
    };
    const merged = mergeVisitStats(local, incoming);
    // 相加会记成 7 次 —— 两台机器各自点过不该翻倍
    assert.equal(merged["https://a.example"].count, 5);
    assert.equal(merged["https://a.example"].last, 900);
    // 按天同样取较大，热力图不会因为合并就变形
    assert.equal(merged["https://a.example"].days?.["2026-09-30"], 3);
});

test("mergeVisitStats：不同日期的明细合并到同一条记录上", () => {
    const merged = mergeVisitStats(
        { "https://a.example": { count: 1, last: 10, days: { "2026-09-28": 1 } } },
        { "https://a.example": { count: 1, last: 20, days: { "2026-09-30": 4 } } }
    );
    assert.deepEqual(merged["https://a.example"].days, {
        "2026-09-28": 1,
        "2026-09-30": 4,
    });
});

test("mergeVisitStats：只补服务端有的链接，本机已有的不会被抹掉", () => {
    const merged = mergeVisitStats(
        { "https://local.example": { count: 9, last: 1 } },
        { "https://remote.example": { count: 1, last: 2 } }
    );
    assert.equal(merged["https://local.example"].count, 9, "本机那条要原样留住");
    assert.equal(merged["https://remote.example"].count, 1);
});

test("mergeVisitStats：服务端那份坏了也不影响本机", () => {
    const local: Record<string, VisitStat> = { "https://a.example": { count: 4, last: 5 } };
    const dirty = {
        "https://a.example": { count: Number.NaN, last: "not-a-number", days: { d: "x" } },
        "https://bad.example": null,
    } as unknown as Record<string, VisitStat>;
    const merged = mergeVisitStats(local, dirty);
    assert.equal(merged["https://a.example"].count, 4, "非法值不该把本机记录压成 0");
    assert.equal(merged["https://a.example"].last, 5);
    assert.equal(merged["https://bad.example"], undefined, "整条为 null 的直接跳过");
});

test("mergeVisitStats：不改传入的对象（重复合并不会自我放大）", () => {
    const local: Record<string, VisitStat> = { "https://a.example": { count: 2, last: 1 } };
    const incoming: Record<string, VisitStat> = { "https://a.example": { count: 7, last: 8 } };
    const merged = mergeVisitStats(local, incoming);
    assert.equal(local["https://a.example"].count, 2, "入参不该被改写");
    assert.equal(merged["https://a.example"].count, 7);
    // 拿合并结果再合并一次，结果必须稳定
    assert.equal(mergeVisitStats(merged, incoming)["https://a.example"].count, 7);
});
