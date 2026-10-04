// tests/globalShortcuts.dom.test.tsx
// 全局键盘编排：hooks/useGlobalShortcuts。
//
// 这 100 多行原先在 App.tsx 里，一条用例都没有。它里面藏的是一组**守卫**：
// 正在输入时不抢键、有弹窗 / 菜单开着时不响应数字键、搜索态下 1~9 优先开搜索结果、
// Alt / Cmd 组合键不误触……守卫写反了不会报错，只会变成「在设置弹窗里按个 1
// 就把某个网站打开了」这种事后很难复现的问题。搬出来之后能用 jsdom 派真键盘事件，
// 一条条钉住。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, useState, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useGlobalShortcuts } from "../src/hooks/useGlobalShortcuts";
import type { Site } from "../src/API/http";
import type { SearchResult } from "../src/components/HeaderSearchBox";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

interface Rec {
    undo: number;
    redo: number;
    opened: Site[];
    shortcuts: boolean[];
    command: boolean[];
    dirs: string[];
}

let rec: Rec;

const site = (id: number, name: string): Site =>
    ({ id, name, url: `https://${name}.com` }) as Site;

const RESULT_SITES = [site(101, "r1"), site(102, "r2"), site(103, "r3")];
const GROUP_SITES = [site(201, "g1"), site(202, "g2"), site(203, "g3")];

const flatResults: SearchResult[] = RESULT_SITES.map(s => ({
    site: s,
    groupName: "结果分组",
}));

type ProbeProps = {
    /** 初始搜索词：空 = 浏览态（1~9 开当前分组的卡片） */
    query?: string;
    focused?: boolean;
    active?: number;
};

/** 一个最小宿主：只装 hook，把能观测的状态渲染成文本 */
function Probe({ query = "", focused = true, active = 0 }: ProbeProps) {
    const [searchQuery, setSearchQuery] = useState(query);
    const [searchFocused, setSearchFocused] = useState(focused);
    const [activeResult, setActiveResult] = useState(active);
    const [searchAnchor, setSearchAnchor] = useState<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchPanelRef = useRef<HTMLDivElement>(null);

    useGlobalShortcuts({
        searchInputRef,
        searchPanelRef,
        searchAnchor,
        searchQuery,
        setSearchQuery,
        setSearchFocused,
        flatResults,
        activeResult,
        setActiveResult,
        openResult: s => {
            rec.opened.push(s);
        },
        currentGroupSites: GROUP_SITES,
        runUndo: () => {
            rec.undo += 1;
        },
        runRedo: () => {
            rec.redo += 1;
        },
        setOpenShortcuts: v => {
            rec.shortcuts.push(v);
        },
        setCommandOpen: v => {
            rec.command.push(v);
        },
        focusCardByDirection: dir => {
            rec.dirs.push(dir);
        },
    });

    return (
        <div>
            <div ref={setSearchAnchor} data-testid="anchor">
                <input ref={searchInputRef} data-testid="input" />
            </div>
            <div ref={searchPanelRef} data-testid="panel">
                <span data-testid="panel-inside">结果面板</span>
            </div>
            <span data-testid="query">{searchQuery}</span>
            <span data-testid="focused">{String(searchFocused)}</span>
            <span data-testid="active">{activeResult}</span>
        </div>
    );
}

function mount(props: ProbeProps = {}) {
    rec = { undo: 0, redo: 0, opened: [], shortcuts: [], command: [], dirs: [] };
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
    document
        .querySelectorAll(".MuiModal-root")
        .forEach(node => node.remove());
};

afterEach(cleanup);

const $ = (id: string) => {
    const el = host!.querySelector(`[data-testid="${id}"]`);
    assert.ok(el, `找不到 [data-testid=${id}]`);
    return el as HTMLElement;
};

const text = (id: string) => $(id).textContent ?? "";

function key(
    k: string,
    opts: { target?: EventTarget; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
) {
    const el = (opts.target ?? document.body) as EventTarget;
    const ev = new KeyboardEvent("keydown", {
        key: k,
        bubbles: true,
        cancelable: true,
        ctrlKey: opts.ctrl ?? false,
        shiftKey: opts.shift ?? false,
        altKey: opts.alt ?? false,
    });
    act(() => {
        el.dispatchEvent(ev);
    });
    return ev;
}

function mouseDown(target: EventTarget) {
    act(() => {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
}

/** 造一个开着的 MUI 弹层：快捷键该让路 */
function openOverlay() {
    const modal = document.createElement("div");
    modal.className = "MuiModal-root";
    document.body.appendChild(modal);
    return modal;
}

// ---------- 「/」聚焦搜索框 ----------

test("不在输入状态时按「/」聚焦搜索框", () => {
    mount();
    ($("input") as HTMLInputElement).blur();
    assert.notEqual(document.activeElement, $("input"));
    key("/");
    assert.equal(document.activeElement, $("input"));
});

test("正在输入框里打字时按「/」不被拦（那个字符要老老实实输进去）", () => {
    mount();
    const input = $("input") as HTMLInputElement;
    input.focus();
    const ev = key("/", { target: input });
    // 不该被 preventDefault —— 否则输入框里永远打不出斜杠
    assert.equal(ev.defaultPrevented, false);
});

// ---------- 撤销 / 重做 ----------

test("Ctrl / Cmd + Z 撤销，Ctrl+Shift+Z 与 Ctrl+Y 重做", () => {
    mount();
    key("z", { ctrl: true });
    assert.equal(rec.undo, 1);
    assert.equal(rec.redo, 0);

    key("z", { ctrl: true, shift: true });
    assert.equal(rec.undo, 1);
    assert.equal(rec.redo, 1);

    key("y", { ctrl: true });
    assert.equal(rec.redo, 2);
});

test("正在输入时 Ctrl+Z 不抢：那是浏览器撤销输入的事", () => {
    mount();
    const input = $("input") as HTMLInputElement;
    const ev = key("z", { ctrl: true, target: input });
    assert.equal(rec.undo, 0, "撤销不该被触发");
    assert.equal(ev.defaultPrevented, false);
});

// ---------- 1~9 快捷打开 ----------

test("没搜索时 1~9 打开当前分组的第 N 张卡片", () => {
    mount();
    key("1");
    assert.deepEqual(
        rec.opened.map(s => s.id),
        [201]
    );
    key("3");
    assert.deepEqual(
        rec.opened.map(s => s.id),
        [201, 203]
    );
});

test("有搜索词时 1~9 打开的是搜索结果，不是当前分组的卡片", () => {
    mount({ query: "r" });
    key("1");
    assert.deepEqual(
        rec.opened.map(s => s.id),
        [101],
        "该开第一条搜索结果（101），不是分组里的 201"
    );
});

test("超出结果条数的数字键不打开任何东西", () => {
    mount({ query: "r" });
    key("9");
    assert.equal(rec.opened.length, 0);
});

test("有弹窗 / 菜单开着时 1~9 不响应（免得在设置里按个 1 就打开网站）", () => {
    mount();
    const modal = openOverlay();
    key("1");
    assert.equal(rec.opened.length, 0, "弹窗开着时不该打开卡片");

    modal.remove();
    key("1");
    assert.equal(rec.opened.length, 1, "弹窗关掉后恢复响应");
});

test("带 Alt / Cmd 的数字键不响应（那是浏览器切标签页的）", () => {
    mount();
    key("1", { alt: true });
    assert.equal(rec.opened.length, 0);
});

// ---------- 「?」快捷键说明表 ----------

test("按「?」打开快捷键说明表，弹窗开着时不抢", () => {
    mount();
    key("?");
    assert.deepEqual(rec.shortcuts, [true]);

    // 弹层留在 body 上，afterEach 会清掉
    openOverlay();
    rec.shortcuts.length = 0;
    key("?");
    assert.deepEqual(rec.shortcuts, [], "弹窗开着时不该再弹一层");
});

// ---------- Ctrl / Cmd + K 命令面板 ----------

test("Ctrl / Cmd + K 打开命令面板，输入框里也照开（它是全局命令）", () => {
    mount();
    key("k", { ctrl: true });
    assert.deepEqual(rec.command, [true]);

    const input = $("input") as HTMLInputElement;
    key("k", { ctrl: true, target: input });
    assert.deepEqual(rec.command, [true, true], "正在输入时也要能唤出命令面板");

    // 单个 k（不带修饰键）不该有任何反应
    key("k");
    assert.deepEqual(rec.command, [true, true]);
});

// ---------- 搜索框内：↑↓ / Enter / Esc ----------

test("搜索框里 ↑↓ 在结果之间循环移动高亮", () => {
    mount({ query: "r" });
    const input = $("input") as HTMLInputElement;
    assert.equal(text("active"), "0");

    key("ArrowDown", { target: input });
    assert.equal(text("active"), "1");
    key("ArrowDown", { target: input });
    assert.equal(text("active"), "2");
    key("ArrowDown", { target: input });
    assert.equal(text("active"), "0", "到底了要回到第一条");

    key("ArrowUp", { target: input });
    assert.equal(text("active"), "2", "从第一条往上要绕到最后一条");
});

test("搜索框里 Enter 打开当前高亮的那条", () => {
    mount({ query: "r", active: 1 });
    const input = $("input") as HTMLInputElement;
    key("Enter", { target: input });
    assert.deepEqual(
        rec.opened.map(s => s.id),
        [102]
    );
});

test("搜索框里 Esc 清空关键词、收起面板并让输入框失焦", () => {
    mount({ query: "abc" });
    const input = $("input") as HTMLInputElement;
    input.focus();
    key("Escape", { target: input });
    assert.equal(text("query"), "");
    assert.equal(text("focused"), "false");
    assert.notEqual(document.activeElement, input);
});

// ---------- 方向键在卡片之间移动焦点 ----------

test("非输入状态下方向键交给卡片导航", () => {
    mount();
    key("ArrowRight");
    key("ArrowLeft");
    key("ArrowDown");
    key("ArrowUp");
    assert.deepEqual(rec.dirs, ["right", "left", "down", "up"]);
});

test("在输入框里按方向键不该跳卡片（光标要能左右移）", () => {
    mount();
    const input = $("input") as HTMLInputElement;
    key("ArrowRight", { target: input });
    assert.deepEqual(rec.dirs, []);
});

// ---------- 点面板外收起 ----------

test("点在搜索框 / 结果面板以外的地方才收起面板", () => {
    mount();
    assert.equal(text("focused"), "true");

    mouseDown($("panel-inside"));
    assert.equal(text("focused"), "true", "点面板里不该收起");

    mouseDown($("anchor"));
    assert.equal(text("focused"), "true", "点搜索框容器里不该收起");

    mouseDown(document.body);
    assert.equal(text("focused"), "false", "点空白处要收起");
});
