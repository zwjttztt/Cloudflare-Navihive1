// tests/ssrf.test.ts
// 内网/本机地址黑名单（SSRF 防护）的纯函数单测。
// 抓取（meta.ts）、图标代理（icon.ts）、WebDAV 备份目标（webdav.ts）共用这一份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedHost } from "../worker/util";

const BLOCKED = [
    "localhost",
    "::1",
    "router.local",
    "metadata.internal",
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // 云元数据服务
    "0.0.0.0",
    "100.64.0.1", // CGNAT
];

const ALLOWED = [
    "example.com",
    "www.yunso.net",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // 不在 16-31 段
    "172.32.0.1",
    "203.0.113.5", // TEST-NET
];

test("isBlockedHost 拒绝内网/本机地址", () => {
    for (const host of BLOCKED) {
        assert.equal(isBlockedHost(host), true, `应拒绝: ${host}`);
    }
});

test("isBlockedHost 放行公网地址", () => {
    for (const host of ALLOWED) {
        assert.equal(isBlockedHost(host), false, `应放行: ${host}`);
    }
});

test("isBlockedHost 大小写不敏感", () => {
    assert.equal(isBlockedHost("LocalHost"), true);
    assert.equal(isBlockedHost("EXAMPLE.COM"), false);
});
