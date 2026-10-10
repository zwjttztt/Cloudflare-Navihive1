// src/utils/markdownToReact.tsx
// Markdown → **React 元素**。
//
// 为什么不用 markdown-it 自带的 renderer（inkstone 就是那么做的）：
// 它的输出是 HTML **字符串**，要变成 DOM 就得走 innerHTML / dangerouslySetInnerHTML。
// 而本项目的 CSP 里有 `require-trusted-types-for 'script'`（enforce，且**没有**
// `trusted-types` 指令），那些 sink 全被封死 —— 赋值字符串直接抛异常，**界面白屏**。
// `_headers` 的注释里早就写明「本条是 enforce：将来引入碰 sink 的依赖，界面会直接白屏」。
//
// 所以这里只用 markdown-it 的**解析器**（`md.parse()` 出 token），再把 token 映射成
// React 元素。全程不产生 HTML 字符串、不碰任何 sink，连 DOMPurify 都不需要
// （没有字符串注入）—— 顺带保住「全仓 0 处 innerHTML」。
//
// 代价（写在方案 docs/notebook-design.md 4.2）：markdown-it 的插件大多注册
// `renderer.rules.*`，在 token 流下大部分失效，所以任务列表 / 高亮都自己实现。
//
// Mermaid 通过独立 opaque-origin 沙箱渲染；主页面仍不允许字符串 HTML sink。原始 HTML 不做。
//
// 公式（KaTeX）**做**，2026-10-05 改：KaTeX 支持 DOM 入口 `katex.render(tex, el)`，
// 它用 createElement / appendChild 建节点、不碰 innerHTML 之类的字符串 sink，
// 所以在 `require-trusted-types-for 'script'` 下是安全的（katex 的 dist 里
// 搜不到任何一个 sink）。渲染组件在 utils/MathNode.tsx，那边有自己的 sink 守卫。
import type MarkdownIt from "markdown-it";
import type { Options as MarkdownItOptions } from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { MathNode } from "./MathNode";
import { MermaidNode } from "./MermaidNode";
import { registerMath } from "./markdownMath";
import { registerMark } from "./markdownMark";
import footnote from "markdown-it-footnote";
import { registerNoteTags } from "./markdownNoteTags";
import { registerWikiLink } from "./noteWikiLink";
import {
    calloutTitleOf,
    calloutTypeOf,
    isFoldType,
    registerCallout,
    type CalloutType,
} from "./markdownCallout";
import { blockIdOf, registerNoteBlocks } from "./markdownNoteBlocks";
import { parseEmbedTarget } from "./noteBlocks";
import { splitFrontMatter, type FrontMatterEntry } from "./noteFrontMatter";
import { NoteEmbedNode, type NoteEmbedTarget } from "../components/NoteEmbedNode";
import { NoteTabsNode } from "../components/NoteTabsNode";

/** 渲染时能被语法引用的外部能力（由页面注入；缺省则相关语法降级） */
export interface RenderContext {
    /** 笔记嵌入 `![[标题]]` 用：按标题找目标笔记 */
    resolveNote?: (title: string) => NoteEmbedTarget | null;
    /** 点嵌入标题时跳到那篇笔记 */
    onOpenNote?: (title: string) => void;
    /** 预览功能开关（设置面板「编辑器」页；不传=全部开启） */
    features?: RenderFeatures;
    /**
     * 预览里点任务复选框 → 回写正文（0 基源码行号）。
     *
     * 没传 = 复选框只读（公开分享页、导出预览都是这个情况）。
     * 调用方负责把行号对应到**当前正在渲染的那份源码**上 ——
     * 嵌入笔记里的复选框看着一样，但它的行号属于被嵌的那篇，
     * 所以渲染层只对**顶层**文档（depth === 0）开放勾选。
     */
    onToggleTask?: (line: number, checked: boolean) => void;
    /**
     * @internal front matter 占掉的行数。
     * `token.map` 是**摘掉 front matter 之后**的行号，回写原材料时要加回这段偏移，
     * 否则带属性的笔记勾选会改到标题行上去。由 renderMarkdownToReact 填，别手填。
     */
    taskLineShift?: number;
}

/** 预览功能开关：inkstone 设置页里的那几项，对应到我们的渲染层 */
export interface RenderFeatures {
    /** 数学公式（关→按普通代码文本显示， KaTeX 不加载） */
    math?: boolean;
    /** Mermaid 图表（关→显示源码块） */
    mermaid?: boolean;
    /** 折叠超过 foldCodeLines 行的代码块 */
    foldCode?: boolean;
    /** 折叠阈值（行数），默认 24 */
    foldCodeLines?: number;
}


/** 延迟加载 markdown-it：它只进懒加载 chunk，不进首屏 */
let parserPromise: Promise<MarkdownIt> | null = null;
function loadParser(): Promise<MarkdownIt> {
    if (!parserPromise) {
        parserPromise = import("markdown-it").then(mod => {
            // markdown-it 是 CJS：default 才是构造器，具名导出是辅助函数
            const Ctor = ((mod as { default?: unknown }).default ?? mod) as new (
                opts: MarkdownItOptions
            ) => MarkdownIt;
            const md = new Ctor({
                // html: false —— 不解析原始 HTML。这是安全上的最后一道闸：
                // 开了它就等于把不可信内容当标签处理，而我们要的正是「只出文本」。
                html: false,
                linkify: true,
                breaks: false,
            });
            // 数学公式语法（$行内$ / $$块级$$）→ 自定义 token，渲染层再认。
            // 注册必须发生在 parse 之前，且整个实例只装一次（parserPromise 缓存了）。
            registerMath(md);
            // 高亮 `==文本==`。⚠️ 不装它的话，工具栏那个高亮按钮「点了没反应」：
            // 插入的 `==…==` 在预览里原样显示成那四个字符，看着像按钮坏了 ——
            // 其实插入是对的，只是没有规则把它变成 <mark>。
            registerMark(md);
            registerNoteTags(md);
            // `[[双链]]` → 可点链接。inkstone 的核心卖点之一，
            // 解析规则在 utils/noteWikiLink.ts（反向链接面板复用同一套判据）。
            registerWikiLink(md);
            // 内容块 `> [!NOTE]`（inkstone 的「内容块」）。注册顺序在 blockquote 之前。
            registerCallout(md);
            // 标签页 / 折叠容器、笔记嵌入、隐藏注释、块 ID（工具栏「插入 / 块」两组）
            registerNoteBlocks(md);
            // 插件提供完整 token 解析；HTML renderer 不调用，下面单独映射 React。
            md.use(footnote as unknown as (parser: MarkdownIt) => void);
            return md;
        });
    }
    return parserPromise;
}

/** 渲染游标：token 流是单向的，靠它一路推进 */
interface Cursor {
    tokens: Token[];
    i: number;
    key: number;
    /** 嵌入深度（防止笔记互相嵌入导致无限递归） */
    depth: number;
    /** 页面注入的外部能力 */
    ctx: RenderContext;
}

function nextKey(c: Cursor): string {
    return `md${c.key++}`;
}

/** 递归渲染用：同样的上下文往下传一层，深度 +1 */
function child(tokens: Token[], c: Cursor, depthOffset = 0): Cursor {
    return { tokens, i: 0, key: c.key++, depth: c.depth + depthOffset, ctx: c.ctx };
}

/** 渲染某段 Markdown 的闭包（给嵌入 / 标签页用） */
function rendererFor(c: Cursor): (source: string, depth: number) => Promise<ReactNode> {
    return (source, depth) => renderMarkdownToReact(source, { ...c.ctx, depth });
}

/**
 * 渲染 Markdown 源码 → React 元素。
 * 异步是因为 markdown-it 走动态 import（必须 lazy，否则进首屏）。
 *
 * @param options.depth  仅供内部递归使用；调用方不用传
 */
export async function renderMarkdownToReact(
    source: string,
    options: RenderContext & { depth?: number } = {}
): Promise<ReactNode> {
    if (!source) return null;
    const md = await loadParser();
    // front matter 在**进解析器之前**摘掉：markdown-it 会把 `---` 那段拆成 hr + 段落，
    // 到 token 层已经看不出它们本来是一块属性了（详见 noteFrontMatter.ts 头注释）。
    const fm = splitFrontMatter(source);
    const depth = options.depth ?? 0;
    const ctx: RenderContext = {
        resolveNote: options.resolveNote,
        onOpenNote: options.onOpenNote,
        features: options.features,
        onToggleTask: options.onToggleTask,
        // 有 front matter 时，正文的行号要整体往后挪（闭线之前那几行）。
        // `token.map` 是相对 `fm.body` 的，回写原材料得加回这段偏移，
        // 否则带属性的笔记勾选会改到标题行上去。
        taskLineShift: fm.bodyOffset
            ? source.slice(0, fm.bodyOffset).split("\n").length - 1
            : 0,
    };
    const tokens = md.parse(fm.body, {});
    const cursor: Cursor = { tokens, i: 0, key: 0, depth, ctx };
    const body = renderBlocks(cursor);
    if (fm.entries.length === 0) return body;
    return (
        <>
            <FrontMatterTable entries={fm.entries} />
            {body}
        </>
    );
}

/** 笔记属性表：inkstone 的「笔记属性（YAML）」。可折叠，默认展开 */
function FrontMatterTable({ entries }: { entries: readonly FrontMatterEntry[] }) {
    return (
        <details data-note-front-matter='1' style={{ margin: "0 0 10px" }}>
            <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>
                属性（{entries.length}）
            </summary>
            <table style={{ ...TABLE_STYLE, fontSize: 13 }}>
                <tbody>
                    {entries.map(e => (
                        <tr key={e.key}>
                            <th style={TH_STYLE}>{e.key}</th>
                            <td style={TD_STYLE}>
                                {e.list?.length
                                    ? e.list.map(t => (
                                          <span key={t} data-inline-tag={t} style={{ marginRight: 6, color: "var(--accent)" }}>
                                              #{t}
                                          </span>
                                      ))
                                    : e.value || "—"}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </details>
    );
}


// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

/** open 标签 → React 组件。link 特殊处理（要带 href），单列在这儿一眼看得全 */
// ⚠️ key 是 markdown-it 的**完整 token 名**（带 _open 后缀），不是去掉后缀的写法。
// 写成 "strong" 的话一个都匹配不上（它给的是 "strong_open"），全落进 span 分支。
const INLINE_TAGS: Record<string, string> = {
    strong_open: "strong",
    em_open: "em",
    s_open: "s",
    mark_open: "mark",
};

/**
 * 行内内容。
 *
 * ⚠️ **必须按 nesting 配对处理**，不能一个 token 一个 token 独立渲染：
 * `strong_open` / `strong_close` 分别是两个 token，中间才是内容。
 * 早先我直接 `children.map()`，结果 strong / em / link **全都渲染不出来**
 * （open/close 都落进了 default 分支，只剩下一堆空 span）。
 */
/** 图片附件是不是「本站那条需要登录的通道」—— 只有这类才值得带凭据重试 */
const isProtectedAttachment = (src: string): boolean =>
    /^\/api\/notes\/attachments\//.test(src);

/**
 * 图片加载结果缓存（2026-10-09 加，模块级 = 跨渲染、跨挂载复用）。
 *
 * 为什么必须有这一层：编辑区的「即时渲染」会把块整块换成 widget，widget 会随
 * 视口进出而被销毁重建。没有缓存时**每重建一次就重走一遍**：
 * 直连 <img> → 失败 → 带凭据 fetch → createObjectURL → 显示 → 卸载时 revoke。
 * 于是同一张图在编辑区里反复「没了又来」，这也是抽动的一部分。
 *
 * 缓存里除了结论还记了**图片的自然尺寸**：下次挂载时直接把 width/height 属性
 * 带上，浏览器按 aspect-ratio 预留出正确高度 —— 图还没解码完，占位高度就已经
 * 是对的，**0 → 300px 的跳变消失**，抖动的幅度也就没了。
 */
interface ImageEntry {
    status: "ok" | "error";
    /** 成功后实际显示的地址：直连成功就是原 src，走 fetch 兜底的就是 objectURL */
    url?: string;
    width?: number;
    height?: number;
    /** 失败原因（会显示在占位上） */
    reason?: string;
}
const imageCache = new Map<string, ImageEntry>();
/** 上限 64 条：笔记里图片不会太多，超了就把最旧的淘汰（blob: 的要 revoke） */
const IMAGE_CACHE_MAX = 64;
function rememberImage(src: string, entry: ImageEntry): ImageEntry {
    const prev = imageCache.get(src);
    imageCache.delete(src);
    imageCache.set(src, entry);
    // LRU 淘汰：只对**被顶掉的** blob: 地址 revoke（缓存里的还在用，不能动）
    while (imageCache.size > IMAGE_CACHE_MAX) {
        const oldestKey = imageCache.keys().next().value as string | undefined;
        if (oldestKey === undefined || oldestKey === src) break;
        const oldest = imageCache.get(oldestKey);
        imageCache.delete(oldestKey);
        if (oldest?.url?.startsWith("blob:")) URL.revokeObjectURL(oldest.url);
    }
    if (prev?.url?.startsWith("blob:") && prev.url !== entry.url) URL.revokeObjectURL(prev.url);
    return entry;
}
/** 测试用：清空图片缓存（用例之间不能互相污染） */
export function resetImageCacheForTests(): void {
    for (const entry of imageCache.values()) {
        if (entry.url?.startsWith("blob:")) URL.revokeObjectURL(entry.url);
    }
    imageCache.clear();
}

/**
 * 预览里的图片（2026-10-08 第二轮，2026-10-09 加缓存与尺寸预留）。
 *
 * 三态，每一态都能在界面上看出来，不再静默空白：
 *  1. 正常：<img src> 直连（最省事，浏览器缓存也照常生效）。
 *  2. 直连失败（onError）且是本站附件 → **带凭据 fetch 一次**，拿到字节转
 *     objectURL 再显示。这条是给用户报的「上传后预览看不见图」兜底：
 *     附件 GET 挂在鉴权后面（worker/routes/data.ts:347），`<img>` 那次请求
 *     在某些部署下带不上会话（自定义域名 + 反代 / cookie 的 Secure 与
 *     SameSite 组合都可能让它变成匿名请求 → 401），而 fetch 显式带
 *     `credentials: "same-origin"` 就一定带得上。
 *     外链图片不做这一步（跨域 fetch 多半反而更糟，直接判失败）。
 *  3. 还是失败 → 虚线占位，**把状态码/原因写出来**，让人一眼看出是
 *     「图没了 / 没权限 / 断网」，而不是渲染层坏了。
 *
 * ⚠️ 结论（含成功用的地址和尺寸）进模块级缓存：编辑区的 widget 反复重建时
 * 不再重新请求、也不再从 0 高度开始撑 —— 这是「图片抽动」的第二半修复，
 * 另一半在 NoteEditorLivePreview 的 ResizeObserver。
 */
function NoteImage({ src, alt }: { src: string; alt: string }) {
    // 初值直接读缓存：命中就能**第一帧**给出正确地址与预留高度
    const [entry, setEntry] = useState<ImageEntry | null>(() => imageCache.get(src) ?? null);

    useEffect(() => {
        setEntry(imageCache.get(src) ?? null);
    }, [src]);

    const remember = (next: ImageEntry) => setEntry(rememberImage(src, next));

    const retryWithCredentials = () => {
        if (!isProtectedAttachment(src)) {
            remember({ status: "error", reason: alt || src });
            return;
        }
        void (async () => {
            try {
                const response = await fetch(src, { credentials: "same-origin" });
                if (!response.ok) {
                    remember({ status: "error", reason: `${alt || src}（服务器返回 ${response.status}）` });
                    return;
                }
                const blob = await response.blob();
                // 401 的登录页 / SPA 兜底也是 200，但类型是 text/html —— 别当图显示
                if (!blob.type.startsWith("image/")) {
                    remember({ status: "error", reason: `${alt || src}（返回的不是图片：${blob.type || "未知类型"}）` });
                    return;
                }
                remember({ status: "ok", url: URL.createObjectURL(blob) });
            } catch {
                remember({ status: "error", reason: `${alt || src}（网络请求失败）` });
            }
        })();
    };

    if (entry?.status === "error") {
        return (
            <span
                data-image-failed='1'
                style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    maxWidth: "100%",
                    padding: "6px 10px",
                    border: "1px dashed rgba(128,128,128,0.5)",
                    borderRadius: 6,
                    fontSize: 12,
                    color: "rgba(128,128,128,0.9)",
                }}
            >
                ⚠️ 图片加载失败：{entry.reason}
            </span>
        );
    }
    const size = entry?.status === "ok" ? entry : null;
    return (
        <img
            src={entry?.status === "ok" && entry.url ? entry.url : src}
            alt={alt}
            loading='lazy'
            // ⚠️ 有缓存尺寸就带上：浏览器据此推出 aspect-ratio 并预留高度，
            // 图还没解码完也不会先塌成 0 再撑开（塌缩→撑开正是抖动的幅度来源）
            width={size?.width}
            height={size?.height}
            onLoad={event => {
                const img = event.currentTarget;
                if (entry?.status === "ok" && entry.width && entry.height) return;
                remember({
                    status: "ok",
                    url: entry?.url ?? src,
                    width: img.naturalWidth || undefined,
                    height: img.naturalHeight || undefined,
                });
            }}
            onError={() => {
                // 已经在用缓存地址还失败 → 图确实没了，别再循环重试
                if (entry?.status === "ok" && entry.url && entry.url !== src) {
                    remember({ status: "error", reason: alt || src });
                    return;
                }
                retryWithCredentials();
            }}
            style={{ maxWidth: "100%", height: "auto", borderRadius: 4 }}
        />
    );
}

function renderInline(children: Token[] | null, c: Cursor): ReactNode {
    if (!children || children.length === 0) return null;
    const out: ReactNode[] = [];
    // 栈：每层记「用什么标签包、里面已经攒了什么」
    const stack: Array<{ tag: string; href?: string; kids: ReactNode[] }> = [];

    const emit = (node: ReactNode) => {
        const top = stack[stack.length - 1];
        if (top) top.kids.push(node);
        else out.push(node);
    };
    /** 把栈顶那一层封成一个元素并交给上一层 */
    const seal = (): ReactNode | null => {
        const frame = stack.pop();
        if (!frame) return null;
        const key = nextKey(c);
        if (frame.tag === "a") {
            const href = frame.href || "";
            if (!/^(https?:|mailto:|#|\/)/i.test(href)) {
                // 危险协议（javascript: / data: …）降级成纯文本，不给可点击的 <a>
                return <span key={key}>{frame.kids}</span>;
            }
            const external = /^https?:/i.test(href);
            return (
                <a
                    key={key}
                    href={href}
                    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                >
                    {frame.kids}
                </a>
            );
        }
        const Tag = frame.tag as "strong";
        return (
            <Tag key={key} style={frame.tag === "mark" ? MARK_STYLE : undefined}>
                {frame.kids}
            </Tag>
        );
    };

    for (const tok of children) {
        if (tok.nesting === 1) {
            if (tok.type === "link_open") {
                stack.push({
                    tag: "a",
                    href: tok.attrGet("href") || "",
                    kids: [],
                });
            } else {
                stack.push({ tag: INLINE_TAGS[tok.type] ?? "span", kids: [] });
            }
            continue;
        }
        if (tok.nesting === -1) {
            const node = seal();
            if (node) emit(node);
            continue;
        }
        emit(renderLeaf(tok, c));
    }
    // 有未闭合的（不该出现，但不能因此吞掉内容）
    while (stack.length) {
        const node = seal();
        if (node) emit(node);
    }
    return out;
}

/** 不需要配对的叶子 token：文本 / 行内代码 / 换行 / 图片 */
function renderLeaf(tok: Token, c: Cursor): ReactNode {
    const key = nextKey(c);
    switch (tok.type) {
        case "note_tag":
            return <span key={key} data-inline-tag={tok.content} title="双击查看标签笔记"
                style={{ color: "var(--accent)", cursor: "pointer" }}>#{tok.content}</span>;
        // `[[双链]]` / `[[目标|显示名]]`：整篇预览的点击事件由 NotesPage 委托处理
        // （按 data-wiki-link 找目标 —— 永远是**目标名**，别名只管显示），
        // 这里只负责语义与外观。用 <a> 而不是 <span>：读屏会念「链接」，
        // 而且点不动时（目标不存在）样式能明显区分。
        case "wiki_link": {
            const alias = (tok.meta as { alias?: string } | undefined)?.alias;
            return (
                <a key={key} data-wiki-link={tok.content}
                    title={`跳到「${tok.content}」`}
                    style={{ color: "var(--accent)", textDecoration: "underline" }}>
                    {alias || tok.content}
                </a>
            );
        }
        // 笔记嵌入 `![[标题]]` / 块引用 `[[笔记#^块ID]]` / 标题锚点 `![[笔记#某标题]]`（带 `!` 的那种）。
        // 独立组件：内容要再跑一遍渲染（异步），synchronous 的映射函数做不了。
        case "note_embed": {
            const { title, blockId, heading } = parseEmbedTarget(tok.content);
            if (!c.ctx.resolveNote) {
                return (
                    <span key={key} data-note-embed-missing={title} style={{ opacity: 0.7 }}>
                        {title}
                    </span>
                );
            }
            return (
                <NoteEmbedNode
                    key={key}
                    title={title}
                    blockId={blockId}
                    heading={heading}
                    depth={c.depth}
                    resolve={c.ctx.resolveNote}
                    render={rendererFor(c)}
                    onOpen={t => c.ctx.onOpenNote?.(t)}
                />
            );
        }
        // 隐藏注释 `%%…%%`：源码里留着，预览里不显示。
        // 渲染成 null 而不是空 span —— 空 span 会在「两段文字之间」留一个无意义的位置。
        case "note_hidden":
            return null;
        case "footnote_ref": {
            const { id, subId } = tok.meta as { id: number; subId: number };
            return <sup key={key} id={`note-fnref-${id}-${subId}`}><a href={`#note-fn-${id}`} aria-label={`脚注 ${id + 1}`}>[{id + 1}]</a></sup>;
        }
        case "footnote_anchor": {
            const { id, subId } = tok.meta as { id: number; subId: number };
            return <a key={key} href={`#note-fnref-${id}-${subId}`} aria-label={`返回脚注 ${id + 1} 引用`}> ↩</a>;
        }
        case "text":
            return <span key={key}>{tok.content}</span>;
        case "code_inline":
            return (
                <code key={key} style={INLINE_CODE}>
                    {tok.content}
                </code>
            );
        case "softbreak":
        case "hardbreak":
            return <br key={key} />;
        // 公式：内容原样交给 KaTeX 那层（它会自己异步把节点挂进这个 span）。
        // 设置里关掉数学公式时按普通代码文本显示（把定界符补回来）。
        case "math_inline":
            if (c.ctx.features?.math === false) {
                return <code key={key} style={INLINE_CODE}>{`$${tok.content}$`}</code>;
            }
            return <MathNode key={key} tex={tok.content} />;
        // 高亮 `==文本==`。用语义标签 <mark> 而不是 <span style>：
        // 读屏软件会念「高亮」，而且浏览器里 ⌘F 搜内容时黄色底也还在。
        case "mark_inline":
            return (
                <mark
                    key={key}
                    style={{
                        background: "rgba(250, 204, 21, 0.38)",
                        color: "inherit",
                        borderRadius: 2,
                        padding: "0 2px",
                    }}
                >
                    {tok.content}
                </mark>
            );
        case "image": {
            const src = tok.attrGet("src") || "";
            // 只放行 http(s)、内联图片与**本站附件**，其余当文本 —— 与链接同一把尺子。
            // ⚠️ `/api/notes/attachments/...` 是上传图片落进正文的形式（2026-07 批次），
            // 之前没放行 → 预览里整张图变成一行 alt 文本（2026-10-08 用户报
            // 「上传图片后预览窗看不见图片」）。同源相对路径在 <img> 上会自动带上
            // 登录 cookie（鉴权走 httpOnly cookie，GET 无 CSRF 问题），安全尺子不变。
            // ⚠️ `/api/note-shares/attachments/...` 是**公开分享页**那条免鉴权通道
            // （2026-10-08 补）：匿名访客没有登录 cookie，不能走上面那条；后端只放行
            // 「属于一条当前有效分享」的附件，所以尺子依然收紧。
            if (!/^(https?:|\/api\/(notes|note-shares)\/attachments\/|data:image\/(png|jpe?g|gif|webp);|blob:)/i.test(src)) {
                return <span key={key}>{tok.content}</span>;
            }
            return <NoteImage key={key} src={src} alt={tok.content || ""} />;
        }
        case "html_inline":
        case "html_block":
            // html: false 时不会出现；真出现了也只当纯文本
            return <span key={key}>{tok.content}</span>;
        default:
            return <span key={key}>{tok.content}</span>;
    }
}

// ---------------------------------------------------------------------------
// 块级
// ---------------------------------------------------------------------------

function renderBlocks(c: Cursor): ReactNode[] {
    const out: ReactNode[] = [];
    while (c.i < c.tokens.length) {
        const tok = c.tokens[c.i];
        const key = nextKey(c);

        switch (tok.type) {
            case "footnote_block_open": {
                c.i++;
                const inner = takeUntilClose(c, "footnote_block_open", "footnote_block_close");
                out.push(<section key={key} aria-label='脚注' style={{ borderTop: "1px solid rgba(128,128,128,.3)", marginTop: 20 }}><ol>{renderBlocks(child(inner, c))}</ol></section>);
                break;
            }
            case "footnote_open": {
                const { id } = tok.meta as { id: number };
                c.i++;
                const inner = takeUntilClose(c, "footnote_open", "footnote_close");
                out.push(<li key={key} id={`note-fn-${id}`}>{renderBlocks(child(inner, c))}</li>);
                break;
            }
            case "footnote_anchor":
                out.push(renderLeaf(tok, c));
                c.i++;
                break;
            case "heading_open": {
                const level = Number(tok.tag.replace("h", "")) || 1;
                const Tag = (`h${Math.min(6, Math.max(1, level))}` as unknown) as "h2";
                const anchor = anchorProps(tok);
                c.i++; // 跳过 open
                const inline = c.tokens[c.i];
                c.i++; // 跳过 inline
                out.push(
                    <Tag key={key} {...anchor}>
                        {renderInline(inline?.children, c)}
                    </Tag>
                );
                break;
            }
            case "paragraph_open": {
                const anchor = anchorProps(tok);
                c.i++;
                const inline = c.tokens[c.i];
                c.i++;
                out.push(
                    <p key={key} {...anchor}>
                        {renderInline(inline?.children, c)}
                    </p>
                );
                break;
            }
            case "note_container": {
                // `:::tabs` 标签页。正文要再跑一遍渲染（异步），所以交给组件。
                const arg = (tok.meta as { arg?: string } | null)?.arg ?? "";
                c.i++;
                out.push(
                    <NoteTabsNode
                        key={key}
                        body={tok.content}
                        arg={arg}
                        depth={c.depth + 1}
                        render={rendererFor(c)}
                    />
                );
                break;
            }
            case "bullet_list_open":
            case "ordered_list_open": {
                const ordered = tok.type === "ordered_list_open";
                const start = ordered ? Number(tok.attrGet("start") || 1) : undefined;
                c.i++;
                const items: ReactNode[] = [];
                while (c.i < c.tokens.length && c.tokens[c.i].type !== `${ordered ? "ordered" : "bullet"}_list_close`) {
                    if (c.tokens[c.i].type === "list_item_open") {
                        // 行号留给任务复选框回写：`list_item_open` 上带的 map[0] 就是这一项
                        // 在源码里的起始行（0 基）。往下传给 renderListItemBody。
                        const itemLine = c.tokens[c.i].map?.[0];
                        const body = takeListItem(c);
                        items.push(
                            <li key={`${key}-${items.length}`} style={LI_STYLE}>
                                {renderListItemBody(body, c, itemLine)}
                            </li>
                        );
                    } else {
                        c.i++;
                    }
                }
                c.i++; // 吃掉 close
                const Tag = ordered ? "ol" : "ul";
                out.push(
                    <Tag key={key} style={LIST_STYLE} {...(start ? { start } : {})}>
                        {items}
                    </Tag>
                );
                break;
            }
            case "callout_open": {
                // 内容块（`> [!NOTE]` 这类）：靠 callout_open/close 包住整块引用。
                // 里面的 blockquote_open 仍会正常渲染成引用块（左侧竖线保留），
                // 这里只加外层的图标、底色与左侧色条。
                const type = calloutTypeOf(tok.meta) ?? "NOTE";
                const palette = CALLOUT_STYLE[type];
                // ⚠️ 必须先 c.i++ 再取内容：takeUntilClose 假定「已经站在 open 之后」，
                //   深度从 1 起算。漏掉这一行的话它会**再读到自己的 open**，
                //   深度变成 2、永远归不了零 → 把后面所有 token（含自己）都吞进去
                //   → 递归渲染自己 → Maximum call stack size exceeded，
                //   整个预览区一起崩（实测：双链也跟着消失了）。
                c.i++;
                const inner = takeUntilClose(c, "callout_open", "callout_close");
                if (isFoldType(type)) {
                    // 折叠块：用原生 <details>（可展开收起，且天然带无障碍语义）。
                    // 首行标题在解析层就摘走了（markdownCallout.takeMarker）。
                    out.push(
                        <details key={key} data-callout='FOLD' style={FOLD_STYLE}>
                            <summary style={FOLD_SUMMARY_STYLE}>
                                {calloutTitleOf(tok.meta) || "展开"}
                            </summary>
                            <div style={{ paddingTop: 6 }}>{renderBlocks(child(inner, c))}</div>
                        </details>
                    );
                    break;
                }
                out.push(
                    // ⚠️ 用原生 div/span + inline style：这个文件全程不引 MUI
                    // （见文件头「为什么不用 renderer」的同款理由），
                    // 引进来的话 markdown 懒加载块会拖上整个 MUI。
                    <div
                        key={key}
                        data-callout={type}
                        style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "flex-start",
                            margin: "0.6em 0",
                            padding: "8px 12px",
                            borderRadius: 6,
                            borderLeft: `3px solid ${palette.border}`,
                            background: palette.bg,
                            color: palette.fg,
                        }}
                    >
                        <span aria-hidden style={{ fontSize: 14, lineHeight: 1.7 }}>
                            {palette.icon}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            {renderBlocks(child(inner, c))}
                        </div>
                    </div>
                );
                break;
            }
            case "callout_close":
                // 内容在 callout_open 时已经一次性取走了，这里不重复渲染
                c.i++;
                break;
            case "blockquote_open": {
                c.i++;
                const inner = takeUntilClose(c, "blockquote_open", "blockquote_close");
                out.push(
                    <blockquote key={key} style={QUOTE_STYLE}>
                        {renderBlocks(child(inner, c))}
                    </blockquote>
                );
                break;
            }
            case "fence":
            case "code_block": {
                const lang = (tok.info || "").trim().split(/\s+/)[0];
                // 设置里关掉图表：Mermaid 源码按普通代码块显示
                if (lang.toLowerCase() === "mermaid" && c.ctx.features?.mermaid !== false) {
                    out.push(<MermaidNode key={`${key}:${tok.content}`} source={tok.content} />);
                    c.i++;
                    break;
                }
                const codeEl = (
                    <pre key={key} style={PRE_STYLE}>
                        <code {...(lang ? { 'data-lang': lang } : {})} style={CODE_STYLE}>
                            {tok.content}
                        </code>
                    </pre>
                );
                // 折叠较长的代码块（inkstone「折叠较长的代码块」）：超过阈值的
                // 默认只露 summary，点开看全文。阈值 0/负数视为不折叠。
                const foldLines = c.ctx.features?.foldCodeLines ?? 24;
                if (c.ctx.features?.foldCode && foldLines > 0) {
                    const lineCount = tok.content.split("\n").length;
                    if (lineCount > foldLines) {
                        out.push(
                            <details key={key} data-code-fold='1' style={{ margin: "8px 0" }}>
                                <summary
                                    style={{
                                        cursor: "pointer",
                                        fontSize: 12,
                                        color: "text.secondary" as const,
                                        userSelect: "none" as const,
                                    }}
                                >
                                    代码块（{lineCount} 行，点击展开）
                                </summary>
                                {codeEl}
                            </details>
                        );
                        c.i++;
                        break;
                    }
                }
                out.push(codeEl);
                c.i++;
                break;
            }
            case "hr":
                out.push(<hr key={key} style={HR_STYLE} />);
                c.i++;
                break;
            case "math_block": {
                // 块级公式独占一块：居中 + 可横向滚动（超宽的公式不能把预览挤歪）。
                // 设置里关掉数学公式时按普通代码文本显示。
                if (c.ctx.features?.math === false) {
                    out.push(
                        <pre key={key} style={PRE_STYLE}>
                            <code style={CODE_STYLE}>{`$$\n${tok.content}\n$$`}</code>
                        </pre>
                    );
                    c.i++;
                    break;
                }
                out.push(
                    <div
                        key={key}
                        style={{
                            margin: "10px 0",
                            textAlign: "center",
                            overflowX: "auto",
                        }}
                    >
                        <MathNode tex={tok.content} block />
                    </div>
                );
                c.i++;
                break;
            }
            case "table_open": {
                c.i++;
                const inner = takeUntilClose(c, "table_open", "table_close");
                out.push(
                    <table key={key} style={TABLE_STYLE}>
                        {renderBlocks(child(inner, c))}
                    </table>
                );
                break;
            }
            case "tr_open": {
                c.i++;
                const inner = takeUntilClose(c, "tr_open", "tr_close");
                out.push(
                    <tr key={key}>{renderBlocks(child(inner, c))}</tr>
                );
                break;
            }
            case "th_open":
            case "td_open": {
                const isTh = tok.type === "th_open";
                c.i++;
                const inline = c.tokens[c.i];
                c.i++;
                const Tag = isTh ? "th" : "td";
                out.push(
                    <Tag key={key} style={isTh ? TH_STYLE : TD_STYLE}>
                        {renderInline(inline?.children, c)}
                    </Tag>
                );
                break;
            }
            default:
                // 未知 token 跳过（而不是把 content 当文本，避免嵌套结构重复出现）
                c.i++;
                break;
        }
    }
    return out;
}

/**
 * 任务列表：markdown-it 默认把 `- [ ] x` 解析成
 * `list_item → paragraph → "[ ] x"`，所以要在渲染段落时识别这个前缀。
 * 自己实现而不是用 markdown-it-task-lists（那个插件注册的是 renderer，token 流下无效）。
 */
function renderListItemBody(body: Token[], c: Cursor, itemLine?: number): ReactNode {
    const sub: Cursor = child(body, c);
    if (body.length >= 2 && body[0].type === "paragraph_open") {
        const inline = body[1];
        if (inline?.type === "inline") {
            const m = /^\[([ xX])\]\s+/.exec(inline.content);
            if (m) {
                const checked = m[1].toLowerCase() === "x";
                const rest = inline.content.slice(m[0].length);
                sub.i = 2; // 跳过 paragraph_open + inline
                // ⚠️ 只有**顶层文档**（depth === 0）的复选框才回写。
                // 嵌入 / 标签页里的内容行号属于被嵌的那篇（而且还被 slice 过），
                // 拿它去改当前笔记的正文会把无关的行改坏 —— inkstone 同样是
                // 「`.note-embed-body` 内只读」。
                const line =
                    c.depth === 0 && c.ctx.onToggleTask
                        ? (body[0].map?.[0] ?? itemLine ?? -1) + (c.ctx.taskLineShift ?? 0)
                        : -1;
                const editable = line >= 0;
                return (
                    <span style={TASK_ROW}>
                        <input
                            type='checkbox'
                            checked={checked}
                            aria-label={checked ? "已完成" : "未完成"}
                            {...(editable
                                ? {
                                      "data-task-line": String(line),
                                      onChange: (e: ChangeEvent<HTMLInputElement>) =>
                                          c.ctx.onToggleTask?.(line, e.target.checked),
                                  }
                                : { readOnly: true })}
                            style={editable ? { ...CHECKBOX, cursor: "pointer" } : CHECKBOX}
                        />
                        <span>{renderInlineInline(inline.children, rest, sub)}</span>
                    </span>
                );
            }
        }
    }
    return renderBlocks(sub);
}

/** 任务项里：第一个 text token 整段就是 "[ ] 内容"，前缀已切掉，所以只渲染剩下的部分 */
function renderInlineInline(
    children: Token[] | null,
    rest: string,
    c: Cursor
): ReactNode {
    if (!children || children.length === 0) return rest;
    return (
        <>
            {rest}
            {renderInline(children.slice(1), c)}
        </>
    );
}

/** 取一个 list_item 的内容（到配对 list_item_close），并消耗掉它 */
function takeListItem(c: Cursor): Token[] {
    const body: Token[] = [];
    let depth = 0;
    while (c.i < c.tokens.length) {
        const t = c.tokens[c.i];
        if (t.type === "list_item_open") depth++;
        else if (t.type === "list_item_close") {
            depth--;
            if (depth === 0) {
                c.i++;
                break;
            }
        } else {
            body.push(t);
        }
        c.i++;
    }
    return body;
}

/**
 * 从当前位置取到配对 close 的内容（不含 close），并消耗 close。
 *
 * ⚠️ 深度**从 1 起算** —— 调用方已经 `c.i++` 吃掉了 open。
 * 从 0 起算的话，第一个内容 token（depth 仍是 0）会被 `depth >= 1` 挡掉，
 * 整个 blockquote / 表格的内容就没了（症状：引用与表格渲染成空）。
 */
function takeUntilClose(c: Cursor, openType: string, closeType: string): Token[] {
    const body: Token[] = [];
    let depth = 1;
    while (c.i < c.tokens.length) {
        const t = c.tokens[c.i];
        if (t.type === openType) depth++;
        else if (t.type === closeType) {
            depth--;
            if (depth === 0) {
                c.i++;
                break;
            }
        }
        body.push(t);
        c.i++;
    }
    return body;
}

const MARK_STYLE: React.CSSProperties = {
    background: "rgba(250, 204, 21, 0.35)",
    color: "inherit",
    padding: "0 2px",
};
const INLINE_CODE: React.CSSProperties = {
    background: "rgba(128,128,128,0.18)",
    borderRadius: 4,
    padding: "1px 5px",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.9em",
};
const PRE_STYLE: React.CSSProperties = {
    background: "rgba(128,128,128,0.14)",
    borderRadius: 8,
    padding: 12,
    overflowX: "auto",
    margin: "8px 0",
};
const CODE_STYLE: React.CSSProperties = {
    fontFamily: "ui-monospace, monospace",
    fontSize: 13,
    lineHeight: 1.6,
};
const LIST_STYLE: React.CSSProperties = { margin: "8px 0", paddingLeft: 22 };
const LI_STYLE: React.CSSProperties = { margin: "2px 0" };
/** 内容块配色。深浅色都用半透明色，跟随主题走，不需要单独切 dark 模式。 */
const CALLOUT_STYLE: Record<CalloutType, { border: string; bg: string; fg: string; icon: string }> = {
    NOTE: { border: "#3b82f6", bg: "rgba(59,130,246,0.10)", fg: "inherit", icon: "ℹ" },
    TIP: { border: "#10b981", bg: "rgba(16,185,129,0.10)", fg: "inherit", icon: "💡" },
    IMPORTANT: { border: "#8b5cf6", bg: "rgba(139,92,246,0.10)", fg: "inherit", icon: "❗" },
    WARNING: { border: "#f59e0b", bg: "rgba(245,158,11,0.12)", fg: "inherit", icon: "⚠" },
    QUOTE: { border: "rgba(128,128,128,0.6)", bg: "rgba(128,128,128,0.08)", fg: "inherit", icon: "❝" },
    // FOLD 走 <details> 分支，palette 不会被读到；放这里只为满足类型完整性
    FOLD: { border: "rgba(128,128,128,0.6)", bg: "transparent", fg: "inherit", icon: "▸" },
};

const QUOTE_STYLE: React.CSSProperties = {
    borderLeft: "3px solid rgba(128,128,128,0.45)",
    margin: "8px 0",
    paddingLeft: 12,
    color: "inherit",
    opacity: 0.9,
};
const HR_STYLE: React.CSSProperties = { border: "none", borderTop: "1px solid rgba(128,128,128,0.3)", margin: "12px 0" };
/** 折叠块（`> [!FOLD]`）：原生 details，展开/收起交给浏览器 */
const FOLD_STYLE: React.CSSProperties = {
    margin: "0.6em 0",
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid rgba(128,128,128,0.3)",
    background: "rgba(128,128,128,0.05)",
};
const FOLD_SUMMARY_STYLE: React.CSSProperties = {
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 600,
    listStyle: "revert",
};

/**
 * 块 ID → 锚点属性。
 *
 * 块 ID（行尾 `^id`）的唯一用途是**被引用**（`![[笔记#^id]]`），
 * 而引用是靠标题名找笔记、再按 ID 裁内容（NoteEmbedNode.sliceBlock），
 * 不依赖 DOM 里的 id 属性。所以这里**不**往元素上写 `id=`：
 * 同一篇里两个块用同一个 ID 很常见，写了就会在 DOM 里撞出重复 id，
 * 而页面里恰好有别的锚点跳转逻辑（大纲/脚注回跳），撞了就是「点大纲跳错地方」。
 */
/**
 * 块级 token 的公共属性。
 *
 * ⚠️ `data-line` 是**滚动同步锚点**（2026-10-17 对齐 inkstone 的
 * `previewSourceAnchors`，features/preview/preview-anchors.ts）：
 * 它记下「这个预览块对应源码的第几行」。滚动同步据此按**行**定位，
 * 而不是按百分比 —— 百分比在两栏长度不同时必然漂移
 * （真机量到一篇文章里源码 2722px / 预览 2174px，长度差 20%，
 * 滚到中间时两边已经对不上是第几段了）。
 *
 * inkstone 靠 markdown-it 的 `token.map`（源码行号数组）拿这个值；
 * 我们 markdown-it 也开着 map，但 `anchorProps` 之前只取 blockId，
 * 这里补上 line。拿不到时返回 undefined（同步会自动退回比例兜底）。
 */
function anchorProps(tok: Token): { "data-block-id"?: string; "data-line"?: number } {
    const props: { "data-block-id"?: string; "data-line"?: number } = {};
    const blockId = blockIdOf(tok.meta);
    if (blockId) props["data-block-id"] = blockId;
    // token.map = [起始行, 结束行]（0 基）。块级 token 一定有 map；
    // inline token 没有（它们不是块）。
    const line = Array.isArray(tok.map) ? tok.map[0] : undefined;
    if (typeof line === "number" && Number.isInteger(line) && line >= 0) {
        props["data-line"] = line;
    }
    return props;
}
const TABLE_STYLE: React.CSSProperties = {
    borderCollapse: "collapse",
    margin: "8px 0",
    maxWidth: "100%",
    display: "block",
    overflowX: "auto",
};
const TH_STYLE: React.CSSProperties = {
    border: "1px solid rgba(128,128,128,0.35)",
    padding: "6px 10px",
    textAlign: "left",
    background: "rgba(128,128,128,0.12)",
};
const TD_STYLE: React.CSSProperties = {
    border: "1px solid rgba(128,128,128,0.35)",
    padding: "6px 10px",
};
const TASK_ROW: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 6 };
const CHECKBOX: React.CSSProperties = { marginTop: 4, flexShrink: 0 };
