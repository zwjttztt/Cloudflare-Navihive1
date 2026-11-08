import test from "node:test";
import assert from "node:assert/strict";
import { beijingDateStamp, fmtAuditDateTime, fmtBytes, fmtDateTime, fmtRelative } from "../src/utils/format";
import {
    AUTO_BACKUP_STALE_DAYS,
    daysSince,
    formatSize,
    formatTime,
} from "../src/utils/backupFormat";

for (const [bytes, expected] of [
    [0, "0 B"], [1023, "1023 B"], [1024, "1 KB"],
    [1536, "2 KB"], [1048576, "1.0 MB"], [NaN, "0 B"],
] as const) {
    test(`fmtBytes formats ${bytes}`, () => assert.equal(fmtBytes(bytes), expected));
}

test("backup size retains its own missing sentinel and precision", () => {
    assert.equal(formatSize(0), "未知大小");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(1048576), "1.00 MB");
});

test("date formatting preserves raw invalid values and explicit empty fallback", () => {
    assert.equal(fmtDateTime("not-a-date"), "not-a-date");
    assert.equal(fmtDateTime("not-a-date", { fallback: "" }), "");
    assert.equal(fmtDateTime(""), "");
    assert.equal(formatTime(""), "");
    assert.equal(formatTime("unknown"), "unknown");
    assert.equal(fmtDateTime(new Date(NaN), { fallback: "—" }), "—");
});

test("审计UTC时间固定显示北京时间，跨日期边界且不依赖浏览器时区", () => {
    const expected = "2026/11/8 00:00:00";
    for (const value of ["2026-11-07 16:00:00", "2026-11-07T16:00:00Z", "2026-11-08T00:00:00+08:00", "2026-11-07T08:00:00-08:00"]) {
        assert.equal(fmtAuditDateTime(value), expected);
    }
    assert.equal(fmtAuditDateTime("2026-11-08 02:38:16"), "2026/11/8 10:38:16");
    assert.equal(fmtAuditDateTime("2026-12-31 16:00:00"), "2027/1/1 00:00:00");
    assert.equal(fmtAuditDateTime("2026-11-07 16:00:00.123"), expected);
    assert.equal(fmtAuditDateTime(new Date("2026-11-07T16:00:00Z")), expected);
    assert.equal(fmtAuditDateTime(Date.parse("2026-11-07T16:00:00Z")), expected);
    assert.equal(fmtAuditDateTime("invalid"), "invalid");
    assert.equal(fmtAuditDateTime("invalid", "—"), "—");
    assert.equal(fmtAuditDateTime(""), "");
    assert.equal(fmtAuditDateTime(new Date(NaN), "—"), "—");
});

// 新增断言①：形态①（SQLite 无时区 UTC 文本）固定显示为北京时间（+8h），且不受本地时区影响。
// "2024-01-02 12:34:56" 是 UTC 12:34 → 北京 20:34。
test("形态① UTC 文本 → 固定北京时间显示（紧凑 YYYY-MM-DD HH:MM）", () => {
    assert.equal(fmtDateTime("2024-01-02 12:34:56", { style: "compact" }), "2024-01-02 20:34");
    assert.equal(formatTime("2024-01-02 12:34:56.123"), "2024-01-02 20:34");
    assert.equal(formatTime("2024-01-02T12:34"), "2024-01-02 20:34");
    // 同一绝对时刻的另两种写法（带 Z / 带偏移）也落到同一个北京钟面
    assert.equal(fmtDateTime("2024-01-02T12:34:56Z", { style: "compact" }), "2024-01-02 20:34");
    assert.equal(fmtDateTime("2024-01-02T20:34:56+08:00", { style: "compact" }), "2024-01-02 20:34");
    // 跨日：UTC 16:00 → 北京次日 00:00
    assert.equal(fmtDateTime("2026-11-07 16:00:00", { style: "compact" }), "2026-11-08 00:00");
});

test("ISO offset / Z / epoch 固定按北京时间 locale 输出，不随本地时区漂移", () => {
    // 期望值写死为北京钟面（toLocaleString("zh-CN",{hour12:false,timeZone:"Asia/Shanghai"}) 的结果），
    // 与运行机器的本地时区无关。
    assert.equal(fmtDateTime("2024-01-02T12:34:56Z"), "2024/1/2 20:34:56");
    assert.equal(fmtDateTime("2024-01-02T12:34:56+08:00"), "2024/1/2 12:34:56");
    // 字符串与等价 Date 走同一路径，输出一致
    assert.equal(fmtDateTime("2024-01-02T12:34:56Z", { style: "compact" }), fmtDateTime(new Date("2024-01-02T12:34:56Z"), { style: "compact" }));
    assert.equal(fmtDateTime(0), "1970/1/1 08:00:00");
});

test("beijingDateStamp：下载文件名用北京日期 YYYY-MM-DD（+8h 跨日也算北京）", () => {
    // UTC 2026-01-02 17:00 → 北京 2026-01-03 01:00
    assert.equal(beijingDateStamp(Date.UTC(2026, 0, 2, 17, 0, 0)), "2026-01-03");
    // UTC 2026-01-02 02:00 → 北京同日 10:00
    assert.equal(beijingDateStamp(Date.UTC(2026, 0, 2, 2, 0, 0)), "2026-01-02");
    assert.match(beijingDateStamp(), /^\d{4}-\d{2}-\d{2}$/);
});

const now = new Date("2026-01-01T00:00:00Z");
for (const [seconds, expected] of [
    [0, "刚刚"], [59, "刚刚"], [60, "1 分钟前"], [3600, "1 小时前"],
    [86400, "1 天前"], [30 * 86400, "1 个月前"], [359 * 86400, "11 个月前"],
    [360 * 86400, "12 个月前"], [364 * 86400, "12 个月前"], [365 * 86400, "1 年前"],
    [-59, "即将"], [-60, "1 分钟后"], [-3600, "1 小时后"], [-86400, "1 天后"],
] as const) {
    test(`relative time boundary ${seconds} seconds`, () => {
        assert.equal(fmtRelative(now.getTime() - seconds * 1000, { now }), expected);
    });
}

// ---- 「上次自动备份是几天前」：备份页那两行文案的原料 ----

test("daysSince：按整天向下取整，解析不出来返回 null", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const day = 86_400_000;
    assert.equal(daysSince(new Date(now - 2 * day).toISOString(), now), 2);
    // 差 1 毫秒不满 3 天：显示「2 天前」比「3 天前」诚实
    assert.equal(daysSince(new Date(now - 3 * day + 1).toISOString(), now), 2);
    assert.equal(daysSince(new Date(now).toISOString(), now), 0);
    // 时间戳在未来（机器时钟被改过）：夹到 0，不显示「-3 天前」
    assert.equal(daysSince(new Date(now + 3 * day).toISOString(), now), 0);
    assert.equal(daysSince("", now), null);
    assert.equal(daysSince("not-a-date", now), null);
});

test("AUTO_BACKUP_STALE_DAYS 是 8：比 6.5 天的间隔多留一天半，避免「晚一小时」就报警", () => {
    assert.equal(AUTO_BACKUP_STALE_DAYS, 8);
    assert.ok(AUTO_BACKUP_STALE_DAYS > 6.5, "报警阈值必须大于备份间隔，否则正常节奏也会报警");
});
