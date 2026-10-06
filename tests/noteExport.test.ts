// tests/noteExport.test.ts
// 单条笔记导出（.md）的用例。
//
// 重点不在「拼字符串」，而在**文件名**：标题里带 `/ \ : * ? " < > |` 时
// 拿它当文件名，Windows 上根本存不下来（另存为报错，或静默失败），
// 而用户看到的现象是「点了导出，什么也没发生」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFileName, buildNoteMarkdown } from "../src/utils/noteExport";

test("普通标题原样保留", () => {
    assert.equal(safeFileName("会议纪要"), "会议纪要");
});

test("Windows 非法字符换成下划线", () => {
    assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
});

test("结尾的点与空格要去掉（系统会悄悄截掉 → 导出成没有后缀的文件）", () => {
    assert.equal(safeFileName("标题..."), "标题");
    assert.equal(safeFileName("标题   "), "标题");
    assert.equal(safeFileName("标题 . "), "标题");
});

test("全是空白或符号时给兜底名", () => {
    assert.equal(safeFileName(""), "未命名笔记");
    assert.equal(safeFileName("   "), "未命名笔记");
    assert.equal(safeFileName("..."), "未命名笔记");
});

test("文件名长度封顶（Windows 路径 260 字符限制）", () => {
    assert.ok(safeFileName("长".repeat(200)).length <= 60);
});

test("换行与 Tab 压成单空格（标题里出现换行会直接破坏文件名）", () => {
    assert.equal(safeFileName("第一行\n第二行"), "第一行 第二行");
    assert.equal(safeFileName("甲\t乙"), "甲 乙");
});

test("导出内容：有标题时补一级标题", () => {
    assert.equal(buildNoteMarkdown("我的笔记", "正文一\n正文二"), "# 我的笔记\n\n正文一\n正文二");
});

test("导出内容：正文首行已经是标题就不重复加", () => {
    const body = "# 已经是标题\n\n正文";
    assert.equal(buildNoteMarkdown("标题", body), body);
});

test("导出内容：无标题时只给正文", () => {
    assert.equal(buildNoteMarkdown("", "只有正文"), "只有正文");
    assert.equal(buildNoteMarkdown("   ", "只有正文"), "只有正文");
});
