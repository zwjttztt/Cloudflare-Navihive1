// tests/historyStack.test.ts
// 撤销/重做命令栈的纯逻辑单测。
// 之前这块 0 测试，而它是全站破坏性操作（删站点/删分组/批量删）唯一的「后悔药」，
// 一旦 undo/redo 把栈弄错，用户删了东西就找不回来。这里把最容易错的三件事钉死：
// 1) 撤销失败不能把那一步弄丢；2) 推新操作要作废之前的重做路径；3) 栈深有上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryStack, MAX_HISTORY_STEPS } from "../src/utils/historyStack";

const cmd = (label: string, on?: () => void, redo?: () => void) => ({
    label,
    undo: on ?? (() => {}),
    redo: redo ?? (() => {}),
});

test("撤销刚推的一步：返回说明文字，且调用了 undo、移入重做栈", async () => {
    const s = new HistoryStack();
    let undone = 0;
    s.push(cmd("删除站点 A", () => { undone++; }));
    assert.equal(await s.undo(), "删除站点 A");
    assert.equal(undone, 1);
    assert.equal(s.canUndo, false);
    assert.equal(s.canRedo, true);
});

test("重做把撤销的那步放回去：调用 redo，移回撤销栈", async () => {
    const s = new HistoryStack();
    let redone = 0;
    s.push(cmd("删除站点 A", () => {}, () => { redone++; }));
    await s.undo();
    assert.equal(await s.redo(), "删除站点 A");
    assert.equal(redone, 1);
    assert.equal(s.canUndo, true);
    assert.equal(s.canRedo, false);
});

test("空栈撤销 / 重做都返回 null，且不抛错", async () => {
    const s = new HistoryStack();
    assert.equal(await s.undo(), null);
    assert.equal(await s.redo(), null);
});

test("推新操作后，之前的重做路径被作废（redo 栈清空）", async () => {
    const s = new HistoryStack();
    s.push(cmd("第一步"));
    await s.undo(); // 现在 redo 栈里有「第一步」，undo 栈清空
    assert.equal(s.canRedo, true);
    assert.equal(s.undoDepth, 0);
    s.push(cmd("第二步")); // 新操作应该清空 redo 栈
    assert.equal(s.canRedo, false);
    // undo 栈里只有刚推的「第二步」一个（「第一步」已被清掉，不会回来）
    assert.equal(s.undoDepth, 1);
});

test("撤销失败：那一步不能丢，仍留在撤销栈并往上抛", async () => {
    const s = new HistoryStack();
    s.push(cmd("会失败的撤销", () => { throw new Error("boom"); }));
    await assert.rejects(() => s.undo(), /撤销失败/);
    // 失败后栈里还在，用户可以再试
    assert.equal(s.canUndo, true);
    assert.equal(s.undoDepth, 1);
    // 再推一个能成功的，能正常撤销
    s.push(cmd("能成功"));
    assert.equal(await s.undo(), "能成功");
});

test("重做失败：那一步留在重做栈并往上抛", async () => {
    const s = new HistoryStack();
    s.push(cmd("会失败的重做", () => {}, () => { throw new Error("boom"); }));
    await s.undo();
    await assert.rejects(() => s.redo(), /重做失败/);
    assert.equal(s.canRedo, true);
    assert.equal(s.redoDepth, 1);
});

test("栈深有上限：超过后最旧的一步被丢掉", () => {
    const s = new HistoryStack();
    for (let i = 0; i < MAX_HISTORY_STEPS + 10; i++) s.push(cmd(`第${i}步`));
    assert.equal(s.undoDepth, MAX_HISTORY_STEPS);
});

test("clear 同时清空两个栈", async () => {
    const s = new HistoryStack();
    s.push(cmd("A"));
    await s.undo();
    s.clear();
    assert.equal(s.canUndo, false);
    assert.equal(s.canRedo, false);
    assert.equal(s.undoDepth, 0);
    assert.equal(s.redoDepth, 0);
});
