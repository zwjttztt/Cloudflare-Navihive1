// tests/overlayScrollLock.dom.test.tsx
// 全站弹层背景滚动锁（useOverlayScrollLock）的组件级用例。
//
// 背景：本 app 的滚动容器是 viewport（html）。MUI 的内置锁只碰 body 锁不住它，
// 所以由 App 顶层常驻的 useOverlayScrollLock 统一管理 documentElement 的
// overflow 锁定 / 还原。这里钉死三条最要命的回归线：
//   1. 弹层打开 → html overflow 必须变 hidden（否则背景照样能滚）；
//   2. 全部弹层关闭 → 必须还原成上锁前的值（**不能留成 hidden**——
//      「关掉弹层后背景永久锁死」正是双重管理 prev 时最危险的回归）；
//   3. 嵌套弹层：关掉内层不解锁，最后一个关掉才还原。
//
// ⚠️ 测试技法：移除弹层要「整棵卸载」（从渲染树里拿掉），而不是把 open 翻成
// false —— open=false 会走 MUI 的退出过渡，jsdom 里 transitionend 永不触发，
// .MuiModal-root 会一直赖在 DOM 里，observer 就永远看不到「弹层消失」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useEffect, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import Dialog from "@mui/material/Dialog";
import { useOverlayScrollLock } from "../src/hooks/useOverlayScrollLock";

// 生产里 useThemeController 已把 MuiDialog 的 disableScrollLock 全局设成 true
// （MUI 自己不去锁 body，滚动锁完全交给 useOverlayScrollLock）。测试用同一套
// 主题，保证行为与线上一致，而不是 MUI 裸默认（裸默认会让 MUI 去锁 body，
// 混入与被测对象无关的副作用）。
const theme = createTheme({
    components: { MuiDialog: { defaultProps: { disableScrollLock: true } } },
});

/** 模拟 App 顶层挂一次的锁宿主。 */
function LockHost(): null {
    useOverlayScrollLock();
    return null;
}

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

function rerender(ui: ReactElement) {
    act(() => {
        root!.render(ui);
    });
}

/** MutationObserver 回调是微任务：等一拍再断言，否则锁还没来得及落上/摘下。 */
async function flushObserver() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
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

const htmlOverflow = () => document.documentElement.style.overflow;
const htmlPaddingRight = () => document.documentElement.style.paddingRight;

const dialog = (key: string) => (
    <Dialog open key={key}>
        <div>{key}</div>
    </Dialog>
);

test("弹层打开时锁 html overflow，全部关闭后还原（不留永久锁）", async t => {
    t.after(cleanup);

    // 1. 挂载时没有弹层：不许提前上锁
    mount(
        <ThemeProvider theme={theme}>
            <LockHost />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "", "没有弹层时不应锁滚动");

    // 2. 弹层 A 打开：html 必须被锁住（这是阻止背景滚轮生效的那一刀）
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
            {dialog("A")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "弹层打开时 html overflow 应为 hidden");
    assert.equal(
        document.documentElement.style.getPropertyValue("scrollbar-gutter"),
        "auto",
        "stable 槽位必须同时收掉，否则空槽 + padding 双份白边（用户实测的白条回归线）"
    );

    // 3. 弹层 A 关闭（整棵卸载）：必须还原成上锁前的值，**不能留成 hidden**
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "", "弹层全部关闭后 overflow 必须还原（永久锁死回归线）");
    assert.equal(htmlPaddingRight(), "", "padding 补偿也要一并还原");
    assert.equal(
        document.documentElement.style.getPropertyValue("scrollbar-gutter"),
        "",
        "scrollbar-gutter 也要还原成样式表里的 stable"
    );
});

test("嵌套弹层：关掉内层不解锁，最后一个关掉才还原", async t => {
    t.after(cleanup);

    // 1. 挂载即带弹层 A（覆盖 hook 初始化 sync() 的「挂载时已有弹层」路径）
    mount(
        <ThemeProvider theme={theme}>
            <LockHost />
            {dialog("A")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "挂载时已有弹层就应立刻上锁");

    // 2. 再叠一层 B（模拟弹窗里再弹确认框）：仍然锁着
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
            {dialog("A")}
            {dialog("B")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden");

    // 3. 只关 B，A 还开着：不许解锁
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
            {dialog("A")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "A 还开着，不应解锁");

    // 4. 最后一个也关掉：还原
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "", "最后一个弹层关闭后必须还原");
    assert.equal(htmlPaddingRight(), "");
});

/** 模拟记事本的 useScrollLock：挂载期同步锁 html，卸载时还原（另一位置的所有者）。 */
function OwnerLock(): null {
    useEffect(() => {
        document.documentElement.style.overflow = "hidden";
        return () => {
            document.documentElement.style.overflow = "";
        };
    }, []);
    return null;
}

test("html 已被其他所有者锁住时只跟随不接管（所有权规则）", async t => {
    t.after(cleanup);

    // 1. 先挂「记事本」（OwnerLock），它同步锁住 html
    mount(
        <ThemeProvider theme={theme}>
            <LockHost />
            <OwnerLock />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "前置：所有者已把 html 锁上");

    // 2. 弹层打开：所有者在场，全局锁只跟随，不接管 overflow
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
            <OwnerLock />
            {dialog("A")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden");

    // 3. 弹层关闭、所有者还在：不能代所有者解锁，也不该动它
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
            <OwnerLock />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "所有者还在锁，全局锁不得写回/解锁 overflow");

    // 4. 所有者自己还原，全局锁不残留
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "", "所有者卸载还原后，html 必须回到可滚状态");
});

test("与其他锁共存后一起卸载，不得把 html 永久锁死（prev 污染回归线）", async t => {
    t.after(cleanup);

    // 复现真实顺序：记事本（OwnerLock）先锁 html → 其内部弹窗打开（全局锁跟随、
    // 把 prev 污染成 "hidden"）→ 记事本卸载（同步还原 html=""）→ observer **随后**
    // 才解锁。若全局锁无所有权规则，这一拍会把污染的 "hidden" 写回 html，
    // 整站永久锁死。真机影响：关掉记事本后导航站滚不动。
    mount(
        <ThemeProvider theme={theme}>
            <LockHost />
            <OwnerLock />
            {dialog("A")}
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(htmlOverflow(), "hidden", "前置：所有者 + 弹层都在锁");

    // 记事本和它的弹窗一起卸载（全局锁宿主 App 仍挂载）
    rerender(
        <ThemeProvider theme={theme}>
            <LockHost />
        </ThemeProvider>
    );
    await flushObserver();
    assert.equal(
        htmlOverflow(),
        "",
        "所有者与弹层一起卸载后不得残留 hidden —— 这是永久锁死回归线"
    );
    assert.equal(htmlPaddingRight(), "");
    assert.equal(document.documentElement.style.getPropertyValue("scrollbar-gutter"), "");
});
