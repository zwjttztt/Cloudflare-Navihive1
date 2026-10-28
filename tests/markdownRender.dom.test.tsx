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

test("本站上传的附件图片（/api/notes/attachments/）渲染成真 <img>", async () => {
    // 2026-10-08 用户报「上传图片后预览窗看不见图片」：上传落进正文的是
    // 相对路径 /api/notes/attachments/<uuid>.png，之前白名单只放行 http(s)/data/blob，
    // 图片整张变成了 alt 文本。同源相对路径在 <img> 上会自动带登录 cookie，安全。
    const host = await renderToDom("![QQ浏览器截图](/api/notes/attachments/db841f8c-1234.png)");
    const img = host.querySelector("img");
    assert.ok(img, "上传的附件图片要渲染成 <img>，不是一行 alt 文本");
    assert.equal(img!.getAttribute("src"), "/api/notes/attachments/db841f8c-1234.png");
    assert.equal(img!.getAttribute("alt"), "QQ浏览器截图");
});

// 2026-10-09「编辑区图片不停抽动」的第二半修复：编辑区的即时渲染会把块整块换成
// widget，widget 随视口进出被反复销毁重建。没有缓存时**每重建一次就重走一遍**
// 直连失败 → 带凭据 fetch → objectURL → 卸载时 revoke，图就没了又来。
// 这条用例盯的是「第二次挂载还请不请求」—— 回滚掉 imageCache 就会红。
test("图片：结论进缓存后，同一张图再次挂载不再重复请求", async () => {
    const { resetImageCacheForTests } = await import("../src/utils/markdownToReact");
    resetImageCacheForTests();
    const originFetch = globalThis.fetch;
    const originCreate = URL.createObjectURL;
    const originRevoke = URL.revokeObjectURL;
    let calls = 0;
    try {
        globalThis.fetch = (async () => {
            calls++;
            return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), {
                status: 200,
            });
        }) as typeof fetch;
        URL.createObjectURL = () => "blob:stub-1";
        URL.revokeObjectURL = () => {};

        const md = "![缓存测试](/api/notes/attachments/cache-1.png)";
        const first = await renderToDom(md);
        const img1 = first.querySelector("img");
        assert.ok(img1, "第一次要渲染出 <img>");
        // jsdom 不发真实网络请求 → 手动触发 error，走「带凭据重试」那条路
        await act(async () => {
            img1!.dispatchEvent(new Event("error"));
            await new Promise(r => setTimeout(r, 0));
        });
        assert.equal(calls, 1, "第一次加载失败要带凭据取一次");

        // 第二次挂载（编辑区 widget 重建就是这么发生的）：缓存命中 → 不再请求
        const second = await renderToDom(md);
        const img2 = second.querySelector("img");
        assert.ok(img2, "第二次也要有 <img>");
        assert.equal(calls, 1, "同一张图再次挂载不该再请求一次（缓存要命中）");
        assert.equal(img2!.getAttribute("src"), "blob:stub-1", "缓存里的地址要直接用上");
    } finally {
        globalThis.fetch = originFetch;
        URL.createObjectURL = originCreate;
        URL.revokeObjectURL = originRevoke;
        resetImageCacheForTests();
    }
});

test("其它相对路径的图片仍然挡掉（白名单只放开本站附件）", async () => {
    const host = await renderToDom("![a](/etc/passwd.png) ![b](javascript:alert(1)) ![c](//evil.com/x.png)");
    assert.equal(
        host.querySelectorAll("img").length,
        0,
        "非 /api/notes/attachments/ 的相对路径不放行"
    );
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

test("公式层（MathNode）不碰任何 CSP 禁用的 sink，且 KaTeX 必须是动态引入", async () => {
    // 公式是唯一会**生产 DOM 子树**的地方（KaTeX 用 createElement/appendChild），
    // 所以它跟渲染层一样需要一条独立守卫：
    //   - 静态扫：不许出现 innerHTML / outerHTML / insertAdjacentHTML 等 sink；
    //   - 再扫源码：必须写成 `import(` 的动态形式（katex 近 270KB，静态引入会顶穿首屏预算）。
    const source = stripComments(
        readFileSync(
            join(findProjectDir(), "src", "utils", "MathNode.tsx"),
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
            `公式层里出现了 ${sink} —— CSP 的 require-trusted-types-for 'script' 会把它封死`
        );
    }
    assert.ok(
        /import\(\s*["']katex["']/.test(source),
        "katex 必须动态 import：静态引入会把 ~270KB 拖进首屏（bundleBudget 会红）"
    );
    // 降级路径：真渲染不出公式时（网络挂了 / 公式写坏）不能让整篇预览消失
    assert.ok(source.includes("failed"), "KaTeX 加载或渲染失败时要退化成文本显示原文");
});

test("预览里 $行内$ 与 $$块级$$ 都渲染成公式节点", async () => {
    const host = await renderToDom("欧拉恒等式 $e^{i\\pi}+1=0$ 见下\n\n$$a^2+b^2=c^2$$\n");
    // 两个公式各出一个「渲染中」的挂载点（内容由 KaTeX 异步补上）
    const math = host.querySelectorAll('[role="math"]');
    assert.equal(math.length, 2, "行内 1 个 + 块级 1 个");
    // 挂载点要带上公式原文（读屏工具、以及 KaTeX 还没到位时的兜底文案）
    assert.ok(
        [...math].some(el => (el.getAttribute("aria-label") || "").includes("e^{i")),
        "行内公式的 LaTeX 原文要挂在 role=math 上"
    );
    // 语法没闭合的美元符号不许被吃掉（误伤正文比不渲染更糟）
    const other = await renderToDom("这件东西 $100 很贵");
    assert.equal(other.querySelectorAll('[role="math"]').length, 0);
});

test("渲染层不依赖 markdown-it 的 renderer（只当解析器用）", async () => {
    const source = readFileSync(
        join(findProjectDir(), "src", "utils", "markdownToReact.tsx"),
        "utf-8"
    );
    // ⚠️ 两条都要盯 `md.` 前缀、且不能用宽泛的 `.render(`：
    // KaTeX 自己也提供 DOM 入口 katex.render()，公式那条路是合法的，
    // 宽泛匹配会让这条守卫变成假警报。要挡的是**解析器自带的 HTML 输出**。
    for (const bad of ["md.render(", ".renderToString("]) {
        assert.ok(
            !source.includes(bad),
            `出现了 ${bad} —— 那是 markdown-it 的 HTML 输出路径（会碰 innerHTML）`
        );
    }
    assert.ok(
        source.includes("md.parse("),
        "应该只调用 md.parse() 拿 token"
    );
    assert.ok(
        source.includes("html: false"),
        "必须显式 html: false —— 不解析原始 HTML 是最外层的安全闸"
    );
});

// ---------- N6 别名 `[[目标|显示名]]`：渲染用显示名，跳转判据仍是目标名 ----------

test("N6 别名渲染：显示别名文本，data-wiki-link 保持目标名", async () => {
    const host = await renderToDom("见 [[目标页|这篇笔记]] 就懂了");
    const link = host.querySelector("[data-wiki-link='目标页']");
    assert.ok(link, "链接应挂 data-wiki-link=目标名");
    assert.equal(link!.textContent, "这篇笔记", `应显示别名而不是目标名，实际：${link!.textContent}`);
});

test("N6 别名渲染：没有别名的双链照旧显示目标名", async () => {
    const host = await renderToDom("见 [[目标页]] 就懂了");
    const link = host.querySelector("[data-wiki-link='目标页']");
    assert.ok(link, "链接应存在");
    assert.equal(link!.textContent, "目标页");
});

// ============ 阶段⑤：服务端尺寸预注入 ============

test("seedAttachmentDimensions：预注入后首帧 <img> 直接带 width/height", async () => {
    const { resetImageCacheForTests, seedAttachmentDimensions } =
        await import("../src/utils/markdownToReact");
    resetImageCacheForTests();
    const seeded = seedAttachmentDimensions([
        { id: "dim-1", width: 640, height: 360 },
        { id: "dim-2", width: 0, height: 0 },      // 无效尺寸不种
        { id: "dim-3", width: null, height: null }, // 老附件没有尺寸不种
    ]);
    assert.equal(seeded, 1, "只有带有效尺寸的附件被种进缓存");

    const host = await renderToDom("![图](/api/notes/attachments/dim-1)");
    const img = host.querySelector("img");
    assert.ok(img);
    // 首帧就带尺寸：浏览器据此预留空间，换设备首开不再「塌缩→撑开」
    assert.equal(img!.getAttribute("width"), "640");
    assert.equal(img!.getAttribute("height"), "360");
    resetImageCacheForTests();
});

test("seedAttachmentDimensions：已有缓存条目（运行时状态）一律不覆盖", async () => {
    const { resetImageCacheForTests, seedAttachmentDimensions } =
        await import("../src/utils/markdownToReact");
    resetImageCacheForTests();
    // 先种一次（模拟运行时已建立的状态），再种一个不同尺寸：不得覆盖
    seedAttachmentDimensions([{ id: "dim-live", width: 10, height: 10 }]);
    const seeded = seedAttachmentDimensions([{ id: "dim-live", width: 1, height: 1 }]);
    assert.equal(seeded, 0, "已有条目不覆盖");

    const host = await renderToDom("![图](/api/notes/attachments/dim-live)");
    const img = host.querySelector("img");
    assert.ok(img);
    assert.equal(img!.getAttribute("width"), "10", "渲染用的是第一次种下的尺寸");
    resetImageCacheForTests();
});

// ---- 2026-10-25「笔记美化」：排版语言 ----
// 这几条盯的是「改样式时最容易悄悄退化的东西」：
// 标题层级（以前是浏览器默认：h1 2em、h5/h6 比正文还小）、
// 块的竖向节奏（以前 8px / 0.6em / 2px 混用）、
// 分隔符能不能表达粗细层级、以及块颜色是不是走了主题变量。

test("标题层级：h1-h6 字号递减，且上间距 > 下间距", async () => {
    const host = await renderToDom(
        "# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\n正文"
    );
    const sizes = [1, 2, 3, 4, 5, 6].map(l => {
        const el = host.querySelector(`h${l}`) as HTMLElement;
        assert.ok(el, `h${l} 必须出得来`);
        return parseFloat(el.style.fontSize);
    });
    for (let i = 1; i < sizes.length; i++) {
        assert.ok(sizes[i] < sizes[i - 1], `h${i + 1}(${sizes[i]}) 必须小于 h${i}(${sizes[i - 1]})`);
    }
    const h1 = host.querySelector("h1") as HTMLElement;
    const top = parseFloat(h1.style.marginTop);
    const bottom = parseFloat(h1.style.marginBottom);
    assert.ok(top > bottom, `标题要贴着它下面的正文（上 ${top}em > 下 ${bottom}em）`);
    assert.equal(parseFloat(h1.style.fontWeight), 600);
});

test("段落 / 列表 / 代码块共用一套竖向节奏（--md-para-gap）", async () => {
    const host = await renderToDom("一段\n\n- 甲\n\n```\ncode\n```\n");
    const p = host.querySelector("p") as HTMLElement;
    const ul = host.querySelector("ul") as HTMLElement;
    const pre = host.querySelector("pre") as HTMLElement;
    for (const [name, el] of [["段落", p], ["列表", ul], ["代码块", pre]] as const) {
        assert.match(
            el.style.margin,
            /var\(--md-para-gap/,
            `${name}的段距必须走 --md-para-gap（紧凑密度下才能整体收窄）`
        );
    }
});

test("分隔符分两档：--- 是细线，*** 是居中三点", async () => {
    const host = await renderToDom("上\n\n---\n\n中\n\n***\n\n下");
    assert.equal(host.querySelectorAll("hr").length, 1, "--- 渲染成 hr");
    const dots = host.querySelector("[role='separator']") as HTMLElement | null;
    assert.ok(dots, "*** 必须走「居中三点」这一档");
    assert.equal(dots!.textContent, "···");
    assert.equal(dots!.style.textAlign, "center");
});

test("块的底色/描边走主题变量（暗色不用改渲染器，换一套变量即可）", async () => {
    const host = await renderToDom("```\ncode\n```\n\n> 引用\n\n| A | B |\n| - | - |\n| 1 | 2 |\n");
    const pre = host.querySelector("pre") as HTMLElement;
    assert.match(pre.style.background, /var\(--md-block-bg/, "代码块底色走变量");
    assert.match(pre.style.border, /var\(--md-block-border/, "代码块描边走变量");
    const quote = host.querySelector("blockquote") as HTMLElement;
    assert.match(quote.style.borderLeft, /var\(--md-quote-border/, "引用竖线走变量");
    const th = host.querySelector("th") as HTMLElement;
    assert.match(th.style.background, /var\(--md-table-head-bg/, "表头底色走变量");
});

test("双链是点状下划线 + 500 字重（和普通链接分开）", async () => {
    const host = await renderToDom("看 [[另一篇]] 和 [外链](https://example.com)");
    const wiki = host.querySelector("[data-wiki-link]") as HTMLElement;
    assert.ok(wiki, "双链节点要出得来");
    assert.equal(wiki.style.textDecoration, "underline dotted");
    assert.equal(parseFloat(wiki.style.fontWeight), 500);
});

// 可复制块（`> [!COPY]`）：块右上角一颗**绝对定位的图标**按钮（2026-10-28 方案 A）。
// 这一组盯两件事：① 按钮不再参与正文排版（旧版 float 会挤掉首行 ~70px）；
// ② 真点一下有没有东西进剪贴板 —— 只断言按钮存在是假通过。
test("COPY 块：复制胶囊绝对定位（不挤正文）+ 带「复制」两字，点一下把整块纯文本写进剪贴板", async () => {
    const host = await renderToDom("> [!COPY]\n> 第一行\n>\n> 第二行");

    const block = host.querySelector('[data-callout="COPY"]');
    assert.ok(block, "没渲染出 COPY 块");

    const btn = block!.querySelector<HTMLButtonElement>('[data-copy-op="copy-block"]');
    assert.ok(btn, "没渲染出复制按钮");

    // ① 绝对定位、不再 float：这是「不影响文字排序」的根。
    assert.equal(btn!.style.getPropertyValue("position"), "absolute", "按钮必须绝对定位（float 会挤掉首行）");
    assert.equal(btn!.style.getPropertyValue("float"), "", "不许再用 float 参与排版");
    assert.equal(btn!.style.getPropertyValue("right"), "12px", "按钮要往正文里缩 12px，别贴窗口右边缘");
    // ② 图标 + 文字：只留图标那版用户两次报「看不清」，第 ③ 版加回「复制」两字。
    assert.equal((btn!.textContent ?? "").trim(), "复制", "胶囊上要有「复制」两个字");
    assert.ok(btn!.querySelector("svg"), "图标也留着（文字 + 图标双保险）");
    // ③ 颜色 / 底色必须留给样式表：内联样式优先级更高，写死就把 index.css 里的
    //    :hover 底色和 [data-copied] 强调色全压掉了（2026-10-28 踩过）。
    assert.equal(btn!.style.getPropertyValue("background"), "", "底色交给 index.css，别写内联值");
    assert.equal(btn!.style.getPropertyValue("color"), "", "颜色交给 index.css，别写内联值");
    // ④ 按钮浮在块顶部预留的 28px 操作带里 —— 不做这件事，长首行会被胶囊盖住。
    assert.equal(
        (block as HTMLElement).style.getPropertyValue("padding-top"),
        "28px",
        "块顶部必须给胶囊留出操作带，否则它会压在首行文字上"
    );
    // ⑤ 不能丢可访问名。
    assert.ok((btn!.getAttribute("aria-label") ?? "").length > 0, "图标按钮必须有 aria-label");

    const written: string[] = [];
    const prevClipboard = navigator.clipboard;
    const hadClipboard = Boolean(prevClipboard);
    Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (t: string) => { written.push(t); } },
    });
    const prevSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    try {
        await act(async () => {
            btn!.click();
            await new Promise(r => setTimeout(r, 0));
        });
        assert.equal(written.length, 1, "点一次只该往剪贴板写一次");
        assert.equal(
            written[0],
            "第一行\n\n第二行",
            "复制的是**渲染后的纯文本**；带上 `>` 就成了让人自己再删一遍的源码"
        );
        assert.equal(btn!.getAttribute("data-copied"), "1", "点完必须当场给反馈（图标换成对勾）");
        assert.equal((btn!.textContent ?? "").trim(), "已复制", "点完文字也要跟着变，不能只换图标");
    } finally {
        if (hadClipboard) {
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: prevClipboard,
            });
        } else {
            delete (navigator as unknown as { clipboard?: unknown }).clipboard;
        }
        if (prevSecure) Object.defineProperty(window, "isSecureContext", prevSecure);
    }
});

test("普通引用块不冒出复制按钮（别把 `>` 引用当成可复制块）", async () => {
    const host = await renderToDom("> 只是一句引用");
    assert.equal(host.querySelector('[data-copy-op="copy-block"]'), null);
});

// 静态守卫（2026-10-28）：复制按钮必须**一眼看得见**。
// 上一版在 `@media (hover: hover) and (pointer: fine)` 里写了静止 `opacity: 0`，
// 结果在鼠标环境里它就是隐形的 —— 用户反馈「复制按键看不见」。
// 这条守卫盯三件事：
//   ① 任何 .md-copy-btn 规则都不许把它整条藏起来（opacity 精确等于 0）；
//   ② 静止态要有可见的不透明度；
//   ③ 悬停 / 聚焦要能更明显（否则等于没有反馈）。
// 只看源码不渲染 DOM 的原因：jsdom 不跑媒体查询里的层叠，算出来的样式测不到这个坑。
test("复制按钮的样式：静止态可见、永不被藏成 opacity: 0", () => {
    const css = readFileSync(join(findProjectDir(), "src", "index.css"), "utf-8")
        // 只剥 CSS 块注释：注释里写着「静止 opacity: 0」这种说明文字，
        // 不剥就变成永远红的假警报。
        .replace(/\/\*[\s\S]*?\*\//g, "");

    // 顶层规则：选择器 + 声明体（嵌套块如 @media 里含花括号，不会被这条匹配到）
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
        selector: m[1].trim(),
        body: m[2],
    }));
    const copyRules = rules.filter(r => r.selector.includes(".md-copy-btn"));
    assert.ok(copyRules.length >= 2, `index.css 里找不到 .md-copy-btn 的规则（找到 ${copyRules.length} 条）`);

    /** 规则体里声明的 opacity 值（没写就是 undefined） */
    const opacityOf = (body: string): number | undefined => {
        const hit = /(?:^|;)\s*opacity\s*:\s*([^;]+)/.exec(`;${body}`);
        return hit ? Number.parseFloat(hit[1]) : undefined;
    };

    for (const rule of copyRules) {
        const opacity = opacityOf(rule.body);
        if (opacity === undefined) continue;
        assert.notEqual(
            opacity,
            0,
            `${rule.selector} 把复制按钮设成完全透明了 —— 鼠标环境里用户根本看不见这个按钮` +
                "（2026-10-28 已踩过：静止 opacity: 0 + 悬停才显形 = 隐形机关）"
        );
    }

    const rest = copyRules.find(r => r.selector === ".md-copy-btn");
    assert.ok(rest, "要有一条针对 .md-copy-btn 本体（静止态）的规则");
    const restOpacity = opacityOf(rest!.body);
    assert.ok(
        restOpacity === undefined || restOpacity >= 0.4,
        `复制按钮静止态不透明度只有 ${restOpacity}，太淡了（要 >= 0.4，最好干脆不设）`
    );
    // 第 ③ 版定稿：它是「浅底 + 描边的胶囊」，靠**形**让人认出是按钮，
    // 不靠颜色深浅。所以静止态必须同时有底色、描边和明确的文字色 —— 缺一样就退回
    // 「一颗灰线图标糊在正文里」那种看不清的状态。
    assert.match(rest!.body, /border\s*:\s*1px\s+solid/, "胶囊要有 1px 描边（否则在正文里没有边界）");
    assert.match(rest!.body, /background\s*:/, "胶囊要有浅底");
    assert.match(rest!.body, /color\s*:/, "文字色要显式给（别让 <button> 的默认色盖上来）");
    assert.match(rest!.body, /font-size\s*:/, "12px 的字号要写死在这里，否则胶囊会跟正文字号走");

    // 悬停要有可见变化：第 ③ 版不再用 opacity，改成换底色 / 描边 / 文字色，
    // 所以这里只要求「改了其中至少一样」，不钉具体属性。
    const hover = copyRules.find(r => r.selector.includes(":hover"));
    assert.ok(hover, "必须有 :hover 规则（点了才知道能点）");
    assert.match(
        hover!.body,
        /(background|border|color)\s*:/,
        "悬停时底色 / 描边 / 文字色至少要变一样"
    );
    assert.ok(
        copyRules.some(r => r.selector.includes(':focus-visible')),
        "键盘聚焦必须有可见样式（只有鼠标反馈等于没法用键盘）"
    );
    assert.ok(
        copyRules.some(r => r.selector.includes('data-copied="1"')),
        "复制成功的瞬间要有专门配色（data-copied 那 1.2 秒的反馈不能只靠换图标）"
    );
});

