// tests/linkDemote.test.ts
// 旧判据留下的「失效」标记降级成「疑似」。
//
// 背景：`一次探测失败就标失效` 那条老规则误伤率太高，已经改成连续两次。但老规则
// 留下的标记还躺在 dead 表里 —— 不处理的话用户升级完打开页面，那几个天天在用的站
// 照样挂着「失效」，只会觉得这功能没救了（就是那张截图里的哔哩哔哩）。
//
// 这里最难测的不是「降级」本身，而是**它得经得起云端回填**：失效记录是可以从服务端
// 合并回来的（mergeLinkHealth 取两边较大值），本机降级完、下次启动云端那份旧的又并
// 回来 —— 用「迁移过没有」的布尔标记就永远清不干净了。所以实现用的是基线时间戳。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    demoteLegacyDeadMarks,
    exportLinkHealth,
    markLink,
    mergeLinkHealth,
    onLinkHealthChange,
    probeLinks,
    readDeadLinks,
    readSuspectTimes,
    SUSPECT_WINDOW_MS,
} from "../src/utils/linkHealth";

const URL_A = "https://a.com/page";
const URL_B = "https://b.com/page";

/** 时间旅行：把 Date.now 整体拨快 */
let nowOffset = 0;
const realNow = Date.now;
const advance = (ms: number) => {
    nowOffset += ms;
};
/** 现在几点（跟着 travel 走） */
const now = () => realNow() + nowOffset;

/** 上传回调被调用了几次：降级后必须通知云端，否则旧记录还会被合并回来 */
let changes = 0;
const originalFetch = globalThis.fetch;

/** 直接往 dead 表里塞一条「很久以前判定的失效」，模拟老版本留下的数据 */
const seedLegacyDead = (url: string, at: number) => {
    const raw = localStorage.getItem("navihive:deadLinks");
    const map = raw ? JSON.parse(raw) : {};
    map[url] = at;
    localStorage.setItem("navihive:deadLinks", JSON.stringify(map));
};

beforeEach(() => {
    localStorage.clear();
    nowOffset = 0;
    changes = 0;
    Date.now = () => realNow() + nowOffset;
    onLinkHealthChange(() => {
        changes += 1;
    });
    globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
    }) as typeof fetch;
});

afterEach(() => {
    onLinkHealthChange(null);
    Date.now = realNow;
    globalThis.fetch = originalFetch;
});

test("老判据留下的失效标记被降级成疑似，卡片上不再显示失效", () => {
    seedLegacyDead(URL_A, now() - 30 * 24 * 60 * 60 * 1000); // 一个月前判定的
    assert.ok(readDeadLinks()[URL_A], "前提：降级前这张卡是标着失效的");

    const moved = demoteLegacyDeadMarks();

    assert.equal(moved, 1);
    assert.deepEqual(readDeadLinks(), {}, "降级后不该再有失效标记");
    assert.ok(readSuspectTimes()[URL_A], "但要在疑似表里留一份");
});

test("降级用的是原来那条时间戳，不是当前时间", () => {
    const old = now() - 30 * 24 * 60 * 60 * 1000;
    seedLegacyDead(URL_A, old);

    demoteLegacyDeadMarks();

    assert.equal(readSuspectTimes()[URL_A], old);
});

test("迁移之后才判定的失效不被降级（那是真连续两次失败的结果）", () => {
    const baseline = now();
    demoteLegacyDeadMarks(); // 第一次调用：建立基线
    advance(1000);
    markLink(URL_A, false); // 迁移之后人工标失效

    advance(60 * 1000);
    const moved = demoteLegacyDeadMarks();

    assert.equal(moved, 0, "不该降级迁移之后才产生的标记");
    assert.ok(readDeadLinks()[URL_A], "人工标的失效要留着");
    assert.ok(baseline > 0);
});

test("降级后会通知云端 —— 否则云端那份旧的还会被合并回来", () => {
    seedLegacyDead(URL_A, now() - 1000);
    changes = 0;

    demoteLegacyDeadMarks();

    assert.equal(changes, 1);
});

test("没有可降级的东西时不触发上传（避免每次启动都白传一次）", () => {
    demoteLegacyDeadMarks(); // 建立基线，此时没有 dead
    changes = 0;

    const moved = demoteLegacyDeadMarks();

    assert.equal(moved, 0);
    assert.equal(changes, 0);
});

test("云端回填的旧记录会被再降级一次（这是不用布尔标记的原因）", () => {
    demoteLegacyDeadMarks(); // 本机降级过，基线已建立
    // 服务端那份快照还是老的（取两边较大值，会把旧 dead 并回来）
    mergeLinkHealth({
        v: 1,
        dead: { [URL_A]: now() - 10 * 24 * 60 * 60 * 1000 },
        probe: {},
        white: [],
    });
    assert.ok(readDeadLinks()[URL_A], "前提：云端那份把旧标记并回来了");

    const moved = demoteLegacyDeadMarks();

    assert.equal(moved, 1, "回填的旧记录不会被放过");
    assert.deepEqual(readDeadLinks(), {});
});

test("不把疑似时间往前推：已有更新的疑似就保留", () => {
    const old = now() - 30 * 24 * 60 * 60 * 1000;
    seedLegacyDead(URL_A, old);
    demoteLegacyDeadMarks();
    const firstSuspect = readSuspectTimes()[URL_A];

    // 又来了一条更旧的 dead（比如从另一台很久没同步的设备并回来）
    advance(1000);
    seedLegacyDead(URL_A, old - 60 * 1000);
    demoteLegacyDeadMarks();

    assert.equal(
        readSuspectTimes()[URL_A],
        firstSuspect,
        "往前推时间戳会让「连续两次」更容易成立，等于把降级打了折扣"
    );
});

test("最近才判定的旧标记降级后，再失败一次就标失效（兜底路径是通的）", async () => {
    seedLegacyDead(URL_A, now() - 24 * 60 * 60 * 1000); // 一天前判定的
    demoteLegacyDeadMarks();
    assert.deepEqual(readDeadLinks(), {});

    await probeLinks([URL_A]);

    assert.ok(readDeadLinks()[URL_A], "降级不是免死金牌，真连不上还是会标上");
});

test("降级保留原时间戳，所以很久以前的旧账不会让下一次失败直接成立", async () => {
    seedLegacyDead(URL_A, now() - 24 * 60 * 60 * 1000);
    demoteLegacyDeadMarks();

    // 跨过疑似有效期：中间大概率早就恢复了，不该拿旧账算数
    advance(SUSPECT_WINDOW_MS - 12 * 60 * 60 * 1000);
    await probeLinks([URL_A]);

    assert.deepEqual(readDeadLinks(), {}, "旧账过期了，得重新失败两次");
    assert.ok(readSuspectTimes()[URL_A]);
});

test("白名单里的链接本来就不算失效，降级不会把它还原成疑似", () => {
    // 先让白名单生效：markLinkAlive 会清 dead 并加白名单
    seedLegacyDead(URL_A, now() - 1000);
    markLink(URL_A, true);
    assert.deepEqual(readDeadLinks(), {});

    const moved = demoteLegacyDeadMarks();

    assert.equal(moved, 0, "已经被纠偏过的链接不该再进疑似表");
    assert.deepEqual(readSuspectTimes(), {});
});

test("导出的快照里带降级后的疑似，dead 是空的", () => {
    seedLegacyDead(URL_A, now() - 1000);
    seedLegacyDead(URL_B, now() - 2000);
    demoteLegacyDeadMarks();

    const snapshot = exportLinkHealth();

    assert.deepEqual(snapshot.dead, {});
    assert.equal(Object.keys(snapshot.suspect ?? {}).length, 2);
});
