// tests/clientUnauthorized.dom.test.tsx
// 「任意接口撞 401 都要把用户送回登录页」这条链路的传输层一半。
//
// 背景：以前「回登录页」只接在 bootstrap 那一条链路上。令牌过期后用户点任何按钮，
// 都只弹同一句 toast、界面停在原地 —— 用户以为是自己点错了，实际是会话没了。
// 现在的分工是：
//   · client（纯传输层）撞 401 → 清本地标记 + 广播 UNAUTHORIZED_EVENT + 照常 throw；
//   · App 那层监听事件 → handleAuthFailure（用 authRequiredRef 做幂等，已在登录页就 return）。
//
// 这个文件只钉 client 这一半，**不测去重**：client 广播几次就几次，
// 去重是 App 的职责。两边混在一起测，最容易出的错是把「同一次请求里并发两个 401」
// 写成只广播一次 —— 那等于让 client 假装知道 UI 状态。
//
// ⚠️ 断言里最容易被写反的是 500：它**不该**广播。写成「任何非 2xx 都广播」的话，
// 服务端一次 500 就能把全站用户踢回登录页，而他们的令牌明明是好的。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NavigationClient } from "../src/API/client";
import { UNAUTHORIZED_EVENT } from "../src/API/transport";
import { ApiError } from "../src/API/apiError";

interface Captured {
    url: string;
    init: RequestInit;
}

let calls: Captured[] = [];
let responder: () => { ok: boolean; status: number; json: () => Promise<unknown> };
let events = 0;

/**
 * 计数监听器只装一次（window 在整个文件里是同一个 jsdom 实例），
 * 计数在 beforeEach 里归零 —— 比起每条用例自己 add/remove，少了「忘 remove 导致串数」的机会。
 */
window.addEventListener(UNAUTHORIZED_EVENT, () => {
    events += 1;
});

/** 装一个假 fetch：记录每次调用，按 responder 返回（照抄 tests/apiClient.dom.test.tsx） */
function installFetch() {
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return responder();
    }) as unknown as typeof fetch;
}

/** 服务端返回了 JSON 错误体。⚠️ 故意不给 headers：替身本来就没有，client 已用 ?. 兜住 */
const errJson = (payload: unknown, status: number) => ({
    ok: false,
    status,
    json: async () => payload,
});

beforeEach(() => {
    calls = [];
    events = 0;
    responder = () => errJson({ message: "认证已过期" }, 401);
    installFetch();
});

// ---------- 401 必须广播 ----------

test("任意接口撞 401 时广播一次 UNAUTHORIZED_EVENT，且异常照常向上抛", async () => {
    const api = new NavigationClient("/api");

    await assert.rejects(
        () => api.getConfigs(),
        (error: unknown) => {
            // 广播不能把异常吞掉：调用点的 try/catch / 离线队列全靠这个 throw 才知道失败了。
            // 一旦有人为了「让界面别再报错」把它包成 resolve，界面上就是「按钮点了没反应」。
            assert.ok(
                error instanceof ApiError,
                `抛出来的不是 ApiError，实际：${String(error)}`
            );
            assert.equal((error as ApiError).status, 401, "状态码要带出来，界面靠它区分认证失败");
            return true;
        }
    );

    assert.equal(
        events,
        1,
        `401 只广播了 ${events} 次 —— 0 次意味着用户被卡在原地，2 次意味着重试链路会重复触发`
    );
});

test("非 401 的错误（500）不广播：别把令牌好好的用户踢下线", async () => {
    responder = () => errJson({ message: "服务端炸了" }, 500);
    const api = new NavigationClient("/api");

    await assert.rejects(() => api.getConfigs(), /服务端炸了/);

    assert.equal(
        events,
        0,
        `500 也广播了 ${events} 次 —— 服务端偶发 500 会把全站用户踢回登录页，而他们的会话是好的`
    );
});

// ---------- 并发：client 不做去重 ----------

test("同一次流程里并发两个 401 请求，就广播两次", async () => {
    const api = new NavigationClient("/api");

    // 首屏同时发好几个请求是常态。这里要钉住「client 不做去重」：
    // 去重靠 App 的 authRequiredRef（已在登录页就 return）。若 client 自己压成一次，
    // 那 App 那层的幂等就永远测不到、也没意义了。
    const results = await Promise.allSettled([api.getConfigs(), api.getConfigs()]);

    assert.equal(calls.length, 2, "前置条件：两个请求都得真的发出去");
    assert.equal(
        results.filter(r => r.status === "rejected").length,
        2,
        "两个请求都该 reject —— 广播不能把任何一个的异常吞掉"
    );
    assert.equal(
        events,
        2,
        `并发两个 401 只广播了 ${events} 次 —— 去重是 App 那层的事，client 层压掉就分不清职责了`
    );
});
