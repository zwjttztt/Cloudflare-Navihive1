// tests/opsRoutes.test.ts
// 运维路由（worker/routes/ops.ts，121 行）：审计日志、前端错误聚合、回收站。
//
// 这一组守的是「看的人」和「改的范围」：
//   - 审计与错误上报都只有 owner 能看 —— 里面带着 IP、页面路径、报错内容，
//     谁都能翻等于把半个后台摆在外面；
//   - 回收站的每个写操作都要**先验证 id**，且留审计 —— 它是唯一能「永久删除」的地方，
//     还原错了最多尴尬，永久删错了就没了；
//   - limit 必须夹在上下限之间：前端传个 limit=100000 就把整表拖出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleOpsRoutes } from "../worker/routes/ops";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

interface Log {
    audits: Array<{ action: string; detail: string }>;
    auditQueries: Array<{ limit: number; offset: number; actor?: string }>;
    errorLimits: number[];
    restored: number[];
    restoredBatch: number[][];
    purged: number[];
    purgedBatch: number[][];
    emptied: number;
}

function emptyLog(): Log {
    return {
        audits: [],
        auditQueries: [],
        errorLimits: [],
        restored: [],
        restoredBatch: [],
        purged: [],
        purgedBatch: [],
        emptied: 0,
    };
}

interface Options {
    role?: "owner" | "user";
    uid?: number | null;
    /** getUserById 查不到人 */
    userMissing?: boolean;
    /** getAuditLog 返回的条数（用来看 hasMore 的判定） */
    auditRows?: number;
}

function makeApi(log: Log, o: Options): NavigationAPI {
    const uid = o.uid === undefined ? 1 : o.uid;
    return {
        getCurrentUserId: () => uid,
        getUserById: async () =>
            o.userMissing ? null : { id: uid ?? 0, username: "u", role: o.role ?? "owner" },
        getAuditLog: async (q: { limit: number; offset: number; actor?: string }) => {
            log.auditQueries.push(q);
            const rows = o.auditRows ?? 3;
            return Array.from({ length: rows }, (_, i) => ({ id: i, action: "logout" }));
        },
        getClientErrors: async (limit: number) => {
            log.errorLimits.push(limit);
            return [{ message: "boom", count: 2 }];
        },
        listRecycleBin: async () => [{ id: 1, kind: "site" }],
        restoreRecycleItem: async (id: number) => {
            log.restored.push(id);
            return true;
        },
        purgeRecycleItem: async (id: number) => {
            log.purged.push(id);
            return true;
        },
        restoreRecycleItems: async (ids: number[]) => {
            log.restoredBatch.push(ids);
            return { success: true, items: [] };
        },
        purgeRecycleItems: async (ids: number[]) => {
            log.purgedBatch.push(ids);
        },
        emptyRecycleBin: async () => {
            log.emptied += 1;
            return true;
        },
        writeAudit: async (action: string, _t: string, _ip: string, detail = "") => {
            log.audits.push({ action, detail });
        },
    } as unknown as NavigationAPI;
}

async function call(
    path: string,
    method: string,
    o: Options = {},
    body?: unknown,
    query = ""
): Promise<{ res: Response | null; log: Log }> {
    const log = emptyLog();
    const request = new Request(`${HOST}/api/${path}${query}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: makeApi(log, o),
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: "jti-1",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    const res = await handleOpsRoutes(ctx);
    return { res, log };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

// ---------------- 审计日志 ----------------

test("audit：仅 owner 可见（里面有 IP 与操作明细）", async () => {
    const { res } = await call("audit", "GET", { role: "user" });
    assert.equal(res?.status, 403);
});

test("audit：未启用登录 / 查不到账号 → 403，不能返回空日志冒充「没问题」", async () => {
    assert.equal((await call("audit", "GET", { uid: null })).res?.status, 403);
    assert.equal((await call("audit", "GET", { userMissing: true })).res?.status, 403);
});

test("audit：limit 夹在 1~200 —— 前端传多大都不能把整表拖出来", async () => {
    const big = await call("audit", "GET", {}, undefined, "?limit=100000");
    assert.equal(big.log.auditQueries[0]!.limit, 200);

    // 0 是 falsy：`parseInt("0") || 50` 会当成没传、回落到默认 50。
    // 这也正是下面那道 Math.max(...,1) 存在的理由 —— 负数才落到 1。
    const zero = await call("audit", "GET", {}, undefined, "?limit=0");
    assert.equal(zero.log.auditQueries[0]!.limit, 50, "limit=0 按「没传」处理");

    const negative = await call("audit", "GET", {}, undefined, "?limit=-20");
    assert.equal(negative.log.auditQueries[0]!.limit, 1, "负数必须被夹回 1");

    const junk = await call("audit", "GET", {}, undefined, "?limit=abc");
    assert.equal(junk.log.auditQueries[0]!.limit, 50, "非数字回落到默认 50");
});

test("audit：offset 不能为负，actor 原样传下去", async () => {
    const { log } = await call("audit", "GET", {}, undefined, "?offset=-5&actor=张三");
    assert.equal(log.auditQueries[0]!.offset, 0);
    assert.equal(log.auditQueries[0]!.actor, "张三");
});

test("audit：hasMore 按「返回条数 == limit」判定", async () => {
    const more = await call("audit", "GET", { auditRows: 2 }, undefined, "?limit=2");
    assert.equal((await json(more.res!)).hasMore, true);
    const none = await call("audit", "GET", { auditRows: 1 }, undefined, "?limit=5");
    assert.equal((await json(none.res!)).hasMore, false);
});

// ---------------- 前端错误上报 ----------------

test("client-errors：仅 owner 可见（上报本身是公开的，所以「看」必须收口）", async () => {
    const { res } = await call("client-errors", "GET", { role: "user" });
    assert.equal(res?.status, 403);
});

test("client-errors：limit 夹在 1~500", async () => {
    const { log } = await call("client-errors", "GET", {}, undefined, "?limit=99999");
    assert.equal(log.errorLimits[0], 500);
});

// ---------------- 回收站 ----------------

test("recycle：列出当前账号软删除的条目", async () => {
    const { res } = await call("recycle", "GET");
    const body = await json(res!);
    assert.equal(body.success, true);
    assert.equal((body.items as unknown[]).length, 1);
});

test("recycle/restore：id 缺失或非数字 → 400，且不碰库", async () => {
    const noId = await call("recycle/restore", "POST", {}, {});
    assert.equal(noId.res?.status, 400);
    assert.equal(noId.log.restored.length, 0);

    const junk = await call("recycle/restore", "POST", {}, { id: "abc" });
    assert.equal(junk.res?.status, 400);
    assert.equal(junk.log.restored.length, 0);
});

test("recycle/restore：还原成功并留审计（永久删除前的事后补救，要能查）", async () => {
    const { res, log } = await call("recycle/restore", "POST", {}, { id: 12 });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.restored, [12]);
    assert.ok(log.audits.some(a => a.action === "recycle.restore" && a.detail.includes("12")));
});

test("recycle/purge：同样要先验证 id，并留审计", async () => {
    const bad = await call("recycle/purge", "POST", {}, { id: "x" });
    assert.equal(bad.res?.status, 400);
    assert.equal(bad.log.purged.length, 0);

    const { res, log } = await call("recycle/purge", "POST", {}, { id: 7 });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.purged, [7]);
    assert.ok(log.audits.some(a => a.action === "recycle.purge"));
});

test("recycle/restore-batch：过滤掉非整数，全被滤掉就报 400", async () => {
    const { res, log } = await call("recycle/restore-batch", "POST", {}, { ids: [1, "x", 2.5, 3] });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.restoredBatch, [[1, 3]], "字符串与小数都不该进库");

    const junk = await call("recycle/restore-batch", "POST", {}, { ids: ["a", "b"] });
    assert.equal(junk.res?.status, 400);
    assert.equal(junk.log.restoredBatch.length, 0);
});

test("recycle/purge-batch：批量永久删除要留审计（写清条数）", async () => {
    const { res, log } = await call("recycle/purge-batch", "POST", {}, { ids: [4, 5, 6] });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.purgedBatch, [[4, 5, 6]]);
    assert.ok(log.audits.some(a => a.detail.includes("3 条")));
});

test("recycle DELETE：清空并留审计", async () => {
    const { res, log } = await call("recycle", "DELETE");
    assert.equal(res?.status, 200);
    assert.equal(log.emptied, 1);
    assert.ok(log.audits.some(a => a.action === "recycle.empty"));
});

// ---------------- 不认领 ----------------

test("不归本模块的 path 返回 null", async () => {
    const { res } = await call("bootstrap", "GET");
    assert.equal(res, null);
});
