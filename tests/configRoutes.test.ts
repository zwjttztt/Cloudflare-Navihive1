// tests/configRoutes.test.ts
// 配置路由（worker/routes/config.ts，161 行）的行为用例。
//
// 这一组守的是三道门槛，写反了都不报错：
//   1. **全站外观只有站点所有者能改** —— 三个写分支（批量 / 单键 / 删除）各判一次，
//      漏一个就等于「普通账号能改站名和主题」。以前只靠前端把入口藏起来，服务端没管；
//   2. **管理员凭据不许从配置接口走** —— 读、写、删、批量都要挡，
//      否则「改配置」就成了绕过「校验当前密码」的改密后门；
//   3. **写配置有单独的限速闸门**，且读接口不能被它误伤（翻几页把人锁住就没法用了）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleConfigRoutes } from "../worker/routes/config";
import { endpointBucket } from "../worker/loginGuard";
import type { RouteCtx } from "../worker/routes/types";
import type { NavigationAPI } from "../src/API/navigationApi";

const HOST = "https://nav.example.com";
const IP = "203.0.113.1";

interface Log {
    setConfigs: Array<Record<string, string>>;
    setConfig: Array<{ key: string; value: string }>;
    deleted: string[];
    guardChecks: number;
}

interface Options {
    /** 是否站点所有者（全站外观的写入权限） */
    owner?: boolean;
    /** 让写闸门直接判定为「已限住」（返回 429） */
    limitWrites?: boolean;
    /** setConfigs 的返回 */
    setConfigsOk?: boolean;
}

/** 闸门记录存在这个键下；闸门自己也会回写它，日志里要把它滤掉 */
const GUARD_KEY = "auth.configGuard";

function makeApi(log: Log, o: Options, bucket: string): NavigationAPI {
    return {
        getCurrentUserId: () => 1,
        canManageSharedConfigs: async () => o.owner ?? true,
        getConfigs: async () => ({ "site.title": "导航站" }),
        getConfig: async (key: string) => {
            // 写闸门读的就是这一个键：给一段「正在锁定期」的记录即视为被限住
            if (o.limitWrites && key === GUARD_KEY) {
                return JSON.stringify({
                    version: 2,
                    buckets: {
                        [bucket]: { count: 999, until: Date.now() + 60_000, seen: Date.now() },
                    },
                });
            }
            return null;
        },
        setConfigs: async (configs: Record<string, string>) => {
            log.setConfigs.push(configs);
            return o.setConfigsOk ?? true;
        },
        setConfig: async (key: string, value: string) => {
            // 闸门自己回写计数也走 setConfig，混进日志会让「一项都不该写」的断言失真
            if (key !== GUARD_KEY) log.setConfig.push({ key, value });
            return true;
        },
        deleteConfig: async (key: string) => {
            log.deleted.push(key);
            return true;
        },
    } as unknown as NavigationAPI;
}

async function call(
    path: string,
    method: string,
    o: Options = {},
    body?: unknown
): Promise<{ res: Response | null; log: Log }> {
    const log: Log = { setConfigs: [], setConfig: [], deleted: [], guardChecks: 0 };
    const request = new Request(`${HOST}/api/${path}`, {
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
        api: makeApi(log, o, endpointBucket(request, 1, false)),
        ip: IP,
        trustXFF: false,
        secureCookie: true,
        currentJti: "jti-1",
        currentTokenExp: 0,
    } as unknown as RouteCtx;
    const res = await handleConfigRoutes(ctx);
    return { res, log };
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

// ---------------- 读 ----------------

test("GET configs：原样返回，不经过写闸门", async () => {
    const { res } = await call("configs", "GET");
    assert.equal(res?.status, 200);
    assert.deepEqual(await json(res!), { "site.title": "导航站" });
});

test("GET configs/auth.xxx：管理员凭据不可读取（拿到配置不等于拿到密码）", async () => {
    const { res } = await call("configs/auth.passwordHash", "GET");
    assert.equal(res?.status, 403);
});

test("GET configs/xxx：回键与值", async () => {
    const { res } = await call("configs/site.title", "GET");
    const body = await json(res!);
    assert.equal(body.key, "site.title");
});

// ---------------- 批量写 ----------------

test("configs/batch：整批一次写完，并回报条数", async () => {
    const { res, log } = await call("configs/batch", "POST", {}, { configs: { a: "1", b: "2" } });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setConfigs, [{ a: "1", b: "2" }]);
    assert.equal((await json(res!)).saved, 2);
});

test("configs/batch：空批次直接成功，不去空转一次写库", async () => {
    const { res, log } = await call("configs/batch", "POST", {}, { configs: {} });
    assert.equal(res?.status, 200);
    assert.equal(log.setConfigs.length, 0);
    assert.equal((await json(res!)).saved, 0);
});

test("configs/batch：含全站共享键且不是所有者 → 403，且一项都不写", async () => {
    // 注意键的归属：site.* 是「每人一份的外观」、webdav.* / ai.* 是账号私有，
    // 这两类普通账号本来就能改；真正的全站共享键是除此之外那些（如巡检开关）。
    const { res, log } = await call(
        "configs/batch",
        "POST",
        { owner: false },
        { configs: { "link.healthSync": "1", "webdav.url": "https://dav.example" } }
    );
    assert.equal(res?.status, 403);
    assert.equal(log.setConfigs.length, 0, "被拒了就不能只写「不受限的那部分」—— 半套写入更难收拾");
});

test("configs/batch：全是账号自己的键（site.* / webdav.*）时普通账号也能写", async () => {
    const { res, log } = await call(
        "configs/batch",
        "POST",
        { owner: false },
        { configs: { "site.title": "我自己的站名", "webdav.url": "https://dav.example" } }
    );
    assert.equal(res?.status, 200, "改自己的外观不该被拦");
    assert.equal(log.setConfigs.length, 1);
});

test("configs/batch：管理员凭据不许从这里改（否则绕过「校验当前密码」）", async () => {
    const { res, log } = await call("configs/batch", "POST", {}, { configs: { "auth.username": "x" } });
    assert.equal(res?.status, 403);
    assert.equal(log.setConfigs.length, 0);
});

test("configs/batch：值不是字符串 → 400，并指名是哪个键", async () => {
    const { res, log } = await call("configs/batch", "POST", {}, { configs: { ok: "1", bad: 42 } });
    assert.equal(res?.status, 400);
    assert.ok(String((await json(res!)).message).includes("bad"), "要说清是哪个键不合法");
    assert.equal(log.setConfigs.length, 0);
});

test("configs/batch：写闸门拦住时返回 429，且不写库", async () => {
    const { res, log } = await call(
        "configs/batch",
        "POST",
        { limitWrites: true },
        { configs: { a: "1" } }
    );
    assert.equal(res?.status, 429);
    assert.equal(log.setConfigs.length, 0);
});

// ---------------- 单键写 ----------------

test("PUT 全站共享键：非所有者 → 403（以前只靠前端藏入口，服务端没管）", async () => {
    const { res, log } = await call(
        "configs/link.healthSync",
        "PUT",
        { owner: false },
        { value: "1" }
    );
    assert.equal(res?.status, 403);
    assert.equal(log.setConfig.length, 0);
});

test("PUT 全站共享键：所有者可写", async () => {
    const { res, log } = await call("configs/link.healthSync", "PUT", { owner: true }, { value: "1" });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setConfig, [{ key: "link.healthSync", value: "1" }]);
});

test("PUT configs/auth.xxx：一律 403（要改密请走校验当前密码的接口）", async () => {
    const { res, log } = await call("configs/auth.username", "PUT", { owner: true }, { value: "x" });
    assert.equal(res?.status, 403);
    assert.equal(log.setConfig.length, 0);
});

test("PUT configs/webdav.xxx：账号私有配置，普通账号也能改", async () => {
    const { res, log } = await call(
        "configs/webdav.url",
        "PUT",
        { owner: false },
        { value: "https://dav.example" }
    );
    assert.equal(res?.status, 200);
    assert.deepEqual(log.setConfig, [{ key: "webdav.url", value: "https://dav.example" }]);
});

test("PUT configs/xxx：值不是非空字符串 → 400（验证发生在写库之前）", async () => {
    const { res, log } = await call("configs/site.title", "PUT", {}, { value: 123 });
    assert.equal(res?.status, 400);
    assert.equal(log.setConfig.length, 0, "先写库再说「不合法」就晚了");
});

// ---------------- 删 ----------------

test("DELETE configs/auth.xxx：不许删（避免悄悄退化回默认密码）", async () => {
    const { res, log } = await call("configs/auth.username", "DELETE");
    assert.equal(res?.status, 403);
    assert.equal(log.deleted.length, 0);
});

test("DELETE 全站共享键：非所有者 → 403（删除也是写，同样要过这道门槛）", async () => {
    const { res, log } = await call("configs/link.healthSync", "DELETE", { owner: false });
    assert.equal(res?.status, 403);
    assert.equal(log.deleted.length, 0);
});

test("DELETE configs/xxx：所有者可删", async () => {
    const { res, log } = await call("configs/link.healthSync", "DELETE", { owner: true });
    assert.equal(res?.status, 200);
    assert.deepEqual(log.deleted, ["link.healthSync"]);
});

// ---------------- 不认领 ----------------

test("不归本模块的 path 返回 null", async () => {
    const { res } = await call("bootstrap", "GET");
    assert.equal(res, null);
});
