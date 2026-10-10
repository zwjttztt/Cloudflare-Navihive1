// tests/notesCommandPalette.dom.test.tsx
// N1 记事本命令面板：项生成 / 分组 / `>` 仅命令 / 远端命中合并 / 无结果建笔记。
//
// 为什么补它：命令面板是记事本里「跳得快」的入口，之前完全没有。
// 这里钉死四件最容易写坏的事：① 空查询给最近笔记 + 命令；
// ② `>` 前缀只搜命令；③ 远端 /search 命中带摘要并上浮；
// ④ 没有任何命中时给「用输入新建笔记」这条退路。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NotesCommandPalette from "../src/components/NotesCommandPalette";
import type { CommandItem } from "../src/components/CommandPalette";
import type { Note, NoteFolder, NoteTag, NoteSearchResult } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const notes: Note[] = [
    { id: 1, title: "Alpha 笔记", content: "开头的无关介绍\nAlpha 命中行的上下文\n结尾" },
    { id: 2, title: "Beta 笔记", content: "beta body" },
    { id: 3, title: "Gamma 笔记", content: "gamma body" },
];
const folders: NoteFolder[] = [{ id: 10, name: "工作笔记" }];
const tags: NoteTag[] = [{ id: 20, name: "随手记" }];
const commands: CommandItem[] = [
    { id: "new", label: "新建笔记", section: "笔记", run: () => {} },
    { id: "find", label: "查找 / 替换", section: "编辑", run: () => {} },
];

function mount(opts: {
    open?: boolean;
    recentNoteIds?: number[];
    onSearchRemote?: (q: string) => Promise<NoteSearchResult | null>;
} = {}) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <NotesCommandPalette
                open={opts.open ?? true}
                onClose={() => {}}
                notes={notes}
                folders={folders}
                tags={tags}
                commands={commands}
                recentNoteIds={opts.recentNoteIds}
                onSearchRemote={opts.onSearchRemote}
                onOpenNote={() => {}}
                onOpenFolder={() => {}}
                onOpenTag={() => {}}
                onCreateNote={() => {}}
            />
        );
    });
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
    // MUI Dialog 走 portal，卸载后清掉残留在 body 的节点
    document.querySelectorAll(".notes-command-palette").forEach(n => n.remove());
}

function rows(): string[] {
    return Array.from(
        document.querySelectorAll(".notes-command-palette .MuiListItemButton-root")
    ).map(el => (el.textContent || "").replace(/\s+/g, " ").trim());
}

function typeInto(value: string) {
    const input = document.querySelector(
        '.notes-command-palette input[aria-label="记事本命令面板搜索"]'
    ) as HTMLInputElement | null;
    assert.ok(input, "命令面板输入框应存在");
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
    )!.set!;
    act(() => {
        setter.call(input, value);
        input!.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
}

test("N1 空查询：展示最近打开的笔记 + 命令", () => {
    mount({ recentNoteIds: [1] });
    const items = rows();
    assert.ok(items.some(t => t.includes("Alpha 笔记")), "应显示最近笔记 Alpha");
    assert.ok(items.some(t => t.includes("新建笔记")), "应显示命令「新建笔记」");
    cleanup();
});

test("N1 普通查询：文件夹匹配出现并标「文件夹」分区", () => {
    mount();
    typeInto("工作");
    const items = rows();
    assert.ok(items.some(t => t.includes("工作笔记")), "应匹配文件夹「工作笔记」");
    assert.ok(items.some(t => t.includes("文件夹")), "应标文件夹分区");
    cleanup();
});

test("N1 `>` 前缀：只搜命令，不出现笔记", () => {
    mount({ recentNoteIds: [1] });
    typeInto(">新");
    const items = rows();
    assert.ok(items.some(t => t.includes("新建笔记")), "命令应命中");
    assert.ok(!items.some(t => t.includes("Alpha 笔记")), "笔记不应出现在仅命令模式");
    cleanup();
});

test("N1 远端命中：带摘要并上浮", async () => {
    const onSearchRemote = async (): Promise<NoteSearchResult> => ({
        mode: "fts",
        results: [{ id: 2, title: "Beta 笔记", snippet: "远端命中片段", score: 5 }],
    });
    mount({ onSearchRemote });
    typeInto("Beta");
    // 远端检索有 180ms 防抖，等它回来
    await act(async () => {
        await new Promise(r => setTimeout(r, 260));
    });
    const items = rows();
    const beta = items.find(t => t.includes("Beta 笔记"));
    assert.ok(beta, "Beta 笔记应出现");
    assert.ok(beta!.includes("远端命中片段"), "应带远端摘要");
    cleanup();
});

test("仅输入 > 时不展示最近笔记", () => {
    mount({ recentNoteIds: [1] });
    typeInto(">");
    assert.ok(!rows().some(t => t.includes("Alpha")));
    assert.ok(rows().some(t => t.includes("新建笔记")));
    cleanup();
});

test("本地搜索摘要优先显示关键词命中行", () => {
    mount();
    typeInto("Alpha");
    const item = rows().find(row => row.includes("Alpha 笔记"));
    assert.ok(item?.includes("Alpha 命中行的上下文"));
    assert.ok(!item?.includes("开头的无关介绍"));
    cleanup();
});

test("输入法选词 Enter 不执行命令", () => {
    mount({ recentNoteIds: [1] });
    const input = document.querySelector('.notes-command-palette input')!;
    const event = new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    act(() => { input.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, false);
    cleanup();
});

test("N1 无结果：用输入新建笔记", () => {
    mount();
    typeInto("zzz什么都没有");
    const items = rows();
    assert.ok(
        items.some(t => t.includes("用「zzz什么都没有」新建笔记")),
        "应给「用输入新建笔记」退路"
    );
    cleanup();
});
