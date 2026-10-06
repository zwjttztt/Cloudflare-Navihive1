// tests/markdownCallout.test.ts
// 内容块（`> [!NOTE]` 这类）的判据。
//
// 重点是**不该被当成 callout 的情形**：普通引用块必须原样渲染，
// 否则用户平时写的 `>` 引用会突然多出图标和底色。
//
// ⚠️ 这里必须**真跑一遍 markdown-it**（而不是只测 parseCalloutType）：
//   第一版把规则实现成 block 规则（手工 tokenize 整块引用），
//   parseCalloutType 全绿、真解析却一个 callout_open 都产不出来 ——
//   纯函数测得再对也证明不了「渲染层能收到 token」。
import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCalloutType, registerCallout } from "../src/utils/markdownCallout";

/** 单测会被复制到 script/tmp-tests/ 下再跑，逐级向上找真身 */
function findProjectDir(): string {
    for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++) {
        try {
            readFileSync(resolve(dir, "package.json"), "utf-8");
            return dir;
        } catch {
            dir = dirname(dir);
        }
    }
    throw new Error("找不到项目根目录");
}

function parse(src: string) {
    const md = new MarkdownIt({ html: false, linkify: true });
    registerCallout(md);
    const tokens = md.parse(src, {});
    return {
        types: tokens.map(t => t.type),
        callouts: tokens.filter(t => t.type === "callout_open").map(t => t.meta?.callout),
        text: tokens
            .filter(t => t.type === "inline")
            .flatMap(t => (t.children ?? []).map(c => c.content))
            .join(""),
    };
}

test("支持的类型（大小写不敏感）", () => {
    assert.equal(parseCalloutType("[!NOTE]"), "NOTE");
    assert.equal(parseCalloutType("[!note]"), "NOTE");
    assert.equal(parseCalloutType("[!Tip]"), "TIP");
    assert.equal(parseCalloutType("[!IMPORTANT]"), "IMPORTANT");
    assert.equal(parseCalloutType("[!WARNING]"), "WARNING");
    assert.equal(parseCalloutType("[!QUOTE]"), "QUOTE");
});

test("不认识的类型不算 callout（该当普通引用）", () => {
    assert.equal(parseCalloutType("[!FAQ]"), null);
    assert.equal(parseCalloutType("[!DANGER]"), null);
    assert.equal(parseCalloutType("NOTE"), null);
    assert.equal(parseCalloutType(""), null);
});

test("前后空白不影响判定", () => {
    assert.equal(parseCalloutType("  [!warning]  "), "WARNING");
});

test("真解析：`> [!NOTE]` 产出 callout_open/close，且标记从正文里摘掉", () => {
    const r = parse("> [!NOTE] 提示内容");
    assert.deepEqual(r.types, [
        "callout_open",
        "blockquote_open",
        "paragraph_open",
        "inline",
        "paragraph_close",
        "blockquote_close",
        "callout_close",
    ]);
    assert.deepEqual(r.callouts, ["NOTE"]);
    assert.equal(r.text, " 提示内容", "正文里不该再留着 [!NOTE]");
});

test("真解析：普通引用块原样不动（最怕这条）", () => {
    const r = parse("> 就是个引用");
    assert.ok(!r.types.includes("callout_open"));
    assert.equal(r.text, "就是个引用");
});

test("真解析：不认识的类型不吞标记，当普通文字留着", () => {
    const r = parse("> [!FAQ] 常见问题");
    assert.ok(!r.types.includes("callout_open"));
    assert.equal(r.text, "[!FAQ] 常见问题", "类型不认识时必须原样显示，不能凭空消失");
});

test("真解析：多行引用整体包成一个 callout", () => {
    const r = parse("> [!WARNING]\n> 第一行\n> 第二行");
    assert.deepEqual(r.callouts, ["WARNING"]);
    assert.equal(r.callouts.length, 1, "多行只能算一个 callout");
    assert.ok(r.text.includes("第一行") && r.text.includes("第二行"));
});

test("真解析：段落之后的引用也能识别", () => {
    const r = parse("前面一段\n\n> [!TIP] 技巧");
    assert.deepEqual(r.callouts, ["TIP"]);
});

test("真解析：嵌套引用里的内层也能识别，且外层不受影响", () => {
    const r = parse(">> [!TIP] 内层");
    assert.deepEqual(r.callouts, ["TIP"]);
    assert.equal(r.text, " 内层");
});

test("真解析：空引用不会炸", () => {
    for (const src of [">", "> [!NOTE]", ">", ">>>"]) {
        assert.doesNotThrow(() => parse(src), src);
    }
});

test("守卫：渲染层取内容前必须先前进游标（否则无限递归）", () => {
    // 这一条对应一个真实的白屏级 bug：内容块的渲染分支里漏了 `c.i++`，
    // 而 takeUntilClose 假定「已经站在 open 之后」、深度从 1 起算 ——
    // 于是它会再读到自己的 open，深度变 2、永远归不了零，
    // 把后面所有 token（含自己）吞进去递归渲染 → Maximum call stack size exceeded，
    // **整个预览区一起崩**（实测连双链都一起消失了）。
    // 静态判据：callout_open 分支里，取内容的下一行必须先 c.i++。
    const source = readFileSync(
        join(findProjectDir(), "src", "utils", "markdownToReact.tsx"),
        "utf-8"
    );
    const branch = /case "callout_open":[\s\S]*?takeUntilClose\(c, "callout_open"/.exec(source);
    assert.ok(branch, "找不到 callout_open 的渲染分支");
    const body = branch![0];
    const advanceAt = body.indexOf("c.i++");
    const takeAt = body.indexOf("takeUntilClose");
    assert.ok(advanceAt >= 0, "callout_open 分支里必须有 c.i++");
    assert.ok(
        advanceAt < takeAt,
        "c.i++ 必须排在 takeUntilClose **之前** —— 否则会读到自己的 open，" +
            "深度永远不归零，预览区直接栈溢出白屏"
    );
});
