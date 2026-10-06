import MarkdownIt from "markdown-it";

/** 中文、英文、数字、下划线和连字符；代码、链接、转义不识别。 */
export function registerNoteTags(md: MarkdownIt): void {
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

let parser: MarkdownIt | undefined;
export function extractNoteTags(source: string): string[] {
    if (!parser) { parser = new MarkdownIt({ html: false, linkify: true }); registerNoteTags(parser); }
    const tags = new Set<string>();
    for (const block of parser.parse(source, {})) {
        for (const token of block.children || []) {
            if (token.type === "note_tag") tags.add(token.content);
        }
    }
    return [...tags];
}
