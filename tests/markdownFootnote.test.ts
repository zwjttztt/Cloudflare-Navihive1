import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";

const render = async (source: string) => renderToStaticMarkup(await renderMarkdownToReact(source));

test("脚注引用、定义与返回链接安全渲染", async () => {
    const html = await render("正文[^a]\n\n[^a]: **说明**与 `代码`");
    assert.match(html, /href="#note-fn-0"/);
    assert.match(html, /id="note-fn-0"/);
    assert.match(html, /<strong>.*说明/);
    assert.match(html, /返回脚注 1 引用/);
});
test("重复引用编号不变，但返回位置独立", async () => {
    const html = await render("甲[^x]乙[^x]\n\n[^x]: 注释");
    assert.match(html, /note-fnref-0-0/);
    assert.match(html, /note-fnref-0-1/);
    assert.equal((html.match(/id="note-fn-0"/g) ?? []).length, 1);
});
test("编号按引用顺序而非定义顺序", async () => {
    const html = await render("甲[^b]乙[^a]\n\n[^a]: 定义甲\n[^b]: 定义乙");
    assert.ok(html.indexOf("定义乙") < html.indexOf("定义甲"));
});
test("未定义、转义与代码中的引用保留文本", async () => {
    const html = await render("未知[^x] `[^a]` \\[^a]\n\n[^a]: 注释");
    assert.doesNotMatch(html, /<sup/);
    assert.match(html, /未知\[\^x\]/);
});
test("脚注支持多段内容且不执行 HTML 或危险链接", async () => {
    const html = await render("正文[^a]\n\n[^a]: 第一段\n\n    第二段 <script>bad</script> [危险](javascript:alert(1))");
    assert.match(html, /第二段/);
    assert.doesNotMatch(html, /<script>|href="javascript:/);
});
test("行内脚注支持与普通脚注相同返回链接", async () => {
    const html = await render("正文^[行内说明]");
    assert.match(html, /行内说明/);
    assert.match(html, /<sup/);
});
