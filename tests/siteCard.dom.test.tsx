// tests/siteCard.dom.test.tsx
// 卡片渲染层：SiteCard 是站内最常渲染的组件（1168 行），之前**一个用例都没有** ——
// 只有 CI 冒烟那十几条断言在守着。这里把几条用户能直接感知的行为钉住：
// 链接与名称、失效徽章、星标按钮、多选模式下「点卡片是勾选不是打开」、搜索高亮。
//
// 用真实的 UIPrefsProvider + localStorage 驱动，而不是自己造一个 context 假值：
// 星标 / 失效记录本来就是存在浏览器本地的，走真实路径才能顺带测到读写。

import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SiteCard from "../src/components/SiteCard";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import { AppConfigProvider } from "../src/context/AppConfigContext";
import type { AppConfigContextValue } from "../src/context/appConfigStore";
import { scopedKey } from "../src/utils/accountScope";

// 星标 / 访问统计按账号分档存：没绑定账号时落在 anon 这一档
const STARRED_KEY = scopedKey("navihive:starred", null);
const VISITS_KEY = scopedKey("navihive:visits", null);
import type { Site } from "../src/API/http";

// DOM 用例的启动脚本补了 window / document，但没挂 localStorage ——
// 组件里是直接写 `localStorage.getItem` 的（UIPrefs 的星标、访问记录都在这儿），
// 不挂的话一渲染就 ReferenceError。jsdom 自己实现了它，指过去即可。
if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: window.localStorage,
        configurable: true,
        writable: true,
    });
}

const APP_CONFIG: AppConfigContextValue = {
    iconApi: "https://ico.example/{domain}",
    thumbApi: "",
    backgroundImage: "",
    backgroundMaskOpacity: "0.15",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeSite(over: Partial<Site> = {}): Site {
    return {
        id: 101,
        group_id: 1,
        name: "示例站点",
        url: "https://example.com/",
        icon: "",
        description: "",
        notes: "",
        order_num: 0,
        ...over,
    };
}

function mount(node: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        // AppConfigProvider 也要包：右键「编辑备注」会打开 SiteSettingsModal，
        // 它用到 useAppConfig()。缺了 Provider 那条路径根本跑不起来，
        // 于是「点编辑备注是不是真的直达放大窗」就没法断言 ——
        // 而那恰恰是这个入口唯一值得测的地方。
        root!.render(
            <AppConfigProvider value={APP_CONFIG}>
                <UIPrefsProvider>{node}</UIPrefsProvider>
            </AppConfigProvider>
        );
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

/** 渲染一张卡片，可选地在渲染前往 localStorage 里塞本机偏好 */
function renderCard(
    opts: {
        site?: Site;
        selectMode?: boolean;
        selected?: boolean;
        highlight?: string;
        isEditMode?: boolean;
        onToggleSelect?: (id: number) => void;
        prefs?: Record<string, string>;
    } = {}
) {
    localStorage.clear();
    for (const [k, v] of Object.entries(opts.prefs ?? {})) localStorage.setItem(k, v);
    const site = opts.site ?? makeSite();
    mount(
        <SiteCard
            site={site}
            onUpdate={() => {}}
            onDelete={() => {}}
            selectMode={opts.selectMode}
            selected={opts.selected}
            highlight={opts.highlight}
            isEditMode={opts.isEditMode}
            onToggleSelect={opts.onToggleSelect}
        />
    );
    return site;
}

const q = (sel: string) => document.querySelector(sel);
const byLabel = (label: string) =>
    document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

/**
 * 把 window.open 换成计数器。
 *
 * 键盘打开卡片走的是 safeOpenSite → window.open，jsdom 里真的 window.open 只会
 * 打一条 "Not implemented" 就返回 null，数不出来。而「按一次回车开出几个标签页」
 * 正是 MUI 9 那条行为变化（ButtonBase 的 Enter/Space 会派发**冒泡**的 click）
 * 唯一能被机器验出来的地方 —— 冒烟脚本在真实浏览器里数不了标签页。
 */
function stubWindowOpen() {
    const calls: string[] = [];
    const holder = window as unknown as { open: unknown };
    const original = holder.open;
    holder.open = (url: string) => {
        calls.push(String(url));
        return null;
    };
    return {
        calls,
        restore: () => {
            holder.open = original;
        },
    };
}

function pressKey(el: Element, key: string) {
    act(() => {
        el.dispatchEvent(
            new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
        );
    });
}

test.afterEach(cleanup);

test("卡片渲染出站点名与可点开的链接", () => {
    renderCard();
    const link = q('a[href^="https://example.com"]');
    assert.ok(link, "没有渲染出指向站点地址的链接");
    assert.match(document.body.textContent ?? "", /示例站点/);
    // 卡片本体必须是 data-nav-card（方向键导航靠它找卡片）
    assert.ok(q('[data-nav-card="true"]'), "缺少 data-nav-card 标记");
});

test("失效链接会挂出提示徽章，健康的链接不挂", () => {
    // 失效记录是「链接 -> 时间戳」，而且之后探测成功的会翻案，所以只塞 deadLinks 就够
    const dead = JSON.stringify({ "https://example.com/": Date.now() });
    renderCard({ prefs: { "navihive:deadLinks": dead } });
    assert.ok(byLabel("链接可能已失效"), "失效链接没有出现徽章");

    cleanup();
    renderCard({ prefs: { "navihive:deadLinks": JSON.stringify({ "https://other.com/": 1 }) } });
    assert.equal(byLabel("链接可能已失效"), null, "健康链接不该有失效徽章");
});

test("星标按钮的状态跟着本机星标走", () => {
    renderCard({ prefs: { [STARRED_KEY]: JSON.stringify([101]) } });
    assert.ok(byLabel("取消星标"), "已星标的卡片按钮应该显示「取消星标」");

    cleanup();
    renderCard({ prefs: { [STARRED_KEY]: JSON.stringify([]) } });
    assert.ok(byLabel("加星标"), "未星标的卡片按钮应该显示「加星标」");
});

test("多选模式下点卡片是勾选，不会记一次访问", () => {
    const picked: number[] = [];
    renderCard({
        selectMode: true,
        onToggleSelect: id => picked.push(id),
    });
    const card = q('[data-nav-card="true"]') as HTMLElement;
    act(() => {
        card.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(picked, [101], "多选模式下点卡片应该切换勾选");
    // 记访问的副作用在多选模式下必须被跳过（否则「顺手勾选」会污染最近访问）
    assert.equal(localStorage.getItem(VISITS_KEY), null, "多选模式下不该记访问");
});

test("普通模式点卡片会记一次访问（最近访问分组的数据来源）", () => {
    renderCard();
    // 记访问的 onClick 挂在真正的 <a> 上，不在卡片外壳上（外壳那个是多选拦截用的）
    const link = q('a[href^="https://example.com"]') as HTMLElement;
    act(() => {
        link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const visits = JSON.parse(localStorage.getItem(VISITS_KEY) || "{}");
    assert.ok(visits["101"], "点击后应该写下访问记录");
});

test("搜索命中会高亮，没命中就不加 <mark>", () => {
    renderCard({ highlight: "示例" });
    const mark = q("mark.nav-hl");
    assert.ok(mark, "命中的关键词没有高亮");
    assert.equal(mark?.textContent, "示例");

    cleanup();
    renderCard({ highlight: "绝不匹配" });
    assert.equal(q("mark.nav-hl"), null, "没命中时不该加高亮标记");
});

test("编辑模式下不参与方向键导航（拖拽排序时不该被焦点系统抓到）", () => {
    renderCard({ isEditMode: true });
    assert.equal(q('[data-nav-card="true"]'), null, "编辑模式的卡片不该带 data-nav-card");
});

// ── 键盘打开：MUI 9 的重点回归点 ────────────────────────────────────────────
//
// 卡片有两层可聚焦元素：外壳 Box（tabIndex=0，自己处理回车/空格）和里面的
// CardActionArea（渲染成真的 <a>，基于 MUI 的 ButtonBase）。ButtonBase 自己也会
// 处理回车/空格 —— MUI 9 把它改成「派发一个会冒泡的 click」，于是键盘事件很容易
// 被两条路各接一次，表现就是**按一次回车开出两个标签页**。
// 这两个用例按「焦点在哪一层」分别钉住，升级 MUI 时它们就是验收标准。

test("焦点在卡片外壳上：回车/空格各只打开一次链接", () => {
    const opened = stubWindowOpen();
    try {
        renderCard();
        const card = q('[data-nav-card="true"]') as HTMLElement;
        pressKey(card, "Enter");
        assert.deepEqual(opened.calls, ["https://example.com/"], "回车应该只打开一次");

        opened.calls.length = 0;
        pressKey(card, " ");
        assert.deepEqual(opened.calls, ["https://example.com/"], "空格应该只打开一次");
    } finally {
        opened.restore();
    }
});

test("焦点在里面的链接上：回车/空格都不会被 ButtonBase 重复触发", () => {
    const opened = stubWindowOpen();
    try {
        renderCard();
        const link = q('a[href^="https://example.com"]') as HTMLElement;
        pressKey(link, "Enter");
        assert.deepEqual(
            opened.calls,
            ["https://example.com/"],
            "焦点在 <a> 上时回车开出了不止一个标签页"
        );

        opened.calls.length = 0;
        pressKey(link, " ");
        assert.deepEqual(
            opened.calls,
            ["https://example.com/"],
            "焦点在 <a> 上时空格开出了不止一个标签页"
        );
    } finally {
        opened.restore();
    }
});

// ---------------------------------------------------------------------------
// 右键「编辑备注」：直达放大窗
// ---------------------------------------------------------------------------

/** 打开卡片右键菜单（真实右键事件走的是同一条路径） */
function openContextMenu() {
    const shell = document.querySelector(".nav-site-card") || document.querySelector("a") || document.body;
    act(() => {
        shell.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 160 })
        );
    });
}

const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLElement>("li")].find(li =>
        (li.textContent || "").trim() === label
    );

test("右键菜单里有「编辑备注」", () => {
    renderCard();
    openContextMenu();
    assert.ok(
        menuItem("编辑备注"),
        "右键菜单要有一项「编辑备注」—— 不然想改备注得先进设置再找放大按钮"
    );
});

test("「编辑备注」排在「编辑」前面（同属修改类，位置要好找）", () => {
    renderCard();
    openContextMenu();
    const labels = [...document.querySelectorAll<HTMLElement>("li")].map(li =>
        (li.textContent || "").trim()
    );
    const notesIdx = labels.indexOf("编辑备注");
    const editIdx = labels.indexOf("编辑");
    assert.ok(notesIdx >= 0, "菜单里要有「编辑备注」");
    assert.ok(editIdx >= 0, "原有的「编辑」要还在（别为了加新项把老的挤掉）");
    assert.ok(
        notesIdx < editIdx,
        `「编辑备注」(${notesIdx}) 应该在「编辑」(${editIdx}) 前面`
    );
});

test("点「编辑备注」直达放大窗；点「编辑」进的是主窗（两条路必须区分得开）", async () => {
    // 这是这个入口唯一值得测的地方：**它和「编辑」走的是两条不同的路**。
    // 之前只测了「菜单项在不在、顺序对不对」，把 onClick 换成 handleMenuEdit
    // 变体验证时测试依然全绿 —— 等于这个功能压根没被测住。
    // 变异验证：把菜单项的 onClick 改回 handleMenuEdit，下面两条会一起变红。
    const openVia = async (label: string) => {
        cleanup();
        renderCard({ site: { ...makeSite(), id: 5, name: "带备注的站", notes: "原来的备注" } });
        openContextMenu();
        const item = menuItem(label);
        assert.ok(item, `菜单里要有「${label}」`);
        // 设置弹窗是 lazy(() => import(...))，要点 + 等 Suspense 把 chunk 解析完。
        // ⚠️ 必须用 `await act(async …)`：裸 setTimeout 里的更新不在 act 范围内，
        // React 不会刷新，DOM 里就永远是找不到的样子。
        await act(async () => {
            item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 80));
        });
    };

    await openVia("编辑备注");
    const area = document.querySelector<HTMLTextAreaElement>("#notes-expanded");
    assert.ok(
        area,
        "点「编辑备注」后放大窗应该直接是打开的 —— 用户点了备注就不该先看一整屏设置"
    );
    assert.equal(area!.value, "原来的备注", "要带着卡片上已有的备注");
    assert.equal(
        document.querySelectorAll(".MuiDialog-paper").length,
        2,
        "放大窗是叠在网站设置之上的，所以两层都在"
    );

    await openVia("编辑");
    assert.equal(
        document.querySelector("#notes-expanded"),
        null,
        "点「编辑」进的是主窗，不该被强制进放大窗 —— 标志必须每次打开时重置"
    );
    assert.ok(
        document.querySelector("#notes"),
        "主窗的备注框应该在（说明设置弹窗确实打开了）"
    );
});
