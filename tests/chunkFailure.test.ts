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

test("在线 + 块没取到：给按钮，并指向「站点刚更新」这个真原因", () => {
    const text = describeChunkFailure(false, true);
    assert.equal(text.retryable, true);
    assert.match(text.hint, /更新|刷新/);
    assert.doesNotMatch(text.hint, /检查网络/, "在线时不该叫人去查网络");
    // 2026-10-29：按钮的动作是「刷页面」，文案必须跟着改。
    // React.lazy 把失败的 import promise 永久缓存，说「重试会重新取一次」是骗人的
    // —— 用户点一次、看到一模一样的错误，再点一次还是那个错误。
    assert.match(text.hint, /刷新/, `要说明按钮会刷新页面，实际：${text.hint}`);
    assert.doesNotMatch(text.hint, /重试/, `不该再许诺「重试」，实际：${text.hint}`);
});

test("不是块加载失败（弹窗自己渲染出错）：仍然给按钮，但不说成网络问题", () => {
    const text = describeChunkFailure(false, false);
    assert.equal(text.retryable, true);
    assert.doesNotMatch(text.hint, /联网|网络/);
    // 同样只能靠刷新：重挂子树对「渲染期已经抛过的那棵树」也一样救不回来
    assert.match(text.hint, /刷新/, `要说明按钮会刷新页面，实际：${text.hint}`);
    assert.doesNotMatch(text.hint, /重试/, "不该再许诺「重试」");
    // 离线 + 业务逻辑报错：这时也还是可以点的（代码已经在本地）
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
