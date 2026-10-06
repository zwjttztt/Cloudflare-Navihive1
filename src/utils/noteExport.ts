// src/utils/noteExport.ts
// 单条笔记导出（inkstone 顶栏那个「导出」，我们放在列表行的菜单里）。
//
// 为什么自己写而不用现成库：需求就「把标题 + 正文存成一个 .md 文件」，
// 而为了这一件事引入一个导出库不划算（首屏预算 + 依赖体积）。
//
// 文件名的坑比想象中多：
//   - 标题里可能有 `/ \ : * ? " < > |` 这些**在 Windows 上非法**的字符，
//     直接拿标题当文件名会存不下来（用户看到的是「另存为」报错或静默失败）；
//   - 结尾不能是空格或点（Windows 会自动截掉，用户以为导出了个空文件）；
//   - `.` 开头的名字在某些系统上是隐藏文件。

/** Windows 禁止的字符。
 *
 * ⚠️ 只列**可见**的非法字符，不写控制字符区间（\x00-\x1f）：
 * 那会让 eslint 的 no-control-regex 报错，换来的正则行为完全一样 ——
 * 换行与 Tab 由下面的 `\s+` → 单空格处理掉，效果等价。 */
const ILLEGAL = /[\\/:*?"<>|]/g;

/** 把标题洗成一个能安全落盘的文件名（不含扩展名） */
export function safeFileName(title: string, fallback = "未命名笔记"): string {
    const cleaned = (title || "")
        .replace(ILLEGAL, "_")
        .replace(/\s+/g, " ")
        .trim()
        // 结尾的空格和点会被系统悄悄截掉 → 导出出一个没有后缀的文件
        .replace(/[ .]+$/, "")
        .slice(0, 60);
    // 全是空白 / 全是符号时给个兜底名
    if (!cleaned || /^[_.\s]+$/.test(cleaned)) return fallback;
    return cleaned;
}

/**
 * 导出用的 Markdown 正文。
 *
 * 有标题时把标题写成一级标题再接正文：这样导出的文件在任何 Markdown 阅读器里
 * 都有个标题，而不只是正文（列表里的标题和内容是分开存的）。
 */
export function buildNoteMarkdown(title: string, content: string): string {
    const body = content || "";
    const t = (title || "").trim();
    if (!t) return body;
    // 已经有 ATX 开头的一级标题就不重复加
    if (/^#\s+\S/m.test(body.split("\n")[0] || "")) return body;
    return `# ${t}\n\n${body}`;
}

/**
 * 触发浏览器下载。
 *
 * ⚠️ 用 Blob + object URL，不用 data: URL —— 长笔记的 data URL 在 Chrome 上
 * 会被截断（地址栏长度限制），而 Blob 没有这个上限。
 * 用完必须 revokeObjectURL，否则这份 Blob 会一直挂在内存里直到刷新页面。
 */
export function downloadTextFile(fileName: string, text: string, mime = "text/markdown"): void {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 延后一拍再 revoke：部分浏览器（Safari）click 是同步的，立刻 revoke 会拿不到文件
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 一步到位：把某条笔记导出成 .md */
export function exportNoteAsMarkdown(title: string, content: string): string {
    const name = `${safeFileName(title)}.md`;
    downloadTextFile(name, buildNoteMarkdown(title, content));
    return name;
}
