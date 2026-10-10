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

test("严格 Trusted Types 环境不调用 DOMParser HTML sink", () => {
    const original = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = () => { throw new TypeError("TrustedHTML required"); };
    try {
        assert.equal(htmlToMarkdown('<p><strong>正文 &amp; &#20013;</strong></p>'), "**正文 & 中**");
        assert.equal(htmlToMarkdown('<a href="https://a.test/?x=1>0&amp;y=2">链接</a>'), "[链接](<https://a.test/?x=1%3E0&y=2>)");
    } finally { DOMParser.prototype.parseFromString = original; }
});

test("N5 空输入返回空串", () => {
    assert.equal(htmlToMarkdown(""), "");
    assert.equal(htmlToMarkdown("   "), "");
});

test("富文本协议过滤和目的地转义", () => {
    const md = htmlToMarkdown('<a href="javascript:alert(1)">危险</a><img src="data:text/html,evil"><a href="https://a.test/a b(x)">安全</a>');
    assert.ok(!md.includes("javascript:"));
    assert.ok(!md.includes("data:"));
    assert.ok(md.includes("https://a.test/a%20b(x)"));
});
test("嵌套列表保留层级与起始编号", () => {
    const md = htmlToMarkdown('<ol start="3"><li>父<ul><li>子</li></ul></li></ol>');
    assert.ok(md.includes("3. 父\n   - 子"), md);
});
test("代码 fence 自适应并保留语言", () => {
    const md = htmlToMarkdown('<pre><code class="language-js">```\na()</code></pre>');
    assert.ok(md.includes("````js\n```\na()\n````"), md);
});
test("块级容器内标题和换行不被压平", () => {
    const md = htmlToMarkdown('<div><h2>标题</h2><p>第一<br>第二</p></div>');
    assert.ok(md.includes("## 标题"), md);
    assert.ok(md.includes("第一\n第二"), md);
});
