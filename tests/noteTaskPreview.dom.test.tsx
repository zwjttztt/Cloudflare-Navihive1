// tests/noteTaskPreview.dom.test.tsx
// 预览里的任务复选框：点了要改回正文。
//
// 这一个行为最容易做成「看起来是对的」：
//   - 复选框 render 出去了 ✓
//   - 点一下 UI 变了 ✓
//   - 但源码没改 / 改错行 / 被下一次自动保存覆盖回去 ✗
// 所以这里钉三件事：① 传了回调才有 `data-task-line`（没传=只读）；
// ② 点击报的是**原文行号**（带 front matter 时要加偏移）；
// ③ 用 noteTasks.toggleTaskLine 走一遍，确认这一行真的能被改成你想要的样子。
import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";
import { toggleTaskLine } from "../src/utils/noteTasks";

type ToggleLog = { line: number; checked: boolean }[];

async function renderTaskList(md: string, log?: ToggleLog): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = await renderMarkdownToReact(md, {
        onToggleTask: (line, checked) => log?.push({ line, checked }),
    });
    const root = createRoot(host);
    act(() => {
        root.render(node);
    });
    return host;
}

test("任务清单渲染成复选框；没给回调用回调时是真只读", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = await renderMarkdownToReact("- [ ] 甲\n- [x] 乙");
    act(() => {
        createRoot(host).render(node);
    });
    const boxes = [...host.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    assert.equal(boxes.length, 2, "两个任务项要各有一个勾选框");
    assert.equal(boxes[0].checked, false);
    assert.equal(boxes[1].checked, true);
    // ⚠️ 只读是**真**只读：没有 data-task-line，宿主也就无从下手
    assert.equal(boxes[0].dataset.taskLine, undefined);
    assert.equal(boxes[0].readOnly, true);
    host.remove();
});

test("给了回调用回调才能勾：上报的是原始行号", async () => {
    const log: ToggleLog = [];
    const source = "今日事项\n\n- [ ] 甲\n- [x] 乙";
    const host = await renderTaskList(source, log);
    const boxes = [...host.querySelectorAll<HTMLInputElement>("input[type='checkbox']")];
    assert.equal(boxes[0].dataset.taskLine, "2", "第一个任务项在原文第 2 行（0 基）");
    assert.equal(boxes[1].dataset.taskLine, "3");

    act(() => {
        boxes[0].click();
    });
    assert.deepEqual(log, [{ line: 2, checked: true }]);
    // 报出来的行号要真的能改成功（不然 UI 动了、正文没动）
    assert.equal(toggleTaskLine(source, log[0].line, log[0].checked), "今日事项\n\n- [x] 甲\n- [x] 乙");
    host.remove();
});

test("带 front matter 时行号要加回属性块占掉的那几行", async () => {
    const log: ToggleLog = [];
    // 属性块 3 行 + 一个空行 → 任务项在原文第 4 行
    const source = "---\ntitle: 甲\n---\n\n- [ ] 待办";
    const host = await renderTaskList(source, log);
    const box = host.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    assert.equal(box.dataset.taskLine, "4", "行号必须是**原文**里的行号，不是摘掉属性后的");
    act(() => {
        box.click();
    });
    assert.deepEqual(log, [{ line: 4, checked: true }]);
    assert.equal(toggleTaskLine(source, 4, true), "---\ntitle: 甲\n---\n\n- [x] 待办");
    host.remove();
});

test("取消勾选也要报回来（来回点不能只报第一次）", async () => {
    const log: ToggleLog = [];
    const host = await renderTaskList("- [x] 已完成", log);
    const box = host.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    act(() => {
        box.click();
    });
    assert.deepEqual(log, [{ line: 0, checked: false }]);
    host.remove();
});
