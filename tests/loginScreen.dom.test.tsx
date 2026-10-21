// tests/loginScreen.dom.test.tsx
// A8 登录页品牌化（2026-10-22）里「外壳」那一半：背景光斑 + 一句话介绍的透传。
// 表单内部的断言在 loginForm.dom.test.tsx，这里只管 LoginScreen 这个壳。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTheme } from "@mui/material/styles";
import LoginScreen from "../src/components/LoginScreen";
import { BRAND } from "../src/brand";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
});

function mount(props: Partial<Parameters<typeof LoginScreen>[0]> = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<LoginScreen theme={createTheme()} {...props} />);
    });
}

/** 登录表单是 lazy chunk：等它挂上（转圈消失、表单出现） */
async function waitForm() {
    for (let i = 0; i < 50; i += 1) {
        await act(async () => { await new Promise(r => setTimeout(r, 10)); });
        if (document.querySelector("[data-brand-tagline='1']")) return;
    }
    assert.fail("登录表单没挂上来（lazy chunk 没加载？）");
}

test("品牌背景：主色静态光斑（不是会动的极光，登录页不烧 GPU）", async () => {
    mount();
    await waitForm();
    const shell = host!.firstElementChild as HTMLElement;
    const bg = getComputedStyle(shell).backgroundImage;
    assert.ok(bg.includes("radial-gradient"), "要有径向渐变光斑，别是一块纯色");
    // 光斑取主题主色（默认 #1976d2 → rgb(25, 118, 210)），透明度压得很低
    assert.ok(bg.includes("25, 118, 210"), "光斑要用主题主色");
    assert.ok(
        getComputedStyle(shell).backgroundAttachment === "fixed",
        "光斑钉在视口上（这一屏真滚时背景不窜）"
    );
});

test("一句话介绍：默认用 BRAND.description，也可由上层覆盖", async () => {
    mount();
    await waitForm();
    assert.equal(
        document.querySelector("[data-brand-tagline='1']")?.textContent,
        BRAND.description,
        "默认透传品牌配置里那句话"
    );
    act(() => root!.unmount());
    host?.remove();
    document.body.innerHTML = "";
    mount({ brandTagline: "测试用的一句话" });
    await waitForm();
    assert.equal(
        document.querySelector("[data-brand-tagline='1']")?.textContent,
        "测试用的一句话",
        "上层传了就用上层的（站点改定位时不用改代码）"
    );
});
