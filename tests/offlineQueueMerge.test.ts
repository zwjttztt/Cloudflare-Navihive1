// tests/offlineQueueMerge.test.ts
// mergeQueues 的直测（2026-11-01 多标签页覆盖写加固）。
//
// 背景：每个标签页各持一份整队内存副本，写盘是整份覆盖 —— B 页落盘会把
// A 页刚入队的操作抹掉。解法是写盘前用 mergeQueues 把盘上「本页没有」的
// 条目并进来。这里把合并逻辑抽成纯函数单独钉死，最容易错的三条：
// 1) 外部新增必须并进来（丢了就是用户编辑凭空消失）；
// 2) 同 opId 必须以本页为准（盘上那份是旧快照，盖掉本页的 sending/退避状态
//    会把错误的状态机写回队列）；
// 3) 没有 opId 的旧条目没法判同一性，两边都保留 —— 宁可重复不丢数据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeQueues, type PendingMutation } from "../src/API/offlineQueue";

/** 造一条最小可用的队列条目 */
const op = (overrides: Partial<PendingMutation> & { opId?: string }): PendingMutation => ({
    kind: "createSite",
    args: [{ name: "x" }],
    ts: 1,
    ...overrides,
});

test("mergeQueues：盘上外部新增的条目必须并入（不能被覆盖写抹掉）", () => {
    const mine = [op({ opId: "a-1" })];
    const disk = [op({ opId: "a-1" }), op({ opId: "b-2", kind: "createGroup" })];
    const merged = mergeQueues(mine, disk);
    assert.equal(merged.length, 2);
    assert.deepEqual(
        merged.map(m => m.opId),
        ["a-1", "b-2"],
        "本页条目在前（保持入队顺序），外部新增追加在后"
    );
});

test("mergeQueues：同 opId 以本页版本为准，别让盘上旧快照盖掉本页状态机", () => {
    const mine = [op({ opId: "a-1", state: "sending", sentAt: 123 })];
    const disk = [op({ opId: "a-1", state: "pending" })];
    const [only] = mergeQueues(mine, disk);
    assert.equal(only?.state, "sending", "本页的 sending 租期状态不该被盘上旧快照覆盖");
    assert.equal(only?.sentAt, 123);
    assert.equal(mergeQueues(mine, disk).length, 1, "同 opId 不能出现两条");
});

test("mergeQueues：没有 opId 的旧条目无法判同一性，两边都保留（宁重复不丢失）", () => {
    const mine = [op({})]; // 无 opId
    const disk = [op({})]; // 无 opId，内容可能就是同一条的盘上副本
    const merged = mergeQueues(mine, disk);
    assert.equal(merged.length, 2, "判不了同一性就都留，重放丢数据比多放一次严重");
});

test("mergeQueues：任一侧为空都退化成立", () => {
    const mine = [op({ opId: "a-1" })];
    assert.deepEqual(mergeQueues(mine, []), mine, "盘为空：原样返回本页队列");
    const disk = [op({ opId: "b-2" })];
    assert.deepEqual(mergeQueues([], disk), disk, "本页为空：整队来自盘上（如刚换账号）");
    assert.deepEqual(mergeQueues([], []), []);
});

test("mergeQueues：不修改任何一份入参（调用方依赖原数组做 indexOf/快照）", () => {
    const mine = [op({ opId: "a-1" })];
    const disk = [op({ opId: "b-2" })];
    mergeQueues(mine, disk);
    assert.equal(mine.length, 1);
    assert.equal(disk.length, 1);
});
