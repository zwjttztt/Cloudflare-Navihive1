// tests/siteListErrorState.dom.test.tsx
// P0-1 的回归守卫：**加载失败**必须显示「加载失败 + 重试」，而不是「还没有任何分组」。
//
// 为什么这条必须有：`useSites` 里的 error 曾经常年恒为 null（只被赋过 null），
// 于是 App 里 `!loading && !error` 这道守卫成了死条件 —— bootstrap 失败后 groups 为空，
// 用户看到的是空状态里的「还没有任何分组」，会以为自己几百个网站全没了。
// 数据一条没丢，只是没取到；而这个界面上「没取到」和「本来就没有」长得一模一样。
//
// 反过来还有一个坑：注销 / 登出 / 改密码这几句**流程提示**原来也写进同一个 error
// （App 把 setError 当 onDataError 传给了两个 hook），那时整个列表会消失且一个字都没有。
// 所以下面第二条用例守的是「错误面板只在真的失败时出现」的另一面：error 只表示加载失败。
//
// 手法与 App.dom.test.tsx 一致：api 走全局 fetch，用桩按 URL 路由。
// 关键在于让「会话还活着、但 bootstrap 这一趟失败」—— 那正是线上遇到的形态
// （/api/auth/me 能拿到「我是谁」，说明不是未登录，所以不会落到登录页）。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import SiteListErrorState from "../src/components/SiteListErrorState";
import { useSites } from "../src/hooks/useSites";
import type { BootstrapData } from "../src/API/http";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;

function json(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** 按 URL 子串路由的 fetch 桩；命不中给 200 {}（启动链路上还有维护探测之类的次要请求） */
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

function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
    if (originalFetch) globalThis.fetch = originalFetch;
    document.cookie = "navihive_session=; Max-Age=0";
    try {
        localStorage.clear();
        sessionStorage.clear();
    } catch {
        /* 隐私模式之类 */
    }
}

afterEach(cleanup);

const bodyText = () => document.body.textContent ?? "";

/** 轮询等条件成立（启动链路是多段 await，等不到就是真失败，不赌时序） */
async function pollUntil(pred: () => boolean, what: string) {
    for (let i = 0; i < 120; i++) {
        if (pred()) return;
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
    }
    assert.fail(`等待超时：${what}；页面文本=${bodyText().slice(0, 300)}`);
}

const retryButton = () =>
    document.querySelector<HTMLButtonElement>(".nav-site-list-error-retry");

// ---- 纯渲染：面板本身 ----

test("错误面板：显示标题、失败原因和可点的重试按钮", () => {
    let retried = 0;
    mount(<SiteListErrorState message='数据库连接超时' onRetry={() => void retried++} />);

    assert.ok(bodyText().includes("加载失败"), `要有标题，实际：${bodyText()}`);
    assert.ok(bodyText().includes("数据库连接超时"), "要把失败原因原样带出来，否则用户不知道怎么办");
    const btn = retryButton();
    assert.ok(btn, "要有「重试」按钮 —— 没有出口的错误提示等于死路");
    act(() => {
        btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(retried, 1, "点重试必须真的触发 onRetry");
});

// ---- App 级：bootstrap 失败 → 错误面板（不是「还没有任何分组」） ----

test("bootstrap 失败：渲染错误面板，而不是「还没有任何分组」", async () => {
    originalFetch = globalThis.fetch;
    // 会话是活的（auth/me 拿得到「我是谁」），但 bootstrap 这一趟失败。
    // 这才是线上形态：不是未登录，所以不会落到登录页。
    installFetch({
        bootstrap: () => json({ error: { code: "internal", message: "数据库连接超时" } }, 500),
        "auth/me": () => json({ id: 1, username: "root", role: "owner" }),
    });

    mount(<App /> as ReactElement);

    await pollUntil(() => retryButton() !== null, "错误面板上的重试按钮出现");
    assert.ok(bodyText().includes("加载失败"), `要看到「加载失败」，实际：${bodyText().slice(0, 200)}`);
    assert.ok(bodyText().includes("数据库连接超时"), "要带上失败原因");
    assert.ok(
        !bodyText().includes("还没有任何分组"),
        "⛔ 加载失败绝不能显示空状态文案 —— 用户会以为自己几百个网站没了"
    );
});

test("错误面板的重试：点一下重新取数，成功后列表回来、面板自己退场", async () => {
    originalFetch = globalThis.fetch;
    // 先失败，点重试之前把后端「修好」——模拟真实的「网盘/数据库短暂不可用」
    let healthy = false;
    const backup: BootstrapData = {
        groups: [{ id: 1, name: "重试分组", order_num: 0 }],
        sites: [
            { id: 7, group_id: 1, name: "重试站点", url: "https://example.com", order_num: 0 },
        ],
        configs: {},
        me: { id: 1, username: "root", role: "owner" },
        recovery: { configured: false },
    } as unknown as BootstrapData;
    installFetch({
        bootstrap: () =>
            healthy
                ? json(backup)
                : json({ error: { code: "internal", message: "数据库连接超时" } }, 500),
        "auth/me": () => json({ id: 1, username: "root", role: "owner" }),
    });

    mount(<App /> as ReactElement);
    await pollUntil(() => retryButton() !== null, "错误面板出现");

    healthy = true;
    await act(async () => {
        retryButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });

    await pollUntil(() => bodyText().includes("重试分组"), "重试成功后的分组渲染出来");
    assert.equal(retryButton(), null, "取数成功后错误面板必须退场，不能留着吓人");
    assert.ok(
        !bodyText().includes("加载失败"),
        `成功后不该再显示「加载失败」，实际：${bodyText().slice(0, 200)}`
    );
});

// ---- hook 级：silent 刷新失败不升级成整页错误 ----

interface UseSitesOut {
    loading: boolean;
    error: string | null;
    toasts: string[];
    authFails: number;
    fetchData: (opts?: { silent?: boolean }) => Promise<boolean>;
}

/**
 * 只测 useSites 的极简宿主：不起 App（那要拖一堆启动请求），
 * 但走的是**同一个** hook，所以「error 什么时候被赋值」这条规则是真被测到的。
 */
function UseSitesHarness({ out, api }: { out: UseSitesOut; api: { bootstrap: () => Promise<BootstrapData> } }) {
    const { loading, error, fetchData } = useSites({
        api,
        onRemoteExtras: () => { },
        onError: msg => void out.toasts.push(msg),
        onAuthFail: () => void out.authFails++,
    });
    out.loading = loading;
    out.error = error;
    out.fetchData = fetchData;
    return null;
}

test("silent 刷新失败：不写 error（有旧数据可看时不该把整页换成错误面板）", async () => {
    const out: UseSitesOut = {
        loading: true,
        error: null,
        toasts: [],
        authFails: 0,
        fetchData: async () => false,
    };
    const api = {
        bootstrap: async (): Promise<BootstrapData> => {
            throw new Error("网络炸了");
        },
    };
    mount(<UseSitesHarness out={out} api={api} />);

    await act(async () => {
        await out.fetchData({ silent: true });
    });

    assert.equal(out.error, null, "silent 刷新失败只该安静地失败，不能升级成整页错误");
    assert.deepEqual(out.toasts, [], "silent 时也不弹 toast（用户正在看旧数据）");
});

test("非 silent 取数失败：error 拿到原因，且成功一次后自己清掉", async () => {
    const out: UseSitesOut = {
        loading: true,
        error: null,
        toasts: [],
        authFails: 0,
        fetchData: async () => false,
    };
    let fail = true;
    const api = {
        bootstrap: async (): Promise<BootstrapData> => {
            if (fail) throw new Error("数据库连接超时");
            return {
                groups: [{ id: 1, name: "一组", order_num: 0 }],
                sites: [],
                configs: {},
            } as unknown as BootstrapData;
        },
    };
    mount(<UseSitesHarness out={out} api={api} />);

    await act(async () => {
        await out.fetchData();
    });
    assert.equal(out.error, "数据库连接超时", "失败要把原因落到 error 上，App 才有东西可画");
    assert.equal(out.loading, false, "失败也要把骨架屏收掉，否则用户一直看加载中");
    assert.equal(out.toasts.length, 1, "同时保留 toast（短暂提示）");

    fail = false;
    await act(async () => {
        await out.fetchData();
    });
    assert.equal(out.error, null, "成功一次之后 error 必须清掉，否则错误面板不会退场");
});
