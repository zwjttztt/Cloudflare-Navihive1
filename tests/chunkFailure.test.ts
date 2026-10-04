// tests/chunkFailure.test.ts
// 弹窗的代码没取到时，界面上该说什么、还要不要给「重试」。
//
// 它守的是一组**写反了不会报错、只会把人带偏**的文案：
//   - 离线时给重试：块本来就没下载到本机，点一百次也取不到，用户会以为重试有用；
//   - 在线时叫人联网：实际多半是站点刚更新、外壳还是旧的，让人去检查网络纯属误导；
//   - 弹窗自己渲染出错（不是块没取到）却说成「联网后就能用」：掩盖了真 bug。

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeChunkFailure, looksLikeChunkLoadError } from "../src/utils/chunkFailure";

test("离线 + 块没取到：说清楚为什么打不开，且不给重试", () => {
    const text = describeChunkFailure(true, true);
    assert.equal(text.retryable, false, "离线时块本来就没缓存到本地，给重试是没用的");
    assert.match(text.title, /离线/);
    assert.match(text.hint, /联网/);
});

test("在线 + 块没取到：给重试，并指向「站点刚更新」这个真原因", () => {
    const text = describeChunkFailure(false, true);
    assert.equal(text.retryable, true);
    assert.match(text.hint, /更新|刷新/);
    assert.doesNotMatch(text.hint, /检查网络/, "在线时不该叫人去查网络");
});

test("不是块加载失败（弹窗自己渲染出错）：仍然给重试，但不说成网络问题", () => {
    const text = describeChunkFailure(false, false);
    assert.equal(text.retryable, true);
    assert.doesNotMatch(text.hint, /联网|网络/);
    // 离线 + 业务逻辑报错：这时也还是可以重试的（代码已经在本地）
    assert.equal(describeChunkFailure(true, false).retryable, true);
});

test("三种情形的文案互不相同（免得改着改着串成同一句）", () => {
    const all = [
        describeChunkFailure(true, true),
        describeChunkFailure(false, true),
        describeChunkFailure(false, false),
    ].map(t => `${t.title}|${t.hint}`);
    assert.equal(new Set(all).size, 3);
});

test("认得出这是块没取到", () => {
    // Vite 产物里三种最常见的说法，浏览器之间还不统一
    assert.equal(looksLikeChunkLoadError(new Error("Failed to fetch dynamically imported module: /assets/X.js")), true);
    assert.equal(looksLikeChunkLoadError(new Error("Importing a module script failed")), true);
    assert.equal(looksLikeChunkLoadError(new Error("error loading dynamically imported module")), true);
    const named: Error & { name: string } = Object.assign(new Error("boom"), { name: "ChunkLoadError" });
    assert.equal(looksLikeChunkLoadError(named), true, "webpack 系直接给 ChunkLoadError 这个名字");
});

test("认得出这不是块没取到（别把业务异常说成网络问题）", () => {
    assert.equal(looksLikeChunkLoadError(new Error("Cannot read properties of undefined")), false);
    assert.equal(looksLikeChunkLoadError(new Error("")), false);
    assert.equal(looksLikeChunkLoadError(null), false, "没有 error 就当普通渲染错误，仍然给重试");
});
