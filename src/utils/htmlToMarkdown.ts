// src/utils/htmlToMarkdown.ts
// 富文本 HTML → Markdown（N5：从网页 / 微信 / 文档拷内容时最常用）。
//
// 设计：用 DOMParser 把剪贴板里的 text/html 解析成 DOM，再递归走一遍。
// 只覆盖日常会遇到的标签（标题 / 段落 / 列表 / 引用 / 链接 / 图片 / 代码 / 强调 /
// 分隔线 / 表格），其余标签剥掉只留文字 —— 不追求 100% 还原，目标是「粘进来能读」。
// 走 DOMParser 而不是正则：正则处理嵌套列表/嵌套标签极容易出错，DOM 才是正解。

export function htmlToMarkdown(html: string): string {
    if (!html || !html.trim()) return "";
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, "text/html");
    } catch {
        return "";
    }
    const out: string[] = [];
    const walk = (node: Node, ctx: { listDepth: number; inListItem: boolean }): void => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3 /* TEXT_NODE */) {
                const text = (child.textContent ?? "").replace(/\s+/g, " ");
                out.push(text);
                continue;
            }
            if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
            const el = child as HTMLElement;
            const tag = el.tagName.toLowerCase();
            switch (tag) {
                case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
                    const level = Number(tag[1]);
                    out.push("\n\n" + "#".repeat(level) + " " + inline(el) + "\n\n");
                    break;
                }
                case "p": case "div": {
                    out.push("\n\n" + inline(el) + "\n\n");
                    break;
                }
                case "br": {
                    out.push("\n");
                    break;
                }
                case "hr": {
                    out.push("\n\n---\n\n");
                    break;
                }
                case "blockquote": {
                    const inner = blockChildren(el, ctx);
                    out.push("\n\n" + inner.split("\n").map(l => (l ? "> " + l : ">")).join("\n") + "\n\n");
                    break;
                }
                case "ul": case "ol": {
                    const ordered = tag === "ol";
                    const items = Array.from(el.children).filter(
                        c => c.tagName.toLowerCase() === "li"
                    ) as HTMLElement[];
                    items.forEach((li, i) => {
                        const marker = ordered ? `${i + 1}. ` : "- ";
                        const depth = ctx.listDepth;
                        const pad = "  ".repeat(depth);
                        out.push("\n" + pad + marker + inline(li).trim());
                    });
                    out.push("\n");
                    break;
                }
                case "li": {
                    // 顶层 ul/ol 会自己遍历 li；单独的 li（理论上不该出现）兜底
                    out.push("\n- " + inline(el).trim());
                    break;
                }
                case "pre": {
                    const code = el.textContent ?? "";
                    out.push("\n\n```\n" + code.replace(/\n+$/, "") + "\n```\n\n");
                    break;
                }
                case "table": {
                    out.push("\n\n" + tableToMarkdown(el) + "\n\n");
                    break;
                }
                case "script": case "style": case "head": case "meta":
                    break;
                case "img": {
                    const src = el.getAttribute("src") ?? "";
                    const alt = el.getAttribute("alt") ?? "";
                    if (src) out.push(`![${alt}](${src})`);
                    break;
                }
                case "a": {
                    const href = el.getAttribute("href") ?? "";
                    const label = inline(el);
                    out.push(href ? `[${label}](${href})` : label);
                    break;
                }
                case "strong": case "b": out.push(`**${inline(el)}**`); break;
                case "em": case "i": out.push(`*${inline(el)}*`); break;
                case "del": case "s": case "strike": out.push(`~~${inline(el)}~~`); break;
                case "code": out.push("`" + (el.textContent ?? "") + "`"); break;
                default:
                    // 未知块级标签：递归其孩子（保留文字）
                    if (isBlock(tag)) {
                        out.push("\n\n" + blockChildren(el, ctx) + "\n\n");
                    } else {
                        walk(el, ctx);
                    }
            }
        }
    };
    const blockChildren = (el: HTMLElement, ctx: { listDepth: number; inListItem: boolean }): string => {
        const saved = out.slice();
        out.length = 0;
        walk(el, ctx);
        const r = out.join("").replace(/\n{3,}/g, "\n\n").trim();
        out.length = 0;
        out.push(...saved);
        return r;
    };
    walk(doc.body, { listDepth: 0, inListItem: false });
    return out.join("").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** 行内元素转 Markdown（标题 / 段落 / 列表项内部的强调 / 链接 / 图片 / 代码） */
function inline(el: HTMLElement): string {
    // ⚠️ 必须是「返回字符串」的纯递归，不能共享一个累加器 ——
    // 共享累加器会把 `<a>` 的文字先裸 push 一遍、再 push 一遍链接，文字翻倍。
    const render = (node: Node): string => {
        let s = "";
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 3) {
                s += (child.textContent ?? "").replace(/\s+/g, " ");
                continue;
            }
            if (child.nodeType !== 1) continue;
            const e = child as HTMLElement;
            switch (e.tagName.toLowerCase()) {
                case "strong": case "b": s += `**${render(e)}**`; break;
                case "em": case "i": s += `*${render(e)}*`; break;
                case "del": case "s": case "strike": s += `~~${render(e)}~~`; break;
                case "code": s += "`" + (e.textContent ?? "") + "`"; break;
                case "a": {
                    const href = e.getAttribute("href") ?? "";
                    const label = render(e);
                    s += href ? `[${label}](${href})` : label;
                    break;
                }
                case "img": {
                    const src = e.getAttribute("src") ?? "";
                    const alt = e.getAttribute("alt") ?? "";
                    if (src) s += `![${alt}](${src})`;
                    break;
                }
                case "br": s += "\n"; break;
                default: s += render(e);
            }
        }
        return s;
    };
    return render(el).replace(/\s+/g, " ").trim();
}

function tableToMarkdown(table: HTMLElement): string {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length === 0) return "";
    const cellText = (tr: HTMLElement, sel: "th" | "td") =>
        Array.from(tr.querySelectorAll(sel)).map(c => (c.textContent ?? "").trim().replace(/\|/g, "\\|"));
    const headerCells = cellText(rows[0], "th");
    const firstRowCells = cellText(rows[0], "td");
    const head = headerCells.length ? headerCells : firstRowCells;
    const lines: string[] = [];
    lines.push("| " + head.join(" | ") + " |");
    lines.push("| " + head.map(() => "---").join(" | ") + " |");
    const bodyRows = headerCells.length ? rows.slice(1) : rows.slice(1);
    for (const tr of bodyRows) {
        const cells = cellText(tr, "td");
        if (cells.length === 0 && cellText(tr, "th").length) continue;
        lines.push("| " + cells.join(" | ") + " |");
    }
    return lines.join("\n");
}

function isBlock(tag: string): boolean {
    return [
        "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "blockquote", "pre", "table", "section", "article", "header", "footer",
        "main", "aside", "figure", "form", "fieldset",
    ].includes(tag);
}
