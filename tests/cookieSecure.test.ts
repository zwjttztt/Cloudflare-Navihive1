// Cookie 的 Secure 属性该不该加 —— 判断错了的表现不是报错，而是
// 「登录接口 200、界面却立刻弹回登录页」，这种问题只能靠测试钉住。

import assert from "node:assert/strict";
import test from "node:test";
import { requestIsSecure } from "../worker/index";

/** 造一个只带指定头、指定 scheme 的请求 */
function req(url: string, headers: Record<string, string> = {}): Request {
    return new Request(url, { headers });
}

test("直连 https：加 Secure", () => {
    assert.equal(requestIsSecure(req("https://nav.example.com/api/login"), new URL("https://nav.example.com/api/login"), false), true);
});

test("直连 http：不加 Secure", () => {
    assert.equal(requestIsSecure(req("http://nav.example.com/api/login"), new URL("http://nav.example.com/api/login"), false), false);
});

test("CF-Visitor 为准：反代回源用 https、但客户端其实是 http 时不加 Secure", () => {
    // 这是「http 登录后闪退」的根因：Worker 看到的 url.protocol 是 https，
    // 于是下发 Secure cookie，浏览器（页面是 http）按规范直接丢弃。
    const url = new URL("https://nav.example.com/api/login");
    const r = req("https://nav.example.com/api/login", { "CF-Visitor": '{"scheme":"http"}' });
    assert.equal(requestIsSecure(r, url, false), false, "CF-Visitor 说了是 http，就不能带 Secure");
});

test("CF-Visitor 说 https 时即便 url 是 http 也加 Secure（Cloudflare 边缘已终止 TLS）", () => {
    const url = new URL("http://nav.example.com/api/login");
    const r = req("http://nav.example.com/api/login", { "CF-Visitor": '{"scheme":"https"}' });
    assert.equal(requestIsSecure(r, url, false), true);
});

test("X-Forwarded-Proto 只在声明信任反代时才认", () => {
    const url = new URL("https://nav.example.com/api/login");
    const headers = { "X-Forwarded-Proto": "http" };
    assert.equal(
        requestIsSecure(req("https://nav.example.com/api/login", headers), url, false),
        true,
        "不信任反代时，伪造的 XFP 不能骗我们去掉 Secure"
    );
    assert.equal(
        requestIsSecure(req("https://nav.example.com/api/login", headers), url, true),
        false,
        "信任反代后按 XFP 判断"
    );
});

test("X-Forwarded-Proto 是多级代理串时只看第一个", () => {
    const url = new URL("https://nav.example.com/api/login");
    const r = req("https://nav.example.com/api/login", { "X-Forwarded-Proto": "http, https" });
    assert.equal(requestIsSecure(r, url, true), false);
});

test("CF-Visitor 格式异常时退回后续判断，不抛错", () => {
    const url = new URL("https://nav.example.com/api/login");
    assert.equal(requestIsSecure(req("https://nav.example.com/api/login", { "CF-Visitor": "not-json" }), url, false), true);
    assert.equal(requestIsSecure(req("https://nav.example.com/api/login", { "CF-Visitor": "{}" }), url, false), true);
});

test("CF-Visitor 优先于 X-Forwarded-Proto（前者客户端伪造不了）", () => {
    const url = new URL("https://nav.example.com/api/login");
    const r = req("https://nav.example.com/api/login", {
        "CF-Visitor": '{"scheme":"http"}',
        "X-Forwarded-Proto": "https",
    });
    assert.equal(requestIsSecure(r, url, true), false);
});
