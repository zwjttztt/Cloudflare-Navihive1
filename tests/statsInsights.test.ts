// tests/statsInsights.test.ts
// B9 看板派生指标（2026-10-22）。
//
// 钉的都是「边界算错也不报错、但显示出来是假信息」的那类：
//   - 环比：数据不足 14 天、前一周为 0（除零 → Infinity%）
//   - 占比：总量为 0（除零 → NaN%）
//   - 峰值：全零时应该没有峰值，而不是「第 0 天峰值 0 次」
//   - 排序：服务端回来的顺序不保证是日历顺序，必须先排再切窗口
//
// ⚠️ 只断言数字与字符串：node:assert 失败时会 util.inspect 整个入参，
//    2026-10-21 把 DOM 元素塞进断言失败路径时进程堆被打爆过。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    dailySummary,
    deltaText,
    shareOf,
    weekOverWeek,
    type DailyPoint,
} from "../src/utils/statsInsights";

/** 造 30 天：day 从 2026-09-22 起，count 按传入函数给 */
function days(n: number, countOf: (i: number) => number): DailyPoint[] {
    const out: DailyPoint[] = [];
    for (let i = 0; i < n; i++) {
        const d = new Date(Date.UTC(2026, 8, 22 + i));
        out.push({ day: d.toISOString().slice(0, 10), count: countOf(i) });
    }
    return out;
}

test("环比：满 14 天时取最近 7 天对比前 7 天", () => {
    // 前 23 天各 1 次，最后 7 天各 3 次 → last7=21, prev7=7 → +200%
    const w = weekOverWeek(days(30, i => (i >= 23 ? 3 : 1)));
    assert.equal(w.last7, 21);
    assert.equal(w.prev7, 7);
    assert.equal(w.deltaPct, 200);
    assert.equal(w.enough, true);
});

test("环比：数据不足 14 天要如实说样本不够", () => {
    const w = weekOverWeek(days(5, () => 2));
    assert.equal(w.enough, false, "不足 14 天不能拿「+x%」糊弄人");
    assert.equal(w.last7, 10);
});

test("环比：前一周为 0 不输出 Infinity%", () => {
    const w = weekOverWeek(days(30, i => (i >= 23 ? 2 : 0)));
    assert.equal(w.prev7, 0);
    assert.equal(w.deltaPct, null, "没有基数时给 null，界面显示「开始有记录」");
    assert.match(deltaText(w), /开始有记录/);
});

test("环比：两边都是 0 是持平，不是「没有数据」", () => {
    const w = weekOverWeek(days(30, () => 0));
    assert.equal(w.deltaPct, 0);
    assert.match(deltaText(w), /持平/);
});

test("环比：输入乱序也要按日历切窗口（不能信服务端顺序）", () => {
    const shuffled = days(30, i => (i >= 23 ? 3 : 1)).reverse();
    const w = weekOverWeek(shuffled);
    assert.equal(w.last7, 21, "乱序输入下仍要取到日历上最近的 7 天");
    assert.equal(w.prev7, 7);
});

test("占比：各项加起来约等于 100，且不出 NaN", () => {
    const slices = shareOf([
        { key: "a", count: 1 },
        { key: "b", count: 1 },
        { key: "c", count: 2 },
    ]);
    assert.equal(slices.find(s => s.key === "a")!.pct, 25);
    assert.equal(slices.find(s => s.key === "c")!.pct, 50);
    const total = slices.reduce((n, s) => n + s.pct, 0);
    assert.ok(Math.abs(total - 100) < 0.5, `占比之和应约等于 100（实际 ${total}）`);
});

test("占比：总量为 0 时给 0，绝不返回 NaN", () => {
    const slices = shareOf([{ key: "a", count: 0 }]);
    assert.equal(slices[0].pct, 0);
    assert.equal(Number.isNaN(slices[0].pct), false, "NaN% 会直接显示成 NaN%");
});

test("活跃度：峰值 / 活跃天数 / 空白天数 / 活跃日均", () => {
    const s = dailySummary(days(30, i => (i === 10 ? 9 : i % 3 === 0 ? 2 : 0)));
    assert.equal(s.peak?.count, 9, "峰值要挑出最多那天");
    assert.equal(s.peak?.day, "2026-10-02");
    assert.equal(s.activeDays, 11, "1 天(第10天) + i%3==0 的 10 天");
    assert.equal(s.quietDays, 19);
    assert.ok(s.avgOnActiveDays > 0, "活跃日均按活跃天算，不把空白天摊进去");
});

test("活跃度：全零时没有峰值", () => {
    const s = dailySummary(days(30, () => 0));
    assert.equal(s.peak, null, "全零不该报「某天峰值 0 次」");
    assert.equal(s.activeDays, 0);
    assert.equal(s.avgOnActiveDays, 0);
});
