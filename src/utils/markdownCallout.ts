// src/utils/markdownCallout.ts
// 内容块 / callout：`> [!NOTE] 正文` 渲染成带图标与配色的提示框。
//
// inkstone 工具栏有「内容块」这一项，本项目原来只有普通引用块。
// 刻意**不用 markdown-it 插件**：插件走 `renderer.rules.*` 输出 HTML 字符串，
// 在 `require-trusted-types-for 'script'`（enforce）下会白屏 —— 理由与
// markdownToReact.tsx 头注释一致。这里只出 token，渲染层映射成 React。
//
// 语法（与 GitHub / Obsidian 一致，便于迁移）：
//   > [!NOTE]      提示（蓝）
//   > [!TIP]       技巧（绿）
//   > [!IMPORTANT] 重要（紫）
//   > [!WARNING]   警告（橙）
//   > [!QUOTE]     引用（灰）
//   没写类型、或类型不认识时，就是普通引用块。
//
// ⚠️ 实现方式：**core 规则（后处理 token 流）**，不是 block 规则。
// 先试过 block 规则（在 blockquote 之前拦截并手工 tokenize 整块）——
// 那条路要跟着 markdown-it 的 silent 模式、行号推进和 token 插入时机周旋，
// 实测一个 callout_open 都产不出来（探针：四种输入的 token 流与普通引用完全一致）。
// core 规则在 block 解析**之后**跑，直接看现成的 blockquote_open/close，
// 只需要「查首行文本 → 摘掉标记 → 包一层」，可靠得多。
import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

/**
 * 支持的类型（与工具栏下拉一一对应）
 *
 * `FOLD` 是折叠内容：语法同为 `> [!FOLD] 标题`，但渲染成 `<details>`
 * —— 可展开收起。放进这个枚举而不是另写一套块规则，是因为折叠块的**解析**
 * （首段首行摘标记、包一层）与内容块完全一致，只有渲染层的表现不同。
 */
export const CALLOUT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE", "FOLD"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** 折叠块（`> [!FOLD]`）：标题之外的正文默认收起来 */
export function isFoldType(type: CalloutType): boolean {
    return type === "FOLD";
}


/**
 * 不区分大小写地解析 `[!note]`；不是这几种就返回 null（当普通引用处理）。
 *
 * ⚠️ 必须**完整匹配** `[!XXX]`：用「剥前缀再比后半段」的话，
 * `[!FAQ` 这种残缺写法会漏过去（`replace(/]$/, "")` 对它不生效），
 * 碰巧命中某个类型就出错了。
 */
export function parseCalloutType(marker: string): CalloutType | null {
    const match = /^\[!([A-Za-z]+)\]$/.exec(marker.trim());
    if (!match) return null;
    const normalized = match[1].toUpperCase();
    return (CALLOUT_TYPES as readonly string[]).includes(normalized)
        ? (normalized as CalloutType)
        : null;
}

/** 摘标记的结果：类型 + 折叠块那一行的标题 */
interface Marker {
    type: CalloutType;
    /** 只有 FOLD 会用到：`> [!FOLD] 标题` 里「标题」那几个字 */
    title: string;
}

/** 首段首行开头是不是 `[!TYPE]`；是则摘掉标记并返回类型与标题 */
function takeMarker(tokens: Token[]): Marker | null {
    const firstInline = tokens.find(t => t.type === "inline");
    if (!firstInline) return null;
    const children = firstInline.children;
    if (!children || children.length === 0) return null;
    const head = children[0];
    if (head.type !== "text") return null;
    const match = /^\s*\[!([A-Za-z]+)\]/.exec(head.content);
    if (!match) return null;
    const type = parseCalloutType(match[0]);
    // 不认识的类型：标记留在正文里（`[!FAQ]` 当普通文字），不吞掉
    if (!type) return null;
    const rest = head.content.slice(match[0].length);
    if (isFoldType(type)) {
        // 折叠块的首行是标题，摘下来单独渲染（否则标题会混在正文第一行里）。
        // ⚠️ 必须按**原始长度**切，不能拿 trim 过的标题去 slice：
        // `> [!FOLD] 细节` 摘完标记后 head.content 是 " 细节"（还带前导空格），
        // 用 title.length(=2) 去切会从「细」字中间切 —— 正文变成一个「节」字，
        // 页面上就是「标题写对了但下面少半个词」。
        const nl = rest.indexOf("\n");
        const title = (nl < 0 ? rest : rest.slice(0, nl)).trim();
        const consumed = (nl < 0 ? rest : rest.slice(0, nl)).length;
        head.content = rest.slice(consumed);
        return { type, title };
    }
    head.content = rest;
    return { type, title: "" };
}


/** 在 token 流里把 callout 引用块标出来，并插上 callout_open / callout_close */
export function registerCallout(md: MarkdownIt): void {
    md.core.ruler.push("callout_wrap", (state) => {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type !== "blockquote_open") continue;
            // 先按深度找配对的 blockquote_close
            let depth = 0;
            let close = -1;
            for (let j = i; j < tokens.length; j++) {
                if (tokens[j].type === "blockquote_open") depth++;
                else if (tokens[j].type === "blockquote_close") {
                    depth--;
                    if (depth === 0) {
                        close = j;
                        break;
                    }
                }
            }
            if (close < 0) continue;
            const marker = takeMarker(tokens.slice(i + 1, close));
            if (!marker) continue;
            const meta = { callout: marker.type, foldTitle: marker.title };

            tokens[i].meta = { ...(tokens[i].meta ?? {}), ...meta };
            const open = new state.Token("callout_open", "div", 1);
            open.meta = meta;
            const closeTok = new state.Token("callout_close", "div", -1);
            closeTok.meta = meta;
            tokens.splice(i, 0, open);
            // +1 是刚插入的 callout_open，原来的 close 往后挪了一位
            tokens.splice(close + 2, 0, closeTok);
            // 跳过刚插入的两个 token，避免把 callout_close 当成新的 blockquote_open
            i = close + 2;
        }
        return true;
    });
}

/** 从 token 的 meta 里读出 callout 类型（渲染层用） */
export function calloutTypeOf(meta: unknown): CalloutType | null {
    return (meta as { callout?: CalloutType } | null)?.callout ?? null;
}

/** 折叠块的标题（`> [!FOLD] 标题` 里的「标题」） */
export function calloutTitleOf(meta: unknown): string {
    return (meta as { foldTitle?: string } | null)?.foldTitle ?? "";
}

