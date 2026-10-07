// tests/noteTime.test.ts
// 笔记时间的**时区判据**。
//
// 为什么单独设一组：笔记时间显示错 8 小时是个「看起来像环境、其实永远是 bug」的问题。
// D1 的 `CURRENT_TIMESTAMP` 落库是 UTC 串 `2026-10-05 11:05:18`（无 T、无时区后缀），
// V8 按**本地时间**解析它 —— 东八区下 11:05 就变成了本地 11:05，
// 而它真实对应的北京时间是 19:05。用户看到的「笔记时间不对」就是这么来的。
//
// 更阴的是：如果测试数据用 `toISOString().slice(0,19)` 造假，
// 那串是 `2026-10-05T11:05:18`（有 T 但**没 Z**），浏览器一样按本地算，
// 一加一减刚好自洽 —— 本地测试全绿，换真库全错。所以这里**硬钉解析语义**，
// 并且 test 里用的时间串刻意写成 SQLite 的真实形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    formatRelative,
    formatWhen,
    groupLabel,
    parseNoteTime,
} from "../src/utils/noteTime";

/**
 * 造一条「今天的笔记在库里长这样」的串：SQLite 形状（UTC、空格分隔、无时区后缀），
 * 且 **这个串的时钟面就是 hh:mm（UTC 时钟）**。
 *
 * 为什么要这么造而不是随手拼个本地时间串：我们的语义是「无时区后缀按 UTC 解释」，
 * 直接把本地 09:05 拼成串喂进去，函数会正确地把它当成 UTC 09:05 → 本地 17:05，
 * 于是 formatWhen 输出 "17:05"。那说明**实现对、测试期望错**，
 * 很容易被误读成 bug 而去改实现（改错方向）。所以这里明确造「UTC 钟面 = hh:mm」。
 */
const utcTodayAt = (hh: number, mm: number) => {
    const d = new Date();
    // UTC 时钟摆到 hh:mm：东八区（offset -480）就是本地 hh+8 点
    d.setHours(hh + d.getTimezoneOffset() / -60, mm, 0, 0);
    return d.toISOString().slice(0, 19).replace("T", " ");
};

test("SQLite 的 UTC 日期时间（空格、无后缀）按 UTC 解释，不是本地时间", () => {
    const t = parseNoteTime("2026-10-05 11:05:18");
    assert.ok(t, "不该解析失败");
    assert.equal(t.getUTCHours(), 11, "存的时候是 UTC 11 点");
    // 东八区：本地钟表应读到 19 点。这条是核心判据 —— 直接 new Date(串) 会得到 11。
    assert.equal(t.getHours(), 11 + new Date().getTimezoneOffset() / -60, "应按 UTC 转成本地时刻");
});

test("带了 T 却没带时区的串（toISOString().slice(0,19) 那种）也按 UTC", () => {
    const t = parseNoteTime("2026-10-05T11:05:18");
    assert.ok(t);
    assert.equal(t.getUTCHours(), 11, "有 T 没 Z 和空格写法必须一致，不能一条差 8 小时");
});

test("真·带时区的串按绝对时刻解析，不能被强行补 Z", () => {
    // "2026-10-05T11:05:18Z" 是 UTC 11 点 → 本地 19 点，与上面两种写法结果相同
    const z = parseNoteTime("2026-10-05T11:05:18Z");
    const noZ = parseNoteTime("2026-10-05 11:05:18");
    const noT = parseNoteTime("2026-10-05T11:05:18");
    assert.ok(z && noZ && noT);
    assert.equal(
        Math.round(z.getTime() / 60000),
        Math.round(noZ.getTime() / 60000),
        "Z 和空格两种写法必须落到同一时刻"
    );
    assert.equal(Math.round(z.getTime() / 60000), Math.round(noT.getTime() / 60000));
    // +08:00 是绝对时刻 03:05 UTC，和上面三种都不同
    const plus8 = parseNoteTime("2026-10-05T11:05:18+08:00");
    assert.ok(plus8);
    assert.equal(plus8.getUTCHours(), 3, "+08:00 不是 UTC，别当成 11 点");
});

test("垃圾/空值一律给 null（不给 UI 丢一个 Invalid Date）", () => {
    for (const bad of [undefined, null, "", "  ", "不是时间", "2026-13-45 99:99:99"]) {
        assert.equal(parseNoteTime(bad as string), null, `${JSON.stringify(bad)} 应该解析不出`);
    }
});

test("毫秒时间戳（回收站 deletedAt）也能解析", () => {
    const t = parseNoteTime(Date.now());
    assert.ok(t);
    assert.ok(Math.abs(t.getTime() - Date.now()) < 5000);
});

test("formatWhen：今天只给时:分，更早给 M月D日", () => {
    // 两层语义要分清，别搞混：
    //   ① **解析**：无后缀的串按 UTC 解释（串里写 09:05 = 绝对时刻 09:05Z）；
    //   ② **显示**：给人类看的一定是**本地钟面**（这条笔记其实是 17:05 建的）。
    // 所以东八区下期望 17:05，UTC 环境下期望 09:05 —— 用偏移现算，别硬编码。
    const offsetHours = new Date().getTimezoneOffset() / -60;
    const hh = 9 + offsetHours;
    const expect = `${String(hh).padStart(2, "0")}:${String(5).padStart(2, "0")}`;
    assert.equal(formatWhen(utcTodayAt(9, 5)), expect);
    const t = parseNoteTime(utcTodayAt(9, 5));
    assert.ok(t);
    assert.equal(t.getHours(), hh, "解析结果必须是本地钟表（这条钉死按 UTC 解释没写反）");
    // 15 天前：一定不是同一天（除非跨月边界，那就只校验形状）
    const old = parseNoteTime("2026-02-03 11:05:18");
    assert.ok(old);
    const txt = formatWhen("2026-02-03 11:05:18");
    if (old.toDateString() === new Date().toDateString()) assert.match(txt, /^\d{2}:\d{2}$/);
    else assert.equal(txt, "2月3日");
});

test("formatWhen 解析不出就给空串，而不是 Invalid Date", () => {
    assert.equal(formatWhen("不是时间"), "");
    assert.equal(formatWhen(undefined), "");
});

// ---- 阶段四第 13 条：相对时间 ----
//
// `now` 是可注入的，所以这里能钉死边界而不是「跑的时候刚好是几点」。
// 用**真实 Date 对象**当入参最省事（parseNoteTime 本来就吃得下 Date）。
test("formatRelative：分钟 / 小时 / 刚刚 的刻度", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);

    assert.equal(formatRelative(ago(5_000), now), "刚刚", "不到 1 分钟 → 刚刚");
    assert.equal(formatRelative(ago(59_000), now), "刚刚", "59 秒还在「刚刚」里");
    assert.equal(formatRelative(ago(60_000), now), "1分钟前");
    assert.equal(formatRelative(ago(35 * 60_000), now), "35分钟前");
    assert.equal(formatRelative(ago(59 * 60_000), now), "59分钟前");
});

test("formatRelative：超过 1 小时且还在今天 → N小时前", () => {
    // 同一天，往前推 3 小时
    const now = new Date(2026, 9, 6, 15, 0, 0); // 本地 2026-10-06 15:00
    const t = new Date(2026, 9, 6, 12, 0, 0);
    assert.equal(formatRelative(t, now), "3小时前");
});

test("formatRelative：跨天就退回日历式，不再堆小时", () => {
    const now = new Date(2026, 9, 6, 9, 0, 0); // 10-06 09:00
    // 昨天 23:00 —— 只差 10 小时，但跨天了：写「10小时前」反而要人再算一遍
    assert.equal(formatRelative(new Date(2026, 9, 5, 23, 0, 0), now), "昨天");
    // 前天
    assert.equal(formatRelative(new Date(2026, 9, 4, 23, 0, 0), now), "10月4日");
    // 去年 → 带年份
    assert.equal(formatRelative(new Date(2025, 11, 31, 10, 0, 0), now), "2025年12月31日");
});

test("formatRelative：时钟超前（未来时间）不会输出「-1分钟前」", () => {
    const now = new Date(2026, 9, 6, 12, 0, 0);
    assert.equal(formatRelative(new Date(2026, 9, 6, 13, 0, 0), now), "刚刚");
});

test("formatRelative 解析不出就给空串", () => {
    assert.equal(formatRelative("不是时间"), "");
    assert.equal(formatRelative(undefined), "");
});

test("groupLabel：越近的分组越粗（今天/昨天/本周/本月/N 月/年 月）", () => {
    // 基准定在 2026-10-07（周三）：本周从周一 10-05 起算，
    // 这样「本周」里至少有一天不是「昨天」，能单独验到这一档。
    const now = new Date(2026, 9, 7, 12, 0, 0).getTime();
    const at = (y: number, m: number, d: number, h = 10) =>
        new Date(y, m, d, h, 0, 0).getTime();

    assert.equal(groupLabel(at(2026, 9, 7), now), "今天", "今天");
    assert.equal(groupLabel(at(2026, 9, 7, 0), now), "今天", "今天凌晨也算今天");
    assert.equal(groupLabel(at(2026, 9, 6), now), "昨天", "昨天");
    assert.equal(groupLabel(at(2026, 9, 5), now), "本周", "前天属于本周（本周从周一 10-05 起算）");
    assert.equal(groupLabel(at(2026, 9, 5, 8), now), "本周", "本周一属于本周");
    assert.equal(groupLabel(at(2026, 9, 4), now), "本月", "同月但过了本周（周日）");
    assert.equal(groupLabel(at(2026, 9, 1), now), "本月", "月初同理");
    assert.equal(groupLabel(at(2026, 8, 20), now), "9 月", "上个月只给月");
    assert.equal(groupLabel(at(2025, 8, 20), now), "2025 年 9 月", "跨年才给年");
});

test("groupLabel：坏值给「其他」，绝不打 NaN", () => {
    assert.equal(groupLabel("乱写"), "其他");
    assert.equal(groupLabel(undefined), "其他");
    assert.equal(groupLabel(null), "其他");
    assert.equal(groupLabel(""), "其他");
});

test("groupLabel：默认基准是此刻（不传 now 也能用）", () => {
    const today = new Date();
    today.setHours(9, 0, 0, 0);
    assert.equal(groupLabel(today), "今天");
});
