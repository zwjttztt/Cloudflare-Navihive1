// tests/noteGraph.dom.test.tsx
// N9 图谱 depth / 范围增强：
//   - depth=1（默认）：只有直接邻居 —— 原有行为不能变；
//   - depth=2/3：沿双链 BFS 往外多走几跳；
//   - 全站模式：孤岛节点也要画出来。
// 链式数据 A→B→C 一眼就能看出 depth 过滤对不对。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import NoteGraphDialog from "../src/components/NoteGraphDialog";
import type { Note } from "../src/API/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const notes: Note[] = [
    { id: 1, title: "A", content: "见 [[B]]" },
    { id: 2, title: "B", content: "见 [[C]]" },
    { id: 3, title: "C", content: "没有链" },
    { id: 4, title: "孤岛", content: "谁也不连" },
];

function mount(activeId: number | null = 1) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <NoteGraphDialog
                open
                notes={notes}
                activeId={activeId}
                onOpenNote={() => {}}
                onClose={() => {}}
            />
        );
    });
}

function cleanup() {
    act(() => root?.unmount());
    if (host) host.remove();
    host = null;
    root = null;
    document.querySelectorAll(".note-graph-dialog-host").forEach(n => n.remove());
}

function nodeIds(): (string | null)[] {
    return Array.from(document.querySelectorAll("[data-graph-node]")).map(n =>
        n.getAttribute("data-graph-node")
    );
}

function clickDepth(d: number) {
    const btn = document.querySelector(`[data-graph-depth='${d}']`) as HTMLButtonElement | null;
    assert.ok(btn, `depth=${d} 按钮应存在`);
    act(() => btn!.click());
}

function clickScope() {
    const btn = document.querySelector("[data-graph-scope]") as HTMLButtonElement | null;
    assert.ok(btn, "范围切换按钮应存在");
    act(() => btn!.click());
}

test("N9 depth=1（默认）：邻域只有直接邻居，二跳之外的 C 不出现", () => {
    mount(1);
    const ids = nodeIds();
    assert.ok(ids.includes("1") && ids.includes("2"), `A、B 应在图上：${ids}`);
    assert.ok(!ids.includes("3"), "C 是二跳之外，不应出现");
    assert.ok(!ids.includes("4"), "孤岛不应出现在邻域模式");
    cleanup();
});

test("N9 depth=2：BFS 多走一跳，C 出现", () => {
    mount(1);
    clickDepth(2);
    const ids = nodeIds();
    assert.ok(ids.includes("1") && ids.includes("2") && ids.includes("3"), `2 跳应含 C：${ids}`);
    assert.ok(!ids.includes("4"), "孤岛仍不在邻域里");
    cleanup();
});

test("N9 全站模式：孤岛也画出来；范围切回后 depth 按钮恢复", () => {
    mount(1);
    clickScope();
    const ids = nodeIds();
    assert.ok(ids.includes("4"), `全站模式应含孤岛：${ids}`);
    assert.ok(document.querySelector("[data-graph-depth='1']") === null, "全站模式不显示 depth 按钮");
    cleanup();
});
