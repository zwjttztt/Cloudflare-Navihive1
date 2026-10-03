// tests/linkCheckPlan.test.ts
// collectCheckUrls / describeLinkCheck：批量检测前收集 URL 与结束后生成提示。
// 这两个从 App.tsx 搬出来是为了让「文案里跳过数到底该不该提」这类细节有网。

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCheckUrls, describeLinkCheck } from "../src/utils/linkHealth";

test("收集链接：去空白、去重、保持首次出现顺序", () => {
    const urls = collectCheckUrls([
        { sites: [{ url: " https://a.com " }, { url: "https://b.com" }] },
        { sites: [{ url: "https://a.com" }, { url: "  " }, { url: "https://c.com" }] },
    ]);
    assert.deepEqual(urls, ["https://a.com", "https://b.com", "https://c.com"]);
});

test("空分组 / 没有 sites 字段 / 整体为 null 都返回空数组", () => {
    assert.deepEqual(collectCheckUrls([]), []);
    assert.deepEqual(collectCheckUrls([{}, { sites: [] }]), []);
    assert.deepEqual(collectCheckUrls(null), []);
    assert.deepEqual(collectCheckUrls(undefined), []);
});

test("有失效链接时报数量、给快捷入口、级别是 info", () => {
    const s = describeLinkCheck(3, 0);
    assert.match(s.text, /3 个链接疑似失效/);
    assert.equal(s.severity, "info");
    assert.equal(s.offerFilter, true);
});

test("全部正常时不提数量、不给入口、级别是 success", () => {
    const s = describeLinkCheck(0, 0);
    assert.match(s.text, /所有链接都能访问/);
    assert.equal(s.severity, "success");
    assert.equal(s.offerFilter, false);
});

test("跳过数 >0 才在文案里提一句；为 0 或缺失时不能出现空括号", () => {
    assert.match(describeLinkCheck(1, 5).text, /（5 个近期检测过，已跳过）/);
    assert.doesNotMatch(describeLinkCheck(1, 0).text, /（/);
    assert.doesNotMatch(describeLinkCheck(1).text, /（/);
});
