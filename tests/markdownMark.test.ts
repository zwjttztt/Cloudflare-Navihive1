// tests/markdownMark.test.ts
// 高亮语法 `==文本==` 的解析用例。
//
// 为什么单独一组：工具栏那个高亮按钮「点了没反应」过一次 ——
// 插入的 `==…==` 在预览里原样显示成那四个字符。插入其实是对的，
// 问题是渲染层没装 mark 规则（现成的 markdown-it-mark 插件注册的是
// renderer.rules，而本项目只把 markdown-it 当解析器，插件不会被调用）。
// 所以要单独钉住「`==x==` 真的变成 mark_inline」这件事。

import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { registerMark } from "../src/utils/markdownMark";

function makeMarkdownIt() {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
    registerMark(md);
    return md;
}

function flat(tokens: Token[]): Token[] {
    const out: Token[] = [];
    for (const t of tokens) {
        out.push(t);
        if (t.children) out.push(...flat(t.children));
    }
    return out;
}

function pick(tokens: Token[], type: string): Token[] {
    return tokens.filter(t => t.type === type);
}

test("==文本== 解析成 mark_inline，内容是去掉标记后的原文", () => {
    const md = makeMarkdownIt();
    const marks = pick(flat(md.parse("这是==高亮==内容", {})), "mark_inline");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].content, "高亮");
});

test("一段里多次高亮都认", () => {
    const md = makeMarkdownIt();
    const marks = pick(flat(md.parse("==甲== 和 ==乙== 都要高亮", {})), "mark_inline");
    assert.equal(marks.length, 2);
    assert.deepEqual(marks.map(t => t.content), ["甲", "乙"]);
});

test("没闭合的 == 不当高亮（原文留着）", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("这里有 ==没闭合", {});
    assert.equal(pick(flat(tokens), "mark_inline").length, 0);
    const text = flat(tokens).filter(t => t.type === "text").map(t => t.content).join("");
    assert.ok(text.includes("没闭合"), "原文要留着");
});

test("正文里的等号（a == b）不被误伤", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("a == b", {})), "mark_inline").length, 0);
    assert.equal(pick(flat(md.parse("x==y==z", {})), "mark_inline").length, 1, "x==y==z 仍要认");
});

test("== 后面紧跟空白不当高亮（那是正文里的两个等号）", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("== 高亮", {})), "mark_inline").length, 0);
});

test("闭合 == 前面是空白也不认", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("高亮 == 内容==", {})), "mark_inline").length, 0);
});

test("内容为空不当高亮", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("====", {})), "mark_inline").length, 0);
});

test("高亮不跨行", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("==跨\n行==", {})), "mark_inline").length, 0);
});

test("高亮里的 \\= 不参与闭合", () => {
    const md = makeMarkdownIt();
    const marks = pick(flat(md.parse("==a \\= b==", {})), "mark_inline");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].content, "a \\= b");
});
