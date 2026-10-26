// src/utils/noteHtmlExport.ts
// 「导出 HTML / 导出 PDF」（inkstone 笔记右键菜单里的两项）。
//
// 安全边界（务必看清楚再改）：
//   - 这里用 markdown-it 的 **renderer** 产出 HTML **字符串**，只写进 Blob 文件 /
//     打印 iframe，**从不**把它赋给本页面的任何 DOM sink（innerHTML / srcdoc…）。
//     本项目的 CSP 是 enforce 的 `require-trusted-types-for 'script'`，页面内
//     innerHTML 一律被封死 —— 但「生成一个文件让浏览器下载/打印」不经过那些
//     sink，Trusted Types 管不到（它只保护页面内的注入点）。
//   - markdown-it 默认开启 html:false，原始 HTML 会被转义，不会把用户笔记里的
//     `<script>` 带进导出文件。
//
// markdown-it 必须动态 import：它只进懒加载 chunk（与预览层同一个模块缓存，
// 首次导出才真正下载）。插件集合要和 markdownToReact 那边**尽量**对齐，
// 但 renderer 侧很多规则由那边自绘（任务列表/高亮/标注块…），导出允许退化 ——
// 这是「文件里少一点样式」与「页面白屏」之间的取舍，选前者。

import { buildNoteMarkdown, downloadTextFile, safeFileName } from "./noteExport";
import type MarkdownIt from "markdown-it";

/** 延迟加载一个配好插件的 markdown-it 实例（导出专用） */
let exporterPromise: Promise<import("markdown-it").default> | null = null;
function loadExporter(): Promise<import("markdown-it").default> {
    if (!exporterPromise) {
        exporterPromise = Promise.all([
            import("markdown-it"),
            // 脚注与预览层对齐（markdown-it-footnote 是纯 renderer 插件，导出完整可用）。
            // ⚠️ 该插件自带的类型是按 markdown-it 的 CJS 构建写的，与 @types/markdown-it
            // 结构性不兼容（历史遗留），这里 cast 一下 —— 运行时 md.use 是同一个签名。
            import("markdown-it-footnote"),
        ]).then(([{ default: MarkdownItCtor }, { default: footnote }]) => {
            const md = new MarkdownItCtor({ html: false, linkify: true, breaks: false });
            return md.use(footnote as unknown as Parameters<MarkdownIt["use"]>[0]);
        });
    }
    return exporterPromise;
}

/** 把正文渲染成 HTML 片段（<body> 里那部分） */
export async function renderNoteHtmlBody(content: string): Promise<string> {
    const md = await loadExporter();
    // 标题并进正文：导出的 .md 也这么干（buildNoteMarkdown），两边口径一致
    const tokens = md.parse(buildNoteMarkdown("", content), {});
    const cache = new Map<string, Promise<string>>();
    const pending: Promise<void>[] = [];
    const visit = (items: typeof tokens) => {
        for (const token of items) {
            if (token.type === "image") {
                const src = token.attrGet("src") ?? "";
                if (/^\/api\/notes\/attachments\/[0-9a-z-]+$/.test(src)) {
                    let result = cache.get(src);
                    if (!result) {
                        result = fetch(src, { credentials: "same-origin", cache: "no-store" }).then(async response => {
                            if (!response.ok) throw new Error("导出图片失败，请检查附件是否仍存在");
                            const blob = await response.blob();
                            if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(blob.type)) throw new Error("附件不是可导出的图片");
                            return await new Promise<string>((resolve, reject) => {
                                const reader = new FileReader();
                                reader.onload = () => resolve(String(reader.result));
                                reader.onerror = () => reject(new Error("读取导出图片失败"));
                                reader.readAsDataURL(blob);
                            });
                        });
                        cache.set(src, result);
                    }
                    pending.push(result.then(url => { token.attrSet("src", url); }));
                }
            }
            if (token.children) visit(token.children);
        }
    };
    visit(tokens);
    await Promise.all(pending);
    return md.renderer.render(tokens, md.options, {});
}

/** 导出文档的公共外壳（内联样式，离线打开也有基本排版） */
function wrapHtmlDocument(title: string, body: string): string {
    const safeTitle = (title || "未命名笔记")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  body { max-width: 820px; margin: 40px auto; padding: 0 24px;
         font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         color: #1f2328; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.35; font-weight: 600; margin: 1.2em 0 0.4em; }
  h1 { font-size: 1.75em; }
  h2 { font-size: 1.42em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.06em; }
  h5 { font-size: 1em; }
  h6 { font-size: 0.95em; }
  p, ul, ol, pre, blockquote, table { margin: 0 0 12px; }
  pre { background: #f6f8fa; padding: 14px; border-radius: 10px; overflow: auto; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 0.92em; }
  blockquote { border-left: 3px solid #d0d7de; margin: 0 0 12px; padding: 2px 0 2px 14px; color: #57606a; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d0d7de; padding: 6px 10px; }
  img { max-width: 100%; }
  a { color: #0969da; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * 导出 .html 文件。返回文件名（调用方拿去弹提示）。
 * ⚠️ 等待解析完成是异步的：markdown-it 是动态 import 的。
 */
export async function exportNoteAsHtml(title: string, content: string): Promise<string> {
    const body = await renderNoteHtmlBody(content);
    const name = `${safeFileName(title)}.html`;
    downloadTextFile(name, wrapHtmlDocument(title, body), "text/html");
    return name;
}

/**
 * 打印 / 另存为 PDF：把渲染好的 HTML 装进一个**隐藏 iframe**（blob: URL），
 * 调起浏览器打印对话框 —— 用户在目的地里选「另存为 PDF」。
 *
 * 为什么不用 window.open + document.write：弹出窗口会被拦截器吃掉，
 * 而且 document.write 本身就是 Trusted Types 盯的 sink；iframe.src 走 blob URL
 * 是导航而不是注入，两条约束都不碰。
 *
 * ⚠️ iframe 必须带 sandbox（S12）：blob URL 继承创建者的源，于是这个 iframe
 * **与本站同源** —— 笔记内容里的 <script> / 自动提交的表单 / 指向外站的 img
 * 都能以本站身份跑起来（读同源数据、带着本站 cookie 出网）。
 * 取值是**最小可用组合**而不是 `sandbox=""`：
 *   - `allow-same-origin`：必须留。没有它 iframe 是透明源，父页面访问
 *     contentDocument / contentWindow 会被当成跨域直接抛 SecurityError，
 *     下面那段「等图片 decode 完再打印」和 contentWindow.print() 全废；
 *   - `allow-modals`：打印对话框本身是模态的，沙箱里不给这条 print() 打不开；
 *   - 刻意**不给** `allow-scripts`：这才是这次要挡的东西 —— 笔记里就算夹了
 *     <script>，在沙箱里也是死的，既碰不到 DOM 也发不出请求（同源也白搭）；
 *   - 刻意**不给** `allow-forms` / `allow-popups` / `allow-top-navigation`：
 *     表单提交、window.open、顶栏跳转一律失效，堵掉「导出一份笔记点开就外带数据」。
 * 用 setAttribute 而不是 `frame.sandbox = "..."`：DOM 里 sandbox 是 DOMTokenList，
 * 直接赋字符串过不了类型检查。
 */
export async function printNoteAsPdf(title: string, content: string): Promise<void> {
    const body = await renderNoteHtmlBody(content);
    const html = wrapHtmlDocument(title, body);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.visibility = "hidden";
    // 装进同源 iframe 的内容必须有边界（理由见函数头那段）
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.src = url;
    frame.addEventListener("load", async () => {
        try {
            const images = Array.from(frame.contentDocument?.images ?? []);
            await Promise.all(images.map(image => image.decode?.().catch(() => undefined)));
            frame.contentWindow?.focus();
            frame.contentWindow?.print();
        } finally {
            // 打印对话框是同步阻塞的（Chrome），关掉后iframe就没用了；
            // Safari 的 print 可能异步，多留一拍再清理
            setTimeout(() => {
                frame.remove();
                URL.revokeObjectURL(url);
            }, 60_000);
        }
    });
    document.body.appendChild(frame);
}
