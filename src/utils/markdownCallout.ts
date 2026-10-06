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

/** 支持的类型（与工具栏下拉一一对应） */
export const CALLOUT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "QUOTE"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

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

/** 首段首行开头是不是 `[!TYPE]`；是则摘掉标记并返回类型 */
function takeMarker(tokens: Token[]): CalloutType | null {
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
    head.content = head.content.slice(match[0].length);
    return type;
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
            const type = takeMarker(tokens.slice(i + 1, close));
            if (!type) continue;

            tokens[i].meta = { ...(tokens[i].meta ?? {}), callout: type };
            const open = new state.Token("callout_open", "div", 1);
            open.meta = { callout: type };
            const closeTok = new state.Token("callout_close", "div", -1);
            closeTok.meta = { callout: type };
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
