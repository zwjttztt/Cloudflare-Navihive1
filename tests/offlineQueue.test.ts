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
    OfflineQueuedError,
} from "../src/API/offlineQueue";

// 每个用例前把模块内的单例队列清空（takeAll 会取出并清空）
const reset = () => {
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
    const api: any = {
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
    const api: any = { setConfig: async () => false }; // returnsSuccess → 视为失败
    enqueueMutation("setConfig", ["k", "v"]);
    const done = await flushOfflineQueue(api);
    assert.equal(done, 0);
    assert.equal(pendingCount(), 1); // 放回队列了
    assert.equal(takeAll()[0].kind, "setConfig");
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
    const api: any = {
        // 网络错（fetch 抛 TypeError）→ 应入队 + 抛 OfflineQueuedError
        createSite: async () => { throw new TypeError("Failed to fetch"); },
        // 服务端错（5xx）→ 原样抛出，绝不能入队
        setConfig: async () => { throw new Error("500 boom"); },
    };
    wrapMutations(api);

    await assert.rejects(
        () => api.createSite({ id: 1 }),
        (e: any) => e instanceof OfflineQueuedError
    );
    assert.equal(pendingCount(), 1);

    await assert.rejects(
        () => api.setConfig("k", "v"),
        (e: any) => !(e instanceof OfflineQueuedError) && e.message.includes("500")
    );
    assert.equal(pendingCount(), 1); // 没新增
});
