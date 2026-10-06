// src/utils/noteWikiLink.ts
// `[[双链]]` 的解析与解析结果的使用（inkstone 的核心卖点之一）。
//
// 为什么单独抽成纯函数：双链有**两处**要用同一套判据 ——
//   ① 渲染层：把 `[[标题]]` 变成可点链接（utils/markdownToReact.tsx 注册 inline 规则）
//   ② 反向链接：算出「哪些笔记引用了当前这条」（本文件 buildBacklinks）
// 两处判据必须一致，所以解析只写一遍，这里同时导出规则注册与纯计算。
//
// 不用 markdown-it 插件的 renderer：那个走 HTML 字符串 sink，
// 在 `require-trusted-types-for 'script'`（enforce）下会白屏（见 markdownToReact 头注释）。
import MarkdownIt from "markdown-it";

/** 与 [[标签名]] 一样，忽略行内代码、围栏代码、转义、链接内、标题行语法 */
export function registerWikiLink(md: MarkdownIt): void {
    md.inline.ruler.before("escape", "wiki_link", (state, silent) => {
        const start = state.pos;
        if (state.src[start] !== "[" || state.src[start + 1] !== "[") return false;
        // 链接目标内部（[文字](url) 的括号里）不识别
        if ((state as typeof state & { linkLevel?: number }).linkLevel! > 0) return false;
        // 前面紧跟 `[` 时是 `[[[`（文献引用一类），这里只认恰好两个方括号
        if (state.src[start - 1] === "[") return false;
        const match = /^\[\[([^[\]\n]{1,120})\]\]/.exec(state.src.slice(start));
        if (!match) return false;
        const target = match[1].trim();
        if (!target) return false;
        if (!silent) {
            // 单个叶子 token（nesting 0）：显示文本就是目标名。
            // 不包 text/close 一对 —— 那样还得让渲染层维护栈，
            // 而这里没有别名语法（`[[目标|显示]]`），一个 token 就够。
            const token = state.push("wiki_link", "", 0);
            token.content = target;
        }
        state.pos += match[0].length;
        return true;
    });
}

let parser: MarkdownIt | undefined;
/** 这段 Markdown 里所有 `[[目标]]` 的目标名（去重、保持出现顺序） */
export function extractWikiLinks(source: string): string[] {
    if (!source.includes("[[")) return [];
    if (!parser) {
        const Ctor = ((MarkdownIt as unknown as { default?: unknown }).default ??
            MarkdownIt) as unknown as new (opts: Record<string, unknown>) => MarkdownIt;
        parser = new Ctor({ html: false, linkify: true });
        registerWikiLink(parser);
        registerNoteTagLikeRule(parser);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const block of parser.parse(source, {})) {
        for (const token of block.children || []) {
            if (token.type === "wiki_link" && !seen.has(token.content)) {
                seen.add(token.content);
                out.push(token.content);
            }
        }
    }
    return out;
}

/**
 * 复用 markdownNoteTags 的 `#标签` 规则。
 * 双链与标签共用一个解析实例，`[[…]]` 与 `#…` 在同一段文本里才互不干扰
 * （两都注册、都在 escape 之前，按位置先到先得）。
 */
function registerNoteTagLikeRule(md: MarkdownIt): void {
    md.inline.ruler.before("escape", "note_tag", (state, silent) => {
        const start = state.pos;
        if (state.src[start] !== "#" || (state as typeof state & { linkLevel?: number }).linkLevel! > 0) return false;
        if (start > 0 && /[\p{L}\p{N}_#\\/]/u.test(state.src[start - 1])) return false;
        const match = /^#([\p{L}\p{N}_][\p{L}\p{N}_-]{0,79})(?![\p{L}\p{N}_-])/u.exec(state.src.slice(start));
        if (!match) return false;
        if (!silent) {
            const token = state.push("note_tag", "", 0);
            token.content = match[1];
        }
        state.pos += match[0].length;
        return true;
    });
}

/** 反向链接需要的一条最小笔记信息（id 允许缺省 —— 库里每条都有，但类型上 Note.id?） */
export interface WikiLinkNote {
    id?: number;
    title: string;
    content: string;
}

/** 标题比较统一走这里：去首尾空白 + 忽略大小写，用户打 `[[API]]` 能命中「api」 */
function normalizeTitle(title: string): string {
    return title.trim().toLowerCase();
}

/**
 * 反向链接：谁引用了这条笔记。
 *
 * @param notes   全部笔记（一次全量即可，客户端本来就持有）
 * @param target  当前笔记
 * @returns 引用了 current 的笔记列表（不含它自己）
 */
export function buildBacklinks(
    notes: readonly WikiLinkNote[],
    current: WikiLinkNote
): ResolvedWikiLink[] {
    const key = normalizeTitle(current.title);
    // 空标题不可能被 [[]] 命中（解析时 trim 后为空就跳过），直接省掉这次扫描
    if (!key) return [];
    const out: ResolvedWikiLink[] = [];
    for (const note of notes) {
        if (note.id === undefined || note.id === current.id) continue;
        if (extractWikiLinks(note.content).some(t => normalizeTitle(t) === key)) {
            out.push({ id: note.id, title: note.title });
        }
    }
    return out;
}

/** 已确认存在、可以跳过去的双链目标（id 一定在 —— 解析时就把缺 id 的排除了） */
export interface ResolvedWikiLink {
    id: number;
    title: string;
}

/** 当前笔记链出去的、且**确实存在**的目标（`[[不存在的]]` 不给死链） */
export function resolveWikiLinks(
    notes: readonly WikiLinkNote[],
    current: WikiLinkNote
): ResolvedWikiLink[] {
    const byTitle = new Map<string, WikiLinkNote>();
    for (const note of notes) {
        const key = normalizeTitle(note.title);
        if (key && !byTitle.has(key)) byTitle.set(key, note);
    }
    const out: ResolvedWikiLink[] = [];
    const seen = new Set<number>();
    for (const target of extractWikiLinks(current.content)) {
        const hit = byTitle.get(normalizeTitle(target));
        if (hit?.id !== undefined && hit.id !== current.id && !seen.has(hit.id)) {
            seen.add(hit.id);
            out.push({ id: hit.id, title: hit.title });
        }
    }
    return out;
}
