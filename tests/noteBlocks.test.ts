// tests/noteBlocks.test.ts
// 工具栏「插入 / 块」两组新语法的纯函数判据。
//
// 全部是纯函数（noteBlocks.ts / noteFrontMatter.ts），不牵 React ——
// 「差一个字符就整体错位」的活儿只有单测能兜住，界面上的失败形态太隐蔽
// （插入的东西看着像对的，点了没反应或渲染成空白）。
import assert from "node:assert/strict";
import test from "node:test";
import {
    buildFoldSource,
    buildHiddenComment,
    buildTabSource,
    isContainerClose,
    parseBlockId,
    parseBracketRef,
    parseContainerOpen,
    parseHiddenComment,
    parseRefTarget,
    parseEmbedTarget,
    parseTabPages,
    stripBlockId,
    withBlockId,
} from "../src/utils/noteBlocks";
import { buildFrontMatter, splitFrontMatter } from "../src/utils/noteFrontMatter";
import { sliceHeading } from "../src/components/NoteEmbedNode";

// ---------- 块 ID ----------

test("块 ID：认行尾的 ^id，并把它从正文里摘掉", () => {
    assert.equal(parseBlockId("一段话 ^abc12"), "abc12");
    assert.equal(stripBlockId("一段话 ^abc12").text, "一段话");
    // 没有 ID 的行原样返回
    assert.equal(stripBlockId("一段普通话").blockId, null);
    assert.equal(stripBlockId("一段普通话").text, "一段普通话");
});

test("块 ID：只认行尾那一个，中间的 ^ 不是 ID", () => {
    // `a ^x b ^y` 里 y 才是块 ID —— 行内规则会两个都认，摘错就丢字
    const r = stripBlockId("a ^x b ^y");
    assert.equal(r.blockId, "y");
    assert.equal(r.text, "a ^x b");
});

test("块 ID：^ 后面跟空格/标点不算 ID（否则一整句会被吞掉）", () => {
    assert.equal(parseBlockId("注意 ^ 这里要改"), null);
    assert.equal(parseBlockId("2^3"), null);
});

test("块 ID：段首的 ^ 不算 ID", () => {
    // markdown-it 的 inline 阶段会剥掉行首空白，所以到规则手里 ` ^only` 已是 `^only`。
    // 纯函数这层也必须守住：段首的 ^ 多半是异或/脱字符，认成 ID 会把正文吃掉。
    assert.equal(stripBlockId("^only").blockId, null);
    assert.equal(stripBlockId("^only").text, "^only");
});

test("块 ID：生成时把非法字符剔掉", () => {
    assert.equal(withBlockId("正文", "abc-1"), "正文 ^abc-1");
    assert.equal(withBlockId("正文", "a b!c"), "正文 ^abc");
});

// ---------- 引用目标 ----------

test("引用目标：支持 标题 与 标题#^块ID 两种", () => {
    assert.deepEqual(parseRefTarget("API"), { title: "API", blockId: null });
    assert.deepEqual(parseRefTarget("API#^intro"), { title: "API", blockId: "intro" });
});

test("引用目标：标题里带 # 也不能切错位置（只在最后一个 #^ 上切）", () => {
    assert.deepEqual(parseRefTarget("C#^笔记"), { title: "C", blockId: "笔记" });
    assert.deepEqual(parseRefTarget("C# 基础"), { title: "C# 基础", blockId: null });
});

// ---------- 方括号引用 ----------

test("方括号引用：![[x]] 是嵌入，[[x]] 是双链，长度都算对", () => {
    const embed = parseBracketRef("![[甲]]尾巴", 0);
    assert.ok(embed);
    assert.equal(embed.embed, true);
    assert.equal(embed.content, "甲");
    assert.equal("![[甲]]尾巴".slice(0, embed.length), "![[甲]]");

    const link = parseBracketRef("[[甲]]尾巴", 0);
    assert.ok(link);
    assert.equal(link.embed, false);
    assert.equal("[[甲]]尾巴".slice(0, link.length), "[[甲]]");
});

test("方括号引用：没闭合、空内容、含换行都返回 null（宁可不认）", () => {
    assert.equal(parseBracketRef("[[甲", 0), null);
    assert.equal(parseBracketRef("![[]]", 0), null);
    assert.equal(parseBracketRef("[[甲\n乙]]", 0), null);
});

// ---------- 隐藏注释 ----------

test("隐藏注释：%%…%% 能取出正文，长度对齐原文", () => {
    const hit = parseHiddenComment("前面%%秘密%%后面", 2);
    assert.ok(hit);
    assert.equal(hit.text, "秘密");
    assert.equal("前面%%秘密%%后面".substr(2, hit.length), "%%秘密%%");
});

test("隐藏注释：不成对就不认（不能吃掉后面的正文）", () => {
    assert.equal(parseHiddenComment("%%没闭合", 0), null);
    assert.equal(buildHiddenComment("批注"), "%%批注%%");
});

// ---------- 容器 ----------

test("容器开行：认得 tabs，不认得别的", () => {
    assert.deepEqual(parseContainerOpen(":::tabs"), { kind: "tabs", arg: "" });
    assert.deepEqual(parseContainerOpen(":::tabs 说明"), { kind: "tabs", arg: "说明" });
    assert.equal(parseContainerOpen(":::fold"), null);
    assert.equal(parseContainerOpen(":::随便"), null);
    assert.equal(isContainerClose(":::"), true);
    assert.equal(isContainerClose(":::tabs"), false);
});

test("标签页：按 === 名称 切页，空页丢掉", () => {
    const pages = parseTabPages("=== 甲\n一\n=== 乙\n二");
    assert.deepEqual(pages, [
        { title: "甲", source: "一" },
        { title: "乙", source: "二" },
    ]);
    // 末尾多敲一个 === 但没内容 → 不该多出一个空白页签
    assert.equal(parseTabPages("=== 甲\n一\n=== 乙\n二\n===").length, 2);
});

test("标签页：第一个 === 之前的内容算第一页，标题取容器参数", () => {
    const pages = parseTabPages("开场白\n=== 乙\n内容", "说明");
    assert.equal(pages.length, 2);
    assert.equal(pages[0].title, "说明");
    assert.equal(pages[0].source, "开场白");
});

test("标签页：空容器给两个可直接写的页签", () => {
    const src = buildTabSource();
    assert.equal(src, ":::tabs\n=== 标签 1\n\n=== 标签 2\n:::\n");
    assert.equal(parseTabPages(src.slice(":::tabs\n".length, -":::\n".length)).length, 2);
});

test("折叠块：生成的是 callout 形态，标题在行尾", () => {
    assert.equal(buildFoldSource("细节"), "> [!FOLD] 细节\n> 折叠内容\n");
    assert.equal(buildFoldSource("  "), "> [!FOLD] 折叠标题\n> 折叠内容\n");
});

// ---------- 笔记属性（YAML）----------

test("笔记属性：摘出键值，正文从闭线下一行开始", () => {
    const src = "---\ntitle: 甲\ntags: [a, b]\n---\n正文第一行\n";
    const fm = splitFrontMatter(src);
    assert.equal(fm.entries.length, 2);
    assert.deepEqual(fm.entries[0], { key: "title", value: "甲" });
    assert.deepEqual(fm.entries[1], { key: "tags", value: "a、b", list: ["a", "b"] });
    assert.equal(fm.body, "正文第一行\n");
    // bodyOffset 是**字符**下标：body 必须正好等于 source.slice(bodyOffset)
    assert.equal(src.slice(fm.bodyOffset), fm.body, "bodyOffset 必须是字符偏移，不能是行号");
});

test("笔记属性：正文为空时 bodyOffset 不越界", () => {
    const src = "---\ntitle: 甲\n---";
    const fm = splitFrontMatter(src);
    assert.equal(fm.body, "");
    assert.equal(fm.bodyOffset, src.length);
    assert.equal(src.slice(fm.bodyOffset), "");
});

test("笔记属性：没有 front matter 时原样返回（bodyOffset 0）", () => {
    const src = "普通笔记\n第二行";
    const fm = splitFrontMatter(src);
    assert.equal(fm.entries.length, 0);
    assert.equal(fm.body, src);
    assert.equal(fm.bodyOffset, 0);
});

test("笔记属性：只有开线没有闭线 → 当正文（用户可能只是在写分隔线）", () => {
    const src = "---\ntitle: 甲\n正文";
    const fm = splitFrontMatter(src);
    assert.equal(fm.entries.length, 0);
    assert.equal(fm.body, src);
});

test("笔记属性：块里有不合式的行 → 整块退回正文，不静默吞字", () => {
    const src = "---\n这是一段散文\n---\n正文";
    const fm = splitFrontMatter(src);
    assert.equal(fm.entries.length, 0);
    assert.equal(fm.body, src, "不合式时必须原样保留，不能吞掉用户写的字");
});

test("笔记属性：必须从第一行开始，前面有内容就不是 front matter", () => {
    assert.equal(splitFrontMatter("引子\n---\ntitle: 甲\n---\n").entries.length, 0);
});

test("笔记属性：行尾注释被去掉，但引号里的 # 保留", () => {
    const fm = splitFrontMatter("---\ntitle: 甲 # 这是备注\nurl: \"a # b\"\n---\n");
    assert.equal(fm.entries[0].value, "甲");
    assert.equal(fm.entries[1].value, "a # b");
});

test("笔记属性：生成器与解析器互逆", () => {
    const src = buildFrontMatter([{ key: "title", value: "甲" }, { key: "tags", value: "", list: ["a", "b"] }]);
    const fm = splitFrontMatter(src);
    assert.equal(fm.entries[0].value, "甲");
    assert.deepEqual(fm.entries[1].list, ["a", "b"]);
});

// ---------- N7 嵌入标题锚点 `![[笔记#某标题]]` ----------

test("N7 parseEmbedTarget：块 ID / 标题锚点 / 纯标题三种都能拆", () => {
    assert.deepEqual(parseEmbedTarget("API"), { title: "API", blockId: null, heading: null });
    assert.deepEqual(parseEmbedTarget("API#^intro"), { title: "API", blockId: "intro", heading: null });
    assert.deepEqual(parseEmbedTarget("API#基本用法"), { title: "API", blockId: null, heading: "基本用法" });
    // 标题里带 # 的优先按块 ID 判（与 parseRefTarget 同判据）
    assert.deepEqual(parseEmbedTarget("C#^笔记"), { title: "C", blockId: "笔记", heading: null });
});

test("N7 sliceHeading：截到下一个同级或更高级标题为止", () => {
    const src = [
        "# 总览",
        "开头",
        "## 基本用法",
        "用法正文A",
        "用法正文B",
        "### 进阶",
        "进阶正文",
        "## 下一节",
        "别的",
    ].join("\n");
    const got = sliceHeading(src, "基本用法");
    assert.ok(got.includes("用法正文A") && got.includes("用法正文B"), got);
    assert.ok(got.includes("### 进阶") && got.includes("进阶正文"), "应包含下级子标题区段");
    assert.ok(!got.includes("下一节") && !got.includes("别的"), "同级标题应截断");
    // 找不到的标题退回整篇
    assert.equal(sliceHeading(src, "不存在的标题"), src);
});
