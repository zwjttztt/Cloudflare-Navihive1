// tests/useThemeController.dom.test.tsx
// 主题模式的三档循环与持久化。
//
// 为什么补它：这个 hook 里最容易被改坏的是 toggleTheme 的循环顺序 ——
// 浅色 → 深色 → 跟随系统，且「跟随系统」时还要按**系统当前是深还是浅**决定下一档，
// 保证「点一下一定有变化」。改错一处的表现是「点主题按钮没反应」，
// 而它不报错、不产生任何日志，只有用户自己发现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useThemeController } from "../src/hooks/useThemeController";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom 不实现 matchMedia，运行器给的是「永不匹配」的替身。这里换成可控的 */
function setSystemPrefersDark(dark: boolean) {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
        matches: dark,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

function Harness() {
    const [accent] = useState("#1976d2");
    const t = useThemeController(accent);
    return (
        <div>
            <span data-testid="mode">{t.themeMode}</span>
            <span data-testid="dark">{String(t.darkMode)}</span>
            <span data-testid="palette">{t.theme.palette.mode}</span>
            <button data-testid="toggle" onClick={t.toggleTheme}>toggle</button>
        </div>
    );
}

function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
}

const text = (id: string) =>
    (document.querySelector(`[data-testid="${id}"]`)?.textContent || "").trim();

async function toggle() {
    const el = document.querySelector<HTMLButtonElement>('[data-testid="toggle"]');
    assert.ok(el);
    await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

test("没存过偏好：默认跟随系统，系统浅色时页面就是浅色", t => {
    t.after(cleanup);
    localStorage.removeItem("theme");
    setSystemPrefersDark(false);
    mount();
    assert.equal(text("mode"), "system");
    assert.equal(text("dark"), "false");
    assert.equal(text("palette"), "light");
});

test("系统深色 + 跟随系统：页面跟着变深", t => {
    t.after(cleanup);
    localStorage.removeItem("theme");
    setSystemPrefersDark(true);
    mount();
    assert.equal(text("mode"), "system");
    assert.equal(text("dark"), "true", "跟随系统、系统是深色时应为深色");
});

test("存过 dark / light 时不跟着系统走", t => {
    t.after(cleanup);
    setSystemPrefersDark(true);
    localStorage.setItem("theme", "light");
    mount();
    assert.equal(text("mode"), "light");
    assert.equal(text("dark"), "false", "显式选了浅色就不该被系统深色覆盖");
});

test("存的是脏值（比如 'Dark' 或旧字段名）：回落到跟随系统，不渲染出坏主题", t => {
    t.after(cleanup);
    localStorage.setItem("theme", "dark-mode");
    setSystemPrefersDark(false);
    mount();
    assert.equal(text("mode"), "system");
    assert.ok(["light", "dark"].includes(text("palette")), `palette 应合法，实际 ${text("palette")}`);
});

test("三档循环：浅色 → 深色 → 跟随系统，每次点都要有变化并写回 localStorage", async t => {
    t.after(cleanup);
    localStorage.setItem("theme", "light");
    setSystemPrefersDark(false); // 系统浅色
    mount();
    assert.equal(text("mode"), "light");

    await toggle();
    assert.equal(text("mode"), "dark");
    assert.equal(text("dark"), "true");
    assert.equal(localStorage.getItem("theme"), "dark", "切换后应立刻持久化");

    await toggle();
    assert.equal(text("mode"), "system");
    assert.equal(localStorage.getItem("theme"), "system");

    // 回到「跟随系统」后系统仍是浅色，下一档给深色（见下面两条用例）
    await toggle();
    assert.equal(text("mode"), "dark");
});

test("跟随系统且系统为深色时，下一档给浅色（否则点下去深浅没变，像没生效）", async t => {
    t.after(cleanup);
    localStorage.setItem("theme", "system");
    setSystemPrefersDark(true);
    mount();
    assert.equal(text("dark"), "true");
    await toggle();
    assert.equal(text("mode"), "light", "系统深色时从「跟随」切出去要给浅色，保证有可见变化");
    assert.equal(text("dark"), "false");
});

test("跟随系统且系统为浅色时，下一档给深色（同样是为了「点一下就有反应」）", async t => {
    t.after(cleanup);
    localStorage.setItem("theme", "system");
    setSystemPrefersDark(false);
    mount();
    await toggle();
    assert.equal(text("mode"), "dark");
});
