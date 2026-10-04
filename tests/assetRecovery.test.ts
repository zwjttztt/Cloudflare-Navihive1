// tests/assetRecovery.test.ts
// 「要不要清缓存 + 重载自救」这一个判断。
//
// 它守的是两条方向相反的故障，改坏任一条都是**不报错**的：
//   - 该自救时不自救：页面停在上一版，点开弹窗一片空白，且要等用户自己硬刷新才好；
//   - 不该自救时自救：真离线时把还能用的离线页面换成一张浏览器错误页 ——
//     尤其恶劣，因为用户会以为数据没了，而其实只是我们多刷了一次。

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRecoverAssets } from "../src/utils/assetRecovery";

test("在线：该自救 —— 页面停在旧版时能自己落回新版", () => {
    assert.equal(shouldRecoverAssets({ online: true }), true);
});

test("明确离线：不要自救 —— 清缓存 + 重载会把能用的离线页面换成错误页", () => {
    assert.equal(shouldRecoverAssets({ online: false }), false);
});

test("拿不到在线状态（undefined）：按在线处理", () => {
    // 拿不准就不作为，会让本来能自愈的故障一直挂着；试错成本只是一次重载
    assert.equal(shouldRecoverAssets({ online: undefined }), true);
    assert.equal(shouldRecoverAssets({}), true);
});

test("本次会话已经试过一次：不再试（网络真不通时不该反复刷新）", () => {
    assert.equal(shouldRecoverAssets({ online: true, alreadyTried: true }), false);
    assert.equal(shouldRecoverAssets({ alreadyTried: false }), true);
});
