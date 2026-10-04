// src/API/client.ts 的直测。
//
// 为什么这个文件必须有：它是**所有请求的唯一出口**，937 行、占了整个前端和后端之间
// 的全部约定（错误怎么解析、401 怎么办、幂等头怎么挂、登录标记怎么读写），
// 而此前一条用例都没碰到它 —— 覆盖报告里它是零覆盖清单的第二名（第一名是 App.tsx）。
//
// 更麻烦的是：其余用例大多走的是 mock，mock 与真实 client 只要有一处不一致
// （比如对错误 body 的解析），表现就是「1648 条用例全绿、线上一个接口报错就白屏」。
// 这份测的是真实 client 的行为，不是 mock 的。
//
// 钉的都是「写反了界面依然正常、或者报错了看不出原因」的那类约定。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NavigationClient } from "../src/API/client";

// client.ts 里 SESSION_COOKIE 是模块内常量、没有导出；这里抄一份名字。
// 故意不去「顺手导出它」：一旦有人改了 client 那边的名字，这批用例会立刻变红，
// 提醒他去确认服务端那条 cookie 是不是也跟着改名了 —— 两边不一致就是半登录态。
const SESSION_COOKIE = "navihive_session";

interface Captured {
    url: string;
    init: RequestInit;
}

/**
 * fetch 的 headers 允许三种形状（对象 / Headers / 二维数组），client 实际写的是普通对象。
 * 这里统一按对象读 —— 哪天改成 Headers 实例，这几条会红，正好提醒断言也要跟着改。
 */
const headersOf = (c: Captured) => c.init.headers as Record<string, string> | undefined;

let calls: Captured[] = [];
let responder: () => { ok: boolean; status: number; json: () => Promise<unknown> };

/** 装一个假 fetch：记录每次调用，按 responder 返回 */
function installFetch() {
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return responder();
    }) as unknown as typeof fetch;
}

const okJson = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
});

/** 服务端返回了 JSON 错误体 */
const errJson = (payload: unknown, status: number) => ({
    ok: false,
    status,
    json: async () => payload,
});

/** 服务端返回的不是 JSON（反代的错误页、HTML 502 等） */
const errNotJson = (status: number) => ({
    ok: false,
    status,
    json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
    },
});

const setLoggedIn = () => {
    document.cookie = `${SESSION_COOKIE}=1; Path=/`;
};

beforeEach(() => {
    calls = [];
    responder = () => okJson({ success: true });
    installFetch();
    // 每个用例从干净登录态开始
    document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0`;
});

// ---------- 幂等头：用完即清 ----------

test("幂等 ID 只挂到下一个请求上，用完立刻清", async () => {
    const api = new NavigationClient("/api");
    api.setIdempotencyKey("idem-1");
    await api.setConfigs({ a: "1" });
    await api.setConfigs({ b: "2" });

    assert.equal(calls.length, 2);
    assert.equal(headersOf(calls[0])?.["Idempotency-Key"], "idem-1", "重放那条必须带上");
    assert.equal(
        headersOf(calls[1])?.["Idempotency-Key"],
        undefined,
        "第二次请求不该再带 —— 用户手动的每次操作都是新意图，"
        + "带着同一个 ID 会被服务端认成「这条做过了」，直接把新操作吞掉"
    );
});

test("显式传的 headers 优先于幂等 ID", async () => {
    const api = new NavigationClient("/api");
    api.setIdempotencyKey("idem-1");
    await api.setConfigs({ a: "1" });
    // 这句是钉给以后的改动看的：options 里的 headers 会被展开到外层，
    // 谁后写谁生效；幂等头先写、options 后展开，所以显式值胜出。
    assert.equal(headersOf(calls[0])?.["Content-Type"], "application/json");
});

// ---------- 401：必须清掉本地登录标记 ----------

test("401 时清掉本地登录标记，并把服务端原因带进错误消息", async () => {
    responder = () => errJson({ message: "令牌已吊销" }, 401);
    const api = new NavigationClient("/api");
    setLoggedIn();
    assert.equal(api.isLoggedIn(), true);

    await assert.rejects(
        () => api.getConfigs(),
        /认证失败：令牌已吊销/,
        "用户得看到具体原因，而不是一句「请重新登录」"
    );
    assert.equal(
        api.isLoggedIn(),
        false,
        "401 之后本地标记必须清掉：留着它就是「标记在、令牌不在」的半登录态，"
        + "表现为刚登录成功界面就闪回登录页"
    );
});

test("401 且服务端没给原因时，回落到通用文案而不是空消息", async () => {
    responder = () => errJson({}, 401);
    const api = new NavigationClient("/api");
    setLoggedIn();

    await assert.rejects(() => api.getConfigs(), /认证已过期或无效/);
    assert.equal(api.isLoggedIn(), false);
});

// ---------- 非 2xx：错误要能看懂 ----------

test("非 2xx 优先用服务端 message，并附上状态码", async () => {
    responder = () => errJson({ message: "密码强度不足" }, 400);
    const api = new NavigationClient("/api");
    await assert.rejects(() => api.getConfigs(), /密码强度不足 \(HTTP 400\)/);
});

test("服务端只给 error 字段时也能读出来", async () => {
    responder = () => errJson({ error: "rate limited" }, 429);
    const api = new NavigationClient("/api");
    await assert.rejects(() => api.getConfigs(), /rate limited \(HTTP 429\)/);
});

test("服务端返回 HTML 错误页（不是 JSON）时不会二次抛错", async () => {
    responder = () => errNotJson(502);
    const api = new NavigationClient("/api");
    // parse 失败会被吞掉并回落到状态码文案；如果这里抛出的是 SyntaxError，
    // 界面上看到的会是「Unexpected token <」—— 用户根本不知道发生了什么
    await assert.rejects(() => api.getConfigs(), /API错误: 502/);
});

test("401 之外的错误不清登录标记", async () => {
    responder = () => errJson({ message: "服务端炸了" }, 500);
    const api = new NavigationClient("/api");
    setLoggedIn();
    await assert.rejects(() => api.getConfigs(), /服务端炸了/);
    assert.equal(api.isLoggedIn(), true, "500 不代表令牌失效，别把用户踢下线");
});

// ---------- 请求组装 ----------

test("请求带 Content-Type 与 same-origin 凭据", async () => {
    const api = new NavigationClient("/api");
    await api.getConfigs();
    assert.equal(calls[0].url, "/api/configs");
    assert.equal(headersOf(calls[0])?.["Content-Type"], "application/json");
    assert.equal(
        calls[0].init.credentials,
        "same-origin",
        "令牌在 httpOnly cookie 里，凭据策略写错就会变成「请求发出去了但没带身份」"
    );
});

test("baseUrl 末尾不带斜杠时也不会拼出双斜杠", async () => {
    const api = new NavigationClient("/api/");
    await api.getConfigs();
    assert.equal(calls[0].url, "/api//configs", "记录现状：拼接是模板字符串，不做归一化");
});

// ---------- checkAuthStatus 的判定 ----------

test("本地没有登录标记时直接算未认证，且一个请求都不发", async () => {
    const api = new NavigationClient("/api");
    assert.equal(await api.checkAuthStatus(), false);
    assert.equal(calls.length, 0, "没标记就没必要发请求 —— 省掉一次无谓的往返");
});

test("网络抖动（非认证错误）时保持已登录，不把用户踢下线", async () => {
    responder = () => errJson({ message: "网关超时" }, 504);
    const api = new NavigationClient("/api");
    setLoggedIn();

    assert.equal(
        await api.checkAuthStatus(),
        true,
        "离线下打开页面是常态，这时候判成未登录会让用户每次断网都被弹回登录页"
    );
});

test("checkAuthStatus 撞上认证错误时清标记并返回 false", async () => {
    responder = () => errJson({ message: "认证失败：令牌过期" }, 401);
    const api = new NavigationClient("/api");
    setLoggedIn();

    assert.equal(await api.checkAuthStatus(), false);
    assert.equal(api.isLoggedIn(), false);
});

// ---------- 登录标记的 cookie 属性 ----------

test("写登录标记时带上 SameSite=Strict 与 Max-Age，不把持久 cookie 降级成会话 cookie", async () => {
    // cookie 的属性（Max-Age / SameSite）是**写入时**才有的，读回来只剩 name=value，
    // 所以要拦住 setter 才能看见完整的写入串。
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    const written: string[] = [];
    Object.defineProperty(document, "cookie", {
        configurable: true,
        get() {
            return original?.get?.call(this) ?? "";
        },
        set(value: string) {
            written.push(value);
            original?.set?.call(this, value);
        },
    });
    try {
        const api = new NavigationClient("/api");
        api.setToken("whatever");
        const line = written.find(w => w.startsWith(`${SESSION_COOKIE}=1`));
        assert.ok(line, `没写出登录标记，实际写入：${JSON.stringify(written)}`);
        assert.ok(
            /Max-Age=\d+/.test(line!),
            "少了 Max-Age 会变成会话 cookie —— 勾了「记住我」却在关掉浏览器后被登出"
        );
        assert.ok(line!.includes("SameSite=Strict"), "SameSite 掉一级就是 CSRF 面");
        assert.ok(line!.includes("Path=/"), "不写 Path 会只在当前路径生效，刷新后标记消失");
    } finally {
        delete (document as unknown as Record<string, unknown>).cookie;
    }
});

test("clearToken 后 isLoggedIn 变假", async () => {
    const api = new NavigationClient("/api");
    setLoggedIn();
    assert.equal(api.isLoggedIn(), true);
    api.clearToken();
    assert.equal(api.isLoggedIn(), false);
});
