// tests/addSiteDeepLink.test.ts
// 站外「一键收藏」深链的编解码（浏览器扩展走它，见 extension/README.md）。
//
// 钉住三件事：
//   1. 中文 / 特殊字符必须来回无损 —— 标题里最常见的就是中文与 & ? #，
//      明文塞 query 会被截断或转义成一团乱码，所以走 base64url。
//   2. 坏数据一律当「没有这个意图」，绝不开一个字段全空的弹窗。
//   3. 意图只兑现一次（参数用完即抹 —— 抹的逻辑在 DOM 侧，这里测编码本身不会撒谎）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ADD_SITE_PARAM,
    buildAddSiteLink,
    decodeAddSitePrefill,
    encodeAddSitePrefill,
    readAddSitePrefill,
} from "../src/utils/addSiteDeepLink";

test("编解码往返：中文标题与带 & ? # 的链接都无损", () => {
    const prefill = {
        url: "https://example.com/a?b=1&c=2#frag",
        name: "一个中文标题 · 还有 / 斜杠",
        icon: "https://example.com/favicon.ico",
        description: "备注：& 与 空格",
    };
    const encoded = encodeAddSitePrefill(prefill);
    // base64url：只含这些字符，塞进 query 不需要再转义
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeAddSitePrefill(encoded), prefill);
});

test("只带链接也能用，可选字段缺失就是 undefined", () => {
    const encoded = encodeAddSitePrefill({ url: "https://a.example.com/" });
    const decoded = decodeAddSitePrefill(encoded);
    assert.equal(decoded?.url, "https://a.example.com/");
    assert.equal(decoded?.name, undefined);
    assert.equal(decoded?.icon, undefined);
    assert.equal(decoded?.description, undefined);
});

test("坏数据一律返回 null：不开一个空壳弹窗", () => {
    // 不是 base64（JSON 明文）
    assert.equal(decodeAddSitePrefill("not-base64!!"), null);
    // 是 base64 但不是 JSON
    assert.equal(decodeAddSitePrefill(btoa("hello")), null);
    // 是 JSON 但不是对象
    assert.equal(decodeAddSitePrefill(btoa("42")), null);
    // 缺 url / url 是空串 / url 不是字符串
    assert.equal(decodeAddSitePrefill(btoa(JSON.stringify({ name: "x" }))), null);
    assert.equal(decodeAddSitePrefill(btoa(JSON.stringify({ url: "" }))), null);
    assert.equal(decodeAddSitePrefill(btoa(JSON.stringify({ url: 123 }))), null);
    // 空输入
    assert.equal(decodeAddSitePrefill(""), null);
    assert.equal(decodeAddSitePrefill(null), null);
    assert.equal(decodeAddSitePrefill(undefined), null);
});

test("从 location.search 里读：带不带问号都行，没有这个参数就是 null", () => {
    const payload = encodeAddSitePrefill({ url: "https://b.example.com/", name: "B" });
    assert.deepEqual(readAddSitePrefill(`?${ADD_SITE_PARAM}=${payload}`), {
        url: "https://b.example.com/",
        name: "B",
        icon: undefined,
        description: undefined,
    });
    assert.equal(readAddSitePrefill(`${ADD_SITE_PARAM}=${payload}`)?.url, "https://b.example.com/");
    assert.equal(readAddSitePrefill("?foo=1"), null);
    assert.equal(readAddSitePrefill(""), null);
    // 别的参数在前面也要认得出
    assert.equal(readAddSitePrefill(`?x=1&${ADD_SITE_PARAM}=${payload}`)?.name, "B");
});

test("拼出来的链接保留原路径，且能被自己读回来", () => {
    const link = buildAddSiteLink("https://home.example.com/", {
        url: "https://c.example.com/p?q=1",
        name: "C",
    });
    const url = new URL(link);
    assert.equal(url.origin, "https://home.example.com");
    assert.equal(url.searchParams.get(ADD_SITE_PARAM) !== null, true);
    const back = readAddSitePrefill(url.search);
    assert.equal(back?.url, "https://c.example.com/p?q=1");
    assert.equal(back?.name, "C");
});
