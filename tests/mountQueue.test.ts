// tests/mountQueue.test.ts
//
// 挂载调度队列（#86 从 GroupCard 抽出的纯调度逻辑）：
// 同一帧涌入的一批任务必须一帧只执行一个，排空后自动收摊；
// 执行中再入队的任务排到下一帧，不会插队。
import test from "node:test";
import assert from "node:assert/strict";
import { enqueueMountTask, resetMountQueueForTests } from "../src/utils/mountQueue";

/** 受控的 rAF 替身：手动推帧，能看清每一帧执行了谁 */
function makeRaf() {
    const pending: Array<() => void> = [];
    const raf = (cb: () => void) => {
        pending.push(cb);
        return pending.length;
    };
    return {
        raf,
        /** 推进一帧：执行当前帧回调（回调里再入队的 rAF 进入下一批） */
        frame() {
            const batch = pending.splice(0);
            batch.forEach(cb => cb());
        },
        get queued() {
            return pending.length;
        },
    };
}

test("挂载队列：一帧只执行一个任务，同帧涌入的排队逐帧放行", () => {
    const { raf, frame } = makeRaf();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    resetMountQueueForTests();

    const ran: number[] = [];
    enqueueMountTask(() => ran.push(1));
    enqueueMountTask(() => ran.push(2));
    enqueueMountTask(() => ran.push(3));
    assert.deepEqual(ran, [], "入队不等于执行：必须等帧回调");

    frame();
    assert.deepEqual(ran, [1], "第一帧只放行第一个");
    frame();
    assert.deepEqual(ran, [1, 2]);
    frame();
    assert.deepEqual(ran, [1, 2, 3]);
    // 队列空了就不再排帧
    assert.equal((raf as unknown as { queued: number }).queued ?? 0, 0);
});

test("挂载队列：执行中入队的新任务排到下一帧；空队列后重新调度", () => {
    const { raf, frame } = makeRaf();
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
    resetMountQueueForTests();

    const ran: string[] = [];
    enqueueMountTask(() => {
        ran.push("first");
        // 第一个任务执行时又排了一个（模拟追加分页）
        enqueueMountTask(() => ran.push("second"));
    });
    frame();
    assert.deepEqual(ran, ["first"]);
    frame();
    assert.deepEqual(ran, ["first", "second"]);
    // 全部排空后再入队：调度器要能重新启动（不能因为上次「收摊」就再也不跑）
    enqueueMountTask(() => ran.push("third"));
    frame();
    assert.deepEqual(ran, ["first", "second", "third"]);
});
