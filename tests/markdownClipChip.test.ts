// tests/markdownClipChip.test.ts
// 行内复制胶囊语法 `{{clip:内容}}` 的解析用例 + 纯文本降级用例。
//
// 为什么单独一组：v31 那次「高亮按钮点了没反应」的教训 —— 工具栏插入的标记
// 在预览里原样显示成几个字符，看着像按钮坏了，其实只是**没人把规则装进解析器**。
// 所以这里从两层钉住：
//   1. 解析层：`{{clip:x}}` 真的变成 clip_chip token，且与既有行内语法互不误伤；
//   2. 降级层：导出 / 「复制为 Markdown」时定界符一个都不带出去。
//
// ⚠️ 断言只比字符串与数字，不把 DOM / 复杂对象交给 assert.equal
//    （node:assert 失败时会 util.inspect 展开，React fiber 图能把堆打爆）。

import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import {
    CLIP_CHIP_OPEN,
    CLIP_CHIP_TOKEN,
    clipChipsToPlainText,
    registerClipChip,
} from "../src/utils/markdownClipChip";
import { registerMark } from "../src/utils/markdownMark";
import { registerNoteTags } from "../src/utils/markdownNoteTags";
import { registerMath } from "../src/utils/markdownMath";

function makeMarkdownIt() {
    const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
    // 注册顺序与 markdownToReact.loadParser 一致：先数学、再高亮、再标签、最后胶囊
    registerMath(md);
    registerMark(md);
    registerNoteTags(md);
    registerClipChip(md);
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
    return flat(tokens).filter(t => t.type === type);
}

/** 所有 text token 拼起来（用来验证「没被认成胶囊的原文还在」） */
function textOf(tokens: Token[]): string {
    return flat(tokens)
        .filter(t => t.type === "text" || t.type === "code_inline")
        .map(t => t.content)
        .join("");
}

/**
 * 等价于「预览 DOM 的 textContent」：按 token 顺序把普通文本、escape 吐出的
 * `text_special`、行内代码和胶囊内容拼起来。
 * ⚠️ 必须带 `text_special` —— markdown-it 的 `escape` 规则产出的就是它，
 *    漏掉的话「预览显示什么」这条断言会假通过（少算一个字还以为是原文）。
 */
function renderedTextOf(tokens: Token[]): string {
    return flat(tokens)
        .filter(t =>
            t.type === "text" ||
            t.type === "text_special" ||
            t.type === "code_inline" ||
            t.type === CLIP_CHIP_TOKEN
        )
        .map(t => t.content)
        .join("");
}

test("{{clip:内容}} 解析成一个 clip_chip token，content 是去掉定界符的原文", () => {
    const md = makeMarkdownIt();
    const chips = pick(md.parse("看这里 {{clip:一段要复制的文本}} 就这样", {}), CLIP_CHIP_TOKEN);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].content, "一段要复制的文本");
    // markup 记的是开标记，将来若要支持多种胶囊形态可以按它分流
    assert.equal(chips[0].markup, CLIP_CHIP_OPEN);
});

test("闭合的 }} 必须被规则吃掉：正文恰为「前后」，不多一个字符", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("前{{clip:甲}}后", {});
    // ⚠️ 这条是 QA 变异 M3 的缺口：把 `state.pos = end + 2` 改成 `state.pos = end`
    //    时，两个 `}` 会漏回正文变成「前}}后」，旧用例只查 token 数根本抓不到。
    const chips = pick(tokens, CLIP_CHIP_TOKEN);
    assert.equal(chips.length, 1, "这一段只该产出 1 个胶囊 token");
    assert.equal(chips[0].content, "甲");
    // ⚠️ 这里要的是「胶囊 token **之外**的纯文本」：胶囊自己的内容由组件渲染，
    //    不计入文本 token。`textOf` 只收 text / code_inline，正好是这条判据。
    assert.equal(
        textOf(tokens),
        "前后",
        "纯文本 token 必须恰为「前后」：闭合的 }} 不能当普通文字漏进正文（游标要吃到闭标记末尾）"
    );
});

test("一段里多个胶囊都认", () => {
    const md = makeMarkdownIt();
    const chips = pick(md.parse("{{clip:甲}} 和 {{clip:乙}}", {}), CLIP_CHIP_TOKEN);
    assert.equal(chips.length, 2);
    assert.deepEqual(chips.map(t => t.content), ["甲", "乙"]);
});

test("内容里可以带空格与标点，也能带单个花括号", () => {
    const md = makeMarkdownIt();
    const chips = pick(md.parse("{{clip:a b, c} d}}", {}), CLIP_CHIP_TOKEN);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].content, "a b, c} d");
});

test("第一处 }} 就是闭合：后面的 }} 留作正文", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("{{clip:甲}} 乙}}", {});
    const chips = pick(tokens, CLIP_CHIP_TOKEN);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].content, "甲");
    assert.equal(textOf(tokens).includes("乙}}"), true, "闭合之后的字要原样留着");
});

test("没闭合的 {{clip: 不认（原文一字不丢）", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("这里有 {{clip:没闭合的内容", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 0);
    assert.equal(textOf(tokens).includes("没闭合的内容"), true, "原文要留着");
});

test("胶囊不跨行", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("{{clip:上\n下}}", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 0);
    assert.equal(textOf(tokens).includes("上"), true);
    assert.equal(textOf(tokens).includes("下}}"), true);
});

test("内容为空或全空白不认（点不出东西的空胶囊比原文更糟）", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(md.parse("{{clip:}}", {}), CLIP_CHIP_TOKEN).length, 0);
    assert.equal(pick(md.parse("{{clip:   }}", {}), CLIP_CHIP_TOKEN).length, 0);
    assert.equal(textOf(md.parse("{{clip:}}", {})).includes("{{clip:}}"), true, "原文留着");
});

test("别的双花括号写法不会被误认（{{note}} / {{clip}} 无冒号）", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(md.parse("{{note}} 与 {{clip}}", {}), CLIP_CHIP_TOKEN).length, 0);
});

test("被转义的 \\{{clip:x}} 不认（escape 规则先吃掉反斜杠）", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("\\{{clip:甲}}", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 0);
});

// ── 两条链路的判据必须同步：预览显示什么，导出 / 复制为 Markdown 就输出什么 ──
// 起因：降级函数原先直接拿正则 `\{\{clip:…\}\}` 跑原文，`\{{clip:甲}}` 会被摘掉
// 定界符留下 `\甲`，而预览里 escape 吃掉反斜杠、显示的是字面 `{{clip:甲}}`。
test("转义过的开标记：预览显示什么，纯文本降级就输出什么", () => {
    const md = makeMarkdownIt();
    const src = "前\\{{clip:甲}}后";
    const tokens = md.parse(src, {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 0, "转义过的不该产出胶囊");
    const shown = renderedTextOf(tokens);
    assert.equal(shown, "前{{clip:甲}}后", "预览里反斜杠被 escape 吃掉，显示的是字面量");
    assert.equal(
        clipChipsToPlainText(src),
        shown,
        "纯文本输出必须与预览字面一致（不能变成 前\\甲后）"
    );
    assert.equal(clipChipsToPlainText(src).includes("{{clip:甲}}"), true, "定界符要原样留着");
    assert.equal(clipChipsToPlainText(src).includes("\\"), false, "转义反斜杠不该被带出去");
});

test("连续反斜杠按 escape 的奇偶语义与预览逐字一致", () => {
    const md = makeMarkdownIt();
    // 奇数枚：最后一枚转义掉 `{` → 字面量；偶数枚：成对变字面反斜杠，胶囊照常生效
    const cases: Array<[string, string]> = [
        ["\\{{clip:甲}}", "{{clip:甲}}"],
        ["\\\\{{clip:甲}}", "\\甲"],
        ["\\\\\\{{clip:甲}}", "\\{{clip:甲}}"],
        ["{{clip:甲}}", "甲"],
    ];
    for (const [src, expected] of cases) {
        const shown = renderedTextOf(md.parse(src, {}));
        assert.equal(shown, expected, `预览字面：${src}`);
        assert.equal(
            clipChipsToPlainText(src),
            shown,
            `纯文本降级必须与预览一致：${src}`
        );
    }
});

// ── 与既有行内语法的互不误伤 ───────────────────────────────────────────────
// 两个方向都要：胶囊不吞掉别人的标记；别人的标记也不把胶囊吃成乱码。

test("行内代码优先：反引号里的 {{clip:x}} 就是代码，不是胶囊", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("`{{clip:甲}}`", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 0, "代码段里不该产出胶囊 token");
    const codes = pick(tokens, "code_inline");
    assert.equal(codes.length, 1);
    assert.equal(codes[0].content, "{{clip:甲}}", "行内代码内容要原样保留");
});

test("行内代码与胶囊相邻时各归各的", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("先 `code` 再 {{clip:甲}}", {});
    assert.equal(pick(tokens, "code_inline").length, 1);
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 1);
});

test("高亮标记不被胶囊吞掉：==x== 仍是 mark_inline", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("{{clip:甲}} 与 ==乙==", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 1);
    const marks = pick(tokens, "mark_inline");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].content, "乙");
});

test("行内数学不受影响：$a+b$ 仍是 math_inline", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("{{clip:甲}} 与 $a+b$", {});
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 1);
    const maths = pick(tokens, "math_inline");
    assert.equal(maths.length, 1);
    assert.equal(maths[0].content, "a+b");
});

test("标签 #tag 与胶囊互不干扰", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("#标签 里看 {{clip:甲}}", {});
    assert.equal(pick(tokens, "note_tag").length, 1);
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 1);
});

test("正文里的美元符号不会把后面的胶囊卷进公式", () => {
    const md = makeMarkdownIt();
    const tokens = md.parse("价格是 $5 和 $9，见 {{clip:甲}}", {});
    // `$5 和 $9` 的 `$` 之间虽然成对，但内容首尾带空白 → 不认公式（与既有判据一致）
    assert.equal(pick(tokens, "math_inline").length, 0);
    assert.equal(pick(tokens, CLIP_CHIP_TOKEN).length, 1);
});

test("胶囊紧跟在一段文字后面也能认（不需要前置空白）", () => {
    const md = makeMarkdownIt();
    assert.equal(pick(md.parse("紧贴着{{clip:甲}}", {}), CLIP_CHIP_TOKEN).length, 1);
});

// ── 纯文本降级：导出 / 「复制为 Markdown」时定界符不许带出去 ────────────────

test("降级：胶囊只留内容", () => {
    assert.equal(clipChipsToPlainText("看 {{clip:甲}} 这里"), "看 甲 这里");
});

test("降级：多个胶囊逐个还原，顺序与内容都不动", () => {
    assert.equal(clipChipsToPlainText("{{clip:甲}}-{{clip:乙}}"), "甲-乙");
});

test("降级：没有胶囊时原样返回（逐字节相同）", () => {
    const src = "# 标题\n\n一段正文，含 `code` 与 ==高亮==\n";
    assert.equal(clipChipsToPlainText(src), src);
});

test("降级：围栏代码块里的示例代码不动", () => {
    const src = ["```md", "{{clip:这是示例}}", "```", "正文 {{clip:甲}}"].join("\n");
    const out = clipChipsToPlainText(src);
    assert.equal(out.includes("{{clip:这是示例}}"), true, "代码块里是示例，不该被改写");
    assert.equal(out.includes("正文 甲"), true, "代码块外面照常降级");
});

test("降级：行内代码里的 {{clip:x}} 不动（与解析器同一把尺子）", () => {
    const out = clipChipsToPlainText("写 `{{clip:甲}}` 才会出现胶囊，正文 {{clip:乙}} 会渲染");
    assert.equal(out.includes("`{{clip:甲}}`"), true, "行内代码原样保留");
    assert.equal(out.includes("正文 乙 会渲染"), true);
});

test("降级：空内容不替换（与解析器的判据一致：空的就是不认）", () => {
    assert.equal(clipChipsToPlainText("空的 {{clip:}} 留着"), "空的 {{clip:}} 留着");
});

test("降级：不跨行（同一行里的第一处 }} 才闭合）", () => {
    assert.equal(clipChipsToPlainText("{{clip:甲}} 后面还有字"), "甲 后面还有字");
});
