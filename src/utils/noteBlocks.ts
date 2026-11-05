// src/utils/noteBlocks.ts
// inkstone 工具栏「插入 / 块」两组用到的**纯文本**判据与构造。
//
// 为什么单独成文件：这一批语法（块 ID、块引用、笔记嵌入、隐藏注释、标签页、折叠块）
// 每一处都有「差一个字符就整体错位」的坑，而它们在界面上的失败形态还特别隐蔽 ——
// 插入的东西看着像对的，点了没反应、或者渲染成空白。
// 抽成纯函数就能直接单测，不用每次手写一篇长笔记去点。
//
// ── 语法约定（与 inkstone / Obsidian 对齐，便于迁移）──────────────────
//   块 ID     `正文 ^abc12`            行尾的 ^标识，给这一块一个可被引用的名字
//   块引用   `[[目标笔记#^abc12]]`     引用另一篇里的**某一块**
//   笔记嵌入 `![[目标笔记]]`           把另一篇的**正文**嵌进来（块级）
//   隐藏注释 `%%这里不显示%%`          预览里不渲染，源码里还在
//   标签页   :::tabs / === 名称 / :::  一组可切换的页
//   折叠块   > [!FOLD] 标题            可展开收起的内容块

/**
 * 块 ID：行尾 `^` + 标识。限定字符集，避免把 `^` 后面一整句话都吞成 ID。
 *
 * ⚠️ 前面要求至少一个空白 —— 段首的 `^` 不算（那多半是 `^` 运算符或误输入）。
 * 代价是「整段只有一个块 ID」（`^intro` 独占一行）认不出来，那本来也是无意义的写法。
 */
const BLOCK_ID_RE = /[ \t]\^([A-Za-z][A-Za-z0-9_-]{0,63})[ \t]*$/;

/** 容器围栏：`:::tabs` / `:::fold 标题` / 收尾 `:::` */
const CONTAINER_OPEN_RE = /^:::\s*([a-z][a-z0-9_-]*)\s*(.*)$/i;
const CONTAINER_CLOSE_RE = /^:::\s*$/;
/** 容器内的分页标记：`=== 标签名` */
const TAB_HEAD_RE = /^===\s*(.+?)\s*$/;
/** 隐藏注释：`%%…%%`，不跨行 */
const HIDDEN_COMMENT_RE = /^%%([^\n]+?)%%/;

/** 支持的容器类型（折叠块走 callout 的 FOLD，不在这里） */
export const CONTAINER_KINDS = ["tabs"] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

/** 解析 `^abc`：命中返回 id，否则 null（不是每个段落都有块 ID） */
export function parseBlockId(trailing: string): string | null {
    const m = BLOCK_ID_RE.exec(trailing);
    return m ? m[1] : null;
}

/** 掐掉行尾的 ` ^id`，剩下的才是正文（没 ID 就原样返回） */
export function stripBlockId(text: string): { text: string; blockId: string | null } {
    const m = BLOCK_ID_RE.exec(text);
    if (!m) return { text, blockId: null };
    return { text: text.slice(0, m.index), blockId: m[1] };
}

/**
 * 引用目标：`标题`、`标题#^块ID` 两种。
 *
 * ⚠️ 只在**最后一个** `#^` 上切：`C#^笔记` 这种标题里带 `#` 的不能切错位置。
 */
export function parseRefTarget(content: string): { title: string; blockId: string | null } {
    const raw = content.trim();
    const at = raw.lastIndexOf("#^");
    if (at > 0) {
        const blockId = raw.slice(at + 2).trim();
        if (blockId) return { title: raw.slice(0, at).trim(), blockId };
    }
    return { title: raw, blockId: null };
}

/**
 * 嵌入目标（N7）：`标题`、`标题#^块ID`、`标题#标题文本` 三种。
 *
 * 判据照 inkstone renderer.ts 的 parseRefTarget：`#` 后以 `^` 开头是块 ID，
 * 否则是**标题锚点**（嵌入该标题的区段）。注意「最后一个 `#^`」优先 ——
 * 标题里本身带 `#` 的（`C#^笔记`）不能切错位置。
 * ⚠️ 与 parseRefTarget 分开：块引用场景（`#` 只是标题一部分）不该被切成 heading。
 */
export function parseEmbedTarget(
    content: string
): { title: string; blockId: string | null; heading: string | null } {
    const { title, blockId } = parseRefTarget(content);
    if (blockId) return { title, blockId, heading: null };
    const hash = title.indexOf("#");
    if (hash > 0) {
        const fragment = title.slice(hash + 1).trim();
        return { title: title.slice(0, hash).trim(), blockId: null, heading: fragment || null };
    }
    return { title, blockId: null, heading: null };
}

/** 双链 `[[…]]` / 嵌入 `![[…]]` 的方括号对。`![[` 必须先判，否则会从第 2 个字符切出 `![…` */
export function parseBracketRef(src: string, start: number): { embed: boolean; content: string; length: number } | null {
    const embed = src[start] === "!" && src[start + 1] === "[";
    const lb = embed ? start + 1 : start;
    if (src[lb] !== "[" || src[lb + 1] !== "[") return null;
    const close = src.indexOf("]]", lb + 2);
    if (close < 0) return null;
    const content = src.slice(lb + 2, close).trim();
    if (!content) return null;
    // 换行/方括号都不该出现在目标名里：它们几乎总是用户少打了一个符号
    if (/[\n[\]]/.test(content)) return null;
    return { embed, content, length: close + 2 - start };
}

/** 隐藏注释：`%%…%%` → 注释正文；不是注释返回 null */
export function parseHiddenComment(src: string, start: number): { text: string; length: number } | null {
    if (src[start] !== "%" || src[start + 1] !== "%") return null;
    const rest = src.slice(start);
    const m = HIDDEN_COMMENT_RE.exec(rest);
    return m ? { text: m[1], length: m[0].length } : null;
}

/** 容器开行：`:::tabs` → { kind: "tabs", arg: "" } */
export function parseContainerOpen(line: string): { kind: ContainerKind; arg: string } | null {
    const m = CONTAINER_OPEN_RE.exec(line.trim());
    if (!m) return null;
    const kind = m[1].toLowerCase();
    if (!(CONTAINER_KINDS as readonly string[]).includes(kind)) return null;
    return { kind: kind as ContainerKind, arg: m[2].trim() };
}

export function isContainerClose(line: string): boolean {
    return CONTAINER_CLOSE_RE.test(line.trim());
}

/** 标签页里的一页 */
export interface TabPage {
    title: string;
    /** 这一页的 Markdown 源码 */
    source: string;
}

/**
 * 解析标签页容器的内容。
 *
 * `=== 名称` 之前的内容（如果有）算**第一页**，标题用 `arg` 或「标签 1」——
 * 用户只写一个 `:::tabs` 直接回车就能看到东西，而不是一个空容器。
 */
export function parseTabPages(body: string, fallbackTitle = ""): TabPage[] {
    const pages: TabPage[] = [];
    let title: string | null = null;
    /** 这一页是用户**显式**写了 `=== 名称` 的吗（区别于第一个 === 之前的隐式页） */
    let explicit = false;
    let buf: string[] = [];
    const flush = () => {
        if (title === null) return;
        const source = buf.join("\n").replace(/^\n+|\n+$/g, "");
        // 只有「隐式页且整页空白」才丢 —— 显式 `=== 名称` 是用户自己建的页签，
        // 空着就是还没写，不该消失（否则工具栏刚插进去的两页只剩一页）。
        if (!source && !explicit && pages.length > 0) return;
        pages.push({ title, source });
    };
    for (const raw of body.split("\n")) {
        const m = TAB_HEAD_RE.exec(raw.trim());
        if (m) {
            flush();
            title = m[1];
            explicit = true;
            buf = [];
            continue;
        }
        if (title === null) {
            // 第一个 `===` 之前的内容 → 用 fallbackTitle 当隐式第一页的标题
            if (raw.trim() || pages.length > 0) {
                title = fallbackTitle || "标签 1";
                explicit = false;
                buf = [raw];
            }
            continue;
        }
        buf.push(raw);
    }
    flush();
    return pages;
}

/** 造一个标签页容器（工具栏插入用）。给 2 个空白页签，用户直接往里写 */
export function buildTabSource(pageTitles: readonly string[] = ["标签 1", "标签 2"]): string {
    const body = pageTitles.map(t => `=== ${t}\n`).join("\n");
    return `:::tabs\n${body}:::\n`;
}

/** 造一个折叠块（`> [!FOLD] 标题` + 缩进正文） */
export function buildFoldSource(title: string, placeholder = "折叠内容"): string {
    const head = title.trim() || "折叠标题";
    return `> [!FOLD] ${head}\n> ${placeholder}\n`;
}

/** 造一条隐藏注释 */
export function buildHiddenComment(text = "隐藏注释"): string {
    return `%%${text}%%`;
}

/** 造 front matter 里的属性行之外，块 ID 追加到行尾的辅助（工具栏用） */
export function withBlockId(text: string, id: string): string {
    const clean = id.trim().replace(/[^\w-]/g, "");
    return clean ? `${text} ^${clean}` : text;
}
