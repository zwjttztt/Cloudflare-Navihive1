// tests/url.test.ts
// 网址规范化的单测：这里每一条都对应一个真实踩过的坑，改动 normalizeUrl 时先跑它。
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostOfUrl, isSafeHttpUrl, normalizeUrl } from "../src/utils/url";

test("没写协议时补 https://", () => {
    assert.equal(normalizeUrl("baidu.com").url, "https://baidu.com");
    assert.equal(normalizeUrl("www.baidu.com/s?wd=x").url, "https://www.baidu.com/s?wd=x");
});

test("已经写了协议就照原样保留（含 http）", () => {
    assert.equal(normalizeUrl("http://example.com/a").url, "http://example.com/a");
    assert.equal(normalizeUrl("https://example.com/a").url, "https://example.com/a");
});

test("危险协议一律拒绝", () => {
    // 这几条是重点：<input type="url"> 挡不住它们，但 href 直接吃下去就会执行脚本
    for (const bad of [
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///C:/Windows/System32/calc.exe",
    ]) {
        const result = normalizeUrl(bad);
        assert.equal(result.ok, false, `${bad} 不该被放行`);
        assert.equal(result.reason, "bad-protocol");
    }
});

test("空白与控制字符会被清掉（从表格 / 地址栏粘贴的常见情况）", () => {
    assert.equal(normalizeUrl("  https://a.com/  ").url, "https://a.com");
    assert.equal(normalizeUrl("https://a.com/a\nb").url, "https://a.com/ab");
    assert.equal(normalizeUrl("htt\nps://a.com").url, "https://a.com");
});

test("根路径的尾斜杠去掉，但子路径保留", () => {
    assert.equal(normalizeUrl("https://a.com/").url, "https://a.com");
    assert.equal(normalizeUrl("https://a.com").url, "https://a.com");
    assert.equal(normalizeUrl("https://a.com/docs/").url, "https://a.com/docs/");
});

test("默认端口去掉，非默认端口保留", () => {
    assert.equal(normalizeUrl("http://a.com:80/x").url, "http://a.com/x");
    assert.equal(normalizeUrl("https://a.com:443/x").url, "https://a.com/x");
    assert.equal(normalizeUrl("https://a.com:8443/x").url, "https://a.com:8443/x");
});

test("空输入与只有协议头的输入被拒", () => {
    assert.equal(normalizeUrl("").ok, false);
    assert.equal(normalizeUrl("").reason, "empty");
    assert.equal(normalizeUrl("   ").reason, "empty");
    assert.equal(normalizeUrl("https://").ok, false);
});

test("isSafeHttpUrl 只认 http(s)，且能吃住脏数据", () => {
    assert.equal(isSafeHttpUrl("https://a.com"), true);
    assert.equal(isSafeHttpUrl("http://a.com"), true);
    assert.equal(isSafeHttpUrl("javascript:alert(1)"), false);
    assert.equal(isSafeHttpUrl("a.com"), false); // 相对路径，不是绝对 URL
    assert.equal(isSafeHttpUrl(""), false);
    assert.equal(isSafeHttpUrl(null), false);
    assert.equal(isSafeHttpUrl(undefined), false);
});

test("hostOfUrl 去掉 www. 前缀", () => {
    assert.equal(hostOfUrl("https://www.example.com/a"), "example.com");
    assert.equal(hostOfUrl("https://sub.example.com"), "sub.example.com");
    assert.equal(hostOfUrl("不是网址"), "");
});
