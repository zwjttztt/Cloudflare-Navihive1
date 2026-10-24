// tests/ThemeToggle.dom.test.tsx
// 顶栏胶囊里的主题三档切换。
//
// 为什么补这个用例：它在覆盖率报表里一直是「零触及」（2026-10-24 全站复查的
// 未触及名单第二名，60 行）。三档循环是纯展示逻辑，改错了没人拦得住：
// 图标/文案/可访问名对不上档位时，用户看到的是「点了一下没变化」或者
// 读屏念出来的档位跟实际相反。

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ThemeToggle, { type ThemeMode } from "../src/components/ThemeToggle";

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

/** 三档的可访问名预期：读屏与自动化都靠它认档位 */
const LABEL: Record<ThemeMode, string> = {
    light: "主题：浅色",
    dark: "主题：深色",
    system: "主题：跟随系统",
};

test("三档各自渲染出对应的可访问名（读屏念的档位必须和实际一致）", () => {
    for (const mode of ["light", "dark", "system"] as ThemeMode[]) {
        mount(<ThemeToggle mode={mode} onToggle={() => {}} />);
        const btn = document.querySelector(".nav-theme-toggle") as HTMLButtonElement | null;
        assert.ok(btn, `${mode} 档要渲染出按钮`);
        assert.equal(btn!.getAttribute("aria-label"), LABEL[mode]);
        cleanup();
    }
});

test("点击回调：按钮可点且真的调用 onToggle", () => {
    let calls = 0;
    mount(<ThemeToggle mode='light' onToggle={() => calls++} />);
    const btn = document.querySelector(".nav-theme-toggle") as HTMLButtonElement;
    assert.ok(btn, "按钮要存在");
    act(() => {
        btn.click();
    });
    assert.equal(calls, 1, "点一次就该回调一次（切换由父组件决定，这里只管把点击传出去）");
    cleanup();
});
