// tests/viewportUi.dom.test.tsx
// 视口那一簇状态：hooks/useViewportUi。
//
// 这块原先在 App.tsx 里，一条用例都没有。它管的都是「写错了不报错、只有手点才能发现」的事：
// 窗口从窄拉宽之后菜单飘到左上角（anchor 已经从 DOM 分离，MUI 下次重定位拿到全零坐标）、
// 头部该收紧时不收紧、左栏高亮的分组和实际看到的不是一个。
// 搬出来之后可以用 jsdom 造 detached 的锚点、改 scrollY，把这些守卫钉住。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useViewportUi, type ViewportUiState } from "../src/hooks/useViewportUi";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: ViewportUiState | null = null;

type ProbeProps = { loading?: boolean; groupCount?: number };

function Probe({ loading = false, groupCount = 0 }: ProbeProps) {
    const ui = useViewportUi({ loading, groupCount });
    latest = ui;
    return (
        <div>
            <span data-testid="compact">{String(ui.headerCompact)}</span>
            <span data-testid="active">{ui.activeGroupId === null ? "null" : ui.activeGroupId}</span>
            <span data-testid="menu">{ui.menuAnchorEl?.id ?? "null"}</span>
            <span data-testid="groups">{ui.mobileGroupsAnchor?.id ?? "null"}</span>
            <span data-testid="openMenu">{String(ui.openMenu)}</span>
        </div>
    );
}

function mount(props: ProbeProps = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(<Probe {...props} />);
    });
}

const cleanup = () => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    latest = null;
    document.querySelectorAll("[data-group-anchor]").forEach(n => n.remove());
    document.querySelectorAll(".nav-mobile-tabbar").forEach(n => n.remove());
    setScrollY(0);
};

afterEach(cleanup);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setScrollY(y: number) {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

async function scrollTo(y: number) {
    setScrollY(y);
    await act(async () => {
        window.dispatchEvent(new Event("scroll"));
        await sleep(60); // 等 requestAnimationFrame 那一帧
    });
}

const text = (id: string) => {
    const el = host!.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `找不到 [data-testid=${id}]`);
    return el.textContent ?? "";
};

/** 带 id 的按钮，方便在 DOM 文本里认出「现在挂着的是谁」 */
function button(id: string, parent?: HTMLElement): HTMLButtonElement {
    const el = document.createElement("button");
    el.id = id;
    (parent ?? document.body).appendChild(el);
    return el;
}

/** 底栏：跨过断点时整个卸载，挂在它上面的菜单锚点会跟着失效 */
function tabBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "nav-mobile-tabbar";
    document.body.appendChild(bar);
    return bar;
}

/** 分组锚点节点：jsdom 的 getBoundingClientRect 全是 0，得自己给一份 */
function groupAnchor(id: number, top: number): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("data-group-anchor", String(id));
    el.getBoundingClientRect = () =>
        ({ top, bottom: top + 100, left: 0, right: 120, width: 120, height: 100 }) as DOMRect;
    document.body.appendChild(el);
    return el;
}

function resize() {
    act(() => {
        window.dispatchEvent(new Event("resize"));
    });
}

// ---------- resize：锚点已经脱离文档就收掉 ----------

test("resize 时收掉已经从 DOM 分离的菜单锚点（否则菜单会飘到左上角）", () => {
    mount();
    const btn = button("menu-btn");
    act(() => latest!.setMenuAnchorEl(btn));
    assert.equal(text("menu"), "menu-btn");

    resize();
    assert.equal(text("menu"), "menu-btn", "锚点还在文档里，不该收");

    btn.remove();
    resize();
    assert.equal(text("menu"), "null", "锚点脱离文档后必须收掉");
});

test("同一个 resize 守卫也管着「分组」菜单的锚点", () => {
    mount();
    const btn = button("groups-btn");
    act(() => latest!.setMobileGroupsAnchor(btn));
    assert.equal(text("groups"), "groups-btn");

    btn.remove();
    resize();
    assert.equal(text("groups"), "null");
});

// ---------- 两个 handleExit 各自只收自己那份 ----------

test("底栏退场：只收挂在底栏按钮上的弹层，顶栏自己的别误伤", () => {
    mount();
    const bar = tabBar();
    const bottomBtn = button("bottom-btn", bar);
    const topBtn = button("top-btn");
    act(() => {
        latest!.setMenuAnchorEl(bottomBtn);
        latest!.setMobileGroupsAnchor(bottomBtn);
    });

    act(() => latest!.handleExitMobileViewport());
    assert.equal(text("menu"), "null", "挂在底栏上的那份要收");
    assert.equal(text("groups"), "null");

    act(() => {
        latest!.setMenuAnchorEl(topBtn);
        latest!.setMobileGroupsAnchor(topBtn);
    });
    act(() => latest!.handleExitMobileViewport());
    assert.equal(text("menu"), "top-btn", "顶栏那份不该被底栏退场收掉");
    assert.equal(text("groups"), "top-btn");
});

test("顶栏「分组」按钮退场：只收顶栏那份，底栏那份归另一个 handleExit 管", () => {
    mount();
    const bar = tabBar();
    const bottomBtn = button("bottom-btn", bar);
    const topBtn = button("top-btn");

    act(() => latest!.setMobileGroupsAnchor(topBtn));
    act(() => latest!.handleExitGroupsButtonViewport());
    assert.equal(text("groups"), "null", "顶栏那份要收");

    act(() => latest!.setMobileGroupsAnchor(bottomBtn));
    act(() => latest!.handleExitGroupsButtonViewport());
    assert.equal(
        text("groups"),
        "bottom-btn",
        "底栏还开着菜单时，视口变化不该被顶栏那份误伤"
    );
});

// ---------- 菜单开关 ----------

test("handleMenuOpen / handleMenuClose 只动「更多」菜单，openMenu 跟着走", () => {
    mount();
    const btn = button("more-btn");
    assert.equal(text("openMenu"), "false");

    act(() => latest!.handleMenuOpen({ currentTarget: btn }));
    assert.equal(text("menu"), "more-btn");
    assert.equal(text("openMenu"), "true");

    act(() => latest!.handleMenuClose());
    assert.equal(text("menu"), "null");
    assert.equal(text("openMenu"), "false");
});

// ---------- 滚动：头部收缩 ----------

test("往下滚过门槛才收紧头部，往回滚立刻放开", async () => {
    setScrollY(0);
    mount({ groupCount: 1 });
    assert.equal(text("compact"), "false");

    await scrollTo(200);
    assert.equal(text("compact"), "true", "离开顶部往下滚要收紧");

    await scrollTo(120);
    assert.equal(text("compact"), "false", "往回滚要放开");
});

// ---------- 当前分组高亮 ----------

test("当前分组取「越过判定线的最后一个」；一个都没越过就取第一个", () => {
    groupAnchor(1, 300);
    groupAnchor(2, 100);
    groupAnchor(3, -50);
    mount({ groupCount: 3 });
    assert.equal(text("active"), "3");

    document.querySelectorAll("[data-group-anchor]").forEach(n => n.remove());
    groupAnchor(7, 400);
    groupAnchor(8, 500);
    // 换锚点要重跑一次：groupCount 变化会重挂 effect
    act(() => {
        root!.render(<Probe loading={false} groupCount={2} />);
    });
    assert.equal(text("active"), "7", "都没越线就退回第一个分组");
});

test("页面上还没有分组锚点时保持 null，不炸", () => {
    mount({ groupCount: 0 });
    assert.equal(text("active"), "null");
});
