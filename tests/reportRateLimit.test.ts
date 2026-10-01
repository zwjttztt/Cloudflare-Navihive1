// tests/reportRateLimit.test.ts
// 两个公开上报端点的限流（S10 的「端点限速」那一条）。
//
// 关键回归：早先错误上报是**整个实例一个窗口** —— 一个脚本猛刷就能把配额占满，
// 于是别人的真实崩溃被静默丢掉，防滥用反倒变成了新的拒绝服务面。
// 现在按来源 IP 分桶，刷子只能把自己刷出去。

import { test } from "node:test";
import assert from "node:assert/strict";
import { reportError, resetErrorReportLimitForTest } from "../worker/errorReport";
import { handleCspReport, resetCspLimitForTest } from "../worker/csp";

const env = {} as never;

function errorRequest(ip: string): Request {
    return new Request("https://example.com/api/report-error", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Error", message: "boom" }),
    });
}

function cspRequest(ip: string): Request {
    return new Request("https://example.com/api/csp-report", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip, "Content-Type": "application/csp-report" },
        body: JSON.stringify({
            "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://evil.example" },
        }),
    });
}

test("错误上报：同一个 IP 刷爆配额后静默丢弃", async () => {
    resetErrorReportLimitForTest();
    let dropped = 0;
    // 窗口是 10 秒 20 份，多打一倍必有一部分被丢
    for (let i = 0; i < 40; i++) {
        const res = await reportError(errorRequest("1.2.3.4"), env);
        const body = (await res.json()) as { dropped?: boolean };
        if (body.dropped) dropped++;
    }
    assert.ok(dropped > 0, "刷量时必须开始丢弃，否则等于没有上限");
});

test("错误上报：一个人刷爆了，不影响别人上报", async () => {
    resetErrorReportLimitForTest();
    // 先把 1.2.3.4 的配额耗光
    for (let i = 0; i < 40; i++) await reportError(errorRequest("1.2.3.4"), env);

    const res = await reportError(errorRequest("9.9.9.9"), env);
    const body = (await res.json()) as { dropped?: boolean };
    assert.notEqual(body.dropped, true, "别人的配额不该被一个刷子占掉");
});

test("CSP 上报：超限后不再往日志里写（静默 204）", async () => {
    resetCspLimitForTest();
    const original = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
    };
    try {
        let warned = 0;
        for (let i = 0; i < 40; i++) {
            const before = seen.length;
            await handleCspReport(cspRequest("5.6.7.8"));
            if (seen.length > before) warned++;
        }
        assert.ok(warned > 0, "正常范围内的报告要照常记录");
        assert.ok(warned < 40, "刷量时不该全部照单全收");
    } finally {
        console.warn = original;
    }
});

test("CSP 上报：换一个 IP 立刻恢复记录", async () => {
    resetCspLimitForTest();
    const original = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
        seen.push(args.map(String).join(" "));
    };
    try {
        for (let i = 0; i < 40; i++) await handleCspReport(cspRequest("5.6.7.8"));
        const before = seen.length;
        const res = await handleCspReport(cspRequest("8.8.8.8"));
        assert.equal(res.status, 204);
        assert.ok(seen.length > before, "别的来源不该被前面的刷子挡住");
    } finally {
        console.warn = original;
    }
});
