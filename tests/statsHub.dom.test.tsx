// tests/statsHub.dom.test.tsx
// 「统计」hub（StatsHubDialog）：一个弹窗两个标签页。
//
// 守住的契约（2026-10-15 菜单瘦身时定下的）：
// 1. **owner 才看得到「运营看板」标签页**；普通账号只有访问统计，
//    且标签栏整个不渲染（一个 Tab 的 Tab 栏纯属噪音）；
// 2. **普通账号不会白发 /api/stats**：未选中的面板不挂载，
//    请求只发生在 owner 真的切到运营看板时；
// 3. 切标签页只是换面板，弹窗不关。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import StatsHubDialog from "../src/components/StatsHubDialog";
import type { NavigationClient } from "../src/API/client";
import type { OpsStatsResponse } from "../src/API/responses";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let anchor: HTMLButtonElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    anchor?.remove();
    root = null;
    host = null;
    anchor = null;
    document.body.innerHTML = "";
}

function makeClient(spy?: { calls: number }): NavigationClient {
    return {
        getOpsStats: () => {
            if (spy) spy.calls += 1;
            // 永远不 resolve：停在 loading 态就够了，本测试不关心数据
            return new Promise<OpsStatsResponse>(() => {});
        },
    } as unknown as NavigationClient;
}

function mount(ui: ReactElement) {
    anchor = document.createElement("button");
    anchor.textContent = "设置";
    document.body.appendChild(anchor);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(ui));
}

const hubText = () => document.body.textContent ?? "";
const tabs = () =>
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map(t => (t.textContent || "").trim());

test("owner：两个标签页，默认落在访问统计", t => {
    t.after(cleanup);
    mount(
        <StatsHubDialog
            open
            onClose={() => { }}
            client={makeClient()}
            isSiteOwner
            nameOf={() => "某网站"}
        />
    );
    assert.deepEqual(tabs(), ["访问统计", "运营看板"]);
    assert.ok(hubText().includes("统计"), "标题是「统计」");
    // 默认面板是访问统计（本机无记录时的空态文案）
    assert.ok(hubText().includes("还没有访问记录"), "默认应落在访问统计");
});

test("普通账号：只有访问统计，标签栏整个不渲染，也不会白发 /api/stats", t => {
    t.after(cleanup);
    const spy = { calls: 0 };
    mount(
        <StatsHubDialog
            open
            onClose={() => { }}
            client={makeClient(spy)}
            isSiteOwner={false}
            nameOf={() => "某网站"}
        />
    );
    assert.deepEqual(tabs(), [], "一个 Tab 的 Tab 栏不该出现");
    assert.ok(hubText().includes("还没有访问记录"), "访问统计要在");
    assert.ok(!hubText().includes("运营看板"), "不该出现运营看板相关内容");
    assert.equal(spy.calls, 0, "没切到运营看板就不该请求 /api/stats");
});

test("owner 切到运营看板：面板挂载并请求 /api/stats（停在加载态也算）", async t => {
    t.after(cleanup);
    const spy = { calls: 0 };
    mount(
        <StatsHubDialog
            open
            onClose={() => { }}
            client={makeClient(spy)}
            isSiteOwner
            nameOf={() => "某网站"}
        />
    );
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        t2 => (t2.textContent || "").trim() === "运营看板"
    );
    assert.ok(tab, "应有运营看板标签页");
    await act(async () => {
        tab!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
    assert.equal(spy.calls, 1, "切过去才发请求");
    assert.ok(hubText().includes("运营看板"), "面板 aria-label 文本应出现");
});
