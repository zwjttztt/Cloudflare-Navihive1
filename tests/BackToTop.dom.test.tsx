// tests/BackToTop.dom.test.tsx
// BackToTop 浮层行为：滚动阈值 / 点击滚回顶部 / 焦点可达性
//
// 几个关键约束：
// - 不可见时 pointer-events:none + tabIndex=-1 + aria-hidden=true：键盘 Tab 不能落到它上面
// - 可见时反过来；点击要触发 window.scrollTo
// - 阈值是 innerHeight * 0.35，跨边界测试

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BackToTop from "../src/components/BackToTop";

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

function fab(): HTMLElement | null {
    return document.querySelector(".nav-back-to-top");
}

function setScroll(y: number) {
    // jsdom 里 window.scrollY 是 getter；用 Object.defineProperty 替身
    Object.defineProperty(window, "scrollY", {
        configurable: true,
        get: () => y,
    });
    Object.defineProperty(document.documentElement, "scrollTop", {
        configurable: true,
        get: () => y,
    });
    window.dispatchEvent(new Event("scroll"));
}

test("BackToTop：不可见时 aria-hidden=true, tabIndex=-1", t => {
    t.after(cleanup);
    // innerHeight 在 jsdom 里默认 768；scrollY=0 → 0 < 768*0.35=268 → 不可见
    setScroll(0);
    mount(<BackToTop />);

    const el = fab();
    assert.ok(el, "应渲染出 fab 元素");
    assert.equal(el!.getAttribute("aria-hidden"), "true");
    assert.equal(el!.getAttribute("tabindex"), "-1");
});

test("BackToTop：滚过阈值后变为可见 + 可获焦", t => {
    t.after(cleanup);
    // 滚到 innerHeight*0.4 = 768*0.4 = 307 > 768*0.35 = 268 → 可见
    setScroll(400);
    mount(<BackToTop />);

    const el = fab();
    assert.equal(el!.getAttribute("aria-hidden"), "false");
    assert.equal(el!.getAttribute("tabindex"), "0");
});

test("BackToTop：阈值边界——正好等于 innerHeight*0.35 仍不可见（用 > 不用 >=）", t => {
    t.after(cleanup);
    Object.defineProperty(window, "innerHeight", {
        configurable: true,
        get: () => 1000,
    });
    setScroll(350); // 0.35 * 1000 = 350，刚好等于阈值
    mount(<BackToTop />);

    const el = fab();
    assert.equal(el!.getAttribute("aria-hidden"), "true");
});

test("BackToTop：阈值边界——比阈值多 1 立即可见", t => {
    t.after(cleanup);
    Object.defineProperty(window, "innerHeight", {
        configurable: true,
        get: () => 1000,
    });
    setScroll(351); // 比 350 多 1
    mount(<BackToTop />);

    const el = fab();
    assert.equal(el!.getAttribute("aria-hidden"), "false");
});

test("BackToTop：点击 fab 调用 window.scrollTo 平滑回顶", t => {
    t.after(cleanup);
    setScroll(500);
    mount(<BackToTop />);

    let called = false;
    let calledWith: unknown = null;
    const orig = window.scrollTo;
    window.scrollTo = (opts) => {
        called = true;
        calledWith = opts;
    };
    try {
        const el = fab();
        act(() => {
            el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        assert.equal(called, true);
        assert.deepEqual(calledWith, { top: 0, behavior: "smooth" });
    } finally {
        window.scrollTo = orig;
    }
});

test("BackToTop：滚动后从可见变不可见，aria/tabIndex/pointer-events 同步翻转", t => {
    t.after(cleanup);
    setScroll(500);
    mount(<BackToTop />);
    assert.equal(fab()!.getAttribute("aria-hidden"), "false");

    // 滚回顶部
    act(() => {
        setScroll(0);
    });

    assert.equal(fab()!.getAttribute("aria-hidden"), "true");
    assert.equal(fab()!.getAttribute("tabindex"), "-1");
});