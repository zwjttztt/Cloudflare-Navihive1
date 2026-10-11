// tests/noteTodoAgenda.test.ts
//
// 全库待办聚合（阶段②）的纯逻辑：收集、围栏跳过、计数。
// 勾选回写复用 toggleTaskLine（它有自己的用例），这里只钉「收得对不对」。
import assert from "node:assert/strict";
import test from "node:test";
import { collectTodos, todoCounts } from "../src/utils/noteTodoAgenda";

const note = (id: number, content: string, title?: string) => ({ id, content, title });

test("收集：无序/有序/星号标记都认，文本取标记后的部分", () => {
    const items = collectTodos([
        note(1, "- [ ] 买菜\n* [x] 已办的事\n+ [ ] 第三种\n1. [ ] 有序任务"),
    ], { includeDone: true });
    assert.deepEqual(
        items.map(i => [i.line, i.text, i.done]),
        [
            [0, "买菜", false],
            [1, "已办的事", true],
            [2, "第三种", false],
            [3, "有序任务", false],
        ]
    );
});

test("收集：围栏代码块里的 - [ ] 是示例不是任务，整段跳过", () => {
    const items = collectTodos([
        note(1, "正文\n\n```md\n- [ ] 这是一段示例\n```\n\n- [ ] 真任务"),
    ]);
    assert.deepEqual(items.map(i => i.text), ["真任务"]);
    // 未闭合围栏到文末：后面的内容全在围栏里，一条都不收
    assert.deepEqual(collectTodos([note(2, "```md\n- [ ] 假任务")]), []);
});

test("收集：includeDone 默认只收未完成；跨笔记聚合并保留 noteId", () => {
    const notes = [
        note(1, "- [ ] 甲\n- [x] 乙"),
        note(2, "- [ ] 丙"),
    ];
    assert.deepEqual(collectTodos(notes).map(i => [i.noteId, i.text]), [[1, "甲"], [2, "丙"]]);
    assert.deepEqual(collectTodos(notes, { includeDone: true }).length, 3);
    // 空内容 / 无 id 的条目直接跳过
    assert.deepEqual(collectTodos([{ id: 3 }, { content: "- [ ] 没有id" }]), []);
});

test("计数：open/done 分开统计（角标只用 open）", () => {
    const counts = todoCounts([note(1, "- [ ] 甲\n- [x] 乙\n- [ ] 丙")]);
    assert.deepEqual(counts, { open: 2, done: 1 });
});
