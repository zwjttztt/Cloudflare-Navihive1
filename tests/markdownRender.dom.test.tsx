// tests/markdownRender.test.tsx
// Markdown → React 渲染层的用例。
//
// 这一组最要紧的不是「渲染对不对」，而是**渲染过程绝不能碰 innerHTML** ——
// 项目的 CSP 有 `require-trusted-types-for 'script'`（enforce、无 trusted-types 指令），
// 一旦碰到那些 sink，**整个界面白屏**。所以：
//   1. 有静态用例盯住源码里不出现那些 sink；
//   2. 有运行时用例把恶意输入丢进去，看结果里有没有真的标签/脚本被执行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderMarkdownToReact } from "../src/utils/markdownToReact";
import { UIPrefsProvider } from "../src/context/UIPrefsContext";

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

/**
 * 剥掉注释再检查。
 * 不剥的话会扫到注释里「为什么不用 dangerouslySetInnerHTML」这类**说明文字**，
 * 守卫就变成了永远红的假警报 —— 那种守卫比没有更糟。
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map(line => {
            // 去掉行注释（注意别把 URL 里的 // 误伤：前面有 : 就当它是 URL）
            const idx = line.indexOf("//");
            if (idx === -1) return line;
            const before = line.slice(0, idx);
            return /:\/\/[\s\S]*$/.test(before) ? line : before;
        })
        .join("\n");
}

/** 渲染到真实 DOM 再读文本 —— 这样断言的是「浏览器里看到的东西」 */
async function renderToDom(md: string): Promise<HTMLElement> {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const node = await renderMarkdownToReact(md);
    const root = createRoot(host);
    act(() => {
        root.render(<UIPrefsProvider>{node}</UIPrefsProvider>);
    });
    return host;
}

test("标题、段落、列表、引用都出得来", async () => {
    const host = await renderToDom(
        "# 大标题\n\n一段话\n\n- 甲\n- 乙\n\n> 引用一句"
    );
    const text = host.textContent || "";
    assert.ok(text.includes("大标题"));
    assert.ok(text.includes("一段话"));
    assert.ok(text.includes("甲") && text.includes("乙"));
    assert.ok(text.includes("引用一句"));
    // 结构上：真的有 h1 / ul / blockquote，不是一坨纯文本
    assert.equal(host.querySelectorAll("h1").length, 1);
    assert.equal(host.querySelectorAll("li").length, 2);
    assert.equal(host.querySelectorAll("blockquote").length, 1);
});

test("任务列表渲染成真正的 checkbox，且勾选状态对", async () => {
    const host = await renderToDom("- [x] 做完了\n- [ ] 没做完");
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
    assert.equal(boxes.length, 2, "两个任务项都要有 checkbox");
    assert.equal(boxes[0].checked, true);
    assert.equal(boxes[1].checked, false);
    // 文本里不该还留着 "- [ ] " 这种源码
    assert.ok(!(host.textContent || "").includes("- ["));
    assert.ok((host.textContent || "").includes("做完了"));
});

test("行内：粗体 / 斜体 / 行内代码", async () => {
    const host = await renderToDom("**粗** *斜* `code`");
    assert.equal(host.querySelectorAll("strong").length, 1);
    assert.equal(host.querySelectorAll("em").length, 1);
    assert.equal(host.querySelectorAll("code").length, 1);
    assert.ok((host.textContent || "").includes("粗"));
});

test("代码块出得来，语言标在 data-lang 上", async () => {
    // 单独一条：把行内语法和代码块塞进同一段时，前半段的解析会影响后半段，
    // 断言失败时定位不到到底是哪一处坏了
    const host = await renderToDom("```js\nconst a = 1;\n```");
    assert.equal(host.querySelectorAll("pre").length, 1);
    assert.equal(host.querySelectorAll("code").length, 1);
    assert.equal(
        host.querySelector("code")!.getAttribute("data-lang"),
        "js",
        "围栏语言的标识要留着（将来上高亮要用）"
    );
    assert.ok((host.textContent || "").includes("const a = 1;"));
});

test("表格出得来", async () => {
    const host = await renderToDom("| 名 | 值 |\n|---|---|\n| a | 1 |");
    assert.equal(host.querySelectorAll("table").length, 1);
    assert.equal(host.querySelectorAll("th").length, 2);
    assert.equal(host.querySelectorAll("td").length, 2, "一行两列 → 两个 td");
});

test("外链带 target/rel，内部链接不带", async () => {
    const host = await renderToDom("[外](https://example.com) [内](/groups)");
    const links = host.querySelectorAll("a");
    assert.equal(links[0].getAttribute("target"), "_blank");
    assert.equal(links[0].getAttribute("rel"), "noopener noreferrer");
    assert.equal(links[1].getAttribute("target"), null);
});

// ---------------------------------------------------------------------------
// 安全：这是本文件存在的首要理由
// ---------------------------------------------------------------------------

test("脚本与事件属性一律不执行（html: false）", async () => {
    const host = await renderToDom(
        '<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned=2">'
    );
    // 没有任何真的 script / img 被建出来
    assert.equal(host.querySelectorAll("script").length, 0);
    assert.equal(host.querySelectorAll("img").length, 0);
    // 原文以纯文本形式出现
    assert.ok((host.textContent || "").includes("<script>"));
});

test("javascript: 链接降级成纯文本（不点不动）", async () => {
    const host = await renderToDom("[点我](javascript:alert(1))");
    const links = host.querySelectorAll("a");
    assert.equal(links.length, 0, "javascript: 链接不该渲染成可点击的 <a>");
    assert.ok((host.textContent || "").includes("点我"));
});

test("data: 协议的图片也挡掉（只放行真的图片类型）", async () => {
    const host = await renderToDom("![x](data:text/html;base64,PHNjcmlwdD4=)");
    assert.equal(host.querySelectorAll("img").length, 0);
});

test("渲染层源码里不出现任何 innerHTML sink", async () => {
    // 静态守卫：这是 CSP 兼容的**前提**。运行时测不到「将来有人又加了 sink」，
    // 所以这一条必须在源码层面盯着。
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "utils", "markdownToReact.tsx"),
            "utf-8"
        )
    );
    for (const sink of [
        "dangerouslySetInnerHTML",
        ".innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "new Function",
        "eval(",
    ]) {
        assert.ok(
            !source.includes(sink),
            `渲染层里出现了 ${sink} —— CSP 的 require-trusted-types-for 'script' ` +
                "会把这些 sink 封死，碰到就是界面白屏"
        );
    }
});

test("渲染层不依赖 markdown-it 的 renderer（只当解析器用）", async () => {
    const source = readFileSync(
        join(findProjectDir(), "src", "utils", "markdownToReact.tsx"),
        "utf-8"
    );
    assert.ok(
        !source.includes(".render("),
        "出现了 `.render(` —— 那是 markdown-it 的 HTML 输出路径（innerHTML）"
    );
    assert.ok(
        source.includes("md.parse("),
        "应该只调用 md.parse() 拿 token"
    );
    assert.ok(
        source.includes("html: false"),
        "必须显式 html: false —— 不解析原始 HTML 是最外层的安全闸"
    );
});
