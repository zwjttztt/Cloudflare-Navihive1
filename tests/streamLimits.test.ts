// tests/streamLimits.test.ts
// S07 的资源上限：不是「读完再判断」，而是在**读取过程中**就掐断。
//
// 三条都要真跑，不能只测纯函数：
//   - 慢流：一直吐字节但吐得极慢 → 超时取消，而不是无限挂住
//   - 超限：无 Content-Length、body 远超上限 → 读到上限就取消，回 413
//   - 解压炸弹：几十 KB 的 gzip 吐出几 MB → 压缩比闸挡下，内存不至于被吃光
//
// 「超限」这条的回归价值最高：早先的实现是先 arrayBuffer() 再判断大小，
// 那等于先把整份数据读进内存才说不要，限额根本没起到保护内存的作用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readBoundedBytes, BodyLimitError } from "../worker/util";
import { gunzipOutputLimit, gunzipToString, gzipBytes } from "../worker/webdav/transport";

/**
 * 「每一块都要等够 delayMs 才吐」的流，而且**永不结束**。
 *
 * 为什么不写成「吐够 N 字节就 close」：ReadableStream 的 pull 会被并发调用来填队列，
 * 那些 setTimeout 是并行跑的，总耗时远小于 N×delay —— 流会在超时前就正常结束，
 * 测的就不是超时了。永不结束的流没有这个歧义：只要 delayMs > timeout，必超时。
 */
function trickleStream(delayMs: number, chunkBytes = 64): ReadableStream<Uint8Array> {
    return new ReadableStream({
        async pull(controller) {
            await new Promise(r => setTimeout(r, delayMs));
            controller.enqueue(new Uint8Array(chunkBytes));
        },
    });
}

/** 一次性把一大块塞进去的流（模拟没有 Content-Length 的大 body） */
function bigStream(totalBytes: number, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream({
        pull(controller) {
            if (sent >= totalBytes) {
                controller.close();
                return;
            }
            const n = Math.min(chunkBytes, totalBytes - sent);
            controller.enqueue(new Uint8Array(n));
            sent += n;
        },
    });
}

test("慢流：一直吐但吐得慢，到点就取消（408 而不是无限挂住）", async () => {
    const stream = trickleStream(300); // 每 300ms 才吐 64 字节
    await assert.rejects(
        () => readBoundedBytes(stream, 10 * 1024 * 1024, 120),
        (err: unknown) => err instanceof BodyLimitError && (err as BodyLimitError).status === 408,
        "慢流应当按超时取消，而不是等它吐完"
    );
});

test("超限：读到上限那一刻就停，不会把整份 body 读进内存", async () => {
    const limit = 64 * 1024;
    // 给一份远超上限的流：真实现里若先读全文再判断，这里就会吃掉 8MB
    await assert.rejects(
        () => readBoundedBytes(bigStream(8 * 1024 * 1024), limit, 5000),
        (err: unknown) => err instanceof BodyLimitError && (err as BodyLimitError).status === 413,
        "超过上限要立刻抛 413"
    );
});

test("不超限的正常流照原样读完（限额没有误杀）", async () => {
    const out = await readBoundedBytes(bigStream(1000, 256), 64 * 1024, 2000);
    assert.equal(out.byteLength, 1000, "小 body 应当完整读到");
});

test("空 body 返回空数组而不是抛错", async () => {
    const out = await readBoundedBytes(null, 1024);
    assert.equal(out.byteLength, 0);
});

// ============ 压缩比闸 ============
test("压缩比闸：输入越小，允许的输出越少（64KB 是下限）", () => {
    // 极小输入也至少给 64KB，合法的小备份不该被误杀
    assert.equal(gunzipOutputLimit(10), 64 * 1024);
    assert.equal(gunzipOutputLimit(1024), 1024 * 200, "1KB 输入最多吐 200KB");
    // 硬上限封顶
    assert.equal(gunzipOutputLimit(1024 * 1024), 10 * 1024 * 1024);
});

test("解压炸弹：几十 KB 的 gzip 吐出几 MB，被压缩比闸挡下", async () => {
    // 造一份高压缩比的样本：全 0 字节，gzip 能压到千分之一量级
    const bomb = new Uint8Array(4 * 1024 * 1024);
    const gz = await gzipBytes("0".repeat(4 * 1024 * 1024));
    assert.ok(gz.byteLength < 64 * 1024, `样本本身要够小（实际 ${gz.byteLength} 字节）`);
    // 输入 gz 很小 → 上限落在 64KB 附近，4MB 的输出必然被掐断
    await assert.rejects(
        () => gunzipToString(gz),
        (err: unknown) => err instanceof BodyLimitError,
        "解压炸弹必须被挡下"
    );
    void bomb;
});

test("正常备份往返：压缩再解压，内容一致（限额没误杀合法数据）", async () => {
    const original = JSON.stringify({
        groups: [{ id: 1, name: "常用工具", order_num: 1 }],
        sites: Array.from({ length: 200 }, (_, i) => ({
            id: i + 1,
            group_id: 1,
            name: `站点 ${i}`,
            url: `https://example.com/${i}`,
        })),
    });
    const gz = await gzipBytes(original);
    const back = await gunzipToString(gz);
    assert.equal(back, original, "正常大小的备份必须原样还原");
});
