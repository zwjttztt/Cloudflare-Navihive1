// tests/App.dom.test.tsx
// App.tsx（2056 行）的启动门控 —— 补测试清单上最后一个文件。
//
// 守的是三条「用户看到任何内容之前」的路径，坏了分别是白屏 / 死登录页 / 闪一下主界面：
//   1. 本地没有令牌 + bootstrap 401 → 登录界面（含表单，不是空白）
//   2. 检查中（bootstrap 还没回来）→ 转圈，不闪登录框也不渲染主界面
//   3. 已登录 + bootstrap 200 → 主界面，分组和站点真的渲染出来
//
// 为什么值得单测：这三条路此前的覆盖只有仓库外的 ui-smoke；而 App 里任何一次
// 「提前 return / 门控顺序调整 / onAuthFail 接线改动」都可能把登录页吃掉或把
// 未登录用户放进主界面，本地还不报错——全靠真机点才发现。
//
// 手法：api 是模块级单例（src/App.tsx:181），走全局 fetch —— 用 fetch 桩按 URL
// 路由返回，cookie 用 jsdom 的 document.cookie 控制登录态（isLoggedIn 认
// navihive_session=1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
let originalIO: typeof globalThis.IntersectionObserver;

/**
 * 「一 observe 就当场触发」的 IntersectionObserver 替身。
 *
 * 为什么需要：GroupCard 正常模式下站点默认不挂载，等 IO 命中（入场动画的分帧懒挂载，
 * src/components/GroupCard.tsx:119）—— jsdom 的 IO 桩 observe() 是空操作，
 * 回调永远不来，站点卡片就永远不渲染。这里替身模拟「分组在视口内」。
 * 只在本文件内生效，不碰 runner 的共享 banner（别的用例还要那个不触发的桩）。
 */
class InstantIntersectionObserver {
    constructor(private cb: IntersectionObserverCallback) { }
    observe(target: Element) {
        this.cb(
            [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
        );
    }
    unobserve() { }
    disconnect() { }
    takeRecords() {
        return [];
    }
}

function json(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/**
 * 按 URL 子串路由的 fetch 桩。命不中就给 200 {} ——
 * 启动链路上还有维护探测之类的次要请求，不该让它们把测试拖红。
 */
function installFetch(routes: Record<string, () => Response | Promise<Response>>) {
    globalThis.fetch = ((input: string | URL | Request) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                    ? input.href
                    : input.url;
        for (const [pattern, make] of Object.entries(routes)) {
            if (url.includes(pattern)) return Promise.resolve(make());
        }
        return Promise.resolve(json({ success: true }));
    }) as typeof globalThis.fetch;
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
    globalThis.IntersectionObserver = originalIO;
    // cookie  Jar 清不掉（jsdom 没有 clear API），用过期时间把登录态消掉
    document.cookie = "navihive_session=; Max-Age=0";
    try {
        localStorage.clear();
    } catch {
        /* 隐私模式之类 */
    }
}

function mountApp() {
    // 站点卡片的懒挂载靠 IO 触发（见 InstantIntersectionObserver 的说明）
    originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
        InstantIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
}

/** 轮询等一个条件成立（启动链路是多段 await，等不到就是真失败） */
async function pollUntil(pred: () => boolean, what: string) {
    for (let i = 0; i < 80; i++) {
        if (pred()) return;
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
    }
    assert.fail(`等待超时：${what}；页面文本=${(document.body.textContent ?? "").slice(0, 200)}`);
}

const hasLoginForm = () => document.querySelector('input[type="password"]') !== null;
const hasSpinner = () => document.querySelector('[role="progressbar"]') !== null;
const bodyText = () => document.body.textContent ?? "";

test("未登录：bootstrap 401 → 登录界面（有表单，不是白屏）", async t => {
    t.after(cleanup);
    originalFetch = globalThis.fetch;
    installFetch({
        bootstrap: () => json({ error: { code: "unauthenticated", message: "未登录" } }, 401),
    });

    mountApp();
    await act(async () => {
        root!.render(<App /> as ReactElement);
    });

    await pollUntil(hasLoginForm, "登录表单出现");
    // 登录页不该把主界面的内容也带上（数据是 401 拿不到的，渲染了就是空的）
    assert.ok(!bodyText().includes("冒烟分组"), "未登录不该渲染主界面内容");
});

test("检查中：bootstrap 悬挂 → 转圈，不闪登录框", async t => {
    t.after(cleanup);
    originalFetch = globalThis.fetch;
    // 永远不 resolve：模拟「认证检查那次请求还在飞」
    installFetch({
        bootstrap: () => new Promise<Response>(() => { }),
    });

    mountApp();
    await act(async () => {
        root!.render(<App /> as ReactElement);
    });

    await pollUntil(hasSpinner, "检查中的转圈出现");
    assert.ok(!hasLoginForm(), "检查中不该提前渲染登录表单（会闪一下）");
    assert.ok(!bodyText().includes("冒烟分组"), "检查中不该渲染主界面");
});

test("已登录：bootstrap 200 → 主界面渲染分组与站点", async t => {
    t.after(cleanup);
    originalFetch = globalThis.fetch;
    // isLoggedIn 认的是 navihive_session=1（src/API/client.ts:106）
    document.cookie = "navihive_session=1";
    installFetch({
        bootstrap: () =>
            json({
                groups: [{ id: 1, name: "冒烟分组", order_num: 0 }],
                sites: [
                    {
                        id: 7,
                        group_id: 1,
                        name: "冒烟站点",
                        url: "https://example.com",
                        order_num: 0,
                    },
                ],
                configs: {},
                me: { id: 1, username: "root", role: "owner" },
                recovery: { configured: false },
            }),
    });

    mountApp();
    await act(async () => {
        root!.render(<App /> as ReactElement);
    });

    await pollUntil(() => bodyText().includes("冒烟分组"), "主界面渲染出分组");
    // 站点卡片在懒加载块里，分组名先出现时它可能还没挂载 —— 一样等，不赌时序
    await pollUntil(() => bodyText().includes("冒烟站点"), "站点卡片渲染出来");
    // 登录态拿到了就不该再显示登录表单
    assert.ok(!hasLoginForm(), "已登录不该停在登录页");
});
