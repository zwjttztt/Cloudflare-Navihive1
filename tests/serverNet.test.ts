// tests/serverNet.test.ts
// server/net.ts 的用例：自托管入口补 X-Forwarded-For 与启动自检用的两个纯函数。
//
// 它们都很小，但**错了不出声**：
//   - IP 形态没归一化 → 审计日志里躺着一列 ::ffff: 前缀，事后按 IP 查事件的人白忙一场；
//   - 回环判定反了 → 要么该提醒的风险一声不吭（绑 0.0.0.0 还信任 XFF，
//     客户端加个头就能换限速桶），要么绑 127.0.0.1 的正常部署天天被刷警告，
//     刷久了真警告也没人看。

import test from "node:test";
import assert from "node:assert/strict";
import { isPublicHost, normalizeRemoteAddress } from "../server/net";

test("normalizeRemoteAddress：IPv4-mapped IPv6 还原成点分十进制", () => {
    assert.equal(normalizeRemoteAddress("::ffff:203.0.113.7"), "203.0.113.7");
    // 双栈监听时 IPv4 客户端就是这个形态，审计日志里不该带前缀
    assert.equal(normalizeRemoteAddress("::ffff:127.0.0.1"), "127.0.0.1");
});

test("normalizeRemoteAddress：IPv6 与点分十进制原样返回", () => {
    assert.equal(normalizeRemoteAddress("2001:db8::1"), "2001:db8::1");
    assert.equal(normalizeRemoteAddress("203.0.113.7"), "203.0.113.7");
    // 只有 ::ffff: + 四段数字这一种形态才还原，少了段数的一律原样返回
    assert.equal(normalizeRemoteAddress("::ffff:203.0.113"), "::ffff:203.0.113");
    assert.equal(normalizeRemoteAddress("::ffff:203.0.113.7.9"), "::ffff:203.0.113.7.9");
    assert.equal(normalizeRemoteAddress("::1"), "::1");
});

test("isPublicHost：回环地址不是对外可见", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.0.0.53", "LOCALHOST", "  127.0.0.1  "]) {
        assert.equal(isPublicHost(h), false, `${h} 应当判为回环`);
    }
});

test("isPublicHost：通配与具体网卡地址是对外可见", () => {
    for (const h of ["0.0.0.0", "::", "", "   ", "192.168.1.10", "10.0.0.5", "203.0.113.7"]) {
        assert.equal(isPublicHost(h), true, `${h} 应当判为对外`);
    }
});

test("isPublicHost：空串算对外 —— Node 的 listen 不传 host 就是监听所有网卡", () => {
    // 这条是启动自检的默认值来源：NAVIHIVE_HOST 不配时 env() 兜底 127.0.0.1，
    // 但直接调 server.listen(PORT) 的人是「监听全部」，不能判成安全。
    assert.equal(isPublicHost(""), true);
});
