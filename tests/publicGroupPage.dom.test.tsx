// src/components/PublicGroupPage.tsx 的直测（158 行，此前零覆盖）。
//
// 为什么是它：公开分组页（2026-10-11 阶段④，/sg/<token>）的匿名访客入口，
// 覆盖率体检（docs/coverage-checkup-2026-10-13.md）里分享 UI 三件套零覆盖之一。
//
// ⚠️ 它和 PublicNotePage 的**错误码形状不一样**，这是本文件最要钉住的东西：
//   笔记分享的 need-password 在 worker 里被转成 **HTTP 401 + 顶层 needPassword**；
//   分组分享那条分支是 `Response.json(result)` 直出，**恒 HTTP 200**，
//   需要口令时 body 是 `{ status: "need-password" }`、撤销后是 `{ status: "not-found" }`。
//   照抄笔记分享那套「看 HTTP 状态码」的写法，这里会全都判成成功 —— 访客看到一片空白。
//
// 所以这里的桩一律回 **200**，分流只看 body 里的 status 字段。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import PublicGroupPage from "../src/components/PublicGroupPage";
import type { PublicGroupAccess } from "../src/API/types";

const TOKEN = "c".repeat(64);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;

interface Stub {
    calls: Array<{ url: string; method: string; body?: string }>;
}

/**
 * 每一步默认 **HTTP 200**：分组分享的分流全在 body.status 上（见文件头说明）。
 * 需要单独指定 HTTP 状态时用 `{ http, body }` 形状 —— 用来验证「组件不看 HTTP 状态码」。
 */
type Step = PublicGroupAccess | { http: number; body: PublicGroupAccess };

function stubFetch(steps: Step[]): Stub {
    const stub: Stub = { calls: [] };
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        stub.calls.push({
            url: String(url),
            method: init.method ?? "GET",
            ...(init.body === undefined ? {} : { body: String(init.body) }),
        });
        const step = steps[Math.min(stub.calls.length - 1, steps.length - 1)];
        const http = "http" in step ? step.http : 200;
        const body = "http" in step ? step.body : step;
        return {
            ok: http >= 200 && http < 300,
            status: http,
            json: async () => body,
        };
    }) as unknown as typeof fetch;
    return stub;
}

function mount(token = TOKEN) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<PublicGroupPage token={token} />);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

beforeEach(() => {
    document.title = "初始标题";
});
afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
});

const pageText = () => document.body.textContent ?? "";

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        if (Date.now() > deadline) assert.fail(`等了 ${timeoutMs}ms 也没等到：${label}`);
        await act(async () => {
            await new Promise(r => setTimeout(r, 10));
        });
    }
}

const okAccess = (over: Partial<Extract<PublicGroupAccess, { status: "ok" }>> = {}): PublicGroupAccess => ({
    status: "ok",
    group: { name: "分享验收分组" },
    sites: [
        { name: "分享验收站点", url: "https://example.com/", description: "一句描述", icon: null },
        { name: "", url: "https://no-name.example/", description: null, icon: null },
    ],
    views: 9,
    ...over,
});

const submitPw = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>("input[aria-label='访问口令']");
    assert.ok(input, "要有口令输入框");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
        document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
    });
};

// ---------- 正常读取与脱敏 ----------

test("匿名 GET 成功：显示分组名、链接数、浏览次数与站点卡片", async () => {
    stubFetch([okAccess()]);
    mount();
    await waitFor("分组名出现", () => pageText().includes("分享验收分组"));

    assert.ok(pageText().includes("2 个链接"), "要显示站点数");
    assert.ok(pageText().includes("浏览 9 次"), "要显示浏览次数");
    assert.ok(pageText().includes("一句描述"), "要显示站点描述");
    // 没名字的站点回落显示 URL（组件里 site.name || site.url）
    assert.ok(pageText().includes("https://no-name.example/"), "无名站点要回落显示 URL");
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
    assert.equal(links.length, 2, "两个站点各一个链接");
    assert.equal(links[0].href, "https://example.com/");
    // 外链必须 noopener/noreferrer/nofollow：公开页被拿去做 SEO 与 tab-nabbing 都是实际风险
    assert.ok(links[0].rel.includes("noopener"), "要带 noopener");
    assert.ok(links[0].rel.includes("nofollow"), "要带 nofollow");
    assert.equal(links[0].target, "_blank", "要新窗口打开");
});

test("公开页不渲染站点账号密码（脱敏契约：服务端 SELECT 就不带，前端也不该显示）", async () => {
    // 服务端已经脱敏（SELECT 只要 name/url/description/icon），这里是**纵深防御**的钉子：
    // 哪天谁「顺手」把整个 site 对象塞进公开响应，这条要红。
    const leaked = okAccess();
    (leaked as unknown as Record<string, unknown>).sites = [
        { name: "站点", url: "https://a.example/", description: null, icon: null, username: "secret-user", password: "secret-pass" },
    ];
    stubFetch([leaked]);
    mount();
    await waitFor("站点出现", () => pageText().includes("站点"));
    assert.ok(!pageText().includes("secret-user"), "不能出现站点账号");
    assert.ok(!pageText().includes("secret-pass"), "不能出现站点密码");
});

// ---------- 口令：恒 200，只看 body.status ----------

test("受口令分享：HTTP 200 + { status: 'need-password' } 就要弹口令框", async () => {
    // ⚠️ 这条钉的是与笔记分享的形状差异：这里**不是** 401。
    // 谁把组件改成「看 response.status」，访客会看到一片空白而不是口令框。
    stubFetch([{ status: "need-password" }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    assert.ok(pageText().includes("此分享受访问口令保护"), "要说明受口令保护");
    assert.equal(document.querySelector("[data-public-group='1']"), null, "不该直接露出分组内容");
});

test("组件不看 HTTP 状态码：就算响应带 401，只要 body.status 是 ok 就要显示内容", async () => {
    // ⚠️ 这条钉的是与笔记分享的**形状差异**本身。分组分享在 worker 里是
    // `Response.json(result)` 直出，need-password / not-found 都回 **200**；
    // 而笔记分享那条会把 need-password 转成 401。两条链路长得像，
    // 很容易有人「统一一下」给分组分享也加个 HTTP 状态判断 —— 那会让访客
    // 在该看到口令框的时候看到一片空白。
    // 用一个「反常的 HTTP 状态 + 正常的 body」来证明组件只认 body.status。
    stubFetch([{ http: 401, body: okAccess() }]);
    mount();
    await waitFor("分组内容出现", () => pageText().includes("分享验收分组"));
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "不该弹口令框");
    assert.ok(!pageText().includes("分享不存在或已过期"), "不该判成不存在");
});

test("口令对：POST 成功 → 显示分组内容", async () => {
    const stub = stubFetch([{ status: "need-password" }, okAccess({ views: 10 })]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    await submitPw("right");

    await waitFor("分组内容出现", () => pageText().includes("分享验收分组"));
    assert.equal(stub.calls[1].method, "POST", "带口令要走 POST");
    assert.equal(stub.calls[1].body, JSON.stringify({ password: "right" }), "口令要放进 body");
    assert.equal(stub.calls[1].url, `/api/group-shares/${TOKEN}`, "URL 不能变");
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "解锁后口令框要消失");
    assert.ok(pageText().includes("浏览 10 次"), "要显示解锁后的浏览次数");
});

test("口令错：仍是 200 + need-password → 留在口令框", async () => {
    const stub = stubFetch([{ status: "need-password" }, { status: "need-password" }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    await submitPw("wrong");
    await waitFor("第二次请求发出", () => stub.calls.length >= 2);
    assert.ok(document.querySelector("input[aria-label='访问口令']"), "口令错要留在口令框");
    assert.equal(document.querySelector("[data-public-group='1']"), null, "口令错不能露出内容");
});

test("空口令不能提交（按钮禁用 + 表单里也有 if 兜底）", async () => {
    stubFetch([{ status: "need-password" }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    const btn = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.textContent ?? "").trim() === "打开");
    assert.ok(btn, "要有「打开」按钮");
    assert.equal(btn!.disabled, true, "没填口令时按钮要禁用");
});

// ---------- 不存在 / 网络失败 ----------

test("撤销或过期：HTTP 200 + { status: 'not-found' } → 显示不存在", async () => {
    // 同样是 200：照笔记分享那套「404 才算不存在」的写法这里会漏判。
    stubFetch([{ status: "not-found" }]);
    mount();
    await waitFor("不存在提示出现", () => pageText().includes("分享不存在或已过期"));
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "不存在不该弹口令框");
});

test("网络层抛错：也走「不存在」分支，不白屏", async () => {
    globalThis.fetch = (async () => {
        throw new Error("网络层失败");
    }) as unknown as typeof fetch;
    mount();
    for (let i=0;i<3;i++){ await act(async()=>{await new Promise(r=>setTimeout(r,30));}); console.error("DBG text=", JSON.stringify(pageText().slice(0,200))); }
    await waitFor("不存在提示出现", () => pageText().includes("分享不存在或已过期"));
});
