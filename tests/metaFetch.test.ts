// tests/metaFetch.test.ts
// worker/meta.ts 的「抓站点信息」失败处理。
//
// 守三件事：
// 1. 522 / 524 这类 Cloudflare 源站抖动是瞬时的，必须重试一次 —— 不重试的话
//    用户点一下「抓取」失败，再点一下就成功了，纯属浪费他一次点击。
// 2. 429（限流）不能重试：人家已经在限流了，往上撞只会锁得更久。
// 3. 错误要翻译成人话。「目标返回 522」对普通用户没有任何指导意义，
//    「源站没响应，可稍后重试或手动填写」才有。

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSiteMeta } from "../worker/meta";

/** 打桩全局 fetch：按调用次序依次返回给定的状态码 */
function stubFetch(statuses: number[]) {
    const calls: string[] = [];
    const original = globalThis.fetch;
    let index = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        const status = statuses[Math.min(index, statuses.length - 1)];
        index++;
        const body =
            status < 300
                ? "<html><head><title>示例站点</title></head></html>"
                : "upstream error";
        return new Response(body, { status, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    return {
        calls,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

const metaRequest = (u: string) =>
    new Request(`https://nav.example.com/api/meta?url=${encodeURIComponent(u)}`);

test("抓取遇 522：重试一次，第二次成功就走成功路径", async () => {
    const stub = stubFetch([522, 200]);
    try {
        const res = await fetchSiteMeta(metaRequest("https://example.com/"));
        assert.equal(res.status, 200);
        const data = (await res.json()) as { title?: string };
        assert.equal(data.title, "示例站点");
        assert.equal(stub.calls.length, 2, "522 之后应该再抓一次");
    } finally {
        stub.restore();
    }
});

test("抓取一直 522：只重试一次就收手，不能无限重试", async () => {
    const stub = stubFetch([522]);
    try {
        const res = await fetchSiteMeta(metaRequest("https://example.com/"));
        assert.equal(res.status, 502);
        // 首次 + 重试 = 2 次，再多就是在给源站添堵
        assert.equal(stub.calls.length, 2);
        const data = (await res.json()) as { error?: string };
        assert.match(data.error || "", /522/);
        assert.match(data.error || "", /源站没响应/);
    } finally {
        stub.restore();
    }
});

test("抓取遇 429：不重试，并且提示是限流", async () => {
    const stub = stubFetch([429]);
    try {
        const res = await fetchSiteMeta(metaRequest("https://example.com/"));
        assert.equal(res.status, 502);
        assert.equal(stub.calls.length, 1, "限流时不准重试");
        const data = (await res.json()) as { error?: string };
        assert.match(data.error || "", /限流/);
    } finally {
        stub.restore();
    }
});

test("抓取遇 404：不重试（重试也不会凭空出现），提示检查网址", async () => {
    const stub = stubFetch([404]);
    try {
        const res = await fetchSiteMeta(metaRequest("https://example.com/nope"));
        assert.equal(res.status, 502);
        assert.equal(stub.calls.length, 1);
        const data = (await res.json()) as { error?: string };
        assert.match(data.error || "", /404/);
    } finally {
        stub.restore();
    }
});

test("正常站点：一次就过，不浪费第二次请求", async () => {
    const stub = stubFetch([200]);
    try {
        const res = await fetchSiteMeta(metaRequest("https://example.com/"));
        assert.equal(res.status, 200);
        assert.equal(stub.calls.length, 1);
    } finally {
        stub.restore();
    }
});
