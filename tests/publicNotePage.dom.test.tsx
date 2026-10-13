// src/components/PublicNotePage.tsx 的直测（131 行，此前零覆盖）。
//
// 为什么是它：这是**匿名访客的唯一入口**（/s/<token>），而覆盖率体检
// （docs/coverage-checkup-2026-10-13.md）把它列为分享 UI 三件套零覆盖之一。
// 它不走 client.request（公开页没有登录态），自己裸 fetch + 自己解析错误 ——
// 整条链路只有它自己在用，改坏了没有第二处能兜住。
//
// 钉的重点是**两种错误形状都要认**：服务端 2026-10-13 起回统一形状
// { error: { code, message } }，老服务端回 { error: "需要访问口令" }。
// 直接读 data.error 的话，新形状下拿到的是对象、界面上会显示 [object Object] ——
// 这正是 2026-10-13 迁移时在这个组件里踩过的坑（见组件内注释）。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import PublicNotePage from "../src/components/PublicNotePage";

const TOKEN = "b".repeat(64);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const realFetch = globalThis.fetch;

interface Stub {
    calls: Array<{ url: string; method: string; body?: string }>;
    /** 按次数排队；不够用时重复最后一个 */
    steps: Array<{ status?: number; body?: unknown; raw?: string; throws?: boolean }>;
}

function stubFetch(steps: Stub["steps"]): Stub {
    const stub: Stub = { calls: [], steps };
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        stub.calls.push({
            url: String(url),
            method: init.method ?? "GET",
            ...(init.body === undefined ? {} : { body: String(init.body) }),
        });
        const step = stub.steps[Math.min(stub.calls.length - 1, stub.steps.length - 1)];
        if (step.throws) throw new Error("网络层失败");
        const payload = step.raw ?? JSON.stringify(step.body ?? {});
        const status = step.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(payload),
        };
    }) as unknown as typeof fetch;
    return stub;
}

function mount(token = TOKEN) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<PublicNotePage token={token} />);
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
    // 每个用例都从干净的标题开始：组件会写 document.title，脏状态会让下一条误判
    document.title = "初始标题";
});
afterEach(() => {
    cleanup();
    globalThis.fetch = realFetch;
});

const pageText = () => document.body.textContent ?? "";
/** 口令框里的错误提示（MUI Typography variant='body2' 渲染成 <p>；注意它用的是
 *  color='error.main'，class 是 MuiTypography-colorError 而**不是** .Mui-error） */
const formError = () => document.querySelector("form p")?.textContent?.trim() ?? "";

/** 等条件成立，而不是睡固定时长：markdown 渲染是真的异步链 */
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

const okNote = (over: Partial<{ title: string; content: string }> = {}) => ({
    status: 200,
    body: { title: "分享验收笔记", content: "正文里有 E2E 标记。", ...over },
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

// ---------- 正常读取 ----------

test("匿名 GET 成功：显示标题与正文，并把标签页标题换成笔记标题", async () => {
    stubFetch([okNote()]);
    mount();
    await waitFor("正文出现", () => pageText().includes("正文里有 E2E 标记"));
    assert.ok(pageText().includes("分享验收笔记"), "要显示笔记标题");
    assert.equal(document.title, "分享验收笔记", "标签页标题要换成笔记标题（否则一堆分享链接分不出来）");
    // 访客不该看到任何登录态外壳
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "成功读取后不该有口令框");
});

test("正文里的附件路径被改写成免鉴权通道（访客没有 cookie，原路径会 401）", async () => {
    stubFetch([okNote({ content: "![图](/api/notes/attachments/ab12-cd34)" })]);
    mount();
    await waitFor("图片出现", () => !!document.querySelector("img"));
    const src = document.querySelector("img")!.getAttribute("src");
    // 必须是 /api/note-shares/attachments/<id>?share=<token>：老路径挂在登录鉴权后面
    assert.equal(
        src,
        `/api/note-shares/attachments/ab12-cd34?share=${encodeURIComponent(TOKEN)}`,
        "附件路径要走公开通道"
    );
});

// ---------- 401：两种错误形状都要认出文案 ----------

test("401 + 新形状 { error: { code, message } }：弹口令框，提示语是 message", async () => {
    // 用一个**与众不同**的文案：这样「页面上出现了它」才能证明文案来自 error.message，
    // 而不是组件里写死的兜底（兜底也是「需要访问口令」，用默认文案根本分不出来）。
    const MARK = "新形状带过来的提示语";
    stubFetch([{ status: 401, body: { error: { code: "unauthenticated", message: MARK }, needPassword: true } }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));

    assert.ok(pageText().includes("需要访问口令"), "要有口令框标题");
    assert.equal(formError(), MARK, "提示语要取自 error.message");
    // ⚠️ 最关键的一条：不能把对象直接渲染出来
    assert.ok(!pageText().includes("[object Object]"), "不能显示 [object Object]");
});

test("401 + 旧形状 { error: \"字符串\" }（老服务端）：同样取到文案", async () => {
    const MARK = "旧形状带过来的提示语";
    stubFetch([{ status: 401, body: { error: MARK } }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    assert.equal(formError(), MARK, "旧形状下 error 是字符串，要原样取出");
    assert.ok(!pageText().includes("[object Object]"), "旧形状也不能显示 [object Object]");
});

test("401 且响应体不是 JSON（反代错误页等）：回落通用文案，不白屏", async () => {
    stubFetch([{ status: 401, raw: "<html>502 Bad Gateway</html>" }]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    assert.equal(formError(), "需要访问口令", "解析不出文案时要回落通用提示");
});

// ---------- 口令提交 ----------

test("口令错：仍回 401，提示语照旧，且请求确实带了口令", async () => {
    const MARK = "口令不对";
    const stub = stubFetch([
        { status: 401, body: { error: { code: "unauthenticated", message: MARK } } },
        { status: 401, body: { error: { code: "unauthenticated", message: MARK } } },
    ]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    await submitPw("wrong");

    await waitFor("第二次请求发出", () => stub.calls.length >= 2);
    assert.equal(stub.calls[1].method, "POST", "带口令要走 POST");
    assert.equal(stub.calls[1].body, JSON.stringify({ password: "wrong" }), "口令要放进 body");
    assert.equal(stub.calls[1].url, `/api/note-shares/${TOKEN}`, "URL 不能变");
    assert.equal(formError(), MARK, "口令错要继续提示服务端给的原因");
    assert.equal(document.querySelector("article"), null, "口令错不能露出正文");
});

test("口令对：POST 成功 → 显示正文、口令框消失", async () => {
    stubFetch([
        { status: 401, body: { error: { code: "unauthenticated", message: "需要访问口令" } } },
        okNote({ title: "解锁后的笔记", content: "解锁后的正文。" }),
    ]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    await submitPw("right");

    await waitFor("正文出现", () => pageText().includes("解锁后的正文"));
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "解锁后口令框要消失");
    assert.equal(document.title, "解锁后的笔记", "标题要跟着更新");
});

// ---------- 失败路径 ----------

test("404（不存在/已过期/已撤销）：显示明确文案，不白屏也不弹口令框", async () => {
    stubFetch([{ status: 404, body: { error: { code: "not_found", message: "分享不存在、已过期或已撤销" } } }]);
    mount();
    await waitFor("错误文案出现", () => pageText().includes("分享不存在、已过期或已撤销"));
    assert.equal(document.querySelector("input[aria-label='访问口令']"), null, "404 不该弹口令框");
});

test("提交口令时网络层抛错：提示错误且不崩", async () => {
    stubFetch([
        { status: 401, body: { error: { code: "unauthenticated", message: "需要访问口令" } } },
        { throws: true },
    ]);
    mount();
    await waitFor("口令框出现", () => !!document.querySelector("input[aria-label='访问口令']"));
    await submitPw("whatever");
    await waitFor("错误提示出现", () => formError().length > 0);
    assert.equal(formError(), "网络层失败", "网络错误要把原因显示出来");
});
