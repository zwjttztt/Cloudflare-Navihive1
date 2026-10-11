import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicRoutes } from "../worker/routes/public";
import { issueShareAssetSession, shareAssetCookieName } from "../worker/shareAssetSession";
import type { RouteCtx } from "../worker/routes/types";

async function requestAsset(cookie = "", token = "share-a", hash = "hash-a") {
    const request = new Request(`https://example.com/api/note-shares/attachments/asset-id?share=${token}`, { headers: { Cookie: cookie } });
    const ctx = {
        request, url: new URL(request.url), path: "note-shares/attachments/asset-id", method: "GET",
        api: { getPublicAttachment: async () => ({ note_id: 1, object_key: "key", storage: "kv", mime: "image/png" }) },
        env: {
            DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ token: "share-a", password: hash }] }) }) }) },
            FILES_KV: { get: async () => new Uint8Array([1, 2]).buffer },
        },
    } as unknown as RouteCtx;
    return handlePublicRoutes(ctx);
}

test("口令分享图片拒绝裸 URL，并在验证口令会话后允许访问", async () => {
    assert.equal((await requestAsset())?.status, 404);
    const value = await issueShareAssetSession("share-a", "hash-a");
    const cookie = `${shareAssetCookieName("share-a")}=${value}`;
    assert.equal((await requestAsset(cookie))?.status, 200);
    assert.equal((await requestAsset(cookie, "share-b"))?.status, 404);
    assert.equal((await requestAsset(cookie, "share-a", "new-hash"))?.status, 404);
    assert.equal((await requestAsset("", "share-a", ""))?.status, 200, "无口令分享仍兼容");
});

test("口令通过后签发 HttpOnly 短时 cookie，失败不签发", async () => {
    for (const success of [true, false]) {
        const request = new Request("https://example.com/api/note-shares/share-a", { method: "POST", body: JSON.stringify({ password: "secret" }) });
        const response = await handlePublicRoutes({
            request, url: new URL(request.url), path: "note-shares/share-a", method: "POST", secureCookie: true,
            api: { getPublicNote: async () => success ? { status: "ok", note: { title: "public" } } : { status: "need-password" } },
            env: { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ password: "hash-a" }) }) }) } },
        } as unknown as RouteCtx);
        assert.equal(response?.status, success ? 200 : 401);
        const cookie = response?.headers.get("Set-Cookie");
        if (success) {
            assert.match(cookie ?? "", /HttpOnly; SameSite=Strict; Path=\/api\/note-shares\/; Max-Age=1800; Secure/);
        } else assert.equal(cookie, null);
    }
});
