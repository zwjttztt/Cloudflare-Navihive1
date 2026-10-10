// tests/noteTasks.test.ts
// 预览里点任务复选框 ↔ 源码 `- [ ]` / `- [x]` 的互改。
//
// 这一组盯的是**写回的正确性**：任务清单最容易写出「勾一下把整行吞掉」的 bug ——
// 比如整行 replace 成 `- [x]`，缩进、有序列表编号、`*`/`+` 标记就全没了，
// 用户保存后发现列表结构被摊平。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTaskLine, toggleTaskLine } from "../src/utils/noteTasks";

test("勾上：只改方括号里那一个字符，行首标记原样保留", () => {
    const src = "- [ ] 写周报";
    assert.equal(toggleTaskLine(src, 0, true), "- [x] 写周报");
});

test("取消勾选：x 还原成空格", () => {
    assert.equal(toggleTaskLine("- [x] 已完成", 0, false), "- [ ] 已完成");
});

test("缩进后的子任务：`    - [ ]` 的四个空格必须留着", () => {
    const out = toggleTaskLine("- 父\n    - [ ] 子任务", 1, true);
    assert.equal(out, "- 父\n    - [x] 子任务");
});

test("三种无序标记与有序列表都认（不能只认 `-`）", () => {
    assert.equal(toggleTaskLine("* [ ] 星号", 0, true), "* [x] 星号");
    assert.equal(toggleTaskLine("+ [ ] 加号", 0, true), "+ [x] 加号");
    assert.equal(toggleTaskLine("1. [ ] 有序", 0, true), "1. [x] 有序");
    assert.equal(toggleTaskLine("2) [ ] 有序括号", 0, true), "2) [x] 有序括号");
});

test("大写 [X] 也认（用户/其它工具可能那样写）", () => {
    assert.equal(toggleTaskLine("- [X] 完成", 0, false), "- [ ] 完成");
});

test("多行里只改指定的那一行，其它行一字不动", () => {
    const src = "- [ ] 甲\n- [x] 乙\n- [ ] 丙";
    const out = toggleTaskLine(src, 2, true);
    assert.equal(out, "- [ ] 甲\n- [x] 乙\n- [x] 丙");
});

test("边界：不是任务行 / 行号越界 / 已经是目标状态 → 都返回 null（不许乱写）", () => {
    const src = "- [ ] 甲\n普通一行\n";
    assert.equal(toggleTaskLine(src, 1, true), null, "普通行不能改");
    assert.equal(toggleTaskLine(src, 99, true), null, "越界行号不能改");
    assert.equal(toggleTaskLine(src, -1, true), null, "负数行号不能改");
    assert.equal(toggleTaskLine(src, 0, false), null, "本来就没勾 → 不用改");
    // ⚠️ 这不是「吹毛求疵」：返回 null 是调用方「放弃写回」的唯一依据，
    // 返回一个照原样拼回去的字符串，会让调用方误以为「改成功了」。
});

test("isTaskLine：同一套判据给渲染层判断要不要给可点勾选框", () => {
    const src = "- [ ] 甲\n普通一行";
    assert.equal(isTaskLine(src, 0), true);
    assert.equal(isTaskLine(src, 1), false);
    assert.equal(isTaskLine(src, 42), false);
});
