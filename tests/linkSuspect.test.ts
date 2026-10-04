// tests/linkSuspect.test.ts
// 「两次探测失败才标失效」这条规则。
//
// 背景：linkHealth 用的是 no-cors 探测，拿不到真实状态码 —— fetch 抛错只说明
// 「这次请求没发出去」。网络抖一下、被拦截插件挡掉、DNS 临时抽风、站点慢过 6 秒
// 超时，都会失败，而这些站点其实都还好好的。一次失败就贴「失效」，误伤率太高。
//
// 所以规则改成：第一次失败只记「疑似」（suspect），窗口内再失败一次才升级成 dead。
// 这里测的就是那个升级 / 撤销 / 过期的过程。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
    exportLinkHealth,
    markLink,
    mergeLinkHealth,
    probeLinks,
    readDeadLinks,
    readSuspectTimes,
    SUSPECT_WINDOW_MS,
} from "../src/utils/linkHealth";

/** 探测结果由测试决定：ok = fetch 正常返回，fail = 抛网络错误 */
let mode: "ok" | "fail" = "ok";
/** 真实发出的请求次数（用来验证「同域名只探一次」） */
let fetchCalls = 0;
const originalFetch = globalThis.fetch;

/** 时间旅行：把 Date.now 整体拨快，用来验证「疑似」会不会过期 */
let nowOffset = 0;
const realNow = Date.now;
const advance = (ms: number) => {
    nowOffset += ms;
};

const URL_A = "https://a.com/page";
const URL_B = "https://b.com/page";

beforeEach(() => {
    localStorage.clear();
    mode = "ok";
    fetchCalls = 0;
    nowOffset = 0;
    Date.now = () => realNow() + nowOffset;
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        if (mode === "fail") throw new TypeError("Failed to fetch");
        return new Response(null, { status: 200 });
    }) as typeof fetch;
});

afterEach(() => {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
});

/** 跑一轮探测（都是不同域名，不会被「同域名只探一次」合并掉） */
const sweep = (urls: string[]) => probeLinks(urls, { concurrency: 1 });

test("第一次失败不标失效，只记疑似", async () => {
    mode = "fail";
    const r = await sweep([URL_A]);

    assert.deepEqual(readDeadLinks(), {}, "一次失败不该直接贴「失效」");
    assert.equal(Object.keys(readSuspectTimes()).length, 1, "但要把这次失败记下来");
    assert.equal(r.suspect, 1);
    assert.equal(r.probed, 1);
});

test("窗口内第二次失败才升级成失效，并清掉疑似", async () => {
    mode = "fail";
    await sweep([URL_A]);
    const r = await sweep([URL_A]);

    assert.equal(Object.keys(readDeadLinks()).length, 1, "第二次失败才标失效");
    assert.deepEqual(readSuspectTimes(), {}, "升级之后疑似就该撤掉");
    assert.equal(r.suspect, 0, "这次是「确认」而不是「又一次疑似」");
});

test("失败之后成功一次：失效与疑似一起清掉", async () => {
    mode = "fail";
    await sweep([URL_A]);
    await sweep([URL_A]);
    assert.equal(Object.keys(readDeadLinks()).length, 1);

    mode = "ok";
    await sweep([URL_A]);
    assert.deepEqual(readDeadLinks(), {});
    assert.deepEqual(readSuspectTimes(), {});
});

// 这条盯的是「成功时必须把疑似一起删掉」。漏删的话，那条旧疑似会一直挂着，
// 等哪天网络抖一下失败一次，就会被当成「窗口内连续第二次」直接标失效 ——
// 也就是说一次偶发抖动就能标死一个天天在用的站，正是这次要治的毛病。
test("失败一次又成功后：残留的疑似必须清掉，否则下次偶发失败会被当成连续第二次", async () => {
    mode = "fail";
    await sweep([URL_A]);
    assert.equal(Object.keys(readSuspectTimes()).length, 1);

    mode = "ok";
    await sweep([URL_A]);
    assert.deepEqual(readSuspectTimes(), {}, "成功了就不该再留着疑似");

    // 很久之后网络抖了一下：这只是「又一次第一次失败」，不该标失效
    advance(60_000);
    mode = "fail";
    await sweep([URL_A]);
    assert.deepEqual(readDeadLinks(), {}, "一次偶发失败不该把站点标死");
    assert.equal(Object.keys(readSuspectTimes()).length, 1);
});

test("疑似会过期：隔了超过一个窗口再失败，仍算第一次", async () => {
    mode = "fail";
    await sweep([URL_A]);

    advance(SUSPECT_WINDOW_MS + 1000);
    const r = await sweep([URL_A]);

    assert.deepEqual(
        readDeadLinks(),
        {},
        "中间隔了那么久，很可能早就恢复了，不能拿旧账算数"
    );
    assert.equal(r.suspect, 1);
});

test("已经确认失效的链接再次失败：保持失效（不能因为疑似被清掉就取消标记）", async () => {
    mode = "fail";
    await sweep([URL_A]);
    await sweep([URL_A]);
    assert.equal(Object.keys(readDeadLinks()).length, 1);

    // 第三次失败：suspect 在升级时就清掉了，所以走的是「重新记疑似」分支。
    // 关键是不能把 dead 也一起清了。
    await sweep([URL_A]);
    assert.equal(Object.keys(readDeadLinks()).length, 1, "失效标记必须还在");
});

test("同域名共享探测结果：一次失败算一次，两个链接各记一份疑似", async () => {
    mode = "fail";
    const r = await sweep(["https://a.com/one", "https://a.com/two"]);

    assert.deepEqual(readDeadLinks(), {});
    assert.equal(Object.keys(readSuspectTimes()).length, 2);
    // probed 是「待探测的链接数」，请求数要看真实发出的 fetch 次数
    assert.equal(r.probed, 2);
    assert.equal(fetchCalls, 1, "同域名只发一次请求");
    assert.equal(r.suspect, 2, "但两个链接各自记一份疑似");
});

test("多个链接各自独立计数", async () => {
    mode = "fail";
    await sweep([URL_A]); // A 第一次
    await sweep([URL_A, URL_B]); // A 第二次（确认），B 第一次
    assert.equal(Object.keys(readDeadLinks()).length, 1, "只有 A 被确认失效");
    assert.equal(Object.keys(readSuspectTimes()).length, 1, "B 还只是疑似");
});

test("人工标记失效不需要凑够两次（用户的判断比探测可靠）", () => {
    markLink(URL_A, false);
    assert.equal(Object.keys(readDeadLinks()).length, 1);
    assert.deepEqual(readSuspectTimes(), {});
});

test("疑似会进云端快照，合并时取较新的时间戳", () => {
    mode = "fail";
    // 直接写一份手工的疑似记录，验证导出 / 合并这一路
    const snapshot = {
        v: 1 as const,
        dead: {},
        probe: {},
        white: [],
        suspect: { [URL_A]: 1000 },
    };
    mergeLinkHealth(snapshot);
    assert.equal(readSuspectTimes()[URL_A], 1000);

    // 较旧的时间戳不该覆盖较新的
    mergeLinkHealth({ ...snapshot, suspect: { [URL_A]: 500 } });
    assert.equal(readSuspectTimes()[URL_A], 1000);

    mergeLinkHealth({ ...snapshot, suspect: { [URL_A]: 2000 } });
    assert.equal(readSuspectTimes()[URL_A], 2000);

    assert.deepEqual(exportLinkHealth().suspect, { [URL_A]: 2000 });
});

test("老快照没有 suspect 字段：缺了就当没有，不报错也不清空本机", () => {
    // 先在本机记一份疑似
    markLink(URL_A, false);
    const suspectBefore = readSuspectTimes();

    mergeLinkHealth({ v: 1, dead: {}, probe: {}, white: [] });
    assert.deepEqual(readSuspectTimes(), suspectBefore, "老快照不该动本机的疑似表");
});
