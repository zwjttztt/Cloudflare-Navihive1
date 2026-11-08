// 按需批量检测的提示与同步通知契约；直接测试真实模块，不真实联网。
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { describeLinkCheck, probeLinks } from "../src/utils/linkCheck";
import {
    FRESH_WINDOW_MS,
    onLinkHealthChange,
    readProbeTimes,
    readSuspectTimes,
} from "../src/utils/linkHealth";

describe("未知检测结果的提示", () => {
    for (const deadCount of [0, 2]) {
        test(`已有 ${deadCount} 条失效且存在未知时不宣称全部可用`, () => {
            const summary = describeLinkCheck(deadCount, 1, 3);

            assert.equal(summary.severity, "info");
            assert.equal(summary.offerFilter, deadCount > 0);
            assert.match(summary.text, /3 个暂时无法确认/);
            assert.match(summary.text, /未判为失效/);
            assert.doesNotMatch(summary.text, /所有链接都能访问/);
            assert.doesNotMatch(summary.text, /再检测一次仍失败才会标失效/);
        });
    }
});

describe("批量完成只发送一次同步变更通知", () => {
    test("多worker及混合HTTP/未知结果完成后恰好通知一次", async () => {
        localStorage.clear();
        const previousFetch = globalThis.fetch;
        const healthy = "https://batch.example/healthy";
        const missing = "https://batch.example/missing";
        const unknown = "https://batch.example/unknown";
        const calls: string[] = [];
        let changes = 0;
        onLinkHealthChange(() => { changes += 1; });
        globalThis.fetch = async input => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            calls.push(url);
            assert.ok([healthy, missing, unknown].includes(url));
            if (url === unknown) throw new TypeError("模拟网络未知");
            return new Response(null, { status: url === missing ? 404 : 200 });
        };
        try {
            const result = await probeLinks([healthy, missing, unknown], { concurrency: 3 });

            assert.equal(changes, 1);
            assert.deepEqual(calls.sort(), [healthy, missing, unknown].sort());
            assert.equal(result.probed, 3);
            assert.equal(result.suspect, 2);
            assert.deepEqual(result.dead, {});
            assert.ok(readProbeTimes()[healthy]);
            assert.ok(readSuspectTimes()[missing]);
            assert.equal(readProbeTimes()[unknown], undefined);
            assert.equal(readSuspectTimes()[unknown], undefined);
        } finally {
            globalThis.fetch = previousFetch;
            onLinkHealthChange(null);
            localStorage.clear();
        }
    });

    test("全部近期成功而跳过时仍仅通知一次且不请求网络", async () => {
        localStorage.clear();
        const previousFetch = globalThis.fetch;
        const url = "https://batch.example/fresh";
        let changes = 0;
        let requests = 0;
        globalThis.fetch = async () => {
            requests += 1;
            return new Response(null, { status: 200 });
        };
        try {
            await probeLinks([url]);
            requests = 0;
            onLinkHealthChange(() => { changes += 1; });

            const result = await probeLinks([url], { skipFreshMs: FRESH_WINDOW_MS });

            assert.equal(changes, 1);
            assert.equal(requests, 0);
            assert.equal(result.probed, 0);
            assert.equal(result.skipped, 1);
        } finally {
            globalThis.fetch = previousFetch;
            onLinkHealthChange(null);
            localStorage.clear();
        }
    });
});
