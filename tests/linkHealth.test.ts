// tests/linkHealth.test.ts
// 失效检测的多端合并逻辑单测。
// 关键点：「是否失效」不是布尔字段，而是从 probe（最近成功）/ dead（最近失败）
// 两份时间戳推导出来的 —— dead > probe 才算失效。合并时各取较大时间戳即可，
// 不需要处理「谁删了谁的标记」。这里测的就是这个推导与合并。
//
// localStorage 由测试运行器注入（harness/unit-tests.mjs 在 bundle 前面塞了个最小实现），
// 所以这几个模块可以按普通方式静态导入。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clearDeadLinks,
    exportLinkHealth,
    markLink,
    markLinkAlive,
    mergeLinkHealth,
    readDeadLinks,
    readWhitelist,
} from "../src/utils/linkHealth";

const reset = () => localStorage.clear();

/** 临时把 Date.now 拨到未来，让「后发生的探测」真的更晚 */
const withTimeOffset = (offsetMs: number, run: () => void) => {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    try {
        run();
    } finally {
        Date.now = realNow;
    }
};

test("标记失效后出现在失效清单里", () => {
    reset();
    markLink("https://a.com", false);
    assert.deepEqual(Object.keys(readDeadLinks()), ["https://a.com"]);
});

test("之后探测成功就自动从失效清单里消失（不需要手动删）", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => markLink("https://a.com", true));
    assert.equal(readDeadLinks()["https://a.com"], undefined);
});

test("手动标记「其实能访问」会进白名单，并立刻从失效清单消失", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => markLinkAlive("https://a.com"));
    assert.deepEqual(readWhitelist(), ["https://a.com"]);
    assert.equal(readDeadLinks()["https://a.com"], undefined);
});

test("清空失效记录时同时记一次探测成功（否则云端旧记录会被带回来）", () => {
    reset();
    markLink("https://a.com", false);
    withTimeOffset(1000, () => clearDeadLinks());
    assert.deepEqual(readDeadLinks(), {});
    const snapshot = exportLinkHealth();
    assert.ok(snapshot.probe["https://a.com"] > 0, "清空时应留下一次探测成功的时间戳");
});

test("合并远端：晚发生的探测结果胜出", () => {
    reset();
    markLink("https://a.com", false); // 本机判定失效
    const localDeadAt = exportLinkHealth().dead["https://a.com"];

    // 远端记录「更晚的时候探测成功了」
    withTimeOffset(2000, () => {
        mergeLinkHealth({
            v: 1,
            dead: {},
            probe: { "https://a.com": localDeadAt + 1000 },
            white: [],
        });
    });
    // 让本机时间往前走一点，确保比较是有意义的
    withTimeOffset(3000, () => {
        markLink("https://b.com", false);
    });

    assert.equal(
        readDeadLinks()["https://a.com"],
        undefined,
        "远端更晚的成功应该覆盖本机的失效"
    );
});

test("合并远端：本机更新的记录不会被旧的远端数据顶掉", () => {
    reset();
    withTimeOffset(5000, () => markLink("https://a.com", true));
    const localProbeAt = exportLinkHealth().probe["https://a.com"];

    mergeLinkHealth({
        v: 1,
        dead: { "https://a.com": localProbeAt - 1000 }, // 远端是更早的失败
        probe: {},
        white: [],
    });
    assert.equal(readDeadLinks()["https://a.com"], undefined, "旧失败不该盖掉新成功");
});

test("合并远端白名单取并集", () => {
    reset();
    markLinkAlive("https://a.com");
    mergeLinkHealth({ v: 1, dead: {}, probe: {}, white: ["https://b.com"] });
    assert.deepEqual(readWhitelist().sort(), ["https://a.com", "https://b.com"]);
});

test("版本号对不上就整体忽略（防止以后改结构读到脏数据）", () => {
    reset();
    mergeLinkHealth({
        v: 2 as unknown as 1,
        dead: { "https://x.com": 1 },
        probe: {},
        white: [],
    });
    assert.deepEqual(readDeadLinks(), {});
});

test("导出快照再合并回自己是幂等的", () => {
    reset();
    markLink("https://a.com", false);
    const before = JSON.stringify(exportLinkHealth());
    mergeLinkHealth(exportLinkHealth());
    assert.equal(JSON.stringify(exportLinkHealth()), before);
});
