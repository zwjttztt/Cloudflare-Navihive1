// tests/backlinksPanel.dom.test.tsx
// N4 反链右侧常驻面板：数量角标 / 上下文摘要 / 点击跳转 / 空态 / 关闭即卸载。
// 钉死「上下文摘要」—— 摘要必须来自引用所在的那一行，而不是随便一句正文。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import BacklinksPanel, { wikiContextSnippet } from "../src/components/BacklinksPanel";
import type { Note } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const notes: Note[] = [
    { id: 1, title: "目标笔记", content: "目标正文" },
    {
        id: 2,
        title: "来源甲",
        content: "# 来源甲\n\n开头一句\n\n见 [[目标笔记]] 的说明，这一句就是上下文。\n\n结尾",
    },
    { id: 3, title: "来源乙", content: "没有引用" },
];

function mount(props: { open?: boolean; currentTitle?: string; currentId?: number; onOpenNote?: (id: number) => void }) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <BacklinksPanel
                open={props.open ?? true}
                onClose={() => {}}
                notes={notes}
                currentId={props.currentId ?? 1}
                currentTitle={props.currentTitle ?? "目标笔记"}
                onOpenNote={props.onOpenNote ?? (() => {})}
            />
        );
    });
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
}

test("N4 wikiContextSnippet：取引用所在那行并压掉 Markdown 符号", () => {
    const s = wikiContextSnippet(notes[1].content, "目标笔记");
    assert.ok(s.includes("见 [[目标笔记]] 的说明"), s);
    assert.ok(!s.includes("开头一句"), "不应混入无关行");
    assert.ok(!s.includes("#"), `不应带标题符号：${s}`);
    assert.equal(wikiContextSnippet(notes[2].content, "目标笔记"), "");
});

test("N4 面板：数量角标 + 条目 + 上下文摘要 + 点击跳转", () => {
    const opened: number[] = [];
    mount({ onOpenNote: id => opened.push(id) });
    const panel = document.querySelector("[data-backlinks-panel='1']");
    assert.ok(panel, "面板应挂载");
    assert.ok(panel!.textContent!.includes("反向链接（1）"), panel!.textContent);
    const item = document.querySelector("[data-backlink-item='2']") as HTMLElement | null;
    assert.ok(item, "来源甲应出现");
    assert.ok(item!.textContent!.includes("来源甲"), item!.textContent);
    assert.ok(item!.textContent!.includes("见 [[目标笔记]] 的说明"), "应带上下文摘要");
    act(() => item!.click());
    assert.deepEqual(opened, [2], "点击条目应回调 onOpenNote");
    cleanup();
});

test("N4 空态：没有反链时给说明文案而不是空白", () => {
    mount({ currentId: 3, currentTitle: "没有引用" });
    const empty = document.querySelector("[data-backlinks='empty']");
    assert.ok(empty, "应有空态说明");
    cleanup();
});

test("N4 open=false 不渲染（条件渲染，DOM 里不存在）", () => {
    mount({ open: false });
    assert.ok(document.querySelector("[data-backlinks-panel='1']") === null, "面板不应挂载");
    cleanup();
});
