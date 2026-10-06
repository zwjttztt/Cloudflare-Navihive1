// src/utils/noteFrontMatter.ts
// 笔记属性（YAML front matter）：笔记**开头**被 `---` 夹住的那块键值。
//
// 为什么在字符串层做，而不是给 markdown-it 注册规则：
//   `---` 开头那段，markdown-it 会拆成 hr + 一串普通段落（`title: 甲` 只是个段落），
//   到了 core 规则那一层已经看不出「它们本来是同一块属性」了。要还原得重新拼文本，
//   反而更容易出错。所以**进解析器之前**先摘掉，剩下正文照常解析 ——
//   属性那块自己渲染成一张表。
//
// 边界（刻意定的）：
//   - 必须在**第一行**（`---` 前面不能有空行/其它内容），否则就不是 front matter。
//   - 结束线也要在行首。两个 `---` 之间逐行按 `键: 值` 解析；不合式的行**原样保留**
//     在正文的开头（宁可显示得奇怪，也不要静默吞掉用户写的字）。
//   - 值支持行内数组 `[a, b]`，解析成字符串数组（渲染层当标签行显示）。
export interface FrontMatterEntry {
    key: string;
    /** 普通值（已 trim） */
    value: string;
    /** `[a, b]` 形式解析出的数组；非数组时为 undefined */
    list?: string[];
}

export interface FrontMatter {
    entries: FrontMatterEntry[];
    /** 去掉 front matter 之后的正文 */
    body: string;
    /** 原文里 front matter 占掉的字符数（body 在原文中的起始下标） */
    bodyOffset: number;
}

const FENCE = /^---[ \t]*$/;

/** 单行 `键: 值`（键允许中文与连字符，值可为空） */
function parseEntry(line: string): FrontMatterEntry | null {
    const m = /^([^\s:#][^:#]*):[ \t]*(.*)$/.exec(line);
    if (!m) return null;
    const key = m[1].trim();
    if (!key) return null;
    const raw = m[2].trim();
    // 行内数组：[a, b, c]（允许空数组）
    if (raw.startsWith("[") && raw.endsWith("]")) {
        const list = raw
            .slice(1, -1)
            .split(",")
            .map(s => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        return { key, value: list.join("、"), list };
    }
    // 去掉行尾注释（`key: value # 说明`）。
    // ⚠️ 必须先剥掉引号再砍：`url: "a # b"` 里的 `#` 在引号内，
    // 直接按 ` #` 找位置会把值砍成 `"a` —— 引号被劈开，剩下后半截还成了新行。
    const quoted = /^(["'])(.*)\1$/.exec(raw);
    if (quoted) return { key, value: quoted[2] };
    const hash = raw.indexOf(" #");
    const value = hash > 0 ? raw.slice(0, hash).trim() : raw;
    return { key, value };
}

/**
 * 摘掉笔记开头的 YAML front matter。
 *
 * @returns 没找到 front matter 时 `entries` 为空、`body` 就是原文（调用方无需分支）
 */
export function splitFrontMatter(source: string): FrontMatter {
    const passthrough = (body: string, bodyOffset: number): FrontMatter => ({
        entries: [],
        body,
        bodyOffset,
    });
    if (!source) return passthrough(source, 0);
    // 必须以 `---` 开头（前面连一个换行都没有）
    const lines = source.split("\n");
    if (!FENCE.test(lines[0] ?? "")) return passthrough(source, 0);

    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (FENCE.test(lines[i])) {
            end = i;
            break;
        }
    }
    // 只有开线没有闭线 → 不是 front matter，整篇当正文（用户可能只是在写分隔线）
    if (end < 0) return passthrough(source, 0);

    const entries: FrontMatterEntry[] = [];
    for (let i = 1; i < end; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        const entry = parseEntry(line);
        // 不合式的行存在 → 整块都不是 front matter，退回当正文
        if (!entry) return passthrough(source, 0);
        entries.push(entry);
    }

    // body 从闭线的下一行开始。
    // ⚠️ bodyOffset 是**字符**下标（body 在原文里的起点），不是行号。
    // 渲染层算大纲跳转位置时按字符找 offset —— 之前这里返回 `end + 1`（行号），
    // 一段带属性的笔记大纲跳转会落到完全无关的位置（行号 3 可能在第 200 个字符处）。
    const consumed = lines.slice(0, end + 1);
    // 只有真的还有正文行时，那道换行符才算被吃掉
    const bodyOffset = consumed.join("\n").length + (end + 1 < lines.length ? 1 : 0);
    const body = lines.slice(end + 1).join("\n");
    return { entries, body, bodyOffset };
}

/** 造一份 front matter 源码（新建笔记时插到最前面用） */
export function buildFrontMatter(entries: readonly FrontMatterEntry[]): string {
    if (entries.length === 0) return "";
    const lines = entries.map(e => {
        if (e.list && e.list.length > 0) {
            return `${e.key}: [${e.list.map(v => (/[\s,[\]]/.test(v) ? JSON.stringify(v) : v)).join(", ")}]`;
        }
        const v = e.value ?? "";
        return `${e.key}: ${/^[\s]|[:#]$/.test(v) ? JSON.stringify(v) : v}`;
    });
    return `---\n${lines.join("\n")}\n---\n`;
}
