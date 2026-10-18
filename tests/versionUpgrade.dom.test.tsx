// tests/versionUpgrade.dom.test.tsx
// 网站设置里的「版本与升级」一节（components/VersionUpgradeSection.tsx）。
//
// 关键约束：
// - 版本比较只认语义版本三段号：`v3.4.0+abc123` 与 `3.4.0` 相等；
//   Docker 无 .git 时构建号兜底（`v1234`）解析不出三段 → 不能瞎比，报「无法比较」
// - 远端取 raw.githubusercontent.com 的 package.json（CORS 友好、不吃 api 配额）
// - 检查失败（网络不通 / GitHub 5xx / 响应没版本号）要落成可见文案，不能空转
// - 发现新版本时必须给出两种部署形态的升级指引（Docker pull / Workers 自动部署）

import { test } from "node:test";
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
