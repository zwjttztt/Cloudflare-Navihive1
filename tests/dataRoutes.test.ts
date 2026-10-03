// tests/dataRoutes.test.ts
// 数据主干路由（worker/routes/data.ts，375 行）的行为用例。
//
// routeCoverage 只证明「这些 path/method 有模块认领」，认领之后做的事全靠这里：
//
// 1. bootstrap 的 ETag —— 站点多的时候这一份 JSON 能到几百 KB，
//    If-None-Match 命中就只回 304，省掉整份下载与解析；
// 2. 写限速只挂在写方法上 —— 读接口不该因为「翻了几页」就把人锁住；
// 3. 参数校验发生在**写库之前**（不然就是先删了再说「id 不对」）；
// 4. 删除站点要留审计。

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleDataRoutes } from "../worker/routes/data";
import { WRITE_GUARD_KEY, writeBucket } from "../worker/loginGuard";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

interface Log {
    created: unknown[];
    updated: Array<{ id: number; data: unknown }>;
    deleted: number[];
    batchDeleted: number[][];
    audits: Array<{ action: string; detail: string }>;
    orders: unknown[];
}

function emptyLog(): Log {
    return { created: [], updated: [], deleted: [], batchDeleted: [], audits: [], orders: [] };
}

interface Options {
    /** 返回一段「正在锁定期」的限速记录，用来验证写请求被挡、读请求不受影响 */
    lockWrites?: boolean;
    bootstrap?: unknown;
    /** 让 validateGroup / validateSite 不通过 */
    invalid?: boolean;
}

function makeApi(log: Log, o: Options, bucket: string): NavigationAPI {
    const guardStore = JSON.stringify({
        buckets: {
            [bucket]: { count: 999, until: Date.now() + 60_000, seen: Date.now() },
        },
    });
    return {
        getCurrentUserId: () => 1,
        getConfig: async (key: string) => (o.lockWrites && key === WRITE_GUARD_KEY ? guardStore : null),
        getBootstrap: async () => o.bootstrap ?? { groups: [], sites: [], configs: {} },
        getGroups: async () => [{ id: 1, name: "g" }],
        getGroup: async (id: number) => ({ id, name: "g" }),
        createGroup: async (g: unknown) => {
            log.created.push(g);
            return { success: true };
        },
        updateGroup: async (id: number, data: unknown) => {
            log.updated.push({ id, data });
            return { success: true };
        },
        deleteGroup: async (id: number) => {
            log.deleted.push(id);
            return { success: true, recycleId: 5 };
        },
        getSites: async (groupId?: number) => [{ id: 1, group_id: groupId ?? 1 }],
        getSite: async (id: number) => ({ id }),
        createSite: async (s: unknown) => {
            log.created.push(s);
            return { success: true };
        },
        updateSite: async (id: number, data: unknown) => {
            log.updated.push({ id, data });
            return { success: true };
        },
        deleteSite: async (id: number) => {
            log.deleted.push(id);
            return { success: true, recycleId: 9 };
        },
        deleteSites: async (ids: number[]) => {
            log.batchDeleted.push(ids);
            return { success: true };
        },
        updateGroupOrder: async (data: unknown) => {
            log.orders.push(data);
            return true;
        },
        updateSiteOrder: async (data: unknown) => {
            log.orders.push(data);
            return { success: true };
        },
        writeAudit: async (action: string, _target: string, _ip: string, detail: string) => {
            log.audits.push({ action, detail });
        },
    } as unknown as NavigationAPI;
}

async function call(
    path: string,
    method: string,
    o: Options = {},
    body?: unknown,
    headers: Record<string, string> = {}
): Promise<{ res: Response | null; log: Log }> {
    const log = emptyLog();
    const request = new Request(`${HOST}/api/${path}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 限速桶的名字要按同一个 request 算出来，假 api 才能把锁放在正确的桶上
    const bucket = writeBucket(request, 1, false);
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: makeApi(log, o, bucket),
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    const res = await handleDataRoutes(ctx);
    return { res, log };
}

// ---- bootstrap 的 ETag ----

test("bootstrap: 首次返回数据并带上 ETag", async () => {
    const { res } = await call("bootstrap", "GET", { bootstrap: { groups: [1] } });
    assert.equal(res?.status, 200);
    assert.ok(res?.headers.get("ETag"));
    assert.equal(res?.headers.get("Cache-Control"), "no-cache");
    assert.deepEqual((await res!.json()) as unknown, { groups: [1] });
});

test("bootstrap: If-None-Match 命中就回 304，不带 body", async () => {
    const first = await call("bootstrap", "GET", { bootstrap: { groups: [1] } });
    const etag = first.res!.headers.get("ETag")!;

    const second = await call("bootstrap", "GET", { bootstrap: { groups: [1] } }, undefined, {
        "If-None-Match": etag,
    });
    assert.equal(second.res?.status, 304);
    assert.equal(await second.res!.text(), "", "304 不该带 body，否则省不掉那几百 KB");
});

test("bootstrap: 内容变了 ETag 就变，不会让浏览器一直拿旧副本", async () => {
    const a = await call("bootstrap", "GET", { bootstrap: { groups: [1] } });
    const b = await call("bootstrap", "GET", { bootstrap: { groups: [1, 2] } });
    assert.notEqual(a.res!.headers.get("ETag"), b.res!.headers.get("ETag"));
});

// ---- 写限速只挂在写方法上 ----

test("读接口不受写限速影响（翻几页不该把人锁住）", async () => {
    const { res } = await call("groups", "GET", { lockWrites: true });
    assert.equal(res?.status, 200, "GET 一律不过闸");
});

test("写接口没撞限速：正常写库（与上一条做对照，免得 429 其实是别的原因）", async () => {
    const { res, log } = await call("groups", "POST", {}, { name: "g", order_num: 0 });
    assert.equal(res?.status, 200);
    assert.equal(log.created.length, 1);
});

test("写接口撞上限速：429 带 Retry-After，且不落到写库", async () => {
    const { res, log } = await call(
        "groups",
        "POST",
        { lockWrites: true },
        { name: "g", order_num: 0 }
    );
    assert.equal(res?.status, 429);
    assert.ok(res?.headers.get("Retry-After"));
    assert.deepEqual(log.created, [], "被限速挡住时不该写库");
});

// ---- 参数校验发生在写库之前 ----

test("分组 id 不是数字：400 且不写库", async () => {
    for (const path of ["groups/abc", "sites/abc"]) {
        const { res, log } = await call(path, "PUT", {}, { name: "x" });
        assert.equal(res?.status, 400, `${path} 应拒绝`);
        assert.deepEqual(log.updated, []);
    }
});

test("改分组：空名 / 排序号不是数字都拦在写库之前", async () => {
    const emptyName = await call("groups/1", "PUT", {}, { name: "   " });
    assert.equal(emptyName.res?.status, 400);
    assert.deepEqual(emptyName.log.updated, []);

    const badOrder = await call("groups/1", "PUT", {}, { order_num: "first" });
    assert.equal(badOrder.res?.status, 400);
    assert.deepEqual(badOrder.log.updated, []);
});

test("改站点：url / 图标 url 不合法要拦下", async () => {
    const badUrl = await call("sites/1", "PUT", {}, { url: "not-a-url" });
    assert.equal(badUrl.res?.status, 400);
    assert.deepEqual(badUrl.log.updated, []);

    const badIcon = await call("sites/1", "PUT", {}, { icon: "not-a-url" });
    assert.equal(badIcon.res?.status, 400);
    assert.deepEqual(badIcon.log.updated, []);
});

test("改站点：空图标字符串是允许的（表示清掉图标）", async () => {
    const { res, log } = await call("sites/1", "PUT", {}, { icon: "" });
    assert.equal(res?.status, 200);
    assert.equal(log.updated.length, 1);
});

test("改站点：凭据字段不是字符串要拦下", async () => {
    const badName = await call("sites/1", "PUT", {}, { username: 123 });
    assert.equal(badName.res?.status, 400);
    const badPwd = await call("sites/1", "PUT", {}, { password: { a: 1 } });
    assert.equal(badPwd.res?.status, 400);
});

// ---- 删除与审计 ----

test("删站点：写审计日志，并把 recycleId 带回给前端撤销用", async () => {
    const { res, log } = await call("sites/7", "DELETE");
    assert.equal(res?.status, 200);
    assert.deepEqual(log.audits, [{ action: "site.delete", detail: "站点 7" }]);
    assert.deepEqual((await res!.json()) as { recycleId: number }, { success: true, recycleId: 9 });
});

test("批量删除：空 id 列表 / 超过 500 个都直接拒绝", async () => {
    const empty = await call("sites/batch-delete", "POST", {}, { ids: [] });
    assert.equal(empty.res?.status, 400);
    assert.deepEqual(empty.log.batchDeleted, []);

    const tooMany = await call(
        "sites/batch-delete",
        "POST",
        {},
        { ids: Array.from({ length: 501 }, (_, i) => i) }
    );
    assert.equal(tooMany.res?.status, 400);
    assert.deepEqual(tooMany.log.batchDeleted, []);
});

test("批量删除：非整数的 id 会被过滤掉，剩下的照删并记审计", async () => {
    const { res, log } = await call("sites/batch-delete", "POST", {}, {
        ids: [1, "x", 2.5, 2, null],
    });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.batchDeleted, [[1, 2]]);
    assert.deepEqual(log.audits, [{ action: "site.batchDelete", detail: "站点 2 个" }]);
});

test("批量删除：整个 body 都不是数组时不会崩", async () => {
    const { res, log } = await call("sites/batch-delete", "POST", {}, { ids: "1,2,3" });
    assert.equal(res?.status, 400);
    assert.deepEqual(log.batchDeleted, []);
});

// ---- 排序 ----

test("分组排序：不是数组 / 缺 order_num 都拒绝", async () => {
    const notArray = await call("group-orders", "PUT", {}, { id: 1 });
    assert.equal(notArray.res?.status, 400);

    const missing = await call("group-orders", "PUT", {}, [{ id: 1 }]);
    assert.equal(missing.res?.status, 400);
    assert.deepEqual(missing.log.orders, []);
});

test("站点排序：group_id 不是数字要拒绝（拖拽跨组会带上它）", async () => {
    const { res, log } = await call("site-orders", "PUT", {}, [
        { id: 1, order_num: 0, group_id: "2" },
    ]);
    assert.equal(res?.status, 400);
    assert.deepEqual(log.orders, []);
});

test("站点排序：合法数据落到 api，且结果原样返回（含「哪几个没成」）", async () => {
    const { res, log } = await call("site-orders", "PUT", {}, [
        { id: 1, order_num: 0, group_id: 2 },
    ]);
    assert.equal(res?.status, 200);
    assert.equal(log.orders.length, 1);
});

// ---- 不认领的路径 ----

test("不归本模块的路径返回 null（交给下一个模块）", async () => {
    const { res } = await call("unknown-thing", "GET");
    assert.equal(res, null);
});
