// src/components/NoteEmbedNode.tsx
// 笔记嵌入 `![[目标笔记]]` 的渲染体。
//
// 为什么要单独一个组件：嵌入的内容要**再跑一遍 Markdown 渲染**，那是异步的
// （markdown-it 走动态 import）。渲染函数本身是纯的 synchronous 映射，
// 塞不进这种「等它解析完」的逻辑，只能交给组件。
//
// ⚠️ 递归深度必须有上限：两篇笔记互相嵌入是能写出来的，
// 不限深度就是无限递归 → 栈溢出 → 整个预览区崩掉（连带同页其它内容一起没了）。
// 超深的嵌入降级成一条「（嵌套过深）」的提示，不是白屏。
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** 超过这个层数就不往下钻了 */
export const MAX_EMBED_DEPTH = 3;

export interface NoteEmbedTarget {
    title: string;
    content: string;
}

export function NoteEmbedNode({
    title,
    blockId,
    heading,
    depth,
    resolve,
    render,
    onOpen,
}: {
    title: string;
    blockId: string | null;
    /** N7 标题锚点：`![[笔记#某标题]]` —— 嵌入该标题的区段（到下一个同级/更高级标题为止） */
    heading?: string | null;
    depth: number;
    /** 按标题找目标笔记；找不到返回 null */
    resolve: (title: string) => NoteEmbedTarget | null;
    /** 渲染一段 Markdown（由 markdownToReact 传进来的闭包，避免循环 import） */
    render: (source: string, depth: number) => Promise<ReactNode>;
    /** 点标题跳到那篇笔记 */
    onOpen: (title: string) => void;
}) {
    const [body, setBody] = useState<ReactNode | null>(null);
    const [state, setState] = useState<"loading" | "ok" | "missing">("loading");

    useEffect(() => {
        if (depth > MAX_EMBED_DEPTH) return;
        const target = resolve(title);
        if (!target) {
            setState("missing");
            return;
        }
        // 只嵌入被点名的那一块（`![[笔记#^块ID]]` / `![[笔记#某标题]]`），否则整篇塞进来
        const source = blockId
            ? sliceBlock(target.content, blockId)
            : heading
                ? sliceHeading(target.content, heading)
                : target.content;
        let alive = true;
        void render(source, depth + 1).then(node => {
            if (!alive) return;
            setBody(node);
            setState("ok");
        });
        return () => {
            alive = false;
        };
    }, [title, blockId, heading, depth, resolve, render]);

    return (
        <div
            data-note-embed={title}
            style={{
                margin: "8px 0",
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(128,128,128,0.3)",
                background: "rgba(128,128,128,0.05)",
            }}
        >
            <button
                type="button"
                onClick={() => onOpen(title)}
                style={{
                    all: "unset",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--accent)",
                    display: "block",
                    marginBottom: 4,
                }}
            >
                {blockId ? `${title} #${blockId}` : heading ? `${title} › ${heading}` : title}
            </button>
            {depth > MAX_EMBED_DEPTH ? (
                <div style={{ fontSize: 13, opacity: 0.7 }}>（嵌套过深，已停止展开）</div>
            ) : state === "missing" ? (
                <div style={{ fontSize: 13, opacity: 0.7 }}>（找不到笔记「{title}」）</div>
            ) : state === "loading" ? (
                <div style={{ fontSize: 13, opacity: 0.5 }}>加载中…</div>
            ) : (
                <div style={{ fontSize: 14 }}>{body}</div>
            )}
        </div>
    );
}

/**
 * 从一篇笔记里裁出 `^blockId` 那一块。
 *
 * 判据：块 ID 在源码里是**行尾**的 ` ^id`（markdownNoteBlocks 摘的就是这个形态），
 * 所以按行找结尾匹配的那行，取它所属的块 —— 段落就是到空行为止，
 * 列表项/引用块则连带上层的 `>`、`- ` 前缀一起带上（不然嵌进来是散句）。
 * 找不到就退回整篇（宁可多给内容，也不要给一块空的）。
 */
export function sliceBlock(source: string, blockId: string): string {
    const lines = source.split("\n");
    const idx = lines.findIndex(l => new RegExp(`\\s\\^${escapeRe(blockId)}\\s*$`).test(l));
    if (idx < 0) return source;

    // 往上吃掉连续的引用 / 列表前缀行（它们是同一个块的一部分）
    let start = idx;
    while (start > 0 && /^(\s*(?:>\s*)?(?:[-*+]\s+|\d+\.\s+))/.test(lines[start - 1])) start--;

    // 往下吃到空行 / 下一个块 ID 行为止
    let end = idx;
    while (end + 1 < lines.length && lines[end + 1].trim() && !/\s\^[A-Za-z][\w-]{0,63}\s*$/.test(lines[end + 1])) {
        end++;
    }
    // 行尾的 ` ^id` 本身不显示
    return lines
        .slice(start, end + 1)
        .map(l => l.replace(/\s\^[A-Za-z][\w-]{0,63}\s*$/, ""))
        .join("\n");
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * 从一篇笔记里裁出「某个标题」的区段（N7：`![[笔记#某标题]]`）。
 *
 * 判据：按行找「`#` 前缀 + 标题文本完全相等（忽略大小写与首尾空白）」的那行，
 * 从它起、到**下一个同级或更高级**标题（`#` 数量 ≤ 它）之前为止。
 * 找不到就退回整篇（与 sliceBlock 同一宽容策略：宁可多给，不给空白）。
 */
export function sliceHeading(source: string, headingText: string): string {
    const key = headingText.trim().toLowerCase();
    if (!key) return source;
    const lines = source.split("\n");
    let level = 0;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
        if (m && m[2].toLowerCase() === key) {
            level = m[1].length;
            idx = i;
            break;
        }
    }
    if (idx < 0) return source;
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
        const m = /^(#{1,6})\s/.exec(lines[i]);
        if (m && m[1].length <= level) {
            end = i;
            break;
        }
    }
    return lines.slice(idx, end).join("\n");
}
