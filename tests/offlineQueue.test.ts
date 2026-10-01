// tests/offlineQueue.test.ts
// 离线写入队列的单测。这块逻辑最容易错的两点：
// 1) 离线时入队、在线时（服务端拒绝）绝不该入队 —— 否则把脏数据塞进队列反复重放；
// 2) 重放仍失败的操作必须放回队列，不能悄悄丢。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    enqueueMutation,
    takeAll,
    pendingCount,
    flushOfflineQueue,
    isOfflineError,
    wrapMutations,
    setAccountUid,
    OfflineQueuedError,
    type MutationApi,
} from "../src/API/offlineQueue";

// 每个用例前把模块内的单例队列清空（takeAll 会取出并清空），账号回到匿名
const reset = () => {
    setAccountUid(null);
    takeAll();
};

test("enqueue / pendingCount / takeAll：取出即清空", () => {
    reset();
    enqueueMutation("createSite", [{ id: 1 }]);
    enqueueMutation("deleteSite", [5]);
    assert.equal(pendingCount(), 2);
    const all = takeAll();
    assert.equal(all.length, 2);
    assert.equal(all[0].kind, "createSite");
    assert.equal(pendingCount(), 0);
});

test("flushOfflineQueue：逐个重放并回报成功数", async () => {
    reset();
    const calls: { kind: string; args: unknown[] }[] = [];
    const api: MutationApi = {
        createSite: async (...a: unknown[]) => { calls.push({ kind: "createSite", args: a }); return { id: 9 }; },
        deleteSite: async (...a: unknown[]) => { calls.push({ kind: "deleteSite", args: a }); return true; },
        setConfig: async (...a: unknown[]) => { calls.push({ kind: "setConfig", args: a }); return true; },
    };
    enqueueMutation("createSite", [{ name: "a" }]);
    enqueueMutation("deleteSite", [5]);
    const done = await flushOfflineQueue(api);
    assert.equal(done, 2);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, [{ name: "a" }]);
    assert.equal(pendingCount(), 0);
});

test("flushOfflineQueue：重放失败（返回假）的操作放回队列，不丢", async () => {
    reset();
    const api: MutationApi = { setConfig: async () => false }; // returnsSuccess → 视为失败
    enqueueMutation("setConfig", ["k", "v"]);
    const done = await flushOfflineQueue(api);
    assert.equal(done, 0);
    assert.equal(pendingCount(), 1); // 放回队列了
    assert.equal(takeAll()[0].kind, "setConfig");
});

test("换账号登录后，上一个人排队的编辑不会被补发（不串号）", async () => {
    reset();
    setAccountUid(1);
    enqueueMutation("createSite", [{ name: "A 的编辑" }]);
    // 登出再登另一个账号：队列换成另一份，A 那条既不该被发也不该被看见
    setAccountUid(2);
    assert.equal(pendingCount(), 0, "新账号看到的是自己的空队列");
    const calls: unknown[][] = [];
    const api: MutationApi = {
        createSite: async (...a: unknown[]) => { calls.push(a); return { id: 1 }; },
    };
    const done = await flushOfflineQueue(api);
    assert.equal(done, 0);
    assert.equal(calls.length, 0, "A 的操作绝不能发到 B 的会话里");
    // 切回 A，排队的内容还在，可以正常重放
    setAccountUid(1);
    assert.equal(pendingCount(), 1);
    assert.equal(await flushOfflineQueue(api), 1);
});

test("服务端明确拒绝（4xx）的操作不再反复重放", async () => {
    reset();
    const api: MutationApi = {
        setConfig: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(pendingCount(), 0, "4xx 再排也没用，不该让角标永远挂着");
});

test("还连不上（网络错）的操作留在队列里等下次", async () => {
    reset();
    const api: MutationApi = {
        setConfig: async () => { throw new TypeError("Failed to fetch"); },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    assert.equal(await flushOfflineQueue(api), 0);
    assert.equal(pendingCount(), 1, "网络没恢复就该继续留着");
});

test("重放不会被并发的两次调用重入（同一条只发一次）", async () => {
    reset();
    let calls = 0;
    const api: MutationApi = {
        setConfig: async () => { calls += 1; return true; },
    };
    enqueueMutation("setConfig", ["k", "v"]);
    await Promise.all([flushOfflineQueue(api), flushOfflineQueue(api)]);
    assert.equal(calls, 1);
});

test("isOfflineError：网络错识别，服务端错不识别", () => {
    assert.equal(isOfflineError(new TypeError("Failed to fetch")), true);
    assert.equal(isOfflineError(new Error("fetch failed")), true);
    assert.equal(isOfflineError(new Error("500 Internal Server Error")), false);
    assert.equal(isOfflineError(new Error("参数错误")), false);
    assert.equal(isOfflineError(null), false);
});

test("wrapMutations：网络错入队并抛 OfflineQueuedError；服务端错原样抛出不入队", async () => {
    reset();
    const api: MutationApi = {
        // 网络错（fetch 抛 TypeError）→ 应入队 + 抛 OfflineQueuedError
        createSite: async () => { throw new TypeError("Failed to fetch"); },
        // 服务端错（5xx）→ 原样抛出，绝不能入队
        setConfig: async () => { throw new Error("500 boom"); },
    };
    wrapMutations(api);

    await assert.rejects(
        () => api.createSite({ id: 1 }),
        (e: unknown) => e instanceof OfflineQueuedError
    );
    assert.equal(pendingCount(), 1);

    await assert.rejects(
        () => api.setConfig("k", "v"),
        (e: unknown) => e instanceof Error && !(e instanceof OfflineQueuedError) && e.message.includes("500")
    );
    assert.equal(pendingCount(), 1); // 没新增
});
