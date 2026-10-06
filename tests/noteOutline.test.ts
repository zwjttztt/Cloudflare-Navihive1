// tests/noteOutline.test.ts
// 大纲（从 Markdown 抽标题层级）的用例。
//
// 为什么值得单测：大纲里最常见的错是**把代码块里的注释当成标题**。
// ```bash 里的 `# 安装依赖` 会被大纲列成一级标题「安装依赖」，
// 而点进去落在代码块中间 —— 大纲一旦胡说八道，用户就不敢用了。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOutline, outlineIndent } from "../src/utils/noteOutline";

test("抽出各级标题与行号", () => {
    const items = extractOutline("# 一\n正文\n## 二\n### 三\n");
    assert.deepEqual(
        items.map(i => [i.level, i.text, i.line]),
        [
            [1, "一", 0],
            [2, "二", 2],
            [3, "三", 3],
        ]
    );
});

test("代码块里的 # 不是标题（最容易出的错）", () => {
    const src = "正文\n```bash\n# 这是注释不是标题\necho hi\n```\n## 真标题\n";
    const items = extractOutline(src);
    assert.deepEqual(
        items.map(i => i.text),
        ["真标题"]
    );
});

test("波浪线围栏的代码块同样跳过", () => {
    const items = extractOutline("~~~\n# 注释\n~~~\n# 真标题\n");
    assert.deepEqual(
        items.map(i => i.text),
        ["真标题"]
    );
});

test("反引号围栏不能被单行反引号提前关掉（行内代码不算围栏）", () => {
    const items = extractOutline("`code` 不是围栏\n# 真标题\n");
    assert.deepEqual(
        items.map(i => i.text),
        ["真标题"]
    );
});

test("井号后必须有空格（#Hello 在 CommonMark 里不是标题）", () => {
    const items = extractOutline("#无空格 不是标题\n# 有空格才是\n");
    assert.deepEqual(
        items.map(i => i.text),
        ["有空格才是"]
    );
});

test("最多六级标题", () => {
    assert.equal(extractOutline("####### 七级\n").length, 0);
    assert.equal(extractOutline("###### 六级\n").length, 1);
});

test("标题里的行内标记被剥掉，只留人能读的文本", () => {
    const items = extractOutline("## **加粗** 与 `代码` 和 [链接](http://x)\n");
    assert.equal(items[0].text, "加粗 与 代码 和 链接");
});

test("行内公式从标题文字里剔掉", () => {
    const items = extractOutline("## 勾股定理 $a^2+b^2=c^2$ 的证明\n");
    assert.equal(items[0].text, "勾股定理 的证明");
});

test("offset 指向该行在源码里的真实位置（跳转靠它）", () => {
    const src = "第一行\n第二行\n## 目标\n";
    const items = extractOutline(src);
    // offset 指向该行的**行首**（跳过去要落在标题那一行，不是标题文字中间）
    assert.equal(items[0].offset, 8);
    assert.ok(src.slice(items[0].offset).startsWith("## 目标"), "从 offset 起要是那一行的内容");
});

test("maxLevel 可以只留浅层（面板窄时用）", () => {
    const items = extractOutline("# 一\n## 二\n### 三\n#### 四\n", 2);
    assert.deepEqual(
        items.map(i => i.level),
        [1, 2]
    );
});

test("闭合式标题（## 标题 ##）剥掉尾部井号", () => {
    const items = extractOutline("## 标题 ##\n");
    assert.equal(items[0].text, "标题");
});

test("空源码返回空数组", () => {
    assert.deepEqual(extractOutline(""), []);
    assert.deepEqual(extractOutline("没有任何标题的正文"), []);
});

test("缩进按层级递增，一级不缩进", () => {
    assert.equal(outlineIndent(1), 0);
    assert.ok(outlineIndent(3) > outlineIndent(2));
});
