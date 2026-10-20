// tests/noteSummary.test.ts
// 笔记列表那行预览的摘要生成（src/utils/noteSummary.ts）。
//
// 2026-10-20 从 NotesPage.tsx 抽出来后才好测：它住在 6675 行的组件文件里时，
// 想测它就得把整个记事页一起 import。抽成纯函数后，这些边界一次钉完。
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../src/utils/noteSummary";

test("去掉 Markdown 语法符号，压成一行", () => {
    assert.equal(summarize("# 标题\n\n正文 **粗体** 和 `代码`"), "标题 正文 粗体 和 代码");
});

test("代码块整段丢掉（里面往往是示例，不是内容）", () => {
    const src = "前言\n```js\nconsole.log(1)\n```\n后记";
    assert.equal(summarize(src), "前言 后记");
});

test("任务列表的方括号与引用符号都不留", () => {
    assert.equal(summarize("- [x] 完成的事\n- [ ] 待办\n> 引用一句"), "完成的事 待办 引用一句");
});

test("超过 max 才截断并加省略号，刚好等于不截", () => {
    assert.equal(summarize("一二三四五", 5), "一二三四五");
    assert.equal(summarize("一二三四五六", 5), "一二三四五…");
});

test("空串 / 全是空白的串返回空（不返回省略号）", () => {
    assert.equal(summarize(""), "");
    assert.equal(summarize("   \n\t "), "");
});

test("空白折叠成一个空格（预览行不该换行）", () => {
    assert.equal(summarize("a\n\n\nb   c"), "a b c");
});
