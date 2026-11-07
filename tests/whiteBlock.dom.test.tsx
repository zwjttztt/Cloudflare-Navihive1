// tests/whiteBlock.dom.test.tsx
//
// 「网页多次抖动 + 卡片消失 + 白色矩形块」的跨界面回归。
//
// 为什么要单独一个文件：这个 bug 有两个界面（首页分组网格 / 记事本全屏层），
// 而根因在第三个地方（useSites 的 bootstrap 落地）。只测 GroupCard 的话笔记界面
// 照旧漏，只测 CSS 的话上游还在不停全量替换 groups。所以这里把三层钉在一起：
//   ① 源码守卫 —— 上游去重 / 拆共享弹窗 / 稳定 fallback / data-notes-open 开关；
//   ② 真实 App 渲染 —— 打开记事本 / 新增站点后 DOM 里真的没有残影与加载白块；
//   ③ 集成 harness —— 笔记打开状态下连续两次 bootstrap，卡片数与 CSS 断言仍全绿。
//
// ⚠️ 根因边界（规格口径，别写反）：
//   setGroups / applyConfigs 的无条件全量替换**只造成重渲染，不是重挂载** ——
//   NotesOverlay 那层 ChunkBoundary（未传 when 时 mounted 恒 true）与 ThemeProvider
//   的 theme 都复用同一实例，useRef / useState 不会因刷新被清空。
//   因此「请求序号 / in-flight 去重 / 结构共享」只为**减少重渲染次数**，不是靠重挂载
//   重置状态；本文件不采用「通过重挂载 / 换 key 顺手清空状态」这类修法。
//   全量替换本身只造成重渲染；白块 / 灰点 / 卡片空白是它下游的条件分支切换
//   （sitesMounted 三元、when 翻转后 320ms 真卸载、key 混用）与层级错位造成的。
//
// 反向变异自证：把关键源码 cp 备份后分别「去掉请求序号 / 去掉 data-notes-open CSS /
// 恢复共享 ChunkBoundary」，下面的守卫与动态用例会变红；恢复后必须全绿。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { act, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/App";
import { useSites, type UseSitesDeps } from "../src/hooks/useSites";
import GroupCard from "../src/components/GroupCard";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import type { BootstrapData, Site } from "../src/API/http";

// 单测会被 esbuild 复制到 script/tmp-tests/ 下再跑，逐级向上找真身。
function findRepoRoot(from: string): string {
    let dir = from;
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir;
        const up = path.dirname(dir);
        if (up === dir) throw new Error("找不到仓库根");
        dir = up;
    }
}
const ROOT = findRepoRoot(process.cwd());
const readSrc = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, "src", rel), "utf8");

/** 剥掉块注释与行注释：源码守卫不能被「解释旧写法」的注释骗到 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/**
 * 从**真实的** index.css 里挑出与白块相关的规则注入 jsdom。
 * 不是复制一份 CSS 来测：删掉源码里的 data-notes-open 规则，这里就抽不到东西，
 * 下面的 computed style 断言会立刻变红。
 */
function extractWhiteBlockRules(): string {
    const css = readSrc("index.css");
    const out: string[] = [];
    let cursor = 0;
    while (cursor < css.length) {
        const open = css.indexOf("{", cursor);
        if (open < 0) break;
        const prevClose = css.lastIndexOf("}", open);
        const start = prevClose < 0 ? 0 : prevClose + 1;
        const selector = css
            .slice(start, open)
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .trim();
        const close = css.indexOf("}", open);
        if (close < 0) break;
        const body = css.slice(open + 1, close);
        if (
            selector.includes("html[data-notes-open]") ||
            selector === '.nav-group-panel[data-sort-mode="None"]' ||
            selector === ".nav-card-in" ||
            selector === ".nav-card-in.nav-card-first-in"
        ) {
            out.push(`${selector} { ${body} }`);
        }
        cursor = close + 1;
    }
    return out.join("\n");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let injectedStyle: HTMLStyleElement | null = null;
let originalFetch: typeof globalThis.fetch | undefined;
let originalIO: typeof globalThis.IntersectionObserver | undefined;
let hitTestInstalled = false;
let sitesApi: ReturnType<typeof useSites> | null = null;

function injectCss(): string {
    if (!injectedStyle) {
        injectedStyle = document.createElement("style");
        injectedStyle.setAttribute("data-whiteblock-test", "1");
        injectedStyle.textContent = extractWhiteBlockRules();
        document.head.appendChild(injectedStyle);
    }
    return injectedStyle.textContent ?? "";
}

function cleanup(): void {
    if (root) {
        act(() => root!.unmount());
    }
    root = null;
    host?.remove();
    host = null;
    sitesApi = null;
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-notes-open");
    injectedStyle?.remove();
    injectedStyle = null;
    if (hitTestInstalled) {
        delete (document as unknown as Record<string, unknown>).elementFromPoint;
        hitTestInstalled = false;
    }
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    if (originalIO !== undefined) globalThis.IntersectionObserver = originalIO;
    originalFetch = undefined;
    originalIO = undefined;
    // cookie Jar 清不掉，用过期时间把登录态消掉
    document.cookie = "navihive_session=; Max-Age=0";
    try {
        localStorage.clear();
        sessionStorage.clear();
    } catch {
        /* 隐私模式之类 */
    }
}
afterEach(cleanup);

/** 「一 observe 就当场触发」的 IO 替身：让主界面真的把卡片挂出来 */
class InstantIntersectionObserver {
    constructor(private cb: IntersectionObserverCallback) {}
    observe(target: Element): void {
        this.cb(
            [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
        );
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
        return [];
    }
}

function json(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function installFetch(routes: Record<string, () => Response | Promise<Response>>): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url;
        for (const [pattern, make] of Object.entries(routes)) {
            if (url.includes(pattern)) return Promise.resolve(make());
        }
        // 记事本 / 配置 / 维护探测等次要请求一律给一个结构完整的空结果，
        // 免得它们把测试拖红（它们与白块无关）。
        return Promise.resolve(json({ success: true, notes: [], groups: [], sites: [] }));
    }) as typeof globalThis.fetch;
}

function mount(node: ReactElement): void {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
}

function mountApp(): void {
    originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
        InstantIntersectionObserver as unknown as typeof globalThis.IntersectionObserver;
    mount(<App /> as ReactElement);
}

async function pollUntil(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 80; i++) {
        if (pred()) return;
        await act(async () => {
            await new Promise(r => setTimeout(r, 25));
        });
    }
    assert.fail(`等待超时：${what}；页面文本=${(document.body.textContent ?? "").slice(0, 200)}`);
}

const site = (id: number, groupId: number, order: number): Site =>
    ({
        id,
        group_id: groupId,
        name: `站点${id}`,
        url: `https://${id}.example`,
        icon: "",
        description: "",
        notes: "",
        order_num: order,
    } as Site);

const bootstrap = (count: number): BootstrapData =>
    ({
        groups: [{ id: 1, name: "冒烟分组", order_num: 0 }],
        sites: Array.from({ length: count }, (_, i) => site(i + 1, 1, i + 1)),
        configs: {},
        me: { id: 1, username: "root", role: "owner" },
        recovery: { configured: false },
    } as unknown as BootstrapData);

async function run(fn: () => Promise<unknown> | void): Promise<void> {
    await act(async () => {
        await fn();
    });
}

// ---------------------------------------------------------------------------
// ① 源码守卫：掐上游 / 拆共享挂载 / 稳定 fallback / 背景停绘开关
// ---------------------------------------------------------------------------

test("useSites 有请求序号 + in-flight 去重，且 applyRemoteData 做结构共享", () => {
    const src = stripComments(readSrc("hooks/useSites.ts"));
    assert.match(src, /requestSeqRef/, "少了请求序号，晚到的旧快照会覆盖新快照");
    assert.match(src, /seq\s*!==\s*requestSeqRef\.current/, "必须在落地前比对序号并丢弃旧响应");
    assert.match(src, /inflightRef/, "少了 in-flight 去重，并发调用会各发各的 bootstrap");
    assert.match(src, /mergeGroupsPreservingRefs/, "落地必须走结构共享，不能无条件 setGroups(新数组)");
});

test("App.tsx：新增分组 / 新增站点各挂各的 ChunkBoundary，不再共享 when", () => {
    const src = stripComments(readSrc("App.tsx"));
    assert.match(src, /<ChunkBoundary when=\{openAddGroup\}>/, "新增分组要有独立的挂载闸门");
    assert.match(src, /<ChunkBoundary when=\{openAddSite\}>/, "新增站点要有独立的挂载闸门");
    assert.ok(
        !/when=\{[^}]*\|\|[^}]*\}/.test(src),
        "又出现共享的 when={a || b}：两个 MUI Dialog 挤在同一个 Suspense 下会留 Paper 残影"
    );
});

test("App.tsx：NotesOverlay 的 loadingFallback 是模块级稳定常量 + when={notesOpen}", () => {
    const src = stripComments(readSrc("App.tsx"));
    assert.match(
        src,
        /const NOTES_LOADING_FALLBACK\s*=\s*<NotesLoadingFallback\s*\/>/,
        "fallback 必须是模块级常量，否则每次 App 重渲染都会换元素、纯白 z2000 层重现"
    );
    assert.match(src, /loadingFallback=\{NOTES_LOADING_FALLBACK\}/, "挂载点要用那份常量");
    assert.ok(
        !/loadingFallback=\{<NotesLoadingFallback\s*\/>\}/.test(src),
        "还在线内新建 fallback 元素"
    );
    assert.match(src, /when=\{notesOpen\}/, "NotesOverlay 的 ChunkBoundary 要显式声明挂载条件");
});

test("App.tsx：notesOpen 会同步 html[data-notes-open]（关闭时移除）", () => {
    const src = stripComments(readSrc("App.tsx"));
    assert.match(src, /setAttribute\("data-notes-open"/, "打开时要打标记");
    assert.match(src, /removeAttribute\("data-notes-open"\)/, "关闭 / 卸载时要摘标记");
    assert.match(src, /\[notesOpen\]\),?;/, "effect 必须跟着 notesOpen 跑");
});

test("index.css：笔记打开时背景停绘 + 分组强制绘制 + 卡片不重播入场", () => {
    const src = stripComments(readSrc("index.css"));
    assert.match(
        src,
        /html\[data-notes-open\]\s+\.nav-root\s*\{[^}]*visibility:\s*hidden/,
        "笔记打开时 .nav-root 必须 visibility:hidden（不能用 display:none，会丢滚动位置）"
    );
    assert.match(
        src,
        /html\[data-notes-open\][^{]*\.nav-group-panel[^{]*\{[^}]*content-visibility:\s*visible/,
        "离屏分组的 420px 方形占位必须被 visible 关掉"
    );
    assert.match(
        src,
        /html\[data-notes-open\]\s+\[data-notes-root\][^{]*\{[^}]*visibility:\s*visible/,
        "笔记层在 .nav-root 内部，漏了这条会把记事本自己一起藏掉"
    );
    assert.match(
        src,
        /html\[data-notes-open\]\s+\.nav-card-in\s*\{[^}]*animation:\s*none/,
        "背景卡片的透明 backwards 帧（三根窄竖条）必须关掉"
    );
    assert.match(
        src,
        /\.nav-card-in\.nav-card-first-in\s*\{[^}]*animation:\s*navCardIn/,
        "入场动画只留给首次挂载那一批"
    );
});

test("SiteCard：一次性入场标记，数据刷新时摘掉、不再重播 navCardIn", () => {
    const src = stripComments(readSrc("components/SiteCard.tsx"));
    assert.match(src, /nav-card-first-in/, "卡片要有一次性入场标记类");
    assert.match(src, /entryPhaseRef/, "用实例级 ref 记住是否已经播过首次入场");
    assert.match(
        src,
        /isFirstEntry\s*\?\s*`\$\{Math\.min\(index,\s*12\)\s*\*\s*35\}ms`\s*:\s*"0ms"/,
        "刷新后 animationDelay 必须归零，否则未轮到的列还是透明空白"
    );
});

// ---------------------------------------------------------------------------
// ② CSS 命中：笔记层在最上层，背景 Paper / 空 Box / 加载白块都不挡路
// ---------------------------------------------------------------------------

/**
 * jsdom 没有布局，document.elementFromPoint 也不存在。这里按「全屏层 + DOM 顺序 +
 * computed visibility」做一个最小命中模型：全屏层里最后一个没被 hidden 的赢，
 * 再返回它最靠内的后代（模拟点在编辑器正文上）。
 * 只用来验证背景 .nav-root 停绘 / 没有 MUI Paper 残影 / 没有加载白块时，
 * 编辑器区域命中的是笔记层；真实像素验收在真浏览器。
 */
function installHitTest(): void {
    Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        writable: true,
        value: (): Element | null => {
            const layers = [
                ...document.querySelectorAll<HTMLElement>(
                    '.nav-root, [data-notes-root], .MuiModal-root, .MuiDialog-root, [role="status"]'
                ),
            ];
            const visibleLayers = layers.filter(el => {
                const cs = getComputedStyle(el);
                return cs.visibility !== "hidden" && cs.display !== "none";
            });
            if (visibleLayers.length === 0) return null;
            const top = visibleLayers[visibleLayers.length - 1]!;
            const descendants = top.querySelectorAll<HTMLElement>("*");
            return descendants.length > 0
                ? descendants[descendants.length - 1]!
                : top;
        },
    });
    hitTestInstalled = true;
}

test("笔记打开时：背景停绘、分组 contentVisibility=visible、命中笔记层而非 Paper", () => {
    const rules = injectCss();
    assert.ok(rules.includes("html[data-notes-open] .nav-root"), "抽不到真实 CSS 规则（守卫空跑）");

    host = document.createElement("div");
    host.innerHTML = `
        <div class="nav-root">
            <div class="nav-group-panel" data-sort-mode="None">
                <div class="nav-card-in" data-site-id="1"></div>
            </div>
        </div>
        <div class="MuiDialog-root"><div class="MuiPaper-root"></div></div>
        <div data-notes-root=""><div class="cm-editor"></div></div>
    `;
    document.body.appendChild(host);

    const rootEl = document.querySelector<HTMLElement>(".nav-root")!;
    const panel = document.querySelector<HTMLElement>(".nav-group-panel")!;
    // 未打开记事本：分组仍按 content-visibility:auto 跳过绘制（420px 方形占位的来源）
    assert.equal(getComputedStyle(panel).contentVisibility, "auto");

    document.documentElement.setAttribute("data-notes-open", "");
    assert.equal(
        getComputedStyle(rootEl).visibility,
        "hidden",
        "背景主页面必须在笔记打开时停绘"
    );
    assert.equal(
        getComputedStyle(panel).contentVisibility,
        "visible",
        "背景分组不能再跳过绘制留下 420px 方形白块"
    );
    const notesRoot = document.querySelector<HTMLElement>("[data-notes-root]")!;
    assert.equal(
        getComputedStyle(notesRoot).visibility,
        "visible",
        "笔记层在 .nav-root 内部，必须显式恢复可见"
    );

    installHitTest();
    const hit = document.elementFromPoint(400, 400);
    assert.ok(hit, "命中测试不该返回空");
    assert.ok(
        hit.closest("[data-notes-root]"),
        "编辑器区域应命中 .cm-editor / [data-notes-root] 后代"
    );
    assert.ok(!hit.closest(".MuiPaper-root"), "不该命中背景残留的 MuiDialog-paper");
    assert.ok(!hit.closest('[role="status"]'), "不该命中加载白块");

    // 关闭笔记：visibility 与 content-visibility 都必须复原（滚动位置不丢）
    document.documentElement.removeAttribute("data-notes-open");
    assert.notEqual(getComputedStyle(rootEl).visibility, "hidden");
    assert.equal(getComputedStyle(panel).contentVisibility, "auto");
});

// ---------------------------------------------------------------------------
// ③ 真实 App：弹窗白块 / 记事本白块
// ---------------------------------------------------------------------------

test("打开「新增站点」：只挂出一份 Dialog Paper，没有第二个残影", async () => {
    originalFetch = globalThis.fetch;
    installFetch({ bootstrap: () => json(bootstrap(1)) });
    document.cookie = "navihive_session=1";
    mountApp();
    await pollUntil(() => (document.body.textContent ?? "").includes("冒烟分组"), "主界面渲染");

    const addButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        b => (b.textContent ?? "").trim() === "新增"
    );
    assert.ok(addButton, "找不到顶栏「新增」按钮");
    await run(() => {
        addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await pollUntil(
        () => document.querySelectorAll(".MuiDialog-paper").length > 0,
        "新增站点弹窗出现"
    );

    assert.equal(
        document.querySelectorAll(".MuiDialog-paper").length,
        1,
        "EditGroupDialog 与 AddSiteDialog 不能同时挂出可见 Paper（共享 when 的残影）"
    );
    assert.equal(
        document.querySelectorAll(".MuiDialog-root").length,
        1,
        "只应有一个 Dialog 根节点"
    );
    assert.equal(
        document.querySelectorAll('[role="status"][aria-label="记事本加载中"]').length,
        0,
        "不该冒出记事本加载骨架"
    );
});

test("打开记事本：html[data-notes-open] 生效，无 MUI 弹层 / 加载白块", async () => {
    originalFetch = globalThis.fetch;
    installFetch({ bootstrap: () => json(bootstrap(1)) });
    document.cookie = "navihive_session=1";
    injectCss();
    mountApp();
    await pollUntil(() => (document.body.textContent ?? "").includes("冒烟分组"), "主界面渲染");

    const openButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="打开记事本"]'
    );
    assert.ok(openButton, "找不到「打开记事本」按钮");
    const overflowBefore = document.documentElement.style.overflow;
    await run(() => {
        openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    assert.ok(
        document.documentElement.hasAttribute("data-notes-open"),
        "notesOpen 必须同步到 html 属性，否则 CSS 一刀全不生效"
    );
    const rootEl = document.querySelector<HTMLElement>(".nav-root")!;
    assert.equal(getComputedStyle(rootEl).visibility, "hidden", "背景主页面应停绘");
    const panel = document.querySelector<HTMLElement>(".nav-group-panel")!;
    assert.equal(
        getComputedStyle(panel).contentVisibility,
        "visible",
        "背景分组应为 content-visibility:visible"
    );
    assert.equal(
        document.querySelectorAll(".MuiModal-root,.MuiPopover-root,.MuiMenu-root").length,
        0,
        "不该有背景残留的 MUI 弹层"
    );
    assert.equal(
        document.querySelectorAll('[role="status"][aria-label="记事本加载中"]').length,
        0,
        "不该有全屏纯白加载层"
    );

    // 笔记层真的渲染出来了：验证它在 .nav-root 内部时没被 visibility:hidden 一起藏掉
    const notesRoot = document.querySelector<HTMLElement>("[data-notes-root]");
    assert.ok(notesRoot, "NotesOverlay 应渲染出 [data-notes-root]");
    assert.equal(
        getComputedStyle(notesRoot).visibility,
        "visible",
        "笔记层在 .nav-root 内部，必须靠 CSS 例外恢复可见"
    );
    // 编辑器区域命中的必须是笔记层后代，不是背景 Paper / 加载白块 / 空 Box
    installHitTest();
    const hit = document.elementFromPoint(400, 400);
    assert.ok(hit, "编辑器区域不该什么都命中不到");
    assert.ok(
        hit.closest("[data-notes-root]"),
        "elementFromPoint 应命中 .cm-editor / [data-notes-root] 后代"
    );
    assert.ok(!hit.closest(".MuiPaper-root"), "不该命中背景残留的 MuiDialog-paper");
    assert.ok(!hit.closest('[role="status"]'), "不该命中全屏纯白加载层");

    // 关闭：点「返回导航站」，属性摘掉、visibility / content-visibility 复原，
    // html 的 overflow 不能被 useOverlayScrollLock 或笔记层污染（滚动位置不丢）
    const closeButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="返回导航站"]'
    );
    assert.ok(closeButton, "找不到关闭记事本的按钮");
    await run(() => {
        closeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.ok(
        !document.documentElement.hasAttribute("data-notes-open"),
        "关闭后 data-notes-open 必须摘掉，否则主页面永远停绘"
    );
    assert.notEqual(
        getComputedStyle(rootEl).visibility,
        "hidden",
        "关闭后 visibility 必须复原"
    );
    assert.equal(
        getComputedStyle(panel).contentVisibility,
        "auto",
        "关闭后分组恢复 content-visibility:auto"
    );
    assert.equal(
        document.documentElement.style.overflow,
        overflowBefore,
        "html 的 overflow 不能被笔记层 / 滚动锁污染"
    );
});

// ---------------------------------------------------------------------------
// ④ 跨界面联动：笔记打开状态下连续两次 bootstrap
// ---------------------------------------------------------------------------

/** 把 useSites + GroupCard + 笔记层装在同一个树里，模拟真实的首页/笔记叠加结构 */
function LinkedHarness({ deps }: { deps: UseSitesDeps }) {
    const s = useSites(deps);
    sitesApi = s;
    const [notesOpen, setNotesOpen] = useState(false);
    // 与 App.tsx 里的 effect 同语义：只改 html 的一个属性，不碰 overflow / 滚动位置
    useEffect(() => {
        if (notesOpen) document.documentElement.setAttribute("data-notes-open", "");
        else document.documentElement.removeAttribute("data-notes-open");
        return () => document.documentElement.removeAttribute("data-notes-open");
    }, [notesOpen]);

    return (
        <UIPrefsProvider>
            <button data-testid="toggle-notes" onClick={() => setNotesOpen(true)}>
                打开记事本
            </button>
            <div className="nav-root">
                {s.groups.map(group => (
                    <GroupCard
                        key={`group-${group.id}`}
                        group={group}
                        sortMode="GroupSort"
                        currentSortingGroupId={null}
                        onUpdate={() => {}}
                        onDelete={() => {}}
                        onSaveSiteOrder={() => {}}
                        onStartSiteSort={() => {}}
                        onUpdateGroup={() => {}}
                        onDeleteGroup={() => {}}
                        searchQuery=""
                        selectMode={false}
                        selectedIds={[]}
                    />
                ))}
            </div>
            {notesOpen && (
                <div data-notes-root="">
                    <div className="cm-editor" />
                </div>
            )}
        </UIPrefsProvider>
    );
}

test("跨界面联动：笔记打开状态下连续两次 bootstrap，卡片数与白块断言全部仍成立", async () => {
    injectCss();
    let calls = 0;
    const deps: UseSitesDeps = {
        api: {
            bootstrap: async () => {
                calls += 1;
                return bootstrap(9);
            },
        },
        onRemoteExtras: () => {},
        onError: () => {},
        onAuthFail: () => {},
    };
    mount(<LinkedHarness deps={deps} />);
    await run(() => sitesApi!.fetchData({ silent: true }));
    assert.equal(calls, 1);

    await run(() => {
        document
            .querySelector<HTMLButtonElement>('[data-testid="toggle-notes"]')!
            .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.ok(document.documentElement.hasAttribute("data-notes-open"));
    const cardsBefore = document.querySelectorAll("[data-site-id]").length;
    assert.equal(cardsBefore, 9, "初始应渲染 9 张卡");
    const groupsBefore = sitesApi!.groups;

    // 连续两次内容相同的刷新：上游结构共享后不该产生任何新的 React 更新
    await run(() => sitesApi!.fetchData({ silent: true }));
    await run(() => sitesApi!.fetchData({ silent: true }));
    assert.equal(calls, 3, "三次调用都真的发了请求（序号闸门才有意义）");

    assert.strictEqual(
        sitesApi!.groups,
        groupsBefore,
        "笔记打开期间刷新换了 groups 引用，整树会重渲染、入场动画会重播"
    );
    assert.equal(
        document.querySelectorAll("[data-site-id]").length,
        cardsBefore,
        "[data-site-id] 计数必须不变（用户实测的 9↔10 跳变）"
    );
    assert.equal(
        document.querySelectorAll(".MuiModal-root,.MuiPopover-root,.MuiMenu-root").length,
        0
    );
    assert.equal(
        document.querySelectorAll('[role="status"][aria-label="记事本加载中"]').length,
        0
    );
    assert.equal(
        getComputedStyle(document.querySelector<HTMLElement>(".nav-root")!).visibility,
        "hidden"
    );
    assert.equal(
        getComputedStyle(document.querySelector<HTMLElement>(".nav-group-panel")!)
            .contentVisibility,
        "visible"
    );
    // 入场动画只在首次挂载播：刷新之后不该再有 first-in 标记
    assert.equal(
        document.querySelectorAll(".nav-card-first-in").length,
        0,
        "刷新后仍有卡片处于首次入场态 —— backwards 的透明帧就是三根窄竖条"
    );
});
