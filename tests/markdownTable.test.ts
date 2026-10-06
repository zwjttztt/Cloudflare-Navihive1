// tests/markdownTable.test.ts
// 表格增删行列的**纯函数**边界（阶段四第 12 条）。
//
// 为什么单独一组：这类操作差一个管道符整张表就错位，而错位后的源码点开还「看着像表」，
// 只有渲染出来才发现列对不上 —— 靠肉眼点很难兜住，必须钉住字符串。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    addColumnRight,
    addRowBelow,
    buildTable,
    columnAtCursor,
    findTableBlock,
    isSeparatorLine,
    isTableLine,
    parseRow,
    removeColumn,
    removeRow,
} from "../src/utils/markdownTable";

/** 一张标准三列表（表头 2 行 + 2 行正文） */
const TABLE = [
    "| 列1  | 列2  | 列3  |",
    "| ---- | ---- | ---- |",
    "| a    | b    | c    |",
    "| d    | e    | f    |",
];

test("isTableLine：首尾都要是管道，只以 | 开头的不算", () => {
    assert.ok(isTableLine("| a | b |"));
    assert.ok(!isTableLine("| 这不是表"), "只有开头的管道是列表转义，不能当表格");
    assert.ok(!isTableLine("普通文字"));
});

test("isSeparatorLine：只认 --- （含对齐冒号），普通行不算", () => {
    assert.ok(isSeparatorLine("| --- | --- |"));
    assert.ok(isSeparatorLine("| :--- | ---: |"));
    assert.ok(!isSeparatorLine("| a | b |"), "有文字的不是分隔行");
});

test("parseRow 拆出单元格并 trim", () => {
    assert.deepEqual(parseRow("| a | b | c |"), ["a", "b", "c"]);
});

test("buildTable：列数行数都对，且带分隔行", () => {
    const t = buildTable(2, 3);
    assert.equal(t.length, 4, "表头 + 分隔 + 2 行正文");
    assert.ok(isSeparatorLine(t[1]), "第二行必须是分隔行");
    assert.deepEqual(parseRow(t[0]), ["列1", "列2", "列3"]);
    assert.deepEqual(parseRow(t[2]), ["", "", ""]);
});

test("findTableBlock：光标在正文行能圈住整张表", () => {
    const block = findTableBlock(TABLE, 2);
    assert.deepEqual(block, { start: 0, end: 3 });
});

test("findTableBlock：没有分隔行的「假表」不算表格", () => {
    // 两行都首尾带管道，但缺分隔行 —— 真表格一定有它
    const fake = ["| 这不是表 |", "| 只是两行竖线 |"];
    assert.equal(findTableBlock(fake, 0), null);
});

test("findTableBlock：光标不在表格行上返回 null", () => {
    assert.equal(findTableBlock(["前文", ...TABLE], 0), null);
});

test("addRowBelow：在光标行下面插一行空行，列数跟表头走", () => {
    const out = addRowBelow(TABLE, 2);
    assert.equal(out.length, 5);
    assert.deepEqual(parseRow(out[3]), ["", "", ""], "新行是三个空格子");
    assert.deepEqual(parseRow(out[4]), ["d", "e", "f"], "原来的最后一行要在新行之后");
});

test("addRowBelow：光标在表头 / 分隔行时，新行落到表尾（不能插到分隔行前面）", () => {
    // 浏览器实测撞出来的：光标停在第 0 行（表头）点「下方插入一行」，
    // 新行被夹进表头与分隔行之间 → 分隔行下移一格 → 整张表在预览里直接散掉。
    const head = addRowBelow(TABLE, 0);
    assert.equal(head.length, 5, "整表还是 5 行");
    assert.ok(isSeparatorLine(head[1]), "分隔行必须还在第二行：" + head.join(" | "));
    assert.deepEqual(parseRow(head[4]), ["", "", ""], "新行在表尾，原来的最后一行被顶下去");

    const sep = addRowBelow(TABLE, 1);
    assert.ok(isSeparatorLine(sep[1]), "光标在分隔行上，分隔行不能被挤走");
    assert.equal(sep.length, 5);
});

test("removeRow：只删正文行，表头和分隔行删不动", () => {
    const out = removeRow(TABLE, 2);
    assert.equal(out.length, 3);
    assert.deepEqual(parseRow(out[2]), ["d", "e", "f"]);

    // 表头 / 分隔行：删了整表就废了，宁可什么都不做
    assert.equal(removeRow(TABLE, 0).length, 4, "表头不能删");
    assert.equal(removeRow(TABLE, 1).length, 4, "分隔行不能删");
});

test("columnAtCursor：按光标前的管道数定列", () => {
    const line = "| a | b | c |";
    //        下标 0 1 2 3 4 5 6...
    assert.equal(columnAtCursor(line, 4), 0, "光标在 a 里 → 第 0 列");
    assert.equal(columnAtCursor(line, 8), 1, "光标在 b 里 → 第 1 列");
    assert.equal(columnAtCursor(line, 12), 2, "光标在 c 里 → 第 2 列");
});

test("addColumnRight：在光标所在列右边加一列，表头补「新列」", () => {
    // 光标落在第 0 列（a 里）
    const out = addColumnRight(TABLE, 2, 4);
    assert.deepEqual(parseRow(out[0]), ["列1", "新列", "列2", "列3"], "表头插在列1右边");
    assert.ok(isSeparatorLine(out[1]), "分隔行要跟着补 --- 而不是『新列』");
    assert.deepEqual(parseRow(out[1]).map(c => c.replace(/[:-]/g, "")), ["", "", "", ""]);
    assert.deepEqual(parseRow(out[2]), ["a", "", "b", "c"]);
});

test("removeColumn：删掉光标所在列，只剩一列时不动", () => {
    const out = removeColumn(TABLE, 2, 8); // 光标在 b → 删第 1 列
    assert.deepEqual(parseRow(out[0]), ["列1", "列3"]);
    assert.deepEqual(parseRow(out[2]), ["a", "c"]);
    assert.deepEqual(parseRow(out[3]), ["d", "f"]);

    const single = ["| 只剩 |", "| ---- |", "| a |"];
    assert.deepEqual(removeColumn(single, 2, 3), single, "剩一列时不删");
});

test("不在表格里时，四个操作都原样返回（不许改坏别的文字）", () => {
    const plain = ["# 标题", "", "随便一行字"];
    assert.deepEqual(addRowBelow(plain, 0), plain);
    assert.deepEqual(removeRow(plain, 0), plain);
    assert.deepEqual(addColumnRight(plain, 0, 0), plain);
    assert.deepEqual(removeColumn(plain, 0, 0), plain);
});

test("增删之后整表重排，各列仍然对齐（源码看着还是一张表）", () => {
    const out = addColumnRight(TABLE, 2, 4);
    // 每一行的管道数要一致，否则渲染出来列会错位
    const pipeCounts = new Set(out.map(l => (l.match(/\|/g) || []).length));
    assert.equal(pipeCounts.size, 1, "各行管道数不一致：" + out.join("\n"));
});
