// tests/ssrf.test.ts
// 内网/本机地址黑名单（SSRF 防护）的纯函数单测。
// 抓取（meta.ts）、图标代理（icon.ts）、WebDAV 备份目标（webdav.ts）共用这一份。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedHost } from "../worker/util";

const BLOCKED = [
    "localhost",
    "::1",
    "[::1]", // URL 字面量里的 IPv6 包围
    "::",
    "router.local",
    "metadata.internal",
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // 云元数据服务
    "0.0.0.0",
    "0.1.2.3", // 0.0.0.0/8
    "100.64.0.1", // CGNAT
    "224.0.0.1", // 组播
    "239.255.255.255",
    "240.0.0.1", // 保留段
    "255.255.255.255", // 广播
    "fc00::1", // IPv6 ULA
    "fd12:3456::1",
    "fe80::1", // IPv6 link-local
    "fe90::1",
    "fea0::1",
    "febf::1", // fe80::/10 上界
    "::ffff:127.0.0.1", // IPv4-mapped IPv6
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
    "::ffff:169.254.169.254",
];

const ALLOWED = [
    "example.com",
    "www.yunso.net",
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // 不在 16-31 段
    "172.32.0.1",
    "203.0.113.5", // TEST-NET
    "2001:db8::1", // IPv6 文档段
    "2606:4700:4700::1111", // Cloudflare DNS 公网
    "100.63.255.255", // CGNAT 段前一个
    "100.128.0.0", // CGNAT 段后一个
    "223.255.255.255", // 组播段前一个
    "256.0.0.0", // 越界（应被正则放行——它根本不是合法 IPv4，但 isBlockedHost 只看字符串前缀）
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
