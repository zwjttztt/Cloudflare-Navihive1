// tests/noteBlocksMarkdown.test.ts
// 新语法在 **markdown-it 规则层** 的产出（不只是纯函数）。
//
// 为什么单测纯函数不够：`![[甲]]` 与 `[[甲]]` 的区别、`:::tabs` 有没有闭合围栏、
// 行尾 ` ^id` 摘没摘干净 —— 这些都发生在 markdown-it 的规则里。
// 纯函数对了但规则没注册（或注册顺序错），界面上的表现是「语法插进去了不生效」，
// 而 token 流是唯一能看见真相的地方。
import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { registerWikiLink } from "../src/utils/noteWikiLink";
import { registerNoteTags } from "../src/utils/markdownNoteTags";
import { registerMark } from "../src/utils/markdownMark";
import { registerNoteBlocks } from "../src/utils/markdownNoteBlocks";
import { registerCallout, calloutTypeOf, calloutTitleOf } from "../src/utils/markdownCallout";

function makeParser(): MarkdownIt {
    const md = new MarkdownIt({ html: false, linkify: true });
    registerMark(md);
    registerNoteTags(md);
    registerWikiLink(md);
    registerCallout(md);
    registerNoteBlocks(md);
    return md;
}

function types(md: MarkdownIt, src: string): string[] {
    return md.parse(src, {}).map(t => t.type);
}

function flatTypes(md: MarkdownIt, src: string): string[] {
    const out: string[] = [];
    for (const t of md.parse(src, {})) {
        out.push(t.type);
        for (const c of t.children || []) out.push(c.type);
    }
    return out;
}

/**
 * 段落里的 inline token。
 *
 * ⚠️ 不能用 `md.parse(src)[0]` —— 那拿到的是 `paragraph_open`，
 * 它的 `children` 恒为空数组，于是每条「行内规则有没有生效」的断言都会假失败
 * （探针里明明产出了 note_embed，测试却说没有）。行内产物一律在 inline 上。
 */
function inlineOf(md: MarkdownIt, src: string): Token {
    const tok = md.parse(src, {}).find(t => t.type === "inline");
    assert.ok(tok, "这段没解析出 inline token：" + types(md, src).join("/"));
    return tok;
}

// ---------- 标签页容器 ----------

test("标签页：:::tabs … ::: 收成一个 note_container，正文原样带在 content", () => {
    const md = makeParser();
    const tokens = md.parse(":::tabs\n=== 甲\n一\n=== 乙\n二\n:::\n", {});
    assert.equal(tokens.length, 1, "整块只该出一个 token");
    assert.equal(tokens[0].type, "note_container");
    assert.equal(tokens[0].info, "tabs");
    assert.equal(tokens[0].content, "=== 甲\n一\n=== 乙\n二");
});

test("标签页：没有收尾 ::: 就不认（否则后面整篇都会被吞进容器）", () => {
    const md = makeParser();
    const t = types(md, ":::tabs\n=== 甲\n一\n");
    assert.ok(!t.includes("note_container"), "没闭合就不能吞：" + t.join("/"));
    assert.ok(t.includes("paragraph_open"), "后面的正文必须还是正常段落");
});

test("标签页：容器参数（:::tabs 说明）进 meta.arg", () => {
    const md = makeParser();
    const [tok] = md.parse(":::tabs 说明\n内容\n:::\n", {});
    assert.equal((tok.meta as { arg?: string }).arg, "说明");
});

test("标签页：围栏之后的正常内容不受影响", () => {
    const md = makeParser();
    const t = types(md, ":::tabs\n=== 甲\n一\n:::\n\n后面一段\n");
    assert.deepEqual(t, ["note_container", "paragraph_open", "inline", "paragraph_close"]);
});

// ---------- 笔记嵌入 vs 双链 ----------

test("笔记嵌入：![[甲]] 出 note_embed，而 [[甲]] 仍出 wiki_link", () => {
    const md = makeParser();
    assert.ok(flatTypes(md, "![[甲]]").includes("note_embed"));
    const link = flatTypes(md, "[[甲]]");
    assert.ok(link.includes("wiki_link"));
    assert.ok(!link.includes("note_embed"), "[[…]] 不能被当成嵌入");
});

test("笔记嵌入：注册顺序不能反 —— 反了会切出 `![甲` 这种垃圾目标名", () => {
    const md = makeParser();
    const embed = (inlineOf(md, "![[甲]]").children || []).find(c => c.type === "note_embed");
    assert.ok(embed, "没产出 note_embed");
    assert.equal(embed.content, "甲", "目标名必须正好是「甲」，不能带上 `![`");
});

test("笔记嵌入：带块 ID 的引用 ![[甲#^intro]] 整体进 content（拆分在渲染层）", () => {
    const md = makeParser();
    const embed = (inlineOf(md, "![[甲#^intro]]").children || []).find(c => c.type === "note_embed");
    assert.equal(embed?.content, "甲#^intro");
});

// ---------- 隐藏注释 ----------

test("隐藏注释：%%…%% 出 note_hidden，正文里不再出现那两个字", () => {
    const md = makeParser();
    const t = flatTypes(md, "前面%%秘密%%后面");
    assert.ok(t.includes("note_hidden"));
    // ⚠️ 只看 **text** token 的内容：note_hidden 自己就带着注释正文，
    // 把所有 children 的 content 拼起来当然会「漏进正文」——那是断言写错，不是规则错。
    const text = (inlineOf(md, "前面%%秘密%%后面").children || [])
        .filter(c => c.type === "text")
        .map(c => c.content)
        .join("");
    assert.ok(!text.includes("秘密"), "注释内容不能漏进正文：" + text);
    assert.equal(text, "前面后面", "只该剩注释两侧的正文");
});

test("隐藏注释：不成对不认（不能把后面的正文吃掉）", () => {
    const md = makeParser();
    const t = flatTypes(md, "%%没闭合");
    assert.ok(!t.includes("note_hidden"));
});

// ---------- 块 ID ----------

test("块 ID：行尾 ^id 被摘掉，落到块的 meta 上", () => {
    const md = makeParser();
    const tokens = md.parse("这是正文 ^intro\n", {});
    const open = tokens[0];
    assert.equal((open.meta as { blockId?: string }).blockId, "intro");
    assert.equal((inlineOf(md, "这是正文 ^intro").children || [])[0].content, "这是正文", "^id 不能留在渲染文本里");
});

test("块 ID：没有 ^id 的段落不受影响", () => {
    const md = makeParser();
    const tokens = md.parse("普通段落\n", {});
    assert.equal((tokens[0].meta as { blockId?: string } | null)?.blockId, undefined);
});

test("块 ID：段首的 ^ 不算 ID（多半是 ^ 运算符）", () => {
    const md = makeParser();
    // ⚠️ markdown-it 在 inline 阶段就剥掉了行首空白，所以无论源码写的是
    // `^only` 还是 ` ^only`，到规则手里都没有那个前导空格 → 都不算块 ID。
    // 这正是「段首的 ^ 不认」这条规则在真实链路上的效果。
    for (const src of ["^only", " ^only"]) {
        assert.equal((inlineOf(md, src).children || [])[0].content, "^only", "该当普通文本：" + src);
    }
});

test("块 ID：标题也能带", () => {
    const md = makeParser();
    const tokens = md.parse("## 标题 ^h1\n", {});
    assert.equal((tokens[0].meta as { blockId?: string }).blockId, "h1");
});

// ---------- 折叠块 ----------

test("折叠块：> [!FOLD] 标题 出 callout，标题被摘到 meta 上", () => {
    const md = makeParser();
    const open = md.parse("> [!FOLD] 细节\n> 正文\n", {}).find(t => t.type === "callout_open");
    assert.ok(open, "没出 callout_open");
    assert.equal(calloutTypeOf(open.meta), "FOLD");
    assert.equal(calloutTitleOf(open.meta), "细节");
});

test("折叠块：标题从正文里摘干净（否则 summary 和正文重复一遍）", () => {
    const md = makeParser();
    const text = (inlineOf(md, "> [!FOLD] 细节\n> 正文\n").children || [])
        .map(c => c.content)
        .join("");
    // ⚠️ 不能拿整个 token 流的 JSON 找「细节」：foldTitle 本来就该在 meta 里带着，
    // 那样断言永远失败。真正要查的是**正文 inline** 里还有没有它。
    assert.ok(!text.includes("细节"), "标题不该同时留在正文里：" + text);
    assert.ok(text.includes("正文"), "正文必须还在：" + text);
});

test("折叠块：普通内容块标题不进 meta.foldTitle（那是折叠块专用）", () => {
    const md = makeParser();
    const tokens = md.parse("> [!NOTE] 提示\n> 正文\n", {});
    const open = tokens.find(t => t.type === "callout_open");
    assert.ok(open, "没出 callout_open");
    assert.equal(calloutTypeOf(open.meta), "NOTE");
    assert.equal(calloutTitleOf(open.meta), "");
});
