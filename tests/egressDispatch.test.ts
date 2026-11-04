// tests/egressDispatch.test.ts
// R06「DNS 检查/连接分离」的单测。
//
// 覆盖两件事：
//   1) createValidatingLookup —— 校验与连接用同一份解析结果的那道闸（纯函数，全注入）
//   2) installEgressDispatcher + safeFetch 的 setFetchImpl 注入链
//
// 全部用假 lookup / 假 isBlocked / 假 undici 模块：不查真 DNS、不建真连接、不依赖网络。
// 真实的「可变 DNS 环境下端到端验收」是环境门槛，这里**不**声称验过。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createValidatingLookup,
    installEgressDispatcher,
    type ConnectLookup,
    type LookupEntry,
} from "../server/egressDispatch";
import { safeFetch, setEgressResolver, setFetchImpl } from "../worker/safeFetch";

/** 一次 lookup 回调的现场 */
interface LookupCallbackRecord {
    error: Error | null;
    address: string | readonly LookupEntry[] | undefined;
    family: number | undefined;
}

/**
 * 调一次 ConnectLookup 并把回调摊平。
 * `records` 收集**所有**回调调用 —— 「拒绝时有没有偷偷退化成连剩下的」就靠它断言。
 */
function invokeLookup(
    lookup: ConnectLookup,
    hostname: string,
    options: { all?: boolean; family?: number }
): { first: Promise<LookupCallbackRecord>; records: LookupCallbackRecord[] } {
    const records: LookupCallbackRecord[] = [];
    const first = new Promise<LookupCallbackRecord>(resolve => {
        lookup(hostname, options, (error, address, family) => {
            const record: LookupCallbackRecord = {
                error: error ?? null,
                address,
                family,
            };
            records.push(record);
            resolve(record);
        });
    });
    return { first, records };
}

/** 让「可能被多调一次」的回调都冒出来（过滤后继续连剩下的那种错误实现会多调一次） */
function flushCallbacks(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}

/** 假解析器：固定返回给定结果（或抛给定错误） */
function fakeLookup(rows: readonly LookupEntry[] | Error) {
    return async (_hostname: string, _options: { all: true; verbatim: true }) => {
        if (rows instanceof Error) throw rows;
        return rows;
    };
}

const PUBLIC_V4: LookupEntry = { address: "93.184.216.34", family: 4 };
const PUBLIC_V4_B: LookupEntry = { address: "93.184.216.35", family: 4 };
const PUBLIC_V6: LookupEntry = { address: "2606:4700:4700::1111", family: 6 };
const PRIVATE: LookupEntry = { address: "10.0.0.7", family: 4 };

/** 只把 10./127./192.168. 当内网的最小判据（真实现是 worker/util 的 isBlockedHost） */
function fakeIsBlocked(address: string): boolean {
    return /^(10\.|127\.|192\.168\.)/.test(address);
}

// ============ createValidatingLookup ============

test("all 模式：回调收到完整地址数组", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V4, PUBLIC_V6]),
        isBlocked: fakeIsBlocked,
    });
    const { first, records } = invokeLookup(lookup, "example.com", { all: true });

    const record = await first;
    assert.equal(record.error, null);
    assert.deepEqual(record.address, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
    ]);
    assert.equal(records.length, 1);
});

test("单模式：回调收到 (address, family) 而不是数组", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V4, PUBLIC_V4_B]),
        isBlocked: fakeIsBlocked,
    });
    const { first, records } = invokeLookup(lookup, "example.com", {});

    const record = await first;
    assert.equal(record.error, null);
    assert.equal(record.address, "93.184.216.34");
    assert.equal(record.family, 4);
    assert.equal(records.length, 1);
});

test("单模式：调用方约定了 family=6 时优先挑 IPv6", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V4, PUBLIC_V6]),
        isBlocked: fakeIsBlocked,
    });
    const record = await invokeLookup(lookup, "example.com", { family: 6 }).first;
    assert.equal(record.error, null);
    assert.equal(record.address, "2606:4700:4700::1111");
    assert.equal(record.family, 6);
});

test("单模式：约定的 family 一条都没有 → 拒绝（不拿别的 family 顶上）", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V4]),
        isBlocked: fakeIsBlocked,
    });
    const record = await invokeLookup(lookup, "example.com", { family: 6 }).first;
    assert.ok(record.error instanceof Error);
    assert.match(record.error.message, /没有 IPv6 地址/);
});

test("IPv6 地址的 family 6 原样透传（all 模式）", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V6]),
        isBlocked: fakeIsBlocked,
    });
    const record = await invokeLookup(lookup, "v6.example.com", { all: true }).first;
    assert.equal(record.error, null);
    assert.deepEqual(record.address, [{ address: "2606:4700:4700::1111", family: 6 }]);
});

test("全部公网 → 放行", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6]),
        isBlocked: fakeIsBlocked,
    });
    const record = await invokeLookup(lookup, "example.com", { all: true }).first;
    assert.equal(record.error, null);
    assert.equal((record.address as readonly LookupEntry[]).length, 3);
});

test("多地址里混一个内网 → 拒绝整次连接，且不退化成「连剩下的」", async () => {
    const lookup = createValidatingLookup({
        // 公网地址排在前面：先放行的那条绝不能成为实际连接目标
        lookup: fakeLookup([PUBLIC_V4, PRIVATE]),
        isBlocked: fakeIsBlocked,
    });
    const { first, records } = invokeLookup(lookup, "rebind.example.com", { all: true });
    const record = await first;
    await flushCallbacks();

    assert.ok(record.error instanceof Error, "必须回调 error");
    assert.equal(record.address, undefined, "拒绝时不能回地址");
    // 回调只被调一次 = 没有「过滤掉内网、把剩下的交出去」这条退路
    assert.equal(records.length, 1, "回调只能被调用一次（不得退化成连剩下的）");
    // 报错带 hostname 与命中的那一条 IP
    assert.match(record.error.message, /rebind\.example\.com/);
    assert.match(record.error.message, /10\.0\.0\.7/);
    // 但**不**把整份解析结果 dump 出来（公网那条不该出现在报错里）
    assert.ok(
        !record.error.message.includes("93.184.216.34"),
        "报错里不应出现未被命中的公网地址"
    );
});

test("单模式下混一个内网也照样拒绝", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([PRIVATE, PUBLIC_V4]),
        isBlocked: fakeIsBlocked,
    });
    const { first, records } = invokeLookup(lookup, "rebind2.example.com", {});
    const record = await first;
    await flushCallbacks();

    assert.ok(record.error instanceof Error);
    assert.equal(record.address, undefined);
    assert.equal(records.length, 1);
});

test("DNS 失败 → 错误原样透传（fail-closed，不退回放行）", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo ENOTFOUND nx.example.com"), {
        code: "ENOTFOUND",
    });
    const lookup = createValidatingLookup({
        lookup: fakeLookup(dnsError),
        isBlocked: fakeIsBlocked,
    });
    const { first, records } = invokeLookup(lookup, "nx.example.com", { all: true });
    const record = await first;
    await flushCallbacks();

    assert.equal(record.error, dnsError, "同一个错误对象原样透传");
    assert.equal(record.address, undefined);
    assert.equal(records.length, 1);
});

test("解析返回空数组 → 拒绝（不让「查不到结果」变成放行）", async () => {
    const lookup = createValidatingLookup({
        lookup: fakeLookup([]),
        isBlocked: fakeIsBlocked,
    });
    const record = await invokeLookup(lookup, "empty.example.com", { all: true }).first;
    assert.ok(record.error instanceof Error);
    assert.match(record.error.message, /没有返回任何地址/);
});

// ============ installEgressDispatcher ============

/** 假的 undici 模块：记录 Agent 的构造参数与 fetch 调用 */
function makeFakeUndici() {
    const agentOptions: { connect?: { lookup?: ConnectLookup } }[] = [];
    const fetchCalls: { input: string; init?: Record<string, unknown> }[] = [];
    class FakeAgent {
        constructor(options?: { connect?: { lookup?: ConnectLookup } }) {
            agentOptions.push(options ?? {});
        }
    }
    const mod = {
        Agent: FakeAgent,
        fetch: async (input: string, init?: Record<string, unknown>) => {
            fetchCalls.push({ input, init });
            return new Response("undici-ok", { status: 200 });
        },
    };
    return { mod, agentOptions, fetchCalls };
}

test("installEgressDispatcher：undici 加载失败 → {installed:false}，不抛、不注入", async () => {
    const warnings: string[] = [];
    const injected: unknown[] = [];
    const result = await installEgressDispatcher({
        setFetchImpl: fn => injected.push(fn),
        logger: { warn: message => warnings.push(message) },
        loadUndici: async () => {
            throw new Error("Cannot find package 'undici'");
        },
    });

    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /undici 加载失败/);
    assert.match(result.reason ?? "", /Cannot find package/);
    assert.deepEqual(injected, [], "失败时不注册 fetch 实现（保持全局 fetch）");
    assert.equal(warnings.length, 1, "失败要留一条 warn");
});

test("installEgressDispatcher：模块形状不对（缺 Agent）→ {installed:false}", async () => {
    const result = await installEgressDispatcher({
        setFetchImpl: () => undefined,
        logger: { warn: () => undefined },
        loadUndici: async () => ({ fetch: async () => new Response("x") }),
    });
    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /缺少 Agent\/fetch/);
});

test("installEgressDispatcher：Agent 建不起来 → {installed:false}", async () => {
    const result = await installEgressDispatcher({
        setFetchImpl: () => undefined,
        logger: { warn: () => undefined },
        loadUndici: async () => ({
            Agent: class {
                constructor() {
                    throw new Error("boom");
                }
            },
            fetch: async () => new Response("x"),
        }),
    });
    assert.equal(result.installed, false);
    assert.match(result.reason ?? "", /Agent 创建失败/);
});

test("installEgressDispatcher：成功时把「校验 lookup + undici.fetch」注册进 safeFetch", async () => {
    const fake = makeFakeUndici();
    const lookupRows: readonly LookupEntry[] = [PUBLIC_V4];
    let injected: ((input: string, init?: RequestInit) => Promise<Response>) | null = null;

    const result = await installEgressDispatcher({
        setFetchImpl: fn => {
            injected = fn;
        },
        logger: { warn: () => undefined },
        loadUndici: async () => fake.mod,
        lookup: fakeLookup(lookupRows),
        isBlocked: fakeIsBlocked,
    });

    assert.equal(result.installed, true);
    assert.equal(fake.agentOptions.length, 1, "只建一个 Agent");
    assert.equal(typeof fake.agentOptions[0]?.connect?.lookup, "function", "connect.lookup 已就位");
    assert.ok(injected, "setFetchImpl 被调用");

    const impl = injected as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    const response = await impl("https://example.com/a", { method: "GET" });
    assert.equal(await response.text(), "undici-ok");
    assert.equal(fake.fetchCalls.length, 1);
    assert.equal(fake.fetchCalls[0].input, "https://example.com/a");
    assert.ok(
        (fake.fetchCalls[0].init as { dispatcher?: unknown }).dispatcher,
        "必须把 Agent 作为 dispatcher 传给 undici.fetch"
    );
    assert.equal((fake.fetchCalls[0].init as { method?: string }).method, "GET");
});

// ============ safeFetch 走注入实现 ============

test("setFetchImpl 注入后 safeFetch 真的走注入实现（且正常路径仍工作）", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    setFetchImpl(async (input, init) => {
        calls.push({ input, init });
        return new Response("<html><title>hi</title></html>", { status: 200 });
    });
    try {
        const result = await safeFetch(new URL("https://example.com/page"), {
            headers: { "user-agent": "navihive-test" },
        });
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.equal(await result.response.text(), "<html><title>hi</title></html>");
        }
        assert.equal(calls.length, 1, "全局 fetch 不该被用到");
        assert.equal(calls[0].input, "https://example.com/page");
        assert.equal(calls[0].init?.method, "GET");
        assert.equal(calls[0].init?.redirect, "manual");
        assert.equal(
            (calls[0].init?.headers as Record<string, string>)["user-agent"],
            "navihive-test",
            "headers 原样透传给注入实现"
        );
        assert.ok(calls[0].init?.signal, "单跳超时照旧带上");
    } finally {
        setFetchImpl(null);
    }
});

test("注入实现覆盖每一跳重定向（不是只覆盖第一跳）", async () => {
    const calls: string[] = [];
    setFetchImpl(async input => {
        calls.push(input);
        // 第一跳 302 到另一个公网主机，第二跳 200
        if (input === "https://example.com/start") {
            return new Response("", {
                status: 302,
                headers: { location: "https://cdn.example.net/final" },
            });
        }
        return new Response("done", { status: 200 });
    });
    try {
        const result = await safeFetch(new URL("https://example.com/start"), {
            headers: { authorization: "Bearer secret" },
        });
        assert.equal(result.ok, true);
        assert.deepEqual(calls, [
            "https://example.com/start",
            "https://cdn.example.net/final",
        ]);
    } finally {
        setFetchImpl(null);
    }
});

test("注入实现抛错时 safeFetch 仍归一化成 timeout 结果", async () => {
    setFetchImpl(async () => {
        throw new Error("boom");
    });
    try {
        const result = await safeFetch(new URL("https://example.com/x"));
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.kind, "timeout");
            assert.equal(result.status, 502);
        }
    } finally {
        setFetchImpl(null);
    }
});

test("setFetchImpl(null) 之后回到全局 fetch（行为零变化）", async () => {
    const original = globalThis.fetch;
    const stubCalls: string[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
        stubCalls.push(String(input));
        return new Response("global", { status: 200 });
    }) as unknown as typeof fetch;
    try {
        const result = await safeFetch(new URL("https://example.com/global"));
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(await result.response.text(), "global");
        assert.deepEqual(stubCalls, ["https://example.com/global"]);
    } finally {
        (globalThis as { fetch: typeof fetch }).fetch = original;
        setFetchImpl(null);
    }
});

test("注入后出站复核（egressResolver）仍然先拦一道", async () => {
    let fetched = 0;
    setFetchImpl(async () => {
        fetched += 1;
        return new Response("should-not-happen", { status: 200 });
    });
    setEgressResolver(async hostname => hostname !== "rebind.example.com");
    try {
        const result = await safeFetch(new URL("https://rebind.example.com/"));
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.kind, "blocked");
        assert.equal(fetched, 0, "被复核拦下就不该发请求");
    } finally {
        setEgressResolver(null);
        setFetchImpl(null);
    }
});
