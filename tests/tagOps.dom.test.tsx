// tests/tagOps.dom.test.tsx
// 标签重命名 / 合并的两个入口：UI 能不能走通，以及 hook 有没有真的写回 + 留撤销。
// 纯计算部分在 tests/tagOps.test.ts；这里只盯「点下去发生了什么」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import TagManagerDialog from "../src/components/TagManagerDialog";
import { useTagOpsActions } from "../src/hooks/useTagOpsActions";
import type { TagMap } from "../src/utils/tagOps";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(ui: React.ReactElement) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(ui);
    });
}

function cleanup() {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    document.body.innerHTML = "";
}

const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
const byLabel = (label: string) =>
    buttons().find(b => b.getAttribute("aria-label") === label);
const byText = (text: string) =>
    buttons().find(b => (b.textContent || "").trim() === text);
const bodyText = () => document.body.textContent || "";

function click(el: Element) {
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

/** 受控输入框改值：MUI 的 TextField 认的是 input 事件 + value setter */
function typeInto(input: HTMLInputElement, value: string) {
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
        )?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const TAGS = ["AI", "人工智能", "设计"];
const COUNTS: Record<string, number> = { AI: 2, 人工智能: 3, 设计: 1 };

test("标签管理：每一行都有重命名 / 合并 / 删除三个入口", t => {
    t.after(cleanup);
    mount(
        <TagManagerDialog
            open
            tags={TAGS}
            counts={COUNTS}
            onDeleteTag={() => {}}
            onRenameTag={() => {}}
            onMergeTags={() => {}}
            onClose={() => {}}
        />
    );
    for (const tag of TAGS) {
        assert.ok(byLabel(`重命名标签 ${tag}`), `应有「${tag}」的重命名入口`);
        assert.ok(byLabel(`合并标签 ${tag}`), `应有「${tag}」的合并入口`);
        assert.ok(byLabel(`删除标签 ${tag}`), `应有「${tag}」的删除入口`);
    }
});

test("重命名：改名后回调收到（旧名, 新名）", t => {
    t.after(cleanup);
    const calls: Array<[string, string]> = [];
    mount(
        <TagManagerDialog
            open
            tags={TAGS}
            counts={COUNTS}
            onDeleteTag={() => {}}
            onRenameTag={(from, to) => calls.push([from, to])}
            onClose={() => {}}
        />
    );

    click(byLabel("重命名标签 AI")!);
    assert.ok(bodyText().includes("重命名标签"), "应弹出重命名框");
    assert.ok(bodyText().includes("AI"), "应说明当前是哪个标签");

    const input = document.querySelector<HTMLInputElement>(
        ".nav-tag-rename-dialog input"
    );
    assert.ok(input, "应有新名字输入框");
    typeInto(input!, "人工智能（旧）");
    click(byText("确定")!);

    assert.deepEqual(calls, [["AI", "人工智能（旧）"]]);
});

test("重命名：新名字撞上已有标签时，弹窗明说这是合并", t => {
    t.after(cleanup);
    mount(
        <TagManagerDialog
            open
            tags={TAGS}
            counts={COUNTS}
            onDeleteTag={() => {}}
            onRenameTag={() => {}}
            onClose={() => {}}
        />
    );
    click(byLabel("重命名标签 AI")!);
    const input = document.querySelector<HTMLInputElement>(
        ".nav-tag-rename-dialog input"
    )!;
    typeInto(input, "人工智能");
    const text = bodyText();
    assert.ok(text.includes("等于把两个标签合并"), `撞车时应说明是合并，实际：${text}`);
    assert.ok(text.includes("3 个网站"), "应给出目标标签已有的数量");
});

test("重命名：新名字为空时确定按钮禁用，不会改出空标签", t => {
    t.after(cleanup);
    const calls: Array<[string, string]> = [];
    mount(
        <TagManagerDialog
            open
            tags={TAGS}
            counts={COUNTS}
            onDeleteTag={() => {}}
            onRenameTag={(from, to) => calls.push([from, to])}
            onClose={() => {}}
        />
    );
    click(byLabel("重命名标签 AI")!);
    const input = document.querySelector<HTMLInputElement>(
        ".nav-tag-rename-dialog input"
    )!;
    typeInto(input, "   ");
    assert.ok(byText("确定")!.disabled, "空名字不能提交");
    click(byText("确定")!);
    assert.deepEqual(calls, []);
});

test("合并：选好目标后回调收到（源标签数组, 目标名），且源标签不会作为选项出现", t => {
    t.after(cleanup);
    const calls: Array<[string[], string]> = [];
    mount(
        <TagManagerDialog
            open
            tags={TAGS}
            counts={COUNTS}
            onDeleteTag={() => {}}
            onMergeTags={(sources, target) => calls.push([sources, target])}
            onClose={() => {}}
        />
    );

    click(byLabel("合并标签 AI")!);
    assert.ok(bodyText().includes("合并标签"), "应弹出合并框");
    // 提交前先把话说清楚：源标签会消失，不是「多一个别名」
    assert.ok(bodyText().includes("「AI」不再存在"), "应说明源标签会消失");
    click(byText("合并")!);
    assert.deepEqual(calls, [[["AI"], "人工智能"]], "默认目标应是第一个其它标签");
});

// —— hook 层：真的写回了吗？撤销还在吗？ ——

function ProbeHarness(props: {
    tags: TagMap;
    onApplied: (next: TagMap) => void;
    onNotify: (
        text: string,
        level?: string,
        ms?: number,
        act?: { label: string; onClick: () => void }
    ) => void;
    onFilter: (updater: (prev: string[]) => string[]) => void;
}) {
    const [current, setCurrent] = useState<TagMap>(props.tags);
    const { renameTagWithUndo } = useTagOpsActions({
        tags: current,
        applyTagOps: next => {
            setCurrent(next);
            props.onApplied(next);
        },
        setActiveTags: updater => {
            // 简化：只把最新的筛选结果报出去（避免依赖上一次 state）
            props.onFilter(prev => (updater as (p: string[]) => string[])(prev));
        },
        notify: props.onNotify as never,
    });
    return (
        <button onClick={() => renameTagWithUndo("AI", "人工智能")}>go</button>
    );
}

test("hook：改名后整份标签表被写回，并给了一次可点的撤销", t => {
    t.after(cleanup);
    const applied: TagMap[] = [];
    const notifications: Array<{ text: string; act?: { label: string; onClick: () => void } }> = [];
    mount(
        <ProbeHarness
            tags={{ "1": ["AI"], "2": ["AI"], "3": ["人工智能"] }}
            onApplied={next => applied.push(next)}
            onNotify={(text, _level, _ms, act) => notifications.push({ text, act: act as never })}
            onFilter={() => {}}
        />
    );

    click(byText("go")!);

    assert.equal(applied.length, 1, "应一次性写回整份标签表");
    assert.deepEqual(applied[0]["1"], ["人工智能"]);
    assert.deepEqual(applied[0]["2"], ["人工智能"]);
    assert.deepEqual(applied[0]["3"], ["人工智能"]);
    // 站点 3 本来就带着「人工智能」，不算被改动 —— 影响面只数真正变了的卡片
    assert.match(notifications[0].text, /已把「AI」改名为「人工智能」（2 个网站）/);
    assert.equal(notifications[0].act?.label, "撤销", "应给一次撤销机会");

    // 点撤销：整份旧表写回
    act(() => notifications[0].act!.onClick());
    assert.equal(applied.length, 2);
    assert.deepEqual(applied[1]["1"], ["AI"], "撤销后应恢复旧标签");
});

test("hook：改不动的时候只提示，不动数据", t => {
    t.after(cleanup);
    const applied: TagMap[] = [];
    const notifications: string[] = [];
    mount(
        <ProbeHarness
            tags={{ "1": ["设计"] }}
            onApplied={next => applied.push(next)}
            onNotify={text => notifications.push(text)}
            onFilter={() => {}}
        />
    );
    click(byText("go")!);
    assert.equal(applied.length, 0, "没有卡片带 AI，不该写任何东西");
    assert.ok(notifications[0].includes("没有可改动"), `应给出提示，实际 ${notifications[0]}`);
});
