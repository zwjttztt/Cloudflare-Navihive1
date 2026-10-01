// tests/safeOpen.test.ts
// S09：打开站点链接不再各处自己 window.open。
//
// 守的是两件事，缺一件都会出事：
//   1. 协议白名单 —— `javascript:` / `data:` 这些**根本不许打开**，
//      而不是「打开之后指望浏览器拦」
//   2. noopener/noreferrer —— 新页面拿不到 window.opener，反向操作本站这条路堵死
//
// 早先的分裂正好说明为什么必须收口：`<a href>` 那条过了白名单，
// 而右键菜单 / 键盘打开那两处既没过白名单也没给 noopener。

import { test } from "node:test";
import assert from "node:assert/strict";
import { canOpenSite, safeOpenSite, safeOpenSites } from "../src/utils/safeOpen";

// 记录每一次 window.open 的调用（把 window 补成最小替身）
type Call = { url: string; target: string; features: string };
let calls: Call[] = [];
let openReturns: unknown = {}; // 非 null = 浏览器没拦

(globalThis as { window?: unknown }).window = {
    open: (url: string, target: string, features: string) => {
        calls.push({ url, target, features });
        return openReturns;
    },
};

const lastCall = () => calls[calls.length - 1];

test.beforeEach(() => {
    calls = [];
    openReturns = {};
});

// ============ 协议白名单 ============
test("http / https 放行", () => {
    assert.equal(canOpenSite("https://example.com"), true);
    assert.equal(canOpenSite("http://example.com"), true);
    assert.equal(safeOpenSite("https://example.com"), "opened");
});

test("javascript: 一律拒绝，且绝不调用 window.open", () => {
    assert.equal(canOpenSite("javascript:alert(1)"), false);
    assert.equal(safeOpenSite("javascript:alert(1)"), "blocked");
    assert.equal(calls.length, 0, "危险协议连 open 都不该调，不是打开后指望浏览器拦");
});

test("data: / vbscript: / file: 一律拒绝", () => {
    for (const bad of [
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///C:/secret.txt",
    ]) {
        assert.equal(safeOpenSite(bad), "blocked", `${bad} 不该被打开`);
    }
    assert.equal(calls.length, 0);
});

test("大小写与前后空白不影响判定（JaVaScRiPt: 也不能过）", () => {
    assert.equal(safeOpenSite("  JavaScript:alert(1)  "), "blocked");
    assert.equal(safeOpenSite("  https://example.com  "), "opened");
    assert.equal(lastCall().url, "https://example.com", "打开的应当是 trim 过的地址");
});

test("空地址返回 empty，且不调用 open", () => {
    assert.equal(safeOpenSite(""), "empty");
    assert.equal(safeOpenSite(null), "empty");
    assert.equal(safeOpenSite(undefined), "empty");
    assert.equal(calls.length, 0);
});

// ============ noopener / noreferrer ============
test("打开时必然带 noopener,noreferrer（新页面拿不到 window.opener）", () => {
    safeOpenSite("https://example.com");
    const call = lastCall();
    assert.equal(call.target, "_blank");
    assert.match(call.features, /noopener/, "缺 noopener：新页面能反向操作本站");
    assert.match(call.features, /noreferrer/, "缺 noreferrer：外站会知道点击来源");
});

// ============ 弹窗拦截 ============
test("被浏览器弹窗拦截时如实报告 blocked，不算成功", () => {
    openReturns = null;
    assert.equal(safeOpenSite("https://example.com"), "blocked");
});

// ============ 批量 ============
test("批量打开：混着危险链接时只开安全的，并数出被挡了几条", () => {
    const r = safeOpenSites([
        "https://a.example",
        "javascript:alert(1)",
        "https://b.example",
        null,
        "data:text/html,x",
    ]);
    assert.deepEqual(r, { opened: 2, blocked: 2 }, "空地址不算 blocked，危险地址要数出来");
    assert.equal(calls.length, 2, "只有两条安全地址真的调用了 open");
});

// ============ 渲染与打开必须同一个判定 ============
test("渲染用的判定和打开用的判定是同一个函数（不会一边给 href 一边拒绝打开）", async () => {
    const { canOpenSite: can } = await import("../src/utils/safeOpen");
    const { isSafeHttpUrl } = await import("../src/utils/url");
    assert.equal(can, isSafeHttpUrl, "两处判定必须是同一个，否则又会出现分裂");
});
