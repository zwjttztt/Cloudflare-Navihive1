// tests/htmlToMarkdown.test.ts
// N5 富文本 HTML → Markdown：从网页 / 微信 / 文档拷内容最常用。
// 钉死常见标签的转换，谁改坏了解析这里必红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown } from "../src/utils/htmlToMarkdown";

test("N5 标题与段落", () => {
    const md = htmlToMarkdown("<h2>标题</h2><p>正文一段</p>");
    assert.ok(md.includes("## 标题"), `应含二级标题，实际：${md}`);
    assert.ok(md.includes("正文一段"), `应含段落，实际：${md}`);
});

test("N5 加粗 / 斜体 / 删除线 / 行内代码", () => {
    const md = htmlToMarkdown("<p><strong>粗</strong><em>斜</em><del>删</del><code>码</code></p>");
    assert.ok(md.includes("**粗**"), md);
    assert.ok(md.includes("*斜*"), md);
    assert.ok(md.includes("~~删~~"), md);
    assert.ok(md.includes("`码`"), md);
});

test("N5 链接与图片", () => {
    const md = htmlToMarkdown('<p><a href="https://a.b">站点</a></p><img src="https://a.b/x.png" alt="图">');
    assert.ok(md.includes("[站点](https://a.b)"), md);
    assert.ok(md.includes("![图](https://a.b/x.png)"), md);
});

test("N5 无序 / 有序列表", () => {
    const md = htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>");
    assert.ok(md.includes("- 甲"), md);
    assert.ok(md.includes("- 乙"), md);
    const om = htmlToMarkdown("<ol><li>壹</li><li>贰</li></ol>");
    assert.ok(om.includes("1. 壹"), om);
    assert.ok(om.includes("2. 贰"), om);
});

test("N5 引用与代码块与分隔线", () => {
    const q = htmlToMarkdown("<blockquote><p>引文</p></blockquote>");
    assert.ok(q.includes("> 引文"), q);
    const pre = htmlToMarkdown("<pre><code>const a = 1;\nconst b = 2;</code></pre>");
    assert.ok(pre.includes("```\nconst a = 1;\nconst b = 2;\n```"), pre);
    const hr = htmlToMarkdown("<p>上</p><hr><p>下</p>");
    assert.ok(hr.includes("---"), hr);
});

test("N5 表格转 Markdown 表", () => {
    const md = htmlToMarkdown(
        "<table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>"
    );
    assert.ok(md.includes("| 名 | 值 |"), md);
    assert.ok(md.includes("| --- | --- |"), md);
    assert.ok(md.includes("| a | 1 |"), md);
});

test("N5 script/style 剥掉不进正文", () => {
    const md = htmlToMarkdown('<p>正文</p><script>alert(1)</script><style>.x{}</style>');
    assert.ok(!md.includes("alert"), md);
    assert.ok(!md.includes(".x{"), md);
    assert.ok(md.includes("正文"), md);
});

test("N5 空输入返回空串", () => {
    assert.equal(htmlToMarkdown(""), "");
    assert.equal(htmlToMarkdown("   "), "");
});
