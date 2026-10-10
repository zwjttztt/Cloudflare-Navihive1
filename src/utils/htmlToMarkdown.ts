// Clipboard conversion never trusts pasted URL protocols.
export function safePastedHref(value: string, image = false): string | null {
    const href = value.trim();
    if (!href || Array.from(href).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    if (scheme && !(image ? ["http", "https"] : ["http", "https", "mailto", "tel"]).includes(scheme)) return null;
    return href;
}
export function markdownLink(label: string, url: string, image = false): string {
    const escaped = label.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/[[\]]/g, "\\$&");
    const destination = Array.from(url, c => c.charCodeAt(0) <= 32 || c === "<" || c === ">" ? encodeURIComponent(c) : c).join("");
    return `${image ? "!" : ""}[${escaped}](${/[\s()<>]/.test(url) ? `<${destination}>` : destination})`;
}
export function looksLikeMarkdown(text: string): boolean {
    return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|)/m.test(text) || /\[[^\]]*\]\([^)]*\)/.test(text);
}
function longestRun(value: string): number {
    return Math.max(0, ...Array.from(value.matchAll(/`+/g), m => m[0].length));
}
// Build an inert tree with node APIs only; DOMParser(text/html) is a Trusted Types sink.
function pastedHtmlTree(html: string): Document {
    const doc = document.implementation.createHTMLDocument("");
    const stack: HTMLElement[] = [doc.body];
    const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
        if (entity[0] === "#") {
            const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
        }
        return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[entity.toLowerCase()] ?? whole;
    });
    const voidTags = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "embed", "param", "track", "col"]);
    const blockedTags = new Set(["script", "style", "iframe", "object", "svg", "math", "noscript", "template"]);
    let blocked: string | null = null;
    for (const match of html.matchAll(/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</gi)) {
        const token = match[0];
        if (token.startsWith("<!")) continue;
        const end = /^<\/\s*([a-z][\w:-]*)/i.exec(token);
        if (blocked) { if (end?.[1].toLowerCase() === blocked) blocked = null; continue; }
        if (end) {
            const tag = end[1].toLowerCase();
            let index = stack.length - 1;
            while (index > 0 && stack[index].tagName.toLowerCase() !== tag) index--;
            if (index > 0) stack.length = index;
            continue;
        }
        const start = /^<([a-z][\w:-]*)\b([\s\S]*?)\/?\s*>$/i.exec(token);
        if (!start) { stack[stack.length - 1].appendChild(doc.createTextNode(decode(token))); continue; }
        const tag = start[1].toLowerCase();
        if (blockedTags.has(tag)) { if (!token.endsWith("/>")) blocked = tag; continue; }
        if (["html", "head", "body"].includes(tag)) continue;
        if (tag === "li" && stack[stack.length - 1].tagName === "LI") stack.pop();
        if (tag === "p" && stack[stack.length - 1].tagName === "P") stack.pop();
        const element = doc.createElement(tag);
        // Only metadata read by the converter is retained; no event/style attributes or resource fetches.
        for (const attr of start[2].matchAll(/([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
            const name = attr[1].toLowerCase();
            if (["href", "src", "alt", "class", "start", "value"].includes(name)) element.setAttribute(name, decode(attr[2] ?? attr[3] ?? attr[4] ?? ""));
        }
        stack[stack.length - 1].appendChild(element);
        if (!voidTags.has(tag) && !token.endsWith("/>")) stack.push(element);
    }
    return doc;
}
export function htmlToMarkdown(html: string): string {
    if (!html.trim()) return "";
    let doc: Document;
    try { doc = pastedHtmlTree(html); } catch { return ""; }
    doc.querySelectorAll("script,style,meta,link,noscript").forEach(el => el.remove());
    const walk = (node: Node, indent = ""): string => {
        if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
        if (node.nodeType !== 1) return "";
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const children = () => Array.from(el.childNodes, child => walk(child, indent)).join("");
        if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
        switch (tag) {
            case "p": case "div": return `\n\n${children().trim()}\n\n`;
            case "br": return "\n";
            case "hr": return "\n\n---\n\n";
            case "strong": case "b": return `**${children()}**`;
            case "em": case "i": return `*${children()}*`;
            case "del": case "s": case "strike": return `~~${children()}~~`;
            case "code": {
                const text = (el.textContent ?? "").replace(/[\r\n]+/g, " ");
                const fence = "`".repeat(longestRun(text) + 1);
                const pad = /^\s|\s$|^`|`$/.test(text) ? " " : "";
                return `${fence}${pad}${text}${pad}${fence}`;
            }
            case "pre": {
                const text = (el.textContent ?? "").replace(/\n$/, "");
                const lang = /language-([a-z0-9+#-]+)/i.exec(el.querySelector("code")?.className ?? "")?.[1] ?? "";
                const fence = "`".repeat(Math.max(3, longestRun(text) + 1));
                return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
            }
            case "blockquote": return `\n\n${children().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
            case "a": {
                const href = safePastedHref(el.getAttribute("href") ?? "");
                const label = children().trim();
                return href ? markdownLink(label || href, href) : label;
            }
            case "img": {
                const src = safePastedHref(el.getAttribute("src") ?? "", true);
                return src ? markdownLink(el.getAttribute("alt") ?? "", src, true) : "";
            }
            case "ul": case "ol": return `\n\n${renderList(el, indent)}\n\n`;
            case "table": {
                const rows = Array.from(el.querySelectorAll("tr"), row => Array.from(row.children).filter(c => /^(TH|TD)$/.test(c.tagName)).map(c => (c.textContent ?? "").trim().replace(/\|/g, "\\|")));
                if (!rows.length) return "";
                return `\n\n${[rows[0], rows[0].map(() => "---"), ...rows.slice(1)].map(row => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
            }
            default: return children();
        }
    };
    const renderList = (list: HTMLElement, indent: string): string => {
        const ordered = list.tagName === "OL";
        const start = Number.parseInt(list.getAttribute("start") ?? "1", 10) || 1;
        return Array.from(list.children).filter(el => el.tagName === "LI").map((item, i) => {
            const marker = ordered ? `${Number.parseInt(item.getAttribute("value") ?? "", 10) || start + i}. ` : "- ";
            const nested = Array.from(item.children).filter(el => /^(UL|OL)$/.test(el.tagName));
            const text = Array.from(item.childNodes).filter(n => !nested.includes(n as Element)).map(n => walk(n, indent + " ".repeat(marker.length))).join("").trim();
            const lines = text.split("\n").filter(Boolean);
            return `${indent}${marker}${lines[0] ?? ""}${lines.slice(1).map(line => `\n${indent}${" ".repeat(marker.length)}${line}`).join("")}${nested.map(el => `\n${renderList(el as HTMLElement, indent + " ".repeat(marker.length))}`).join("")}`;
        }).join("\n");
    };
    return walk(doc.body).replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}
