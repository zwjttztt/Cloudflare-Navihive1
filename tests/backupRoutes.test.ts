// tests/backupRoutes.test.ts
// 备份与恢复路由（worker/routes/backup.ts，340 行）。
//
// 这里守的是这一类接口独有的两件事 —— 它们都是「拿到会话后收益最大 / 破坏最大」的：
//   1. **导出**一次带走整站数据 + 解密后的站点密码，所以有专门的限速与审计：
//      锁定期内要挡回 429，且**被拦了还一直点**不能把等待时间越点越长；
//   2. **导入**是唯一能「整体替换全站数据」的入口：光限体积不够（10MB 的短 JSON
//      能塞几万条），必须再限条数；并且一定要留审计（数据已经换完了，事后要能查是谁换的）。
// WebDAV 那五条只测闸门 —— 它们会真的出网到用户网盘，单测里不该碰。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleBackupRoutes } from "../worker/routes/backup";
import { endpointBucket, exportBucket, writeBucket } from "../worker/loginGuard";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";
const DAV_GUARD_KEY = "auth.davGuard";
const EXPORT_GUARD_KEY = "auth.exportGuard";
const WRITE_GUARD_KEY = "auth.writeGuard";

interface Log {
    audits: Array<{ action: string; target: string; detail: string }>;
    imports: Array<{ groups: number }>;
    exportCalls: number;
}

type Guards = Record<string, string>;

function makeApi(log: Log, guards: Guards, auditFails = false): NavigationAPI {
    return {
        getCurrentUserId: () => 1,
        getConfig: async (key: string) => guards[key] ?? null,
        setConfig: async (key: string, value: string) => {
            guards[key] = value;
            return true;
        },
        compareAndSetConfig: async (key: string, expected: string | null, value: string) => {
            if ((guards[key] ?? null) !== expected) return false;
            guards[key] = value;
            return true;
        },
        exportData: async () => {
            log.exportCalls += 1;
            return { groups: [], sites: [], configs: {} };
        },
        importData: async (data: { groups?: unknown[] }) => {
            log.imports.push({ groups: data.groups?.length ?? 0 });
            return { success: true };
        },
        writeAudit: async (action: string, target: string, _ip: string, detail = "") => {
            if (auditFails) throw new Error("审计表写不进去");
            log.audits.push({ action, target, detail });
        },
    } as unknown as NavigationAPI;
}

async function call(
    path: string,
    method: string,
    o: {
        guards?: Guards;
        body?: unknown;
        headers?: Record<string, string>;
        contentLength?: string;
        auditFails?: boolean;
    } = {}
): Promise<{ res: Response | null; log: Log; guards: Guards }> {
    const log: Log = { audits: [], imports: [], exportCalls: 0 };
    const guards: Guards = { ...(o.guards ?? {}) };
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "CF-Connecting-IP": IP,
        ...(o.headers ?? {}),
    };
    if (o.contentLength) headers["Content-Length"] = o.contentLength;
    const request = new Request(`${HOST}/api/${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: makeApi(log, guards, o.auditFails ?? false),
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: "jti-1",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    const res = await handleBackupRoutes(ctx);
    return { res, log, guards };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** 造一段「这个桶正在锁定期」的闸门记录 */
function lockedStore(bucket: string, untilMs = 60_000): string {
    return JSON.stringify({
        version: 2,
        buckets: { [bucket]: { count: 999, until: Date.now() + untilMs, seen: Date.now() } },
    });
}

// ---------------- 导出 ----------------

test("export：正常导出，带上附件头与 no-store", async () => {
    const { res, log } = await call("export", "GET");
    assert.equal(res?.status, 200);
    assert.equal(log.exportCalls, 1);
    assert.match(res!.headers.get("Content-Disposition") || "", /attachment; filename="navihive-data.json"/);
    assert.equal(res!.headers.get("Cache-Control"), "no-store");
});

test("export：留审计（整站数据一次带走，限速挡频率、审计留证据）", async () => {
    const { log } = await call("export", "GET");
    assert.ok(
        log.audits.some(a => a.action === "data-export"),
        `应写一条 data-export 审计，实际 ${JSON.stringify(log.audits)}`
    );
});

test("export：锁定期内 → 429，且不真的去读数据", async () => {
    // 桶名要按同一个 request 算出来，闸门才认
    const probe = new Request(`${HOST}/api/export`, {
        method: "GET",
        headers: { "CF-Connecting-IP": IP },
    });
    const bucket = exportBucket(probe, 1, false);
    const { res, log } = await call("export", "GET", {
        guards: { [EXPORT_GUARD_KEY]: lockedStore(bucket) },
    });
    assert.equal(res?.status, 429);
    assert.equal(log.exportCalls, 0, "被限住就不该再去读一遍全站数据");
    assert.match(String((await json(res!)).message), /秒后再试/);
});

test("export：审计写失败不影响导出结果（留痕是附加价值，不能反过来拖垮主流程）", async () => {
    const { res, log } = await call("export", "GET", { auditFails: true });
    assert.equal(res?.status, 200, "审计挂了也得把数据给回用户");
    assert.equal(log.exportCalls, 1);
});

test("import：审计写失败不影响导入结果（数据已经换完了，为审计回滚反而更糟）", async () => {
    const { res, log } = await call("import", "POST", { body: validBody, auditFails: true });
    assert.equal(res?.status, 200);
    assert.equal(log.imports.length, 1);
});

// ---------------- 导入 ----------------

const validBody = { groups: [{ id: 1, name: "g", sites: [] }], sites: [], configs: {} };

test("import：数据格式无效（没有 groups）→ 400，且不碰库", async () => {
    const { res, log } = await call("import", "POST", { body: { sites: [] } });
    assert.equal(res?.status, 400);
    assert.equal(log.imports.length, 0);
});

test("import：条数超限 → 413（光限体积不够：10MB 的短 JSON 能塞几万条）", async () => {
    const groups = Array.from({ length: 2_001 }, (_, i) => ({ id: i, name: `g${i}`, sites: [] }));
    const { res, log } = await call("import", "POST", { body: { groups } });
    assert.equal(res?.status, 413);
    assert.equal(log.imports.length, 0, "超限就不能开始写");
});

test("import：站点数按嵌套在分组里的也算（兼容旧版备份格式）", async () => {
    const groups = [
        { id: 1, name: "g", sites: Array.from({ length: 20_001 }, (_, i) => ({ id: i })) },
    ];
    const { res } = await call("import", "POST", { body: { groups } });
    assert.equal(res?.status, 413);
});

test("import：超体积（Content-Length）→ 413，连 body 都不读", async () => {
    const { res, log } = await call("import", "POST", {
        body: validBody,
        contentLength: String(11 * 1024 * 1024),
    });
    assert.equal(res?.status, 413);
    assert.equal(log.imports.length, 0);
});

test("import：正常导入后写审计（唯一能整体换掉全站数据的入口，必须留痕）", async () => {
    const { res, log } = await call("import", "POST", { body: validBody });
    assert.equal(res?.status, 200);
    assert.equal(log.imports.length, 1);
    assert.ok(
        log.audits.some(a => a.action === "data-import" && a.detail.includes("groups")),
        `应写一条带条数的 data-import 审计，实际 ${JSON.stringify(log.audits)}`
    );
});

test("import：写限速拦住时 → 429，不开始导入", async () => {
    const probe = new Request(`${HOST}/api/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP },
        body: "{}",
    });
    const bucket = writeBucket(probe, 1, false);
    const { res, log } = await call("import", "POST", {
        body: validBody,
        guards: { [WRITE_GUARD_KEY]: lockedStore(bucket) },
    });
    assert.equal(res?.status, 429);
    assert.equal(log.imports.length, 0);
});

// ---------------- WebDAV：只测闸门（后面会真的出网，单测里不碰） ----------------

test("webdav/*：闸门拦住时 429 —— 且发生在读 body 之前（被限的请求连 10MB 都不必读进来）", async () => {
    const probe = new Request(`${HOST}/api/webdav/list`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP },
        body: "{}",
    });
    const bucket = endpointBucket(probe, 1, false);
    const { res } = await call("webdav/list", "POST", {
        body: {},
        guards: { [DAV_GUARD_KEY]: lockedStore(bucket) },
    });
    assert.equal(res?.status, 429);
});

// ---------------- 不认领 ----------------

test("不归本模块的 path 返回 null", async () => {
    const { res } = await call("bootstrap", "GET");
    assert.equal(res, null);
});
