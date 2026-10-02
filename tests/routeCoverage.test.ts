// 路由覆盖：worker/index.ts 原来是一个 1323 行的 if/else 长链，拆成 worker/routes/*.ts
// 之后最大的风险是「某个分支在搬运过程中掉了」或者「新加的路由模块忘了挂进分发表」——
// 这两种错误的表现都是某个接口静默 404，跑单测跑不出来，只有部署上去点到了才发现。
//
// 这里用最直接的办法钉住：把「每个 path + method 组合应该被谁认领」列成清单，
// 拿真实的分发表去跑一遍。认领的判断标准是「这个模块返回了 Response」，
// 返回 null 就是没认领。替身 api 撑不住分支后续逻辑而抛错，也算认领 ——
// 因为能抛错就说明 path/method 那个 if 已经进去了，而我们要测的正是这件事。

import assert from "node:assert/strict";
import test from "node:test";
import { PROTECTED_ROUTES } from "../worker/index";
import { handlePublicRoutes } from "../worker/routes/public";
import type { RouteCtx } from "../worker/routes/types";

/** 替身 api：方法一律存在，返回值一律 undefined。分支只看 path/method，够用了。 */
function fakeApi(): unknown {
    return new Proxy({} as Record<string, unknown>, {
        get(_target, prop) {
            if (prop === "isAuthEnabled") return () => false;
            return async () => undefined;
        },
    });
}

type Handler = (ctx: RouteCtx) => Promise<Response | null>;

/** 分发表：公开路由在前，之后是 index.ts 里真实使用的受保护路由链 */
const TABLE: Array<[string, Handler]> = [
    ["public", handlePublicRoutes as Handler],
    ...PROTECTED_ROUTES.map((fn): [string, Handler] => [fn.name, fn as Handler]),
];

async function tryHandle(fn: Handler, path: string, method: string): Promise<boolean> {
    const request = new Request(`https://nav.example.com/api/${path}`, {
        method,
        headers: method === "GET" ? {} : { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
    });
    const ctx = {
        request,
        env: {},
        url: new URL(request.url),
        path,
        method,
        api: fakeApi(),
        ip: "203.0.113.1",
        trustXFF: false,
        secureCookie: true,
        currentJti: "",
        currentTokenExp: 0,
    } as unknown as RouteCtx;

    try {
        return (await fn(ctx)) !== null;
    } catch {
        // 分支命中了，只是替身 api 给不出后面要的数据 —— 仍然算认领
        return true;
    }
}

/** 跑完整条链，返回所有认领了该请求的模块名 */
async function whoClaims(path: string, method: string): Promise<string[]> {
    const hits: string[] = [];
    for (const [name, fn] of TABLE) {
        // 每个模块给一份全新 Request：body 只能读一次，前一个模块读了后一个就没了
        if (await tryHandle(fn, path, method)) hits.push(name);
    }
    return hits;
}

// 全部 50 个路由分支。startsWith 的那几个（users/ groups/ sites/ configs/）
// 用一条具体路径代表 —— 前缀匹配对任意 id 都成立，测一个就够。
const EXPECTED: Array<[string, string]> = [
    // public：不需要登录
    ["GET", "icon"],
    ["POST", "csp-report"],
    ["POST", "report-error"],
    ["POST", "login"],
    ["POST", "auth/register"],
    ["POST", "auth/recover"],
    ["GET", "auth/recovery-status"],
    ["GET", "init"],
    // account
    ["POST", "logout"],
    ["GET", "auth/me"],
    ["POST", "auth/invite"],
    ["GET", "users"],
    ["POST", "users/1"],
    ["DELETE", "account"],
    ["PUT", "auth/credentials"],
    ["PUT", "auth/recovery-key"],
    // ops
    ["GET", "audit"],
    ["GET", "recycle"],
    ["POST", "recycle/restore"],
    ["POST", "recycle/purge"],
    ["POST", "recycle/restore-batch"],
    ["POST", "recycle/purge-batch"],
    ["DELETE", "recycle"],
    // data
    ["GET", "meta"],
    ["GET", "bootstrap"],
    ["GET", "groups"],
    ["GET", "groups/1"],
    ["POST", "groups"],
    ["PUT", "groups/1"],
    ["DELETE", "groups/1"],
    ["GET", "sites"],
    ["GET", "sites/1"],
    ["POST", "sites"],
    ["PUT", "sites/1"],
    ["DELETE", "sites/1"],
    ["POST", "sites/batch-delete"],
    ["PUT", "group-orders"],
    ["PUT", "site-orders"],
    // config
    ["GET", "configs"],
    ["POST", "configs/batch"],
    ["GET", "configs/theme"],
    ["PUT", "configs/theme"],
    ["DELETE", "configs/theme"],
    // backup
    ["GET", "export"],
    ["POST", "import"],
    ["POST", "webdav/test"],
    ["POST", "webdav/upload"],
    ["POST", "webdav/list"],
    ["POST", "webdav/download"],
    ["POST", "webdav/delete"],
    // ai
    ["GET", "ai/status"],
    ["POST", "ai/test"],
    ["POST", "ai/site-meta"],
    ["POST", "ai/suggest-tags"],
    ["POST", "ai/embed"],
    ["POST", "ai/search"],
];

// 测试期间任何 fetch 都不许真的发出去：分支里若有外网调用（图标、meta、WebDAV），
// 让它拿到一个空响应就好，反正我们只关心「这个分支有没有被认领」。
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("{}", { status: 200 });

test("分发表里的模块数量与预期一致", () => {
    assert.equal(TABLE.length, 7, "public + 6 个受保护路由模块");
    assert.deepEqual(
        TABLE.map(([name]) => name).sort(),
        [
            "handleAccountRoutes",
            "handleBackupRoutes",
            "handleConfigRoutes",
            "handleDataRoutes",
            "handleOpsRoutes",
            "handleAiRoutes",
            "public",
        ].sort(),
    );
});

test("50 个路由分支全部有人认领，且不重复", async () => {
    for (const [method, path] of EXPECTED) {
        const hits = await whoClaims(path, method);
        assert.ok(
            hits.length > 0,
            `${method} /api/${path} 没有任何模块认领 —— 分支丢了还是模块没挂进分发表？`,
        );
        assert.ok(
            hits.length === 1,
            `${method} /api/${path} 被 ${hits.join(" + ")} 多个模块认领 —— 拆的时候抄重了`,
        );
    }
});

test("不存在的路径 / 方法组合落到 404（无人认领）", async () => {
    const misses: Array<[string, string]> = [
        ["GET", "nope"],
        ["DELETE", "groups"], // groups 只有 GET / POST，删单组走 groups/:id
        ["GET", "logout"], // 退出只接受 POST
        ["POST", "init"], // 初始化是只读探测
        ["PUT", "configs"], // 改单键走 configs/:key
        ["GET", "webdav"], // WebDAV 全是 POST
    ];
    for (const [method, path] of misses) {
        assert.deepEqual(await whoClaims(path, method), [], `${method} /api/${path} 不该有人认领`);
    }
});

test("受保护路由链的顺序：账号 → 运维 → 数据 → 配置 → 备份 → AI", () => {
    assert.deepEqual(PROTECTED_ROUTES.map(fn => fn.name), [
        "handleAccountRoutes",
        "handleOpsRoutes",
        "handleDataRoutes",
        "handleConfigRoutes",
        "handleBackupRoutes",
        "handleAiRoutes",
    ]);
});

test.after(() => {
    globalThis.fetch = realFetch;
});
