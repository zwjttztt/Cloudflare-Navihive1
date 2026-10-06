// tests/markdownMath.test.ts
// 公式语法（$行内$ / $$块级$$）的解析用例。
//
// 这一组盯的是「**认不认得公式**」和「**会不会误伤正文**」两件事：
// 公式认不出来 = 用户写的 LaTeX 变成一串怪字符；误认 = 正常句子里的美元符号
// 被吃掉半截。后者更糟（看不出哪里错了），所以未闭合 / 不合法的写法一律要有用例钉住。

import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { registerMath } from "../src/utils/markdownMath";

/** 每个用例一个干净实例：注册过的实例只给对应这一条看 */
function makeMarkdownIt() {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
    registerMath(md);
    return md;
}

/** 把 token 流递归摊平 —— 行内公式藏在 inline 的 children 里，不摊平找不到 */
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

/** 把 token 流还原成近似原文（验「不该被吃掉的字符还在不在」） */
function textOf(tokens: Token[]): string {
    return flat(tokens)
        .map(t => (t.type === "text" ? t.content : ""))
        .join("");
}

test("行内公式解析成 math_inline，内容是去掉 $ 之后的原文", async () => {
    const md = makeMarkdownIt();
    const tokens = flat(md.parse("欧拉恒等式 $e^{i\\pi}+1=0$ 很美", {}));
    const math = pick(tokens, "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "e^{i\\pi}+1=0");
    assert.equal(math[0].markup, "$");
    // 前后的正文还要在，不能被公式吞掉
    assert.ok(tokens.some(t => t.type === "text" && t.content.includes("欧拉恒等式")));
});

test("块级公式一行写完 → math_block", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$$x=1$$", {});
    assert.equal(tokens.length, 1, "块级公式独占一块，不该再包一层段落");
    assert.equal(tokens[0].type, "math_block");
    assert.equal(tokens[0].content, "x=1");
    assert.equal(tokens[0].block, true);
});

test("块级公式可以跨多行", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$", {});
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, "math_block");
    assert.equal(tokens[0].content, "\\int_0^1 x\\,dx = \\frac{1}{2}");
    assert.ok(Array.isArray(tokens[0].map), "要带上源码行范围，将来做锚点跳转用");
});

test("块级公式的闭合行可以缩进", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$$\n  a+b\n  $$", {});
    assert.equal(tokens[0].type, "math_block");
    assert.equal(tokens[0].content, "a+b");
});

test("公式块后面的段落不丢（规则要把 state.line 推过整块）", async () => {
    // 这条是钉 markdown-it 的**规则签名坑**：块级规则签名为 (state, line, endLine, silent)，
    // 少接参数的话 `silent` 收到的其实是行号（恒真）→ token 一个都 push 不出来，
    // 块被吞掉、后面的内容整段消失，界面上却什么都不报。
    const md = makeMarkdownIt();
    const tokens = md.parse("$$\nE=mc^2\n$$\n\n公式后面还有一段正文", {});
    assert.equal(pick(tokens, "math_block").length, 1);
    const text = flat(tokens).map(t => t.content || "").join("");
    assert.ok(text.includes("E=mc^2"));
    assert.ok(text.includes("公式后面还有一段正文"), "公式块之后的正文必须还在");
});

test("连续两个公式块都认，中间的正文也不丢", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$$a$$\n\n间隔文字\n\n$$b$$", {});
    assert.equal(pick(tokens, "math_block").length, 2);
    const text = flat(tokens).map(t => t.content || "").join("");
    assert.ok(text.includes("间隔文字"));
});

test("没闭合的 $$ 不当公式，原文留着（不能吞掉后面的段落）", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$$\nx = 1\n\n这是后面的正文", {});
    assert.equal(pick(tokens, "math_block").length, 0);
    assert.equal(tokens[0].type, "paragraph_open", "没闭合就该退回普通段落");
    const text = flat(tokens).map(t => t.content || "").join("");
    assert.ok(text.includes("$$"), "原文要还在");
    assert.ok(text.includes("这是后面的正文"));
});

test("$ 没配对时不当公式（$100 这种不该被吃掉）", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("这件东西 $100，不便宜", {});
    assert.equal(pick(tokens, "math_inline").length, 0);
});

test("内容首尾带空白不算公式（$100 和 $5 这种正文不能被吃掉）", async () => {
    const md = makeMarkdownIt();
    // 第一枚 $ 会一路找到「和」后面那枚，配对形式上「成立」——
    // 但内容是 `100 和 `，后半句还跟着半个 $5。放过去正文的美元符号就全没了。
    const tokens = md.parse("价格是 $100 和 $5，别当公式", {});
    assert.equal(pick(tokens, "math_inline").length, 0);
    assert.ok(textOf(tokens).includes("$100"), "原文里的 $ 要留着");
});

test("内容尾随空白也不算公式（$x $）", async () => {
    const md = makeMarkdownIt();
    assert.equal(pick(md.parse("$x $", {}), "math_inline").length, 0);
    assert.equal(pick(md.parse("$ x$", {}), "math_inline").length, 0);
});

test("正常公式里的内容带空格照样认（$a + b$）", async () => {
    const md = makeMarkdownIt();
    const math = pick(flat(md.parse("$a + b$", {})), "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "a + b");
});

test("行内公式不跨行", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$a\nb$", {});
    assert.equal(pick(tokens, "math_inline").length, 0);
});

test("$ 后面紧跟空白不算公式", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("$ x$", {});
    assert.equal(pick(tokens, "math_inline").length, 0);
});

test("转义的美元符号不参与配对", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("5\\$ 和 \\$3 元", {});
    assert.equal(pick(tokens, "math_inline").length, 0);
});

test("公式里的反斜杠序列不会被当成闭合", async () => {
    const md = makeMarkdownIt();
    const math = pick(flat(md.parse("$\\alpha+\\beta$", {})), "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "\\alpha+\\beta");
});

test("同一个实例连着解析多段都认公式（实例只建一次，别把状态漏到第二段）", async () => {
    const md = makeMarkdownIt();
    assert.equal(
        pick(flat(md.parse("第一段 $a$", {})), "math_inline").length,
        1
    );
    assert.equal(
        pick(flat(md.parse("第二段 $\\beta$", {})), "math_inline").length,
        1
    );
});

// ---- LaTeX 原生定界符：\(…\) 行内、\[…\] 块级 ----
//
// 这两套的注册位置与 `$` 那套**相反**（必须排在 escape 之前，
// 因为 escape 会把 `\(` 当成 ASCII 标点转义吃掉），所以单独钉一组用例。
test("行内原生定界符 \\(…\\)", async () => {
    const md = makeMarkdownIt();
    const math = pick(flat(md.parse("看这个 \\(a^2+b^2=c^2\\) 就行", {})), "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "a^2+b^2=c^2");
});

test("行内原生定界符两侧留空格照样认（\\$ 那套会拒，这是故意的差别）", async () => {
    const md = makeMarkdownIt();
    const math = pick(flat(md.parse("\\( a + b \\)", {})), "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "a + b", "内容两侧的空白要 trim 掉");
});

test("行内 \\[…\\] 也认成行内公式", async () => {
    const md = makeMarkdownIt();
    const math = pick(flat(md.parse("夹在文字里 \\[x=1\\] 也能认", {})), "math_inline");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "x=1");
});

test("\\( 没闭合不当公式（退回原文）", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("写了一半 \\(a+b 就没了", {});
    assert.equal(pick(flat(tokens), "math_inline").length, 0);
    assert.ok(textOf(tokens).includes("a+b"), "原文要留着");
});

test("空内容 \\(\\) 不当公式", async () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("\\(\\)", {})), "math_inline").length, 0);
});

test("转义的反斜杠 \\\\( 不当公式开头", async () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("路径 C:////(x) 不是公式", {})), "math_inline").length, 0);
});

test("代码块里的 \\( 不是公式", async () => {
    const md = makeMarkdownIt();
    assert.equal(pick(flat(md.parse("`\\(a\\)`", {})), "math_inline").length, 0);
});

test("块级 \\[ … \\] 独占行写法", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("前文\n\n\\[\nE = mc^2\n\\]\n\n后文", {});
    const math = pick(tokens, "math_block");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "E = mc^2");
    assert.ok(textOf(tokens).includes("后文"), "公式块后面那段不能被吞");
});

test("块级 \\[…\\] 一行写完", async () => {
    const md = makeMarkdownIt();
    const math = pick(md.parse("\\[\\frac{1}{2}\\]", {}), "math_block");
    assert.equal(math.length, 1);
    assert.equal(math[0].content, "\\frac{1}{2}");
});

test("块级 \\[ 没闭合不当公式（不能吞掉后面的段落）", async () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("\\[\nx = 1\n\n这是后面的正文", {});
    assert.equal(pick(tokens, "math_block").length, 0);
    assert.ok(textOf(tokens).includes("后面的正文"));
});

test("两套定界符混排各认各的", async () => {
    const md = makeMarkdownIt();
    const inline = pick(flat(md.parse("美元 $a$ 与原生 \\(b\\) 并存", {})), "math_inline");
    assert.equal(inline.length, 2);
    assert.deepEqual(inline.map(t => t.content), ["a", "b"]);
});
