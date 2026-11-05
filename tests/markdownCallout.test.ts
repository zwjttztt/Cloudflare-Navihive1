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

/** 要连 token 结构一起看时用它（比如「空段落有没有被摘掉」） */
function parseTokens(src: string) {
    const md = new MarkdownIt({ html: false, linkify: true });
    registerCallout(md);
    return md.parse(src, {});
}

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

// ─────────────────────────────────────────────────────────────────────────────
// COPY（复制块）——语法已**整体移除**，这三条钉的是「移除之后的真实表现」
//
// 历史：v31 下线复制能力但保留语法（脏数据无害）；这一版连语法一起删了。
// 于是 `> [!COPY]` 不再是「会被摘掉标记的 callout」，而是一段**普通引用**，
// 那行源码会原样显示成 `[!COPY]` 文字 ——
// 这正是数据迁移 `notes-copy-callout-marker` 存在的唯一理由（见第三条注释）。
//
// ⚠️ 这里**不是**在弱化断言，是换了语义：以前钉「标记必须被摘走」，
//    现在钉「语法认不出来 + 正文不丢 + 残留由迁移负责」。
// ─────────────────────────────────────────────────────────────────────────────

test("COPY：语法已移除 —— parseCalloutType 认不出它了", () => {
    // 大小写都不认：不是「暂时忘了小写」，是这个类型根本不在枚举里了
    assert.equal(parseCalloutType("[!COPY]"), null, "COPY 必须已经从 CALLOUT_TYPES 里删掉");
    assert.equal(parseCalloutType("[!copy]"), null);
    assert.equal(parseCalloutType("[!Copy]"), null);
});

test("COPY：真解析一遍 —— 不再产出 callout_open，正文与行内代码一字不丢", () => {
    const src = "> [!COPY]\n> 数据库连接：`10.0.42.18:5432`\n> 账号：`postgres_ro`\n";
    const tokens = parseTokens(src);

    // ① 不再是内容块：callout_open 一个都不该有（以前这里是 meta.callout === "COPY"）
    const calloutTokens = tokens.filter(t => t.type === "callout_open");
    assert.equal(
        calloutTokens.length,
        0,
        "COPY 已从 CALLOUT_TYPES 移除，不该再被识别成内容块"
    );

    // ② 它退化成一个普通引用：blockquote 结构还在
    assert.ok(
        tokens.some(t => t.type === "blockquote_open"),
        "认不出类型之后必须退回普通引用，而不是整块消失"
    );

    // ③ **正文一个字都不能丢**（这是删除语法时唯一真正的风险）
    const children = tokens.filter(t => t.type === "inline").flatMap(t => t.children ?? []);
    const codes = children.filter(t => t.type === "code_inline").map(t => String(t.content));
    assert.deepEqual(
        codes,
        ["10.0.42.18:5432", "postgres_ro"],
        "两个反引号必须照常成为 code_inline（渲染层不再给它们套复制单元，但代码本身要留着）"
    );
    const text = children.map(c => String(c.content)).join("");
    assert.ok(text.includes("数据库连接："), "正文文字必须还在");
    assert.ok(text.includes("账号："), "正文文字必须还在");

    // ④ 代价也明确钉住：标记本身现在会作为**普通文本**留在正文里。
    //    这条断言看起来像「钉住了 bug」，其实是钉住了**迁移的必要性** ——
    //    迁移 `notes-copy-callout-marker` 把历史笔记里的标记行删掉之后，
    //    线上就不会再有笔记走到这一支。断言一旦变红，说明有人又把 COPY
    //    加回了 CALLOUT_TYPES（那是死灰复燃，不是修复）。
    assert.ok(
        text.includes("[!COPY]"),
        "语法移除后标记会原样显示 —— 这是预期行为，脏数据由迁移负责清"
    );
});

test("COPY 走了之后，其余 6 种类型照常解析（别误伤）", () => {
    for (const type of ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE", "FOLD"]) {
        assert.equal(parseCalloutType(`[!${type}]`), type, `${type} 必须照常解析`);
        assert.equal(parseCalloutType(`[!${type.toLowerCase()}]`), type, `${type} 大小写不敏感`);
    }
    // 真解析一遍：六种各来一个块，callout_open 必须正好六个
    const src = ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE", "FOLD"]
        .map(type => `> [!${type}]\n> 内容\n`)
        .join("\n");
    assert.deepEqual(
        parse(src).callouts,
        ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE", "FOLD"],
        "删掉 COPY 时不许误伤其他类型"
    );
});
