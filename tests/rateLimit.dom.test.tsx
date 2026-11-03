// tests/rateLimit.dom.test.tsx
// 429「稍后再来」这条链路的两半：
//   · client（纯传输层）读 `Retry-After` → 塞进 ApiError.retryAfter → 广播 RATE_LIMITED_EVENT；
//   · RateLimitBanner 订阅事件 → 按秒倒计时显示 → 到 0 自己消失。
//
// 为什么值得钉住：服务端六七处 429 早就把 `Retry-After` 回了，客户端却读完就丢，
// 界面永远只有一句「操作过于频繁」。这类「服务端给了、前端不用」的缺口不会报错、
// 不会让任何测试变红 —— 用户只会反复点、反复撞同一堵墙（限流窗口还因此被续期）。
//
// ⚠️ 两个最容易写反的地方：
//   1) 没有 `Retry-After` 时**不能**编一个数字出来。0 会让提示条瞬间消失（等于没做），
//      猜一个值则是在骗用户「再等 30 秒就好了」。认不出就是 undefined。
//   2) 连续两次 429 时倒计时取**更晚**的那个终点。直接覆盖会让服务端给的短窗口
//      把「其实还要等 30 秒」缩成「5 秒」，用户提前重试又撞一堵墙。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NavigationClient } from "../src/API/client";
import { RATE_LIMITED_EVENT, type RateLimitedDetail } from "../src/API/transport";
import { ApiError } from "../src/API/apiError";
import RateLimitBanner from "../src/components/RateLimitBanner";

// ---------------- 假响应 / 假 fetch ----------------

/** 只实现 client 用到的那一个方法：Headers.get（大小写不敏感，与真 Headers 一致） */
interface FakeHeaders {
    get(name: string): string | null;
}

interface FakeResponse {
    ok: boolean;
    status: number;
    headers?: FakeHeaders;
    json: () => Promise<unknown>;
}

function headersWith(map: Record<string, string>): FakeHeaders {
    return {
        get: (name: string) => {
            const wanted = name.toLowerCase();
            for (const [key, value] of Object.entries(map)) {
                if (key.toLowerCase() === wanted) return value;
            }
            return null;
        },
    };
}

let calls = 0;
let responder: () => FakeResponse = () => rateLimited("30");

/** 429 响应。retryAfter 为 undefined 表示「服务端没给这个头」 */
function rateLimited(retryAfter?: string): FakeResponse {
    return {
        ok: false,
        status: 429,
        ...(retryAfter === undefined ? {} : { headers: headersWith({ "Retry-After": retryAfter }) }),
        json: async () => ({
            error: { code: "rate_limited", message: "操作过于频繁，请 30 秒后再试" },
        }),
    };
}

function installFetch(): void {
    globalThis.fetch = (async () => {
        calls += 1;
        return responder();
    }) as unknown as typeof fetch;
}

// ---------------- 事件计数 ----------------

let rateEvents: number[] = [];

// 计数监听器只装一次（整个文件是同一个 jsdom 实例），计数在 beforeEach 里重置
window.addEventListener(RATE_LIMITED_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<RateLimitedDetail>).detail;
    rateEvents.push(detail.retryAfter);
});

beforeEach(() => {
    calls = 0;
    rateEvents = [];
    responder = () => rateLimited("30");
    installFetch();
});

/** 跑一次请求，断言它抛的是 ApiError，然后把它交回来 */
async function expectApiError(run: () => Promise<unknown>): Promise<ApiError> {
    let caught: unknown;
    try {
        await run();
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof ApiError, `抛出来的不是 ApiError，实际：${String(caught)}`);
    return caught;
}

// ---------------- client：读头、带出来、广播 ----------------

test("429 + Retry-After: 30 → ApiError 带出 retryAfter=30，并广播一次", async () => {
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.equal(calls, 1, "前置条件：请求要真的发出去");
    assert.equal(err.status, 429);
    assert.equal(err.code, "rate_limited", "code 要能从服务端 envelope 里取出来");
    assert.equal(
        err.retryAfter,
        30,
        "Retry-After 的秒数必须带到 ApiError 上 —— 这是界面倒计时的唯一权威来源"
    );
    assert.deepEqual(
        rateEvents,
        [30],
        `应当广播一次带 30 秒的限流事件，实际 ${JSON.stringify(rateEvents)}`
    );
});

test("429 没有 Retry-After → retryAfter 是 undefined，且不广播", async () => {
    responder = () => rateLimited(undefined);
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.equal(err.status, 429);
    assert.equal(
        err.retryAfter,
        undefined,
        "没有这个头就必须留空 —— 0 会让提示条瞬间消失，猜的值等于骗用户"
    );
    assert.deepEqual(
        rateEvents,
        [],
        "没有秒数就没有倒计时可显示，不该广播（通用 toast 已经把那句话说过了）"
    );
});

test("Retry-After 是 HTTP-date 时也认（服务端中间隔着代理，形状可能变）", async () => {
    responder = () => rateLimited(new Date(Date.now() + 30_000).toUTCString());
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.ok(
        typeof err.retryAfter === "number" && err.retryAfter >= 28 && err.retryAfter <= 31,
        `HTTP-date 应换算成剩余秒数（约 30），实际：${String(err.retryAfter)}`
    );
});

test("Retry-After 是过去的 HTTP-date → 规整为 0（现在就能重试），不出负数", async () => {
    responder = () => rateLimited(new Date(Date.now() - 60_000).toUTCString());
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.equal(err.retryAfter, 0, "过去的日期给 0，别返回负数让界面算出「还剩 -60 秒」");
});

test("Retry-After 是乱码 → 认不出就留空，不瞎猜", async () => {
    responder = () => rateLimited("soon");
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.equal(err.retryAfter, undefined);
    assert.deepEqual(rateEvents, []);
});

test("非 429（500）带 Retry-After：不广播，但头不丢（防御其它状态码）", async () => {
    responder = () => ({
        ok: false,
        status: 500,
        headers: headersWith({ "Retry-After": "12" }),
        json: async () => ({ message: "服务端炸了" }),
    });
    const api = new NavigationClient("/api");

    const err = await expectApiError(() => api.request("ping"));

    assert.equal(err.status, 500);
    assert.equal(err.retryAfter, 12, "其它状态码若带该头，也不该在传输层被吃掉");
    assert.deepEqual(rateEvents, [], "限流提示条只该由 429 触发，500 不该弹它");
});

// ---------------- 组件：倒计时 / 不缩短 / 自己消失 ----------------

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mountBanner(): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<RateLimitBanner />));
}

function unmountBanner(): void {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const bodyText = () => document.body.textContent || "";

/** 广播一次限流（模拟 client 撞到 429 之后做的事） */
async function fireRateLimited(retryAfter: number): Promise<void> {
    await act(async () => {
        window.dispatchEvent(
            new CustomEvent<RateLimitedDetail>(RATE_LIMITED_EVENT, { detail: { retryAfter } })
        );
        await Promise.resolve();
    });
}

test("RateLimitBanner：没有限流事件时什么都不渲染（常驻挂载不占位）", () => {
    mountBanner();
    try {
        assert.equal(bodyText().trim(), "", "默认必须是 null —— 否则首屏多一条空提示条");
    } finally {
        unmountBanner();
    }
});

test("RateLimitBanner：收到事件后按秒显示，且不缩短已有倒计时", async () => {
    mountBanner();
    try {
        await fireRateLimited(30);
        assert.ok(
            bodyText().includes("操作过于频繁，请 30 秒后再试"),
            `应当显示倒计时文案，实际：${bodyText()}`
        );

        // 倒计时中途又撞一次，服务端给的是更短的窗口 —— 不能把「还要等 30 秒」缩成 5 秒
        await fireRateLimited(5);
        assert.ok(
            bodyText().includes("操作过于频繁，请 30 秒后再试"),
            `更短的窗口不该缩短已有倒计时，实际：${bodyText()}`
        );
    } finally {
        unmountBanner();
    }
});

test("RateLimitBanner：retryAfter 为 0 时忽略（0 秒的提示条只会闪一下）", async () => {
    mountBanner();
    try {
        await fireRateLimited(0);
        assert.equal(bodyText().trim(), "", "0 秒不该弹提示条");
    } finally {
        unmountBanner();
    }
});

test("RateLimitBanner：倒计时归零后自己消失，不留残影", async () => {
    mountBanner();
    try {
        await fireRateLimited(1);
        assert.ok(bodyText().includes("操作过于频繁"), "前置条件：先显示出来");

        // 1 秒间隔的定时器 + 1.1 秒真实等待：到点后 remaining 归零、组件渲染 null
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 1100));
        });
        assert.equal(
            bodyText().trim(),
            "",
            "倒计时到 0 就该自己消失 —— 留着一条「请 0 秒后再试」比不显示更让人困惑"
        );
    } finally {
        unmountBanner();
    }
});
