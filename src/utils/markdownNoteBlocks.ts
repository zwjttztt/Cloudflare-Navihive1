// src/utils/markdownNoteBlocks.ts
// inkstone 工具栏「插入 / 块」两组新语法的 markdown-it 规则。
//
// 和 markdownCallout.ts 同一个理由：**只出 token，不注册 renderer**。
// markdown-it 插件的 `renderer.rules.*` 产出 HTML 字符串，在
// `require-trusted-types-for 'script'`（enforce）下会白屏 —— 见 markdownToReact.tsx 头注释。
//
// 这里注册三样东西：
//   1. `note_container`  块级：`:::tabs` / `:::fold` 围栏 → 一个 token（正文原样带在 content）
//   2. `note_embed`      行内：`![[目标]]`（`[[…]]` 由 noteWikiLink 先判掉）
//   3. `note_hidden`     行内：`%%…%%`
//   4. 块 ID             core 后处理：行尾 ` ^id` 摘掉，记到 open token 的 meta 上
//
// ⚠️ 容器为什么用**块规则**而不是 core 后处理：core 阶段 `:::tabs` 已经被解析成
// 段落了，要靠 token.map 反推行号再拼回来 brittle得很。块规则能直接看到原始行。
// 这里刻意**不**在块规则里递归解析内容 —— 那样要么重入 md.parse（不安全），
// 要么得自己拼 token 流。改成围栏整体出一个 token、正文留给 React 侧异步渲染
// （TabsNode / 与 MermaidNode 同一个路子），规则层就只剩「认围栏」这一件事。

import type MarkdownIt from "markdown-it";
import {
    isContainerClose,
    parseBracketRef,
    parseContainerOpen,
    parseHiddenComment,
    stripBlockId,
} from "./noteBlocks";

/** 这些块级 token 的 open 之后紧跟一个 inline，块 ID 就摘在那里 */
const BLOCK_WITH_INLINE = new Set(["paragraph_open", "heading_open"]);

export function registerNoteContainers(md: MarkdownIt): void {
    md.block.ruler.before("fence", "note_container", (state, startLine, endLine, silent) => {
        const first = state.src.slice(
            state.bMarks[startLine] + state.tShift[startLine],
            state.eMarks[startLine]
        );
        const open = parseContainerOpen(first);
        if (!open) return false;

        // 先找收尾 `:::`。找不到就**不认**这个围栏：认了会把后面整篇笔记吞进容器里，
        // 而用户只是随手写了个 `:::tabs` 想看看效果。
        let closeLine = -1;
        for (let line = startLine + 1; line < endLine; line++) {
            const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
            if (isContainerClose(text)) {
                closeLine = line;
                break;
            }
        }
        if (closeLine < 0) return false;
        // silent = markdown-it 在「只问能不能匹配」阶段调它（校验/嵌套判定），
        // 这时不能改 state，只回话。
        if (silent) return true;

        const bodyStart = state.bMarks[startLine + 1] ?? state.eMarks[startLine];
        const bodyEnd = closeLine > startLine + 1 ? state.bMarks[closeLine] : bodyStart;
        const body = closeLine > startLine + 1 ? state.src.slice(bodyStart, bodyEnd) : "";

        const token = state.push("note_container", "div", 0);
        token.info = open.kind;
        token.content = body.replace(/\n+$/, "");
        // meta.arg 给 `:::fold 标题` 的标题用
        token.meta = { kind: open.kind, arg: open.arg };
        token.map = [startLine, closeLine + 1];
        token.block = true;

        state.line = closeLine + 1;
        return true;
    });
}

export function registerNoteEmbed(md: MarkdownIt): void {
    // ⚠️ 必须 before("wiki_link")：`![[x]]` 的第 2、3 个字符也是 `[[`，
    // 让 noteWikiLink 先判的话会切出 `![x` 这种垃圾目标名。
    md.inline.ruler.before("wiki_link", "note_embed", (state, silent) => {
        const start = state.pos;
        if (state.src[start] !== "!") return false;
        if ((state as typeof state & { linkLevel?: number }).linkLevel! > 0) return false;
        const ref = parseBracketRef(state.src, start);
        if (!ref || !ref.embed) return false;
        // N6：嵌入也认别名 `![[目标|显示]]` —— 别名剥掉再当目标名，
        // 否则 title 会带上 `|显示` 永远匹配不到笔记（嵌入显示的是
        // 被嵌笔记自己的标题条，别名在这里只保证目标匹配不回归）。
        const bar = ref.content.indexOf("|");
        const content = bar >= 0 ? ref.content.slice(0, bar).trim() : ref.content;
        if (!content) return false;
        if (!silent) {
            const token = state.push("note_embed", "", 0);
            token.content = content;
            if (bar >= 0) token.meta = { alias: ref.content.slice(bar + 1).trim() };
        }
        state.pos += ref.length;
        return true;
    });

    md.inline.ruler.before("escape", "note_hidden", (state, silent) => {
        const start = state.pos;
        if ((state as typeof state & { linkLevel?: number }).linkLevel! > 0) return false;
        const hit = parseHiddenComment(state.src, start);
        if (!hit) return false;
        if (!silent) {
            const token = state.push("note_hidden", "", 0);
            token.content = hit.text;
        }
        state.pos += hit.length;
        return true;
    });
}

/**
 * 块 ID：把行尾的 ` ^id` 摘掉，记到所属块的 meta 上。
 *
 * 为什么是 **core 规则**而不是行内规则：块 ID 必须落在「整行的最后」，
 * 而行内规则不知道自己能走到行尾（`a ^x ^y` 里哪个才是 ID 只有行尾那个算数）。
 * 而且剥掉之后段落正文要少几个字符，交给 core 改 token.content 最干净。
 */
export function registerBlockId(md: MarkdownIt): void {
    md.core.ruler.push("note_block_id", (state) => {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length; i++) {
            if (!BLOCK_WITH_INLINE.has(tokens[i].type)) continue;
            const inline = tokens[i + 1];
            if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
            const last = inline.children[inline.children.length - 1];
            if (last.type !== "text") continue;
            const { text, blockId } = stripBlockId(last.content);
            if (!blockId) continue;
            last.content = text;
            // ⚠️ 这里**不需要**「正文被摘空就删掉整段」的分支：
            // markdown-it 在 inline 解析阶段就剥掉了行首空白，` ^only` 的
            // children 已经是 `^only`（前面没空格了）→ stripBlockId 根本不命中。
            // 也就是说「整个段落只剩一个块 ID」这种状态到不了这里，
            // 写一个删段落的分支只是永远不执行的死代码（还会让人误以为它在防什么）。
            tokens[i].meta = { ...(tokens[i].meta ?? {}), blockId };
        }
        return true;
    });
}

export function registerNoteBlocks(md: MarkdownIt): void {
    registerNoteContainers(md);
    registerNoteEmbed(md);
    registerBlockId(md);
}

/** 渲染层读块 ID 用 */
export function blockIdOf(meta: unknown): string | null {
    return (meta as { blockId?: string } | null)?.blockId ?? null;
}
