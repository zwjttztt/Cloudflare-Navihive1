import { test } from "node:test";
import assert from "node:assert/strict";
import { issueShareAssetSession, verifyShareAssetSession } from "../worker/shareAssetSession";

test("分享附件会话绑定分享、口令和有效期", async () => {
    const now = Date.now();
    const value = await issueShareAssetSession("share-a", "password-hash-a", now);
    assert.equal(await verifyShareAssetSession(value, "share-a", "password-hash-a", now), true);
    assert.equal(await verifyShareAssetSession(value, "share-b", "password-hash-a", now), false);
    assert.equal(await verifyShareAssetSession(value, "share-a", "password-hash-b", now), false);
    assert.equal(await verifyShareAssetSession(value, "share-a", "password-hash-a", now + 31 * 60_000), false);
    assert.equal(await verifyShareAssetSession(value + "x", "share-a", "password-hash-a", now), false);
});
