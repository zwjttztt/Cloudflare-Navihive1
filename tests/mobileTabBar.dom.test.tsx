// tests/mobileTabBar.dom.test.tsx
// 底部胶囊导航：窄屏（<=899.98px）唯一的功能入口集合。
//
// 2026-10-16 弹窗排查（docs/dialogs-audit-2026-10-16.md）抓到一个 P1：
// 顶栏「记事本」按钮在 md 以下被隐藏，而底栏当时没有这一项 —— 手机和窄窗口
// 完全打不开记事本。补项之后用这份用例钉住三件事：
//   1. 传了 onNotes 才有「笔记」项（不传就不出现，老调用方不受影响）；
//   2. 点它真的调 onNotes；
//   3. 角标按条数显示、99 封顶。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import MobileTabBar from "../src/components/MobileTabBar";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom 没有 matchMedia；底栏靠 useMediaQuery("(max-width: 899.98px)") 决定显不显示 */
function stubMatchMedia(matches: boolean) {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
    });
}

function mount(props: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <MobileTabBar
                onSearch={() => {}}
                onGroups={() => {}}
                onAdd={() => {}}
                onMore={() => {}}
                {...props}
            />
        );
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

const labels = () =>
    [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute("aria-label"));

const clickAsync = async (el: Element) => {
    await act(async () => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
};

afterEach(cleanup);

test("窄屏底栏有「笔记」项，点了真的打开记事本（P1：之前窄屏完全没入口）", async () => {
    stubMatchMedia(true);
    let opened = 0;
    mount({ onNotes: () => void opened++ });
    const notes = document.querySelector('[aria-label="笔记"]');
    assert.ok(notes, "窄屏底栏必须有「笔记」项");
    await clickAsync(notes);
    assert.equal(opened, 1, "点「笔记」要真的打开记事本");
});

test("不传 onNotes 就没有「笔记」项（老调用方不受影响）", () => {
    stubMatchMedia(true);
    mount();
    assert.equal(labels().includes("笔记"), false, "没接回调就不该出现这一项");
    // 基础四项仍在
    for (const l of ["搜索", "分组", "新增", "更多"]) {
        assert.ok(labels().includes(l), `缺少 ${l}`);
    }
});

test("记事本条数 >0 时贴角标，99 封顶", () => {
    stubMatchMedia(true);
    mount({ onNotes: () => {}, notesBadge: 3 });
    const notes = document.querySelector('[aria-label="笔记"]');
    assert.match(notes?.textContent ?? "", /3/, "角标要显示条数");

    cleanup();
    stubMatchMedia(true);
    mount({ onNotes: () => {}, notesBadge: 120 });
    const capped = document.querySelector('[aria-label="笔记"]');
    assert.match(capped?.textContent ?? "", /99\+/, "超过 99 显示 99+");
});

test("宽屏（>=900px）整个底栏不渲染，「笔记」项也不该露出来", () => {
    stubMatchMedia(false);
    mount({ onNotes: () => {} });
    assert.equal(document.querySelector(".nav-mobile-tabbar"), null);
    assert.equal(labels().includes("笔记"), false);
});
