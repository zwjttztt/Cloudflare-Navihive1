// src/utils/bookmarks.ts
// 解析浏览器导出的书签 HTML（Netscape 格式，Chrome / Edge / Firefox 通用），
// 顶层文件夹当分组，里面的链接当卡片。

export interface ParsedBookmark {
    title: string;
    url: string;
    folder: string;
}

export interface ParsedBookmarkGroup {
    folder: string;
    items: ParsedBookmark[];
}

// 往上找最近的文件夹名：书签里文件夹是 <DT><H3>名字</H3>，链接在它后面的 <DL> 里
function folderOf(node: Element): string {
    let current: Element | null = node.parentElement;
    while (current) {
        // 找到包裹这个链接的 DL，再看它前面那个 DT 里的 H3
        if (current.tagName === "DL") {
            let prev: Element | null = current.previousElementSibling;
            while (prev) {
                const h3 = prev.tagName === "DT" ? prev.querySelector("h3") : null;
                if (h3 && h3.textContent?.trim()) return h3.textContent.trim();
                prev = prev.previousElementSibling;
            }
        }
        current = current.parentElement;
    }
    return "导入的书签";
}

export function parseBookmarksHtml(html: string): ParsedBookmarkGroup[] {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    const groups = new Map<string, ParsedBookmark[]>();

    for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(href)) continue; // 跳过 javascript: / place: 之类的伪协议
        const title = (a.textContent || "").trim() || href;
        const folder = folderOf(a);
        const list = groups.get(folder) ?? [];
        // 同一个文件夹里可能有重复链接，去重后再导入
        if (!list.some(item => item.url === href)) {
            list.push({ title, url: href, folder });
        }
        groups.set(folder, list);
    }

    return [...groups.entries()].map(([folder, items]) => ({ folder, items }));
}
