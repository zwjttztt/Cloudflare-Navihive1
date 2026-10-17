// tests/cronResilience.test.ts
// cron 的「韧性」两件套：单任务耗时上限（withDeadline）与 D1 读重试（withD1Retry）。
//
// 为什么值得单测：这两个函数都是**故障路径**才有行为的代码 ——
// 正常时候它们只是透明地转发结果，改坏了（比如超时了还继续 await、
// 或者重试把写操作也包进去）在绿色 CI 上一点看不出来，
// 只有线上真的卡住那周才会发现后面几项整周没跑。

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { CRON_TASK_TIMEOUT_MS, backupDeadlineMs, withD1Retry, withDeadline } from "../worker/cron";

test("备份任务的耗时上限比上传封顶还宽（10 分钟上传 + 导出余量）", () => {
    assert.ok(CRON_TASK_TIMEOUT_MS.backup > 10 * 60_000, "备份上限必须宽过上传封顶");
    assert.ok(CRON_TASK_TIMEOUT_MS.notesBackup > 10 * 60_000);
    // 其余几项不该比备份还宽，否则「某一项卡住拖垮后面」又回来了
    for (const key of ["linkSweep", "inactiveSweep", "retention"]) {
        assert.ok(CRON_TASK_TIMEOUT_MS[key] < CRON_TASK_TIMEOUT_MS.backup, `${key} 上限该比备份短`);
    }
});

test("withDeadline：正常完成时原样返回 ok", async () => {
    const r = await withDeadline("linkSweep", async () => "done");
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, false);
    assert.ok(r.ms >= 0);
});

test("withDeadline：任务抛错时返回 ok:false 而不是把调用方炸掉", async () => {
    const r = await withDeadline("linkSweep", async () => {
        throw new Error("D1 抽风");
    });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, false);
    assert.match((r.error as Error).message, /D1 抽风/);
});

test("withDeadline：超时就地标记 timedOut，且不会把调用方拖死", async () => {
    const started = Date.now();
    const r = await withDeadline("linkSweep", () => sleep(5000), 60);
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true, "超时必须是可区分的，调用方要按它写留痕文案");
    assert.ok(elapsed < 2000, `超时后该立刻返回，实际等了 ${elapsed}ms`);
});

test("withDeadline：超时后底层任务自己 reject 不会变成未处理 rejection", async () => {
    // 这条盯的是实现里的 work.catch(no-op)：少了它，超时后底层 promise 的 rejection
    // 会在 Workers 里把整次调用判失败 —— 也就是「加了超时反而更容易红」
    const r = await withDeadline("linkSweep", async () => {
        await sleep(30);
        throw new Error("后台才炸");
    }, 10_000);
    assert.equal(r.ok, false);
    // 等到底层真的 settle：如果 rejection 漏了出去，node:test 会在这里报未处理错误
    await sleep(60);
    assert.equal(r.timedOut, false);
});

test("withD1Retry：第一次抖动、第二次成功", async () => {
    let calls = 0;
    const out = await withD1Retry(async () => {
        calls += 1;
        if (calls === 1) throw new Error("D1_ERROR: network blip");
        return "rows";
    });
    assert.equal(out, "rows");
    assert.equal(calls, 2, `该重试一次，实际调了 ${calls} 次`);
});

test("withD1Retry：两次都失败才抛，且抛最后一次的错误", async () => {
    let calls = 0;
    await assert.rejects(
        withD1Retry(async () => {
            calls += 1;
            throw new Error(`fail-${calls}`);
        }),
        /fail-2/
    );
    assert.equal(calls, 2);
});

test("withD1Retry：成功时绝不重试（不浪费一次 D1 读）", async () => {
    let calls = 0;
    await withD1Retry(async () => {
        calls += 1;
        return null;
    });
    assert.equal(calls, 1);
});

test("备份上限按账号数放宽，但自身封顶", () => {
    // 单账号：就是默认的 12 分钟
    assert.equal(backupDeadlineMs(1), 12 * 60_000);
    // 多账号串行，耗时线性叠加：每多一个账号 +10 分钟
    assert.equal(backupDeadlineMs(2), 22 * 60_000);
    // 3 个账号算出来 32 分钟，超过 30 分钟封顶 → 取封顶值
    assert.equal(backupDeadlineMs(3), 30 * 60_000);
    // 真到上限还传不完，该做的是分卷而不是继续等
    assert.equal(backupDeadlineMs(10), 30 * 60_000);
    // 0 / 负数是脏输入，不能算出比默认还短的值
    assert.equal(backupDeadlineMs(0), 12 * 60_000);
});
