import test from "node:test";
import assert from "node:assert/strict";
import { handlePublicRoutes } from "../worker/routes/public";
import { issueShareAssetSession, shareAssetCookieName, shareViewCookieName, utcDayStamp } from "../worker/shareAssetSession";
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

// ---------------- 浏览计数防刷（2026-10-11） ----------------
//
// views 去重用 cookie 当日戳：首访签发、同日复访把 countView=false 传给方法层。
// 两条路由（note-shares / group-shares）都要验：签发、复访跳过计数、跨天重计。

function makeViewCtx(path: string, method: "GET" | "POST", cookie: string, record: { countView?: boolean }[]) {
    const request = new Request(`https://example.com/api/${path}`, {
        method,
        headers: cookie ? { Cookie: cookie } : undefined,
        body: method === "POST" ? JSON.stringify({}) : undefined,
    });
    const okResult = path.startsWith("group-shares/")
        ? { status: "ok", group: { name: "g" }, sites: [], views: 1 }
        : { status: "ok", note: { title: "t", content: "c" }, views: 1 };
    const api = {
        getPublicNote: async (_t: string, _p: unknown, countView?: boolean) => {
            record.push({ countView });
            return okResult;
        },
        getPublicGroupShare: async (_t: string, _p: unknown, countView?: boolean) => {
            record.push({ countView });
            return okResult;
        },
    };
    const ctx = {
        request, url: new URL(request.url), path, method, api, secureCookie: true,
        env: {},
    } as unknown as RouteCtx;
    return handlePublicRoutes(ctx);
}

test("note-shares 防刷：首访计数并签当日戳，同日复访跳过计数", async () => {
    const seen: { countView?: boolean }[] = [];
    const first = await makeViewCtx("note-shares/share-a", "GET", "", seen);
    assert.equal(first?.status, 200);
    assert.equal(seen[0]?.countView, true, "无 cookie 的首访必须计数");
    const name = shareViewCookieName("note", "share-a");
    const set = first?.headers.get("Set-Cookie") ?? "";
    assert.match(set, new RegExp(name + "=" + utcDayStamp()));
    assert.match(set, /HttpOnly; SameSite=Strict; Path=\/api\/; Max-Age=\d+/);

    const second = await makeViewCtx("note-shares/share-a", "GET", `${name}=${utcDayStamp()}`, seen);
    assert.equal(second?.status, 200);
    assert.equal(seen[1]?.countView, false, "同日带当日戳复访必须跳过计数");
    assert.equal(second?.headers.get("Set-Cookie"), null, "已计过就不再签发当日戳");
    // 过期（昨天的戳）→ 重新计数
    const staleCookie = `${name}=${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}`;
    seen.length = 0;
    await makeViewCtx("note-shares/share-a", "GET", staleCookie, seen);
    assert.equal(seen[0]?.countView, true, "昨天的当日戳跨天失效，重新计数");
});

test("group-shares 防刷：与 note-shares 同一套当日戳语义", async () => {
    const seen: { countView?: boolean }[] = [];
    const first = await makeViewCtx("group-shares/share-a", "GET", "", seen);
    assert.equal(first?.status, 200);
    assert.equal(seen[0]?.countView, true);
    const name = shareViewCookieName("group", "share-a");
    const set = first?.headers.get("Set-Cookie") ?? "";
    assert.match(set, new RegExp(name + "=" + utcDayStamp()));

    seen.length = 0;
    const second = await makeViewCtx("group-shares/share-a", "GET", `${name}=${utcDayStamp()}`, seen);
    assert.equal(second?.status, 200);
    assert.equal(seen[0]?.countView, false);
    assert.equal(second?.headers.get("Set-Cookie"), null);
});
