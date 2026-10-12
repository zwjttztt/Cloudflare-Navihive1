// tests/maintenanceBanner.dom.test.tsx
// 维护模式横幅：服务端报 maintenance 时才挂，且轮询要在卸载时停掉。
//
// 为什么值得单测：这是个**常驻轮询**组件（60s 一次）。忘了清理定时器的话，
// 每次切页面都多一个永远在跑的 interval —— 这种泄漏在测试里看不出来，
// 只在用户机器上慢慢变卡，所以「卸载即停」必须钉死。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import MaintenanceBanner from "../src/components/MaintenanceBanner";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host = null;
});

function mount(client: { checkMaintenance: () => Promise<boolean> }) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<MaintenanceBanner client={client} />);
    });
}

test("服务端在维护中：挂出横幅，并说明「能看不能写」", async () => {
    mount({ checkMaintenance: async () => true });
    // 等一轮 effect 里的首次探测
    await act(async () => {
        await Promise.resolve();
    });
    const bar = document.querySelector('[role="status"]');
    assert.ok(bar !== null, "该挂出横幅");
    assert.match(bar.textContent || "", /维护中/);
    assert.match(bar.textContent || "", /查看/);
});

test("不在维护中：什么都不挂（不占地方）", async () => {
    mount({ checkMaintenance: async () => false });
    await act(async () => {
        await Promise.resolve();
    });
    assert.equal(document.querySelector('[role="status"]'), null);
});

test("探测失败不打扰用户（下个周期再试），且不挂横幅", async () => {
    mount({
        checkMaintenance: async () => {
            throw new Error("network");
        },
    });
    await act(async () => {
        await Promise.resolve();
    });
    assert.equal(document.querySelector('[role="status"]'), null);
});

test("卸载后停掉轮询（不泄漏 interval）", async () => {
    let calls = 0;
    mount({
        checkMaintenance: async () => {
            calls += 1;
            return false;
        },
    });
    await act(async () => {
        await Promise.resolve();
    });
    const afterMount = calls;
    act(() => root!.unmount());
    root = null;
    // 等过一小段时间（远小于 60s 的轮询周期，但足以让漏掉的 timer 触发一次）
    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls, afterMount, `卸载后不该再探测，实际又发了 ${calls - afterMount} 次`);
});
