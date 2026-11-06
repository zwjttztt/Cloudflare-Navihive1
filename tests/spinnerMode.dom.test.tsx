// tests/spinnerMode.dom.test.tsx
// Spinner 只干两件事：给出 role=progressbar（读屏知道在等），以及把「当前是哪一档色」
// 告诉 CSS（data-mode）。颜色与尺寸全在 index.html 的 `.bs-spinner` 那**一处**定义里，
// 节点上不许出现内联样式 —— 一旦有人用 sx / style 把颜色补回来，
// 就又变成第二份规格了（这正是本次要消灭的东西）。
//
// 为什么这条值得有 DOM 层：`data-mode` 是暗色档的**唯一**开关，
// 它要是没真的落到 DOM 上（比如被 MUI 的 Box 过滤掉），暗色下就会静默用亮色环 ——
// 静态读码的守卫看不出来，用户看得出来。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import Spinner from "../src/components/Spinner";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(mode: "light" | "dark") {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <ThemeProvider theme={createTheme({ palette: { mode } })}>
                <Spinner />
            </ThemeProvider>
        );
    });
    return host.querySelector("[role='progressbar']") as HTMLElement;
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

test("亮/暗两档都通过 data-mode 交给 CSS，节点上没有内联样式", t => {
    t.after(cleanup);
    const light = render("light");
    assert.equal(light.getAttribute("data-mode"), "light", "亮色档要打 data-mode=light");
    assert.equal(
        light.classList.contains("bs-spinner"),
        true,
        // 类名必须与 index.html 里那条唯一定义同名 —— 否则 React 渲染的环没有任何样式
        "样式靠 index.html 的 .bs-spinner 那条规则（全站唯一一处定义）"
    );
    assert.equal(
        light.getAttribute("style"),
        null,
        "⛔ 不许出现内联样式 —— 尺寸/颜色只能在 index.html 的 .bs-spinner 里"
    );
    cleanup();

    const dark = render("dark");
    assert.equal(
        dark.getAttribute("data-mode"),
        "dark",
        "暗色档要打 data-mode=dark（别改成等 html.dark：那是由 useEffect 挂的，首帧会闪一下）"
    );
    assert.equal(dark.getAttribute("aria-label"), null, "别自带可访问名：外层 role=status 已经念过一遍");
});

test("className 透传是叠加、不是覆盖（默认类名不能丢）", t => {
    t.after(cleanup);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <ThemeProvider theme={createTheme()}>
                <Spinner className='nav-extra' />
            </ThemeProvider>
        );
    });
    const node = host.querySelector("[role='progressbar']") as HTMLElement;
    assert.equal(node.classList.contains("bs-spinner"), true, "透传 className 时默认类名不能在拼接里丢掉");
    assert.equal(node.classList.contains("nav-extra"), true, "调用方的类名要真的挂上去");
});
