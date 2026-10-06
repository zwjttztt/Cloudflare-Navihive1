// src/utils/markdownMark.ts
// Markdown 的**高亮**语法（`==文本==`）→ markdown-it token。
//
// 为什么自己写：和公式一样，现成的 markdown-it 插件（markdown-it-mark）也是注册
// `renderer.rules`，而本项目的渲染层只把 markdown-it 当**解析器**用
// （md.parse 出 token 再映射成 React 元素，见 utils/markdownToReact.tsx），
// 插件那套在 token 流下不会被调用。
//
// 判据（与 `$…$` 那套同款，宁可漏认也不误伤正文）：
//   - `==` 后面紧跟空白 → 不是高亮（`== x==` 是正文里的两个等号）；
//   - 闭合的 `==` 前面紧跟空白 → 同样不认；
//   - 内容为空 / 没闭合 → 退回普通文本。
//   代价：`==` 两侧留空格的写法（`== 高亮 ==`）不认。想留空格就写 `== 高亮==` 或 `==高亮 ==`。
//
// ⚠️ 注册位置：排在 `escape` **之后**。`escape` 要先处理 `\$` `\\` 这类转义，
// 否则 `==a \== b==` 这种会被自己的闭合符截断。

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

export function markInline(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    if (state.src[start] !== "=" || state.src[start + 1] !== "=") return false;
    // 开头两枚 `==` 之后必须是非空白，否则是正文里的等号（`a == b`）
    const afterOpen = state.src[start + 2];
    if (afterOpen === undefined || /\s/.test(afterOpen)) return false;

    let pos = start + 2;
    let end = -1;
    while (pos < state.posMax) {
        const ch = state.src[pos];
        // 转义：跳过下一个字符（`\=` 不该被当成闭合符的一部分）
        if (ch === "\\") {
            pos += 2;
            continue;
        }
        if (ch === "\n") break; // 行内高亮不跨行
        if (ch === "=" && state.src[pos + 1] === "=") {
            // 闭合的 `==` 前面不能是空白（`a== b==` 不认）
            if (!/\s/.test(state.src[pos - 1])) end = pos;
            break;
        }
        pos++;
    }
    if (end < 0) return false;
    const content = state.src.slice(start + 2, end);
    if (!content) return false;

    if (!silent) {
        const token = state.push("mark_inline", "", 0);
        token.content = content;
        token.markup = "==";
    }
    state.pos = end + 2;
    return true;
}

export function registerMark(md: { inline: { ruler: unknown } }): void {
    const inlineRuler = md.inline.ruler as {
        after: (name: string, id: string, fn: unknown, opts?: unknown) => void;
    };
    inlineRuler.after("escape", "mark_inline", markInline as never, { alt: [] });
}
