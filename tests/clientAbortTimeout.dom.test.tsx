// tests/clientAbortTimeout.dom.test.tsx
// 首屏误报「加载数据失败: The user aborted a request.」的传输层根因守卫（2026-11）。
//
// 链路：bootstrap() 用 timeoutMs:10_000 → client.request() 里 AbortSignal.timeout()；
// Chromium 下它中止时 fetch 抛的是 name=AbortError、message="The user aborted a request."
// 的 DOMException。老 catch 只认 `instanceof Error && name === "TimeoutError"`，于是原文
// 一路冒到 useSites 的 onError → 红色 toast + 假的 load-error 审计。
//
// 这里钉两件事：
//   1. 我们自己创建的 timeout signal 触发的 AbortError / TimeoutError 一律翻成
//      ApiError(request_timeout) + 中文超时文案；
//   2. 外部 options.signal 主动取消（组件卸载 / 切换）**绝不**被当成超时 ——
//      哪怕内部 timeoutSignal 那一刻也恰好 aborted。
// 再加一组静态正则守卫，把「关键判定」钉在源码上，防止以后被顺手改回去。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NavigationClient } from "../src/API/client";
import { ApiError } from "../src/API/apiError";

const here = dirname(fileURLToPath(import.meta.url));
/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找仓库里的真身 */
function readProjectFile(rel: string): string {
    for (let dir = here, i = 0; i < 6; i++) {
        try {
            return readFileSync(resolve(dir, rel), "utf8");
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error(`找不到 ${rel}`);
}

const originalFetch = globalThis.fetch;
const signalCtor = AbortSignal as unknown as { timeout: (ms: number) => AbortSignal };
const originalTimeout = signalCtor.timeout;

/** reason 故意不是 Error 实例：Chromium 抛的是 DOMException，判据不能靠 instanceof Error */
function domAbortReason(message = "The user aborted a request."): { name: string; message: string } {
    return { name: "AbortError", message };
}

/** 让内部 AbortSignal.timeout() 当场就处于 aborted 状态，并带上指定 reason */
function stubInternalTimeout(reason: unknown): void {
    signalCtor.timeout = () => {
        const controller = new AbortController();
        controller.abort(reason);
        return controller.signal;
    };
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    signalCtor.timeout = originalTimeout;
});

// ---------- 行为：内部超时 / 外部取消的区分 ----------

test("内部 timeout signal 触发的 AbortError → request_timeout + 中文超时文案", async () => {
    const reason = domAbortReason();
    stubInternalTimeout(reason);
    // 真 fetch 被 signal 中止时抛的就是 signal.reason，这里按这个形状喂回去
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
        throw init?.signal?.reason ?? reason;
    }) as unknown as typeof fetch;

    const api = new NavigationClient("/api");
    let caught: unknown;
    try {
        await api.request("bootstrap?full=1", { timeoutMs: 10_000 });
    } catch (error) {
        caught = error;
    }

    assert.ok(caught instanceof ApiError, `应翻译成 ApiError，实际：${String(caught)}`);
    const err = caught as ApiError;
    assert.equal(err.code, "request_timeout");
    assert.equal(err.status, 0);
    assert.match(err.message, /请求超时（10 秒无响应），请检查网络后重试/);
    assert.ok(
        !err.message.includes("The user aborted a request."),
        "⛔ 不能把 Chromium 的英文原文冒到 UI / 审计"
    );
});

test("标准 TimeoutError 仍被翻译成 request_timeout（原有行为不变）", async () => {
    const reason = { name: "TimeoutError", message: "The operation was aborted due to timeout" };
    stubInternalTimeout(reason);
    globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
        throw init?.signal?.reason ?? reason;
    }) as unknown as typeof fetch;

    const api = new NavigationClient("/api");
    await assert.rejects(
        () => api.request("bootstrap?full=1", { timeoutMs: 10_000 }),
        (error: unknown) =>
            error instanceof ApiError &&
            error.code === "request_timeout" &&
            /请求超时（10 秒无响应）/.test(error.message),
        "TimeoutError 必须仍走中文超时文案"
    );
});

test("外部 signal 主动取消原样抛：即使内部 timeoutSignal 也已 aborted，也不翻译成超时", async () => {
    // 最坏情况：两份 signal 都 aborted。判据必须靠「这次请求用的是不是内部 signal」区分。
    stubInternalTimeout(domAbortReason("内部超时"));
    const reason = domAbortReason("组件卸载，取消请求");
    const controller = new AbortController();
    globalThis.fetch = (async () => {
        controller.abort(reason);
        throw reason;
    }) as unknown as typeof fetch;

    const api = new NavigationClient("/api");
    let caught: unknown;
    try {
        await api.request("bootstrap?full=1", { signal: controller.signal, timeoutMs: 10_000 });
    } catch (error) {
        caught = error;
    }

    assert.equal(caught, reason, "外部取消要原样抛，不能包成 ApiError");
    assert.ok(!(caught instanceof ApiError), "⛔ 普通取消绝不能生成误导性的「请求超时」");
    assert.equal((caught as { name?: string }).name, "AbortError");
    assert.ok(
        !JSON.stringify(caught).includes("请求超时"),
        "⛔ 不能出现任何超时提示文案"
    );
});

test("真实网络错误（TypeError: fetch failed）原样抛，不伪装成超时", async () => {
    // timeoutMs:0 = 不设内部超时，排除定时器干扰
    globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const api = new NavigationClient("/api");
    await assert.rejects(
        () => api.request("bootstrap?full=1", { timeoutMs: 0 }),
        (error: unknown) => error instanceof TypeError && !(error instanceof ApiError),
        "断网 / 网络错误要保持原样，不能被吞成超时"
    );
});

// ---------- 静态正则守卫：把关键判定钉在源码上 ----------

test("client.ts：内部 timeoutSignal 单独留引用，AbortError 判定限定为「自建 signal + 无外部 signal」", () => {
    const src = readProjectFile("src/API/client.ts");
    assert.match(src, /const timeoutSignal = timeoutMs > 0 \? AbortSignal\.timeout\(timeoutMs\) : null;/u);
    assert.match(src, /const signal = options\.signal \?\? timeoutSignal \?\? undefined;/u);
    assert.match(src, /name === "AbortError"/u);
    assert.match(src, /timeoutSignal !== null/u);
    assert.match(src, /timeoutSignal\.aborted/u);
    assert.match(src, /options\.signal === undefined/u, "外部 signal 的排除条件不能丢");
    assert.match(src, /name === "TimeoutError"/u);
    assert.match(src, /code: "request_timeout"/u);
    assert.match(src, /请求超时（/u);
    // 不能退回「只认 instanceof Error」的老写法（DOMException 不一定是 Error 实例）
    assert.ok(
        !/error instanceof Error && error\.name === "TimeoutError"/u.test(src),
        "⛔ 别把 name 判据重新塞回 instanceof Error 里"
    );
});

test("useSites.ts：自愈判定存在、toast 被挡住、序号闸门与真失败出口都还在", () => {
    const src = readProjectFile("src/hooks/useSites.ts");
    assert.match(src, /function isSelfHealingTransportError/u);
    assert.match(src, /e\.code === "request_timeout"/u);
    assert.match(src, /name === "TimeoutError"/u);
    assert.match(src, /name === "AbortError"/u);
    assert.match(src, /The user aborted a request/u);
    assert.match(src, /The operation was aborted/u);
    assert.match(
        src,
        /if \(!selfHealing\) depsRef\.current\.onError\("加载数据失败: " \+ message\)/u,
        "⛔ 自愈类错误不能直接拼「加载数据失败」toast"
    );
    assert.match(src, /groupsRef\.current\.length === 0/u, "已有数据时不报硬错的判据要保留");
    assert.match(src, /if \(seq !== requestSeqRef\.current\) return false/u, "序号过期静默丢弃要保留");
    assert.match(src, /setError\(message\)/u, "真失败仍要保留错误面板 / 重试路径");
});

test("App.tsx：真实加载失败的 load-error 归类不变（不做防御性改动，出口已在 A/B 堵住）", () => {
    const src = readProjectFile("src/App.tsx");
    assert.match(
        src,
        /errorMessage\.startsWith\("加载数据失败"\) \? "load-error" : "save-error"/u,
        "别为了消掉误报削弱真实加载失败的分类"
    );
});
