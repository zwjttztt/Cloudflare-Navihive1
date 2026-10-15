// tests/BuildBadge.dom.test.tsx
// 右下角部署版本徽标。
//
// 关键约束：
// - 版本号为空（开发模式 / 单测没有 define）→ 不渲染，右下角不留杂物
// - 渲染时要带版本号文本，title 提示里带上构建时间
// - pointer-events 必须是 none：徽标贴着右下角，那里常有翻页/悬浮操作，
//   一层看不见的 div 挡住点击就是「点了没反应」的灵异故障

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BuildBadge from "../src/components/BuildBadge";

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

test("渲染版本号与构建时间提示", t => {
    t.after(cleanup);
    mount(<BuildBadge version="v0.1.0+c49c59f" builtAt="2026-10-15 17:30" />);

    const el = document.querySelector("[title]") as HTMLElement | null;
    assert.ok(el !== null, "应渲染出带 title 的徽标节点");
    assert.equal(el.textContent, "v0.1.0+c49c59f");
    assert.equal(el.getAttribute("title"), "部署版本 v0.1.0+c49c59f · 构建于 2026-10-15 17:30");
});

test("没有构建时间时 title 只含版本号", t => {
    t.after(cleanup);
    mount(<BuildBadge version="v0.1.0+1760511123456" builtAt="" />);

    const el = document.querySelector("[title]") as HTMLElement | null;
    assert.ok(el !== null);
    assert.equal(el.getAttribute("title"), "部署版本 v0.1.0+1760511123456");
});

test("版本号为空（开发模式没烘 define）→ 不渲染", t => {
    t.after(cleanup);
    mount(<BuildBadge version="" builtAt="" />);

    // ⚠️ mount 的 host div 本身挂在 body 上，判「没渲染」要看 host 内部
    assert.ok(host!.firstChild === null, "host 里不应有任何节点");
});

test("pointer-events 必须是 none：右下角永远不挡点击", t => {
    t.after(cleanup);
    mount(<BuildBadge version="v0.1.0+abc1234" />);

    const el = document.querySelector("[title]") as HTMLElement | null;
    assert.ok(el !== null);
    assert.equal(el.style.pointerEvents, "none");
    assert.equal(el.style.position, "fixed");
});
