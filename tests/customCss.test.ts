// tests/customCss.test.ts
// 「网站设置」里自定义 CSS 的清洗（从 App.tsx 抽出来的 utils/customCss.ts）。
//
// 这一层只是**兜底**：那段 CSS 是管理员自己填的，真正的安全底线是
// 「非 owner 写不了全站配置」（canManageSharedConfigs）。清洗的价值在于：
// 管理员直接把网上抄来的一段样式贴进去时不至于把站点变成执行脚本的入口。

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCustomCss } from "../src/utils/customCss";

test("空值返回空串，不产生 undefined 之类的脏内容", () => {
    assert.equal(sanitizeCustomCss(""), "");
});

test("正常样式原样保留（不能为了安全把用户的样式改坏）", () => {
    const css = ".card { color: red; background: url('/bg.png'); }";
    assert.equal(sanitizeCustomCss(css), css);
});

test("url(javascript:) 被改写成无效协议", () => {
    const out = sanitizeCustomCss("body { background: url(javascript:alert(1)); }");
    assert.ok(!/javascript:/i.test(out), "javascript: 必须消失");
    assert.ok(out.includes("invalid:"), "改成抽掉脚本语义的无效 URL");
});

test("带引号、大小写混写、符号间隔也一样拦", () => {
    for (const raw of [
        `background: url("javascript:alert(1)")`,
        `background: URL( 'JavaScript:alert(1)' )`,
        `background: url(\n  javascript:alert(1))`,
    ]) {
        assert.ok(!/javascript:/i.test(sanitizeCustomCss(raw)), raw);
    }
});

test("expression() 被改写掉（老 IE 的脚本执行入口）", () => {
    const out = sanitizeCustomCss("a { width: expression(document.body.clientWidth); }");
    assert.ok(!/expression\s*\(/i.test(out));
    assert.ok(out.includes("invalid("));
});

test("@import 被注释掉：不能把外部样式表带进来绕过清洗", () => {
    const out = sanitizeCustomCss("@import url('https://evil.test/x.css'); p{color:red}");
    assert.ok(!/^\s*@import/i.test(out.replace(/\/\*[\s\S]*?\*\//g, "")), "@import 已被注释");
    assert.ok(out.includes("/* @import */"));
    assert.ok(out.includes("p{color:red}"), "同一段里的正常样式要留着");
});

test("behavior: 被注释掉（老 IE 的 HTC 行为）", () => {
    const out = sanitizeCustomCss("a { behavior: url(x.htc); }");
    assert.ok(out.includes("/* behavior: */"), "整条声明进注释");
    // 注释之外不能再出现这个属性（CSS 里被注释就等于没写）
    const withoutComments = out.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/behavior\s*:/i.test(withoutComments), "注释外仍有 behavior: 说明没挡住");
});

test("content 里嵌 url(javascript:) 也被处理（伪元素同样会触发）", () => {
    const out = sanitizeCustomCss("a::before { content: ''; background: url(javascript:alert(1)); }");
    assert.ok(out.includes("invalid:"));
});
