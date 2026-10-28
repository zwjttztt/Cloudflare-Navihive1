// tests/clientTimeout.test.ts
//
// 请求超时的「分级判定」（2026-10-28）。
//
// 为什么要单独抽个纯函数来测：超时值藏在 `AbortSignal.timeout(n)` 里，**读不出来** ——
// 跑真请求只能验「有没有超时」，验不出「给的是不是 240 秒」。而这一档值恰恰是
// 一个真实的线上 bug 的来源：
//
//   `const slow = /upload|download|backup|import|export|restore|icon/i.test(endpoint)`
//   而附件端点叫 `notes/attachments` —— 不含 upload，于是拿满默认 30s。
//   附件上限 25MB，25MB/30s ≈ 830KB/s，也就是说**默认超时要求用户至少 830KB/s 的上行**。
//   手机 4G 上行普遍 200~500KB/s，传一张 8MB 的截图必然超时，报出来的却是
//   「请求超时（30 秒无响应）」—— 用户会以为服务器挂了。
//
// 反向的坑也在这里：**别简单地把 attachment 塞进正则**。
// `notes/attachments/list`（列元数据）、`notes/attachments/<id>`（删除）都是几百字节的
// JSON 往返，给它们 4 分钟等一个卡死的请求毫无意义 —— 真卡住了应该 30 秒就让用户重试。
import assert from "node:assert/strict";
import test from "node:test";
import { ATTACHMENT_UPLOAD_TIMEOUT_MS, timeoutForEndpoint } from "../src/API/client";
import { REQUEST_TIMEOUT_MS } from "../src/API/transport";

test("附件上传拿到与体量匹配的超时（不是默认 30 秒）", () => {
    // 上传的真实 URL 形状：POST notes/attachments?filename=xxx（query 直接跟在路径后）
    assert.equal(timeoutForEndpoint("notes/attachments?filename=a.png"), ATTACHMENT_UPLOAD_TIMEOUT_MS);
    assert.equal(timeoutForEndpoint("notes/attachments?filename=a.png&noteId=3"), ATTACHMENT_UPLOAD_TIMEOUT_MS);
    // 无 query（理论上不会这么发，但别让它漏网）
    assert.equal(timeoutForEndpoint("notes/attachments"), ATTACHMENT_UPLOAD_TIMEOUT_MS);
    // 240 秒是有依据的：25MB / 240s ≈ 107KB/s，覆盖到边缘信号的上行；
    // 又不能是 0（无限等）——卡死的连接得自己断开，不能永久占着上传队列。
    assert.equal(ATTACHMENT_UPLOAD_TIMEOUT_MS, 240_000);
    assert.ok(
        ATTACHMENT_UPLOAD_TIMEOUT_MS > REQUEST_TIMEOUT_MS * 4,
        "要和默认超时明显拉开档次，否则等于没改"
    );
    // 25MB 的上限换算过来必须落在「弱网也能传完」的区间（≥100KB/s 就够）
    const worstCaseBytesPerSecond = (25 * 1024 * 1024) / (ATTACHMENT_UPLOAD_TIMEOUT_MS / 1000);
    assert.ok(
        worstCaseBytesPerSecond <= 120 * 1024,
        `按 25MB 上限算，240s 只要求 ${(worstCaseBytesPerSecond / 1024).toFixed(0)}KB/s`
    );
});

test("附件的元数据 / 删除端点仍然是默认 30 秒（别被 attachment 一刀切放宽）", () => {
    // 这三个都是几百字节的 JSON 往返：真卡住了就该 30 秒失败让用户重试，
    // 给 4 分钟只会让界面「转圈到天荒地老」。
    assert.equal(timeoutForEndpoint("notes/attachments/list"), REQUEST_TIMEOUT_MS);
    assert.equal(timeoutForEndpoint("notes/attachments/3f2a-9b"), REQUEST_TIMEOUT_MS);
    assert.equal(timeoutForEndpoint("notes/attachments/prune"), REQUEST_TIMEOUT_MS);
    assert.equal(timeoutForEndpoint("notes/attachments/3f2a-9b/content"), REQUEST_TIMEOUT_MS);
});

test("搬整份数据的端点不吃超时（0 = 不限）", () => {
    // 这些端点的耗时由数据量决定，客户端预估不了：整库备份上传、ZIP 导出下载、图标代理。
    for (const endpoint of [
        "backup/upload",
        "backup/download?name=x.zip",
        "notes/backup/upload",
        "notes/import",
        "notes/export",
        "transfer/export",
        "transfer/restore",
        "icon?url=https%3A%2F%2Fexample.com%2Fa.png",
    ]) {
        assert.equal(timeoutForEndpoint(endpoint), 0, `${endpoint} 应当不设超时`);
    }
});

test("普通读写仍然是默认 30 秒", () => {
    for (const endpoint of ["notes", "notes?fields=list", "notes/changes?since=x", "sites", "groups", "config"]) {
        assert.equal(timeoutForEndpoint(endpoint), REQUEST_TIMEOUT_MS, `${endpoint} 应当是默认超时`);
    }
});

test("调用方显式给的 timeoutMs 永远优先（包括显式 0 = 不限）", () => {
    assert.equal(timeoutForEndpoint("notes/attachments?filename=a.png", 5_000), 5_000);
    assert.equal(timeoutForEndpoint("notes", 120_000), 120_000);
    assert.equal(timeoutForEndpoint("notes/backup/upload", 1_000), 1_000);
    assert.equal(timeoutForEndpoint("notes", 0), 0, "显式 0 也要尊重（= 不限）");
});
