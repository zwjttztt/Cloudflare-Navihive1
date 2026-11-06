// tests/appLoadingState.dom.test.tsx
// App 的**列表加载态**守卫：只给一个转圈，不再画「假卡片骨架」。
//
// 2026-11-06 用户反馈（弱网打开网站）：先看到一整屏假卡片（index.html 里那段纯 CSS
// 启动占位画的）、跳一下变成骨架、再跳一下才出现真卡片 —— 三次形态跳变，每次都像
// 「已经快好了」其实没到。改法定为**全程只留转圈**：启动占位换成静态圆环，
// 这里的 loading 分支从 SiteListSkeleton 换成 CircularProgress，两侧视觉一致。
//
// 守三件事：
//   1. loading 期间有一个 role="status"、可访问名是「正在加载站点」的节点
//      （读屏要知道「在等什么」，而不是面对一片空白）；
//   2. loading 期间**没有** MUI Skeleton 节点（假卡片回潮立刻红）；
//   3. 数据到位后这个节点消失 —— 转圈常驻会让用户以为永远在加载。
//
// 怎么把 App 停在 loading：冷启动那段其实是 LoginScreen 的 checking 态
// （App 的 isAuthChecking 门控，那时列表区还没渲染），列表的 loading 分支只会出现在
// 「重试 / 刷新」这类再取数的时候。所以这里就按真实路径走一遍：
// bootstrap 先失败 → 错误面板 → 点重试，让这次 bootstrap **挂住不返回**（loading 为真、
// error 已清）→ 此时应当只有转圈 → 再放行，数据与转圈必须互相顶掉。
//
// 手法与 App.dom.test.tsx / siteListErrorState.dom.test.tsx 一致：api 是模块级单例，
// 走全局 fetch，用按 URL 路由的桩控制每一次 bootstrap 的结果。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import type { BootstrapData } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
let originalIO: typeof globalThis.IntersectionObserver;

/**
 * 「一 observe 就当场触发」的 IntersectionObserver 替身（同 App.dom.test.tsx）。
 * 分组里的站点卡片靠 IO 命中才挂载，jsdom 那个空操作桩会让它永远不渲染。
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

/** 启动链路上还有维护探测之类的次要请求，命不中一律给 200 {} */
function installFetch(routes: Record<string, () => Response | Promise<Response>>) {
    globalThis.fetch = ((input: string | URL | Request) => {
        const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
    document.cookie = "navihive_session=; Max-Age=0";
    try {
        localStorage.clear();
        sessionStorage.clear();
    } catch {
        /* 隐私模式之类 */
    }
}

function mountApp() {
    originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
        InstantIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
}

/** 轮询等一个条件成立（启动链路是多段 await，等不到就是真失败） */
async function pollUntil(pred: () => boolean, what: string) {
    for (let i = 0; i < 120; i++) {
        if (pred()) return;
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
    }
    assert.fail(`等待超时：${what}；页面文本=${(document.body.textContent ?? "").slice(0, 200)}`);
}

// 页面上还有别的 role="status"（读屏播报区 / 提示条都是 live region），
// 所以按「可访问名」精确定位到加载态这一个 —— 断言本身也是在验可访问名。
const statusNode = () =>
    document.querySelector('[role="status"][aria-label="正在加载站点"]');
const skeletons = () => document.querySelectorAll(".MuiSkeleton-root").length;
const retryButton = () => document.querySelector<HTMLButtonElement>(".nav-site-list-error-retry");
const bodyText = () => document.body.textContent ?? "";

/** 重试成功后应当渲染出来的数据 */
const BACKUP: BootstrapData = {
    groups: [{ id: 1, name: "加载态分组", order_num: 0 }],
    sites: [
        { id: 7, group_id: 1, name: "加载态站点", url: "https://example.com", order_num: 0 },
    ],
    configs: {},
    me: { id: 1, username: "root", role: "owner" },
    recovery: { configured: false },
} as unknown as BootstrapData;

test("loading：只有一个 role=status 的转圈，不画假卡片；数据到位后它自己退场", async t => {
    t.after(cleanup);
    originalFetch = globalThis.fetch;
    document.cookie = "navihive_session=1";

    // 三次 bootstrap 三种行为：先失败（走到错误面板）→ 挂住（停在 loading）→ 成功
    let mode: "fail" | "hang" | "ok" = "fail";
    const pending: Array<(response: Response) => void> = [];
    installFetch({
        bootstrap: () => {
            if (mode === "fail") {
                return json({ error: { code: "internal", message: "数据库连接超时" } }, 500);
            }
            if (mode === "hang") {
                return new Promise<Response>(resolve => {
                    pending.push(resolve);
                });
            }
            return json(BACKUP);
        },
        "auth/me": () => json({ id: 1, username: "root", role: "owner" }),
    });

    mountApp();
    await act(async () => {
        root!.render(<App /> as ReactElement);
    });

    // 先走到「加载失败」，重试按钮是进入 loading 分支的唯一入口
    await pollUntil(() => retryButton() !== null, "错误面板上的重试按钮出现");

    mode = "hang";
    await act(async () => {
        retryButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });

    await pollUntil(() => statusNode() !== null, "加载态转圈出现");

    const node = statusNode();
    assert.equal(
        node!.getAttribute("aria-label"),
        "正在加载站点",
        "读屏要听到「在加载什么」，不能只丢一个无名的转圈"
    );
    assert.equal(
        skeletons(),
        0,
        "⛔ 加载态不许再画 MUI Skeleton（2026-11-06 起全程只留转圈，假卡片会让用户以为内容在加载）"
    );
    // 转圈本体是 MUI CircularProgress，语义上是 progressbar —— 顺带钉住「真的是转圈」
    assert.ok(
        node!.querySelector('[role="progressbar"]') !== null,
        "role=status 里面应当是一个 CircularProgress"
    );
    assert.ok(!bodyText().includes("加载态分组"), "数据还没回来，不该已经有分组内容");
    assert.equal(retryButton(), null, "重试已经点下去了，错误面板不该还挂着（那份错误已被清掉）");

    // 放行这次 bootstrap：数据到位后转圈必须消失
    mode = "ok";
    await act(async () => {
        for (const resolve of pending) resolve(json(BACKUP));
        await Promise.resolve();
    });

    await pollUntil(() => bodyText().includes("加载态分组"), "数据到位后的分组渲染出来");
    assert.equal(statusNode(), null, "数据到位后加载态必须退场（转圈常驻会让人以为永远在加载）");
    assert.ok(
        bodyText().includes("加载态站点"),
        `站点也要渲染出来（说明放行的是真数据，不是空壳），实际：${bodyText().slice(0, 200)}`
    );
});
