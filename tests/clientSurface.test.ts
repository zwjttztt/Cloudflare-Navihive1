// 前端 API 表面覆盖：src/API/client.ts 原本是一个 1530 行 / 90 个方法的类，
// 现在拆成「传输核心 + ./clientMethods/*.ts 四个域」，由 client.ts 末尾的
// Object.assign 混回原型。
//
// 与 tests/apiSurface.test.ts（盯服务端 NavigationAPI）同形，但多钉一条：
// 真客户端与演示客户端的**方法集合必须一致**。
// 原因就在 transport.ts 里 ClientThis 那条注释上 —— 域方法体为了兼容
// `NavigationClient | MockNavigationClient` 联合类型，`this` 写成了最小接口 ClientThis，
// 于是「Mock 少实现一个方法」这件事**编译器不会报错**（缺的那个方法只是不在联合类型
// 的公共部分里），要到运行时某个界面点了那里才 TypeError。
// 演示模式（VITE_USE_REAL_API 未开）走的正是 Mock，CI 全绿但演示模式一点就炸，
// 这种回归只能靠运行时比对拦住。
//
// 三个只有跑起来才暴露的坑：
//   1. 某个域忘了加进混回列表 —— TS 只信 interface 声明合并，不会核实原型上真有这些方法；
//   2. 两个域定义了同名方法 —— 后混入的静默覆盖先混入的；
//   3. Mock 与真客户端方法集合漂移 —— 演示模式里才炸。

import assert from "node:assert/strict";
import test from "node:test";
import { NavigationClient } from "../src/API/client";
import { MockNavigationClient } from "../src/API/mock";
import { authImpl } from "../src/API/clientMethods/auth";
import { notesImpl } from "../src/API/clientMethods/notes";
import { sitesImpl } from "../src/API/clientMethods/sites";
import { systemImpl } from "../src/API/clientMethods/system";
import type { ClientThis } from "../src/API/transport";

/** 域实现清单。新增域时**必须**在这里加一行，否则这个测试会漏掉它。 */
const IMPLS: Array<[string, object]> = [
    ["auth", authImpl],
    ["notes", notesImpl],
    ["sites", sitesImpl],
    ["system", systemImpl],
];

/** 留在 client.ts 类里的传输核心 */
const CORE_METHODS = [
    "setIdempotencyKey",
    "isLoggedIn",
    "setToken",
    "setSessionCookie",
    "clearToken",
    "request",
];

/** 拆分时搬走的方法数，用来兜底「整批没混进去」这种大面积回退 */
const MOVED_METHOD_COUNT = 90;

/** 原型上（含继承链）值为函数、且不是构造器的自有成员 */
function methodNames(proto: object): string[] {
    return Object.getOwnPropertyNames(proto).filter(
        name => name !== "constructor" && typeof (proto as Record<string, unknown>)[name] === "function"
    );
}

/** 实例能看到的方法名（含原型链上的），用于「对外可用」的判断 */
function visibleMethods(instance: object): Set<string> {
    const names = new Set<string>();
    let cursor: object | null = instance;
    while (cursor && cursor !== Object.prototype) {
        for (const name of methodNames(cursor)) names.add(name);
        cursor = Object.getPrototypeOf(cursor);
    }
    return names;
}

test("每个域的方法都真的混进了 NavigationClient 原型", () => {
    const proto = NavigationClient.prototype as unknown as Record<string, unknown>;
    for (const [domain, impl] of IMPLS) {
        const names = Object.keys(impl);
        assert.ok(names.length > 0, `${domain} 域的实现是空的（导出错了？）`);
        for (const name of names) {
            assert.equal(
                typeof proto[name],
                "function",
                `${domain}.${name} 没混进原型 —— 检查 client.ts 末尾的 mixin 列表`,
            );
        }
    }
});

test("留在类里的传输核心没有被搬丢", () => {
    const client = new NavigationClient("/api");
    for (const name of CORE_METHODS) {
        assert.equal(
            typeof (client as unknown as Record<string, unknown>)[name],
            "function",
            `${name} 应该留在 client.ts 的类里`,
        );
    }
    assert.equal(client.baseUrl, "/api");
    assert.equal(client.idempotencyKey, null);
});

test("没有两个域定义同名方法（后者会静默覆盖前者）", () => {
    const owner = new Map<string, string>();
    for (const [domain, impl] of IMPLS) {
        for (const name of Object.keys(impl)) {
            assert.ok(!owner.has(name), `${name} 同时出现在 ${owner.get(name)} 和 ${domain}`);
            owner.set(name, domain);
        }
    }
});

test("搬走的方法总数没有缩水", () => {
    const total = IMPLS.reduce((sum, [, impl]) => sum + Object.keys(impl).length, 0);
    assert.ok(
        total >= MOVED_METHOD_COUNT,
        `原型上只有 ${total} 个搬来的方法，拆分时是 ${MOVED_METHOD_COUNT} 个 —— 有方法在搬运中丢了`,
    );
});

// ---------------- 演示客户端与真客户端必须同形 ----------------
//
// 演示模式（Mock）是给「没后端也想看界面」的人用的，它一旦少一个方法，
// 用户点到的那一刻才炸，而本地跑 npm test 时没人点。这里在运行时把两边
// 的方法集合核一遍。
//
// 允许的差异写在下面，每一项都要写清理由 —— 想加一行先问自己：
// 「这个差异是真的合理，还是我懒得补 Mock？」

/**
 * Mock 独有、真客户端不需要的。
 *
 * 前六个是**服务端** NavigationAPI 的方法（幂等锁 / 版本快照），前端真客户端本来就没有；
 * Mock 之所以实现它们，是因为演示模式要自己模拟「写库」那一路的内部流程
 * （pushRevision 由 updateNote 调用）。留着无害，但别再往里加新的。
 */
const MOCK_ONLY_ALLOWED = new Set<string>([
    "aiUnavailable", // TS private，只是编译期私有、运行时仍在原型上；Mock 内部的统一失败返回
    "claimIdempotency",
    "completeIdempotency",
    "purgeExpiredIdempotency",
    "pushRevision",
    "readIdempotency",
    "releaseIdempotency",
]);

/** 真客户端独有、Mock 用不上的（目前为空：两侧必须完全对齐） */
const REAL_ONLY_ALLOWED = new Set<string>([]);

test("演示客户端与真客户端的方法集合一致（少一个就是演示模式里的 TypeError）", () => {
    const mock = visibleMethods(new MockNavigationClient());
    const real = visibleMethods(new NavigationClient("/api"));

    const mockOnly = [...mock].filter(n => !real.has(n)).sort();
    const realOnly = [...real].filter(n => !mock.has(n)).sort();

    assert.deepEqual(
        mockOnly.filter(n => !MOCK_ONLY_ALLOWED.has(n)),
        [],
        "Mock 有、真客户端没有的方法 —— 演示模式里能调到但真实环境会炸",
    );
    assert.deepEqual(
        realOnly.filter(n => !REAL_ONLY_ALLOWED.has(n)),
        [],
        "真客户端有、Mock 没有的方法 —— 演示模式点到这里会 TypeError（补进 src/API/mock.ts）",
    );
});

// ---------------- ClientThis：域方法体需要的那点 this ----------------
//
// `this` 写成最小接口是为了不被联合类型连锁炸（详见 transport.ts），
// 代价是「真客户端到底凑没凑齐这些成员」没人盯了。这里补上：
// 少一个，域方法体里 this.xxx 就是 undefined。
const CLIENT_THIS_MEMBERS: Array<keyof ClientThis> = [
    "baseUrl",
    "idempotencyKey",
    "request",
    "isLoggedIn",
    "clearToken",
    "setSessionCookie",
    "getConfigs",
    "getConfig",
    "setConfig",
];

test("真客户端凑齐了 ClientThis 要求的全部成员", () => {
    const client = new NavigationClient("/api") as unknown as Record<string, unknown>;
    for (const name of CLIENT_THIS_MEMBERS) {
        assert.notEqual(
            client[name],
            undefined,
            `NavigationClient 缺 ${name} —— 域方法体里 this.${name} 会是 undefined`,
        );
    }
});

test("演示客户端同样凑齐了 ClientThis（否则联合类型调用点会炸）", () => {
    const mock = new MockNavigationClient() as unknown as Record<string, unknown>;
    for (const name of CLIENT_THIS_MEMBERS) {
        assert.notEqual(
            mock[name],
            undefined,
            `MockNavigationClient 缺 ${name} —— 联合类型下 this.${name} 会是 undefined`,
        );
    }
});
