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
// Mermaid、原始 HTML 依旧不做（理由同上）。
//
// 公式（KaTeX）**做**，2026-10-05 改：KaTeX 支持 DOM 入口 `katex.render(tex, el)`，
// 它用 createElement / appendChild 建节点、不碰 innerHTML 之类的字符串 sink，
// 所以在 `require-trusted-types-for 'script'` 下是安全的（katex 的 dist 里
// 搜不到任何一个 sink）。渲染组件在 utils/MathNode.tsx，那边有自己的 sink 守卫。
import type MarkdownIt from "markdown-it";
import type { Options as MarkdownItOptions } from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { ReactNode } from "react";
import { MathNode } from "./MathNode";
import { registerMath } from "./markdownMath";
import { registerMark } from "./markdownMark";

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
}

function nextKey(c: Cursor): string {
    return `md${c.key++}`;
}

/**
 * 渲染 Markdown 源码 → React 元素。
 * 异步是因为 markdown-it 走动态 import（必须 lazy，否则进首屏）。
 */
export async function renderMarkdownToReact(source: string): Promise<ReactNode> {
    if (!source) return null;
    const md = await loadParser();
    const tokens = md.parse(source, {});
    const cursor: Cursor = { tokens, i: 0, key: 0 };
    return renderBlocks(cursor);
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
        // 公式：内容原样交给 KaTeX 那层（它会自己异步把节点挂进这个 span）
        case "math_inline":
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
            // 只放行 http(s) 与内联图片，其余当文本 —— 与链接同一把尺子
            if (!/^(https?:|data:image\/(png|jpe?g|gif|webp);|blob:)/i.test(src)) {
                return <span key={key}>{tok.content}</span>;
            }
            return <img key={key} src={src} alt={tok.content || ""} loading='lazy' />;
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
            case "heading_open": {
                const level = Number(tok.tag.replace("h", "")) || 1;
                const Tag = (`h${Math.min(6, Math.max(1, level))}` as unknown) as "h2";
                c.i++; // 跳过 open
                const inline = c.tokens[c.i];
                c.i++; // 跳过 inline
                out.push(<Tag key={key}>{renderInline(inline?.children, c)}</Tag>);
                break;
            }
            case "paragraph_open": {
                c.i++;
                const inline = c.tokens[c.i];
                c.i++;
                out.push(<p key={key}>{renderInline(inline?.children, c)}</p>);
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
                        const body = takeListItem(c);
                        items.push(
                            <li key={`${key}-${items.length}`} style={LI_STYLE}>
                                {renderListItemBody(body, c)}
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
            case "blockquote_open": {
                c.i++;
                const inner = takeUntilClose(c, "blockquote_open", "blockquote_close");
                out.push(
                    <blockquote key={key} style={QUOTE_STYLE}>
                        {renderBlocks({ tokens: inner, i: 0, key: c.key++ })}
                    </blockquote>
                );
                break;
            }
            case "fence":
            case "code_block": {
                const lang = (tok.info || "").trim().split(/\s+/)[0];
                out.push(
                    <pre key={key} style={PRE_STYLE}>
                        <code {...(lang ? { 'data-lang': lang } : {})} style={CODE_STYLE}>
                            {tok.content}
                        </code>
                    </pre>
                );
                c.i++;
                break;
            }
            case "hr":
                out.push(<hr key={key} style={HR_STYLE} />);
                c.i++;
                break;
            case "math_block": {
                // 块级公式独占一块：居中 + 可横向滚动（超宽的公式不能把预览挤歪）
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
                        {renderBlocks({ tokens: inner, i: 0, key: c.key++ })}
                    </table>
                );
                break;
            }
            case "tr_open": {
                c.i++;
                const inner = takeUntilClose(c, "tr_open", "tr_close");
                out.push(
                    <tr key={key}>{renderBlocks({ tokens: inner, i: 0, key: c.key++ })}</tr>
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
function renderListItemBody(body: Token[], c: Cursor): ReactNode {
    const sub: Cursor = { tokens: body, i: 0, key: c.key++ };
    if (body.length >= 2 && body[0].type === "paragraph_open") {
        const inline = body[1];
        if (inline?.type === "inline") {
            const m = /^\[([ xX])\]\s+/.exec(inline.content);
            if (m) {
                const checked = m[1].toLowerCase() === "x";
                const rest = inline.content.slice(m[0].length);
                sub.i = 2; // 跳过 paragraph_open + inline
                return (
                    <span style={TASK_ROW}>
                        <input
                            type='checkbox'
                            checked={checked}
                            readOnly
                            aria-label={checked ? "已完成" : "未完成"}
                            style={CHECKBOX}
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
const QUOTE_STYLE: React.CSSProperties = {
    borderLeft: "3px solid rgba(128,128,128,0.45)",
    margin: "8px 0",
    paddingLeft: 12,
    color: "inherit",
    opacity: 0.9,
};
const HR_STYLE: React.CSSProperties = { border: "none", borderTop: "1px solid rgba(128,128,128,0.3)", margin: "12px 0" };
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
