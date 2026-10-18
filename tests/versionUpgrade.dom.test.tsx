// tests/versionUpgrade.dom.test.tsx
// 网站设置里的「版本与升级」一节（components/VersionUpgradeSection.tsx）。
//
// 关键约束：
// - 版本比较只认语义版本三段号：`v3.4.0+abc123` 与 `3.4.0` 相等；
//   Docker 无 .git 时构建号兜底（`v1234`）解析不出三段 → 不能瞎比，报「无法比较」
// - 远端取 raw.githubusercontent.com 的 package.json（CORS 友好、不吃 api 配额）
// - 检查失败（网络不通 / GitHub 5xx / 响应没版本号）要落成可见文案，不能空转
// - 发现新版本时必须给出两种部署形态的升级指引（Docker pull / Workers 自动部署）

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import VersionUpgradeSection, {
    parseSemver,
    fetchUpstreamVersion,
} from "../src/components/VersionUpgradeSection";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
    });
}

function cleanup() {
    if (root) {
        act(() => {
            root!.unmount();
        });
    }
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

async function click(el: Element | null | undefined, msg = "要点的元素不在") {
    assert.ok(el, msg);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** onCheck 的 await 链（fetch → json → setState）有几层 microtask，统一冲干净 */
async function flushAsync() {
    await act(async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
        await new Promise(r => setTimeout(r, 0));
    });
}

function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

type FakeResponse = {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
};

const realFetch = globalThis.fetch;
// jsdom 不实现 scrollIntoView：「出结果时滚进可视区」的兜底路径会调它。
// ⚠️ afterEach 不能把它恢复成 undefined（jsdom 压根没有这个方法），
// 否则第二个用例触发滚动时就 TypeError —— 保持 stub，只重置计数。
let scrollCalls = 0;
function scrollIntoViewStub(this: Element) {
    scrollCalls += 1;
    void this;
}
Element.prototype.scrollIntoView = scrollIntoViewStub;
afterEach(() => {
    Element.prototype.scrollIntoView = scrollIntoViewStub;
    scrollCalls = 0;
});

// ---------- parseSemver：纯函数，先钉住边界 ----------

test("parseSemver：v 前缀 + 短哈希、裸三段号都能解析", () => {
    assert.deepEqual(parseSemver("v3.4.0+abc123"), [3, 4, 0]);
    assert.deepEqual(parseSemver("3.4.0"), [3, 4, 0]);
    assert.deepEqual(parseSemver("  v0.1.0\n"), [0, 1, 0]);
});

test("parseSemver：Docker 构建号兜底与垃圾串返回 null（不许瞎比）", () => {
    assert.equal(parseSemver("v1234+1760511123456"), null);
    assert.equal(parseSemver(""), null);
    assert.equal(parseSemver("dev"), null);
});

// ---------- fetchUpstreamVersion：拉取与校验 ----------

test("fetchUpstreamVersion：正常响应返回 version 字符串并走 raw 域名", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (input: unknown) => {
        calledUrl = String(input);
        return {
            ok: true,
            status: 200,
            json: async () => ({ name: "navihive", version: "3.5.0" }),
        } as unknown as Response;
    }) as typeof fetch;
    try {
        const v = await fetchUpstreamVersion();
        assert.equal(v, "3.5.0");
        assert.ok(
            calledUrl.includes("raw.githubusercontent.com"),
            "必须走 raw.githubusercontent.com（CORS 友好）",
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("fetchUpstreamVersion：GitHub 5xx 抛错、响应缺版本号也抛错", async () => {
    globalThis.fetch = (async () =>
        ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    try {
        await assert.rejects(() => fetchUpstreamVersion(), /503/);
    } finally {
        globalThis.fetch = realFetch;
    }

    globalThis.fetch = (async () =>
        ({
            ok: true,
            status: 200,
            json: async () => ({ version: "build-999" }),
        })) as unknown as typeof fetch;
    try {
        await assert.rejects(() => fetchUpstreamVersion(), /版本号/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ---------- 组件行为 ----------

test("渲染当前版本号与检查按钮", t => {
    t.after(cleanup);
    mount(<VersionUpgradeSection version="v3.4.0+abc123" />);

    const el = document.querySelector("[data-current-version]");
    assert.ok(el !== null, "应有当前版本节点");
    // ⚠️ 只显示语义版本（v3.4.0）：+短哈希/构建号收进 title 悬浮提示，
    // 与右下角徽标同口径 —— 用户要求「v3.5.0 后面的不要显示」
    assert.equal(el.textContent, "v3.4.0");
    assert.equal(el.getAttribute("title"), "v3.4.0+abc123", "完整版本进 title 可悬浮查看");
    assert.ok(document.querySelector("[data-check-update]"), "应有检查更新按钮");
    assert.equal(
        document.querySelector("[data-update-result]"),
        null,
        "初始不应有结果提示",
    );
});

test("远端版本更高 → 显示新版本与两种部署形态的升级指引", async t => {
    t.after(cleanup);
    const d = deferred<FakeResponse>();
    globalThis.fetch = (async () => d.promise) as unknown as typeof fetch;
    try {
        mount(<VersionUpgradeSection version="v3.4.0+abc123" />);
        await click(document.querySelector("[data-check-update]"));
        // 检查中：按钮禁用、无结果
        assert.equal(
            (document.querySelector("[data-check-update]") as HTMLButtonElement).disabled,
            true,
            "检查中按钮应禁用",
        );

        d.resolve({ ok: true, status: 200, json: async () => ({ version: "3.5.0" }) });
        await flushAsync();

        const result = document.querySelector("[data-update-result='available']");
        assert.ok(result !== null, "应显示发现新版本");
        assert.ok(result.textContent!.includes("3.5.0"), "文案要带新版本号");
        assert.ok(result.textContent!.includes("docker pull"), "要有 Docker 升级指引");
        assert.ok(result.textContent!.includes("Workers"), "要有 Workers 部署说明");
        assert.ok(result.querySelector("a[href*='/releases']"), "要给发版页链接");
        // ⚠️ 结果必须与按钮**同一行**（用户报「提示框还要往下移动很不方便」）：
        // 网站设置是最长的弹窗、版本节在最底部，Alert 排在按钮下方就停在
        // 内容折叠线下面。父容器即按钮所在的 flex 行。
        const row = document.querySelector("[data-check-update]")!.parentElement!;
        assert.ok(
            row.contains(result),
            "结果 Alert 必须与「检查更新」按钮在同一行容器里",
        );
        // 滚动兜底：出结果时把这一行滚进可视区（无 DialogContent 时走 scrollIntoView）
        assert.ok(scrollCalls > 0, "出结果应触发滚动兜底");
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("发现新版本时才出现「更新」按钮，点击复制升级命令（失败给原文）", async t => {
    t.after(cleanup);
    // clipboard 桩：第一次成功、第二次失败（覆盖两条反馈分支）
    let writes: string[] = [];
    let mode: "ok" | "fail" = "ok";
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                if (mode === "fail") throw new Error("denied");
                writes.push(text);
            },
        },
    });
    t.after(() => {
        Reflect.deleteProperty(navigator, "clipboard");
    });

    const d = deferred<FakeResponse>();
    globalThis.fetch = (async () => d.promise) as unknown as typeof fetch;
    try {
        mount(<VersionUpgradeSection version="v3.4.0+abc123" />);
        // 「更新」按钮只在发现新版本前不出现
        assert.equal(document.querySelector("[data-update-action]"), null, "未检查前不应有更新按钮");
        await click(document.querySelector("[data-check-update]"));
        d.resolve({ ok: true, status: 200, json: async () => ({ version: "3.5.0" }) });
        await flushAsync();

        const updateBtn = document.querySelector("[data-update-action]");
        assert.ok(updateBtn !== null, "发现新版本应出现「更新」按钮");
        await click(updateBtn);
        await flushAsync();
        assert.deepEqual(writes, ["docker pull ghcr.io/zwjttztt/navihive:latest"], "应复制升级命令");
        assert.ok(document.querySelector("[data-update-copied]"), "复制成功要有确认");

        // 复制失败：命令原文摆出来（用户还能手动复制）
        writes = [];
        mode = "fail";
        await click(document.querySelector("[data-update-action]"));
        await flushAsync();
        assert.ok(
            document.querySelector("[data-update-copy-failed]")?.textContent?.includes("docker pull"),
            "复制失败要把命令原文摆出来",
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("「更新」按钮优先走网页直接升级；端点不可用时回落复制命令", async t => {
    t.after(cleanup);
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { writes.push(text); } },
    });
    t.after(() => { Reflect.deleteProperty(navigator, "clipboard"); });

    // fetch 桩：按用例切状态
    let mode: "upgrade" | "unsupported" = "upgrade";
    globalThis.fetch = (async (url: string) => {
        if (String(url).includes("/api/system/upgrade")) {
            if (mode === "unsupported") {
                return { ok: false, status: 501, json: async () => ({ ok: false, reason: "unsupported" }) };
            }
            return { ok: true, status: 200, json: async () => ({ ok: true, message: "升级已启动" }) };
        }
        // 版本检查走 upstream
        return { ok: true, status: 200, json: async () => ({ version: "3.5.0" }) };
    }) as unknown as typeof fetch;
    try {
        mount(<VersionUpgradeSection version="v3.4.0+abc123" />);
        await click(document.querySelector("[data-check-update]"));
        await flushAsync();
        assert.ok(document.querySelector("[data-update-action]"), "要有更新按钮");

        // ① 网页直接升级：显示升级中提示，不复制命令
        await click(document.querySelector("[data-update-action]"));
        await flushAsync();
        assert.ok(document.querySelector("[data-update-running]"), "升级已触发要有运行提示");
        assert.deepEqual(writes, [], "走了网页升级就不该再复制命令");

        // ② 端点 501（没挂 docker.sock / Workers 部署）→ 回落复制命令
        writes.length = 0;
        mode = "unsupported";
        await click(document.querySelector("[data-update-action]"));
        await flushAsync();
        assert.equal(document.querySelector("[data-update-running]"), null, "回落后不该有运行提示");
        assert.deepEqual(writes, ["docker pull ghcr.io/zwjttztt/navihive:latest"], "回落要复制升级命令");
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("远端版本相同或更低 → 已是最新", async t => {
    t.after(cleanup);
    globalThis.fetch = (async () =>
        ({
            ok: true,
            status: 200,
            json: async () => ({ version: "3.4.0" }),
        })) as unknown as typeof fetch;
    try {
        mount(<VersionUpgradeSection version="v3.4.0+abc123" />);
        await click(document.querySelector("[data-check-update]"));
        await flushAsync();
        assert.ok(
            document.querySelector("[data-update-result='latest']") !== null,
            "应显示已是最新",
        );
        assert.equal(
            document.querySelector("[data-update-result='available']"),
            null,
            "不应出现新版本提示",
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("请求失败 → 错误文案可见且可再次点击检查", async t => {
    t.after(cleanup);
    globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    try {
        mount(<VersionUpgradeSection version="v3.4.0+abc123" />);
        await click(document.querySelector("[data-check-update]"));
        await flushAsync();
        const err = document.querySelector("[data-update-result='error']");
        assert.ok(err !== null, "应显示失败提示");
        assert.ok(err.textContent!.includes("Failed to fetch"));
        assert.equal(
            (document.querySelector("[data-check-update]") as HTMLButtonElement).disabled,
            false,
            "失败后按钮恢复可用，允许重试",
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});
