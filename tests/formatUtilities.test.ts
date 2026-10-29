import test from "node:test";
import assert from "node:assert/strict";
import { fmtBytes, fmtDateTime, fmtRelative } from "../src/utils/format";
import { formatSize, formatTime } from "../src/utils/backupFormat";

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

test("SQLite timestamps keep local wall time, including fractional seconds", () => {
    assert.equal(fmtDateTime("2024-01-02 12:34:56", { style: "compact" }), "2024-01-02 12:34");
    assert.equal(formatTime("2024-01-02 12:34:56.123"), "2024-01-02 12:34");
    assert.equal(formatTime("2024-01-02T12:34"), "2024-01-02 12:34");
});

test("ISO offset and Z retain their instant and use local output", () => {
    for (const value of ["2024-01-02T12:34:56Z", "2024-01-02T12:34:56+08:00"]) {
        assert.equal(fmtDateTime(value), new Date(value).toLocaleString("zh-CN", { hour12: false }));
        assert.equal(fmtDateTime(value, { style: "compact" }), fmtDateTime(new Date(value), { style: "compact" }));
    }
    assert.equal(fmtDateTime(0), new Date(0).toLocaleString("zh-CN", { hour12: false }));
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
