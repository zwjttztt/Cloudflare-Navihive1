// tests/iconApi.test.ts
// 图标 / 缩略图 API 地址的拼装。
//
// 这个函数每张卡片渲染都要跑一遍（还有新建卡片时自动填图标、站点设置里换链接时重算），
// 而模板是**用户在设置里自己填的** —— 也就是说输入完全不可控。它写错的表现不是报错，
// 是「所有图标全是裂图」，而这种事在没有图的环境里（单测、CI）根本看不出来。
//
// 另外有一条刻意的「反直觉」设计要钉住：{url} 是**原样替换、不做编码**的。
// 按 URL 的规矩本该 encodeURIComponent，但换到能吃未编码链接的服务（比如 thum.io）
// 就会对不上 —— 所以这里选择了「照抄用户的意图」。改回编码会让那批用户的缩略图
// 集体失效，测试要能挡住这种「看起来更正确」的改动。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_ICON_API,
    DEFAULT_THUMB_API,
    getDomainFromUrl,
    resolveIconApiUrl,
} from "../src/utils/iconApi";

// ---------- 取域名 ----------

test("取到的是主机名（含子域）", () => {
    assert.equal(getDomainFromUrl("https://www.example.com/a/b?c=1"), "www.example.com");
});

test("只填了域名也要认（用户经常这么填）", () => {
    assert.equal(getDomainFromUrl("example.com"), "example.com");
    assert.equal(getDomainFromUrl("  example.com  "), "example.com");
});

test("链接非法或为空时返回空串，不抛", () => {
    for (const bad of ["", "   ", "not a url", "http://", "///"]) {
        assert.equal(getDomainFromUrl(bad), "", `「${bad}」`);
    }
});

// ---------- 拼图标地址 ----------

test("模板里的 {domain} / {host} 换成主机名", () => {
    assert.equal(
        resolveIconApiUrl("https://x.com/{domain}.png", "https://www.example.com/p"),
        "https://x.com/www.example.com.png"
    );
    assert.equal(
        resolveIconApiUrl("https://x.com/{host}.png", "https://www.example.com/p"),
        "https://x.com/www.example.com.png"
    );
});

test("{origin} 换成协议 + 主机名（不带路径）", () => {
    assert.equal(
        resolveIconApiUrl("https://shot/{origin}", "https://www.example.com/a/b?c=1"),
        "https://shot/https://www.example.com"
    );
});

test("{url} 换成完整链接，且**不编码** —— 换服务会对不上", () => {
    const url = "https://example.com/a b?c=1&d=2";
    assert.equal(resolveIconApiUrl("https://thumb/{url}", url), `https://thumb/${url}`);
    assert.ok(
        !resolveIconApiUrl("https://thumb/{url}", url).includes("%20"),
        "一编码，吃未编码链接的服务就对不上了"
    );
});

test("占位符大小写不敏感（{DOMAIN} 也得认）", () => {
    assert.equal(
        resolveIconApiUrl("https://x.com/{DOMAIN}.png", "https://example.com/"),
        "https://x.com/example.com.png"
    );
});

test("模板没填时用默认图标 API", () => {
    assert.equal(resolveIconApiUrl("", "https://example.com/"), DEFAULT_ICON_API.replace("{domain}", "example.com"));
    assert.equal(
        resolveIconApiUrl("   ", "https://example.com/"),
        DEFAULT_ICON_API.replace("{domain}", "example.com")
    );
});

test("站点链接非法时返回空串 —— 卡片靠这个判断「没有图标」", () => {
    assert.equal(resolveIconApiUrl("https://x.com/{domain}", "not a url"), "");
    assert.equal(resolveIconApiUrl("https://x.com/{domain}", ""), "");
    // 返回空串而不是原模板很重要：空串会被当成「没图标」，原模板会被当成图标地址
    assert.notEqual(resolveIconApiUrl("https://x.com/{domain}", "bad"), "https://x.com/{domain}");
});

test("链接没有协议时也能拼出来（用户只填了 example.com）", () => {
    assert.equal(
        resolveIconApiUrl("https://x.com/{domain}.png", "example.com"),
        "https://x.com/example.com.png"
    );
});

test("模板里没有占位符就原样返回", () => {
    assert.equal(resolveIconApiUrl("https://static.example.com/f.png", "https://a.com/"), "https://static.example.com/f.png");
});

test("推荐的缩略图模板是给设置里当占位提示的，不是默认值", () => {
    // 启用缩略图等于把每个站点的链接交给第三方去截图，不该开箱即用
    assert.ok(DEFAULT_THUMB_API.includes("{url}"));
    assert.notEqual(resolveIconApiUrl("", "https://example.com/"), DEFAULT_THUMB_API);
});
