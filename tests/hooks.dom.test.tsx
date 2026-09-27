// tests/hooks.dom.test.tsx
// 给「批量多选」和「弹窗编排」两个域 hook 补的组件级用例。
// 这俩 hook 是上轮 App.tsx 瘦身时抽出来的（useMultiSelect / useAppDialogs），
// 当时零测试覆盖。它们只管状态、不碰网络，用一个小宿主组件把状态渲染到 DOM、
// 再用按钮触发 setter，就能在 jsdom 里把行为钉死，且不影响任何现有 UI。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { useMultiSelect } from "../src/hooks/useMultiSelect";
import { useAppDialogs } from "../src/hooks/useAppDialogs";
import type { DuplicateHit } from "../src/utils/duplicate";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

function mount(node: ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

const text = (id: string): string => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `应有 [data-testid="${id}"]`);
    return (el!.textContent || "").trim();
};

async function click(id: string) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `应有 [data-testid="${id}"]`);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

// ---------------- useMultiSelect ----------------
function MultiHarness() {
    const m = useMultiSelect();
    return (
        <div>
            <span data-testid="mode">{m.multiSelect ? "on" : "off"}</span>
            <span data-testid="sel">{m.selectedIds.join(",")}</span>
            <button data-testid="enter" onClick={() => m.setMultiSelect(true)}>enter</button>
            <button data-testid="exit" onClick={() => m.exitMultiSelect()}>exit</button>
            <button data-testid="t1" onClick={() => m.toggleSelect(1)}>t1</button>
            <button data-testid="t2" onClick={() => m.toggleSelect(2)}>t2</button>
            <button data-testid="t1b" onClick={() => m.toggleSelect(1)}>t1b</button>
            <button data-testid="clear" onClick={() => m.clearSelection()}>clear</button>
            <button data-testid="off" onClick={() => m.setMultiSelect(false)}>off</button>
        </div>
    );
}

test("useMultiSelect：初始关闭、无勾选", t => {
    t.after(cleanup);
    mount(<MultiHarness />);
    assert.equal(text("mode"), "off");
    assert.equal(text("sel"), "");
});

test("useMultiSelect：toggle 累加勾选，再点同一个取消", async t => {
    t.after(cleanup);
    mount(<MultiHarness />);
    await click("t1");
    await click("t2");
    assert.equal(text("sel"), "1,2", "两次勾选应累加");
    await click("t1b");
    assert.equal(text("sel"), "2", "再点已勾选的应取消");
});

test("useMultiSelect：clearSelection 只清勾选，保留多选模式", async t => {
    t.after(cleanup);
    mount(<MultiHarness />);
    await click("enter");
    await click("t1");
    await click("clear");
    assert.equal(text("sel"), "", "勾选应清空");
    assert.equal(text("mode"), "on", "多选模式应保留");
});

test("useMultiSelect：exitMultiSelect 退出同时清空勾选", async t => {
    t.after(cleanup);
    mount(<MultiHarness />);
    await click("enter");
    await click("t1");
    await click("t2");
    await click("exit");
    assert.equal(text("mode"), "off", "应退出多选模式");
    assert.equal(text("sel"), "", "退出应顺手清空勾选，避免下次残留");
});

test("useMultiSelect：setMultiSelect(false) 也清空勾选", async t => {
    t.after(cleanup);
    mount(<MultiHarness />);
    await click("enter");
    await click("t1");
    await click("off");
    assert.equal(text("mode"), "off");
    assert.equal(text("sel"), "", "关掉多选模式时勾选应一并清空");
});

// ---------------- useAppDialogs ----------------
function DialogHarness() {
    const d = useAppDialogs();
    const dummyHit = { site: { id: 1, name: "x", url: "https://x.com" }, groupName: "g" } as unknown as DuplicateHit;
    return (
        <div>
            <span data-testid="cmd">{d.commandOpen ? "1" : "0"}</span>
            <span data-testid="vis">{d.openVisits ? "1" : "0"}</span>
            <span data-testid="dup">{d.dupPrompt ? "1" : "0"}</span>
            <button data-testid="openCmd" onClick={() => d.setCommandOpen(true)}>openCmd</button>
            <button data-testid="setDup" onClick={() => d.setDupPrompt({ url: "https://x.com", hit: dummyHit, run: () => {} })}>
                setDup
            </button>
            <button data-testid="clearDup" onClick={() => d.setDupPrompt(null)}>clearDup</button>
            <button data-testid="openVis" onClick={() => d.setOpenVisits(true)}>openVis</button>
        </div>
    );
}

test("useAppDialogs：初始全关、无重复确认", t => {
    t.after(cleanup);
    mount(<DialogHarness />);
    assert.equal(text("cmd"), "0");
    assert.equal(text("vis"), "0");
    assert.equal(text("dup"), "0");
});

test("useAppDialogs：setCommandOpen 打开命令面板", async t => {
    t.after(cleanup);
    mount(<DialogHarness />);
    await click("openCmd");
    assert.equal(text("cmd"), "1");
});

test("useAppDialogs：setDupPrompt 挂上重复确认，setDupPrompt(null) 关闭", async t => {
    t.after(cleanup);
    mount(<DialogHarness />);
    await click("setDup");
    assert.equal(text("dup"), "1", "应弹出重复确认");
    await click("clearDup");
    assert.equal(text("dup"), "0", "清空后应关闭");
});

test("useAppDialogs：各弹窗开关相互独立", async t => {
    t.after(cleanup);
    mount(<DialogHarness />);
    await click("openCmd");
    await click("openVis");
    await click("setDup");
    assert.equal(text("cmd"), "1");
    assert.equal(text("vis"), "1");
    assert.equal(text("dup"), "1", "三个开关应互不影响");
});
