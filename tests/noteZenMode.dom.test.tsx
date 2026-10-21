// tests/noteZenMode.dom.test.tsx
// A9 真·专注模式（2026-10-22）。
//
// 盯三件事：
// ① 进了专注，外围（导航列 / 列表列 / 工具栏 / 状态栏）真的从 DOM 里**卸掉**，
//    只剩标题、保存点、退出键和正文 —— 不是 display:none 那种「假隐藏」
//    （卸载连副作用一起停：图标批量请求、搜索防抖都不该在只留正文时还活着）；
// ② Esc 与退出按钮都能出来，出来后外围原样回来；
// ③ Esc 要让位给浮层：命令面板开着的时候 Esc 先关它，不能顺手把页面布局掀了。
//
// ⚠️ 断言写法：只比**布尔与字符串**，绝不把 DOM 元素放进 assert 的失败路径 ——
// node:assert 失败时要 util.inspect(actual)，序列化一棵 jsdom 树能把进程堆炸掉
// （本项目 2026-10-07 踩过类似的 heap OOM，现象就是「用例全过但进程死了」）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";
import NotesPage from "../src/components/NotesPage";
import type { Note } from "../src/API/http";

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
    if (root) {
        act(() => root!.unmount());
        root = null;
    }
    if (host) {
        host.remove();
        host = null;
    }
    document.body.innerHTML = "";
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
});

function note(over: Partial<Note> = {}): Note {
    return {
        id: 1,
        uuid: "u1",
        title: "标题",
        content: "内容",
        pinned: false,
        order_num: 0,
        site_id: null,
        ...over,
    };
}

function mountPanel(notes: Note[]) {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <UIPrefsProvider>
                <NotesPage
                    onClose={() => {}}
                    notes={notes}
                    onCreate={async () => note({ id: 99 })}
                    onUpdate={async () => {}}
                    onDelete={async () => {}}
                    onTogglePin={async () => {}}
                    trashedNotes={[]}
                    onLoadTrash={async () => {}}
                    onRestoreTrashed={async () => {}}
                    onPurgeTrashed={async () => {}}
                    onEmptyTrash={async () => {}}
                    onToggleArchive={async () => {}}
                />
            </UIPrefsProvider>
        );
    });
}

/** 布尔断言助手：失败时 actual 也是布尔，不会把 DOM 树拖进错误消息 */
const has = (sel: string) => Boolean(document.querySelector(sel));
const escape = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
};
const openCommandPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
};

test("默认态：导航列 / 工具栏 / 状态栏都在，且看得到专注入口", () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文" })]);
    assert.equal(has("[data-nav-col='1']"), true, "导航列要常驻");
    assert.equal(has("[data-tool='link']"), true, "格式工具栏要常驻（uiSettings.showToolbar 默认开）");
    assert.equal(has("[data-statusbar='1']"), true, "状态栏要常驻");
    assert.equal(has("[data-tool='zen']"), true, "标题行要有专注模式入口");
    assert.equal(has("[data-tool='zen-exit']"), false, "没进专注就不该有退出键");
});

test("点专注：外围整块卸掉，只留标题 / 保存点 / 退出键 / 正文", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文" })]);
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='zen']")!.click();
    });

    assert.equal(has("[data-nav-col='1']"), false, "导航列要卸掉");
    assert.equal(has("[data-list-col='1']"), false, "列表列要卸掉");
    assert.equal(has("[data-tool='link']"), false, "工具栏要卸掉");
    assert.equal(has("[data-statusbar='1']"), false, "状态栏要卸掉");
    assert.equal(has("[data-tool='zen-exit']"), true, "要有退出键");
    // 正文本身不能没：标题输入框和 CodeMirror 编辑器都还得在
    const title = document.querySelector<HTMLInputElement>("input[aria-label='笔记标题']");
    assert.equal(Boolean(title), true, "标题输入框要留着（专注是少干扰，不是不能改标题）");
    assert.equal(title!.value, "甲", "还是原来那条笔记");
    assert.equal(has(".cm-editor"), true, "CodeMirror 编辑器要留着");
});

test("Esc 退出专注，外围原样回来", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文" })]);
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='zen']")!.click();
    });
    assert.equal(has("[data-nav-col='1']"), false, "前置条件：已进专注");
    await act(async () => { escape(); });
    assert.equal(has("[data-nav-col='1']"), true, "Esc 后导航列要回来");
    assert.equal(has("[data-tool='link']"), true, "Esc 后工具栏要回来");
    assert.equal(has("[data-statusbar='1']"), true, "Esc 后状态栏要回来");
    assert.equal(has("[data-tool='zen-exit']"), false, "退出键要消失");
});

test("退出按钮也能退出", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文" })]);
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='zen']")!.click();
    });
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='zen-exit']")!.click();
    });
    assert.equal(has("[data-nav-col='1']"), true, "点退出键要恢复外围");
    assert.equal(has("[data-tool='zen-exit']"), false, "退出键要消失");
});

test("浮层开着时 Esc 先归浮层，不退出专注", async () => {
    mountPanel([note({ id: 1, title: "甲", content: "正文" })]);
    await act(async () => {
        document.querySelector<HTMLButtonElement>("[data-tool='zen']")!.click();
    });
    assert.equal(has("[data-nav-col='1']"), false, "前置条件：已进专注");
    // 开命令面板（⌘K，role=dialog）—— Esc 应该先给它，不动页面布局
    await act(async () => { openCommandPalette(); });
    assert.equal(has("[role='dialog']"), true, "命令面板要开着");
    await act(async () => { escape(); });
    assert.equal(has("[data-tool='zen-exit']"), true, "浮层开着时 Esc 不该退出专注");
    assert.equal(has("[data-nav-col='1']"), false, "布局还是专注态");
});
