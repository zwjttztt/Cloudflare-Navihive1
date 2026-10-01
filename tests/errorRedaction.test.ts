// tests/errorRedaction.test.ts
// 服务端上报链路（worker/errorReport.ts）的脱敏。
//
// 按键名脱敏只是第一层：真正容易漏的是**写在字符串里面**的秘密 ——
// `message` 叫这个名字一点都不可疑，可它可能是
// "请求 https://api.x.com/cb?access_token=eyJ... 失败"，整句原样进了日志和审计表。

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../worker/errorReport";

test("URL 查询串整体去掉（令牌最爱藏在这里）", () => {
    const out = redactSecrets("请求 https://api.example.com/cb?access_token=abc123&state=1 失败");
    assert.equal(out, "请求 https://api.example.com/cb 失败");
});

test("路径与域名保留，排错信息不至于全丢", () => {
    const out = redactSecrets("GET https://dav.example.com/dav/navihive-backup/a.json.gz 404");
    assert.equal(out, "GET https://dav.example.com/dav/navihive-backup/a.json.gz 404");
});

test("Bearer / Basic 凭据头被抹掉", () => {
    assert.match(redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxx"), /redacted/);
    assert.equal(
        redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxx").includes("eyJhbGci"),
        false
    );
    assert.equal(redactSecrets("Authorization: Basic dXNlcjpwYXNz").includes("dXNlcjpwYXNz"), false);
});

test("key=value / key: value 形态的秘密被抹掉", () => {
    assert.equal(redactSecrets("password=hunter2").includes("hunter2"), false);
    assert.equal(redactSecrets("token: abcdef123456").includes("abcdef123456"), false);
    assert.equal(redactSecrets('{"password":"hunter2"}').includes("hunter2"), false);
    assert.equal(redactSecrets("api_key=AKIA1234567890").includes("AKIA1234567890"), false);
});

test("JWT 形态（eyJ 开头三段）被抹掉", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjd9.c2lnbmF0dXJl";
    assert.equal(redactSecrets(`登录态失效：${jwt}`).includes(jwt), false);
});

test("普通报错原文不受影响（别把排错信息也抹了）", () => {
    const text = "保存站点排序失败：HTTP 500";
    assert.equal(redactSecrets(text), text);
    assert.equal(redactSecrets("TypeError: Cannot read properties of null"), "TypeError: Cannot read properties of null");
});

test("同一个串反复脱敏不会越缩越短", () => {
    const once = redactSecrets("password=hunter2 请求失败");
    assert.equal(redactSecrets(once), once);
});
