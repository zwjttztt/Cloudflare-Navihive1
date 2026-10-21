// tests/editorCursorGuard.test.ts
// 编辑区光标统一蓝色的静态守卫（2026-10-22）。
//
// 用户两轮反馈同一问题：光标在灰色渲染块内发浅/发白、块外又是蓝色。
// 第一轮修成了「与正文同色（亮色 #1f2937 近黑）」，用户复报并点名方案 ——
// 「把它都变成蓝色显眼一些」。现在钉成亮色 #1a73e8 / 暗色 #6cb2ff，
// 鼠标指针换自带白描边的蓝色 I 字 SVG（data URI），子元素 cursor: inherit。
//
// ⚠️ 守卫只比字符串：断言失败路径里不能塞 DOM 元素（node:assert 会 util.inspect
//    整个元素，进程堆会炸 —— 2026-10-21 踩过同款 heap OOM）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { projectDir as findProjectDir, stripComments } from "./helpers/notesSource";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = () => findProjectDir(here);
// ⚠️ 换行归一化：index.css 在 Windows 上是 CRLF，守卫里写 `\n` 拼多行选择器会
//    匹配不上（2026-10-22 踩到：选择器明明在文件里，indexOf 却返回 -1）。
const readCss = (rel: string) =>
    stripComments(
        readFileSync(resolve(projectDir(), rel), "utf8").replace(/\r\n/g, "\n")
    );

/** 取出某条规则的花括号内容：给选择器，返回它自己的声明块 */
function ruleBody(css: string, selector: string): string {
    const idx = css.indexOf(selector);
    if (idx < 0) return "";
    const open = css.indexOf("{", idx);
    if (open < 0) return "";
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") {
            depth--;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    return "";
}

const CSS = () => readCss("src/index.css");

test("编辑区文字光标：亮色主题钉成显眼蓝 #1a73e8", () => {
    const body = ruleBody(CSS(), ".cm-editor .cm-content {");
    assert.ok(body.length > 0, "要能取到 .cm-editor .cm-content 规则块");
    assert.match(body, /caret-color:\s*#1a73e8\s*!important/, "亮色光标必须是显眼蓝");
    // 反向验证：守卫本身得真能抓到「改成近黑」这种回退
    assert.equal(
        /caret-color:\s*#1f2937\s*!important/.test(body),
        false,
        "不该再是上一版那个近黑色（用户已判定不够显眼）"
    );
});

test("编辑区文字光标：暗色主题钉成亮蓝 #6cb2ff", () => {
    const body = ruleBody(CSS(), "html.dark .cm-editor .cm-content {");
    assert.ok(body.length > 0, "要能取到暗色主题规则块");
    assert.match(body, /caret-color:\s*#6cb2ff\s*!important/, "暗色光标必须是亮蓝");
});

test("编辑区鼠标指针：统一是自定义蓝色 I 字 SVG，且带 text 兜底", () => {
    const body = ruleBody(CSS(), ".cm-editor .cm-content {");
    // 白描边 + 蓝针：两条 path 同形、先白后蓝
    assert.match(body, /cursor:\s*url\("data:image\/svg\+xml,/, "指针要用内联 SVG 光标");
    assert.match(body, /stroke='%231a73e8'/, "亮色 I 字是蓝色描边");
    assert.match(body, /stroke='%23ffffff'/, "要有白描边垫底（浅灰块上才不发白）");
    assert.match(body, /\)\s*\n?\s*12 4,\s*\n?\s*text;/, "必须给热点 12 4 并保留 text 兜底");
});

test("渲染块内的光标跟着父级走（cursor 用 inherit，不能重钉成 text）", () => {
    const body = ruleBody(CSS(), ".cm-editor .cm-content * {");
    assert.ok(body.length > 0, "要能取到 .cm-editor .cm-content * 规则块");
    assert.match(
        body,
        /cursor:\s*inherit/,
        "子元素必须 inherit —— 钉成 text 会把自定义蓝针打回系统黑针，灰块内又发白"
    );
    // 反向验证：断言「钉成 text」这种回退会被判为不合规
    assert.equal(
        /cursor:\s*text\s*;/.test(body),
        false,
        "子元素不该再钉死 text"
    );
});

test("能点的元素仍是手型（别把链接/按钮也变成 I 字）", () => {
    const body = ruleBody(
        CSS(),
        '.cm-editor .cm-content a,\n.cm-editor .cm-content button,\n.cm-editor .cm-content [role="button"] {'
    );
    assert.ok(body.length > 0, "要能取到可点元素规则块");
    assert.match(body, /cursor:\s*pointer/, "链接/按钮必须还是手型");
});
