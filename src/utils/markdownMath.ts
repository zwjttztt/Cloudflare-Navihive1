// src/utils/markdownMath.ts
// Markdown 里的数学公式语法（`$...$` 行内 / `$$...$$` 块级）→ markdown-it token。
//
// 为什么自己写而不用现成的 markdown-it-math：markdown-it 的插件基本都是注册
// **renderer.rules**（`md.renderer.rules.math_inline = (tokens, idx) => "…"`），
// 而本项目的渲染层只把 markdown-it 当**解析器**用（md.parse 出 token 再映射成 React
// 元素，见 utils/markdownToReact.tsx）—— renderer 那套在 token 流下根本不会被调用。
// 所以只能自己写 parser 侧的 inline / block 规则，产出自定义 token，渲染层再认它。
//
// 语法约定（比 LaTeX 常见的 `$…$` 稍微严一点，宁可漏认也不误伤正文）：
//   - 行内：`$x^2$`，跨行不成立，内容**首尾都不能是空白**
//     （`$ x$` / `$x $` / `价格是 $100 和 $5` 一律不当公式）；
//   - 块级：整行 `$$` 起、某行 `$$` 止；也支持一行写完 `$$x=1$$`；
//   - 没闭合的 `$$` 一律不当公式（退回普通文本），否则一整段会被吞掉。

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

/** `$$` 单独成行（或行尾只允许空白） */
const FENCE_LINE = /^\$\$[ \t]*$/;
/** 整行写完的块级公式：`$$x=1$$` */
const FENCE_SINGLE = /^\$\$([\s\S]*?)\$\$[ \t]*$/;
/** 结束行：`$$` 前可带缩进 */
const FENCE_CLOSE = /^[ \t]*\$\$[ \t]*$/;

/**
 * 行内公式：读 `$…$`。
 *
 * 返回 false 表示「这次不匹配」，把位置留给后面的规则 —— 一定要保证
 * `state.pos` 不被改动（markdown-it 的规矩），否则会把后面的解析全带偏。
 */
export function mathInline(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    if (start >= state.posMax || state.src[start] !== "$") return false;
    // ⚠️ 下一枚字符是空白 → 不是公式（`"$ x$"` 是正文里的一个美元符号）；
    // 下一枚字符又是 `$` → 那是**块级**的语法（由 mathBlock 处理），别在这儿抢，
    // 否则同一行写成 `$$x$$` 会被行内规则当成公式，和块级渲染的样式对不上。
    const nextCh = state.src[start + 1];
    if (nextCh === undefined || nextCh === "$" || /\s/.test(nextCh)) return false;

    let pos = start + 1;
    let end = -1;
    while (pos < state.posMax) {
        const ch = state.src[pos];
        // 转义：跳过下一个字符（比如 `\$` 里的 `$` 不该被当成闭合）
        if (ch === "\\") {
            pos += 2;
            continue;
        }
        if (ch === "\n") break; // 行内公式不跨行
        if (ch === "$") {
            end = pos;
            break;
        }
        pos++;
    }
    if (end < 0) return false;
    const content = state.src.slice(start + 1, end);
    // ⚠️ 内容**首尾带空白的一律不算公式**（markdown-it-texmath 也是这条规矩）。
    // 浏览器实测撞过：`价格是 $100 和 $5` 里第一枚 `$` 会一路找到「和」后面那枚
    // —— 内容是 `100 和 `，配对「成立」但后半句其实还有半个 `$5`。放它过去
    // 等于把正文里的美元符号全吃掉。顺手把 `$ x$` / `$x $` 也挡了：
    // 这两种在正文里更像「一个美元符号加个空格」，不是公式。
    if (!content || /^\s|\s$/.test(content)) return false;

    if (!silent) {
        const token = state.push("math_inline", "", 0);
        token.content = content;
        token.markup = "$";
    }
    state.pos = end + 1;
    return true;
}

/**
 * 块级公式：读 `$$\n…\n$$`。
 *
 * ⚠️ **规则签名是 `(state, startLine, endLine, silent)`**（markdown-it 14 起就是四个参数）。
 * 只写 `(state, silent)` 的话，那个 `silent` 收到的其实是**行号** —— 恒为真值，
 * `if (!silent) pushToken(...)` 永远不执行：公式行被吞掉、token 一个都出不来，
 * 而界面上看到的只是「那段文字不见了」，看不出任何报错。
 *
 * ⚠️ 返回 true 时**必须**把 `state.line` 推到「最后一行 + 1」，否则主循环抛
 * `block rule didn't increment state.line`。
 *
 * ⚠️ 没闭合时必须返回 false，不能「吃掉到文件尾」——
 * 那会把后面整几段都吞进公式里，用户看到的是「我写的好好的段落没了」。
 */
export function mathBlock(
    state: StateBlock,
    line: number,
    endLine: number,
    silent: boolean
): boolean {
    const start = state.bMarks[line];
    const text = state.src.slice(start, state.eMarks[line]);

    // ① `$$x=1$$` 一行写完
    const single = FENCE_SINGLE.exec(text);
    if (single) {
        if (!silent) pushBlock(state, line, line + 1, single[1].trim());
        state.line = line + 1;
        return true;
    }
    // ② `$$` 独占首行，后面几行是公式体，再某行 `$$` 收尾
    if (!FENCE_LINE.test(text)) return false;

    const body: string[] = [];
    let closeLine = -1;
    for (let l = line + 1; l < endLine; l++) {
        const from = state.bMarks[l] + state.tShift[l];
        const lineText = state.src.slice(from, state.eMarks[l]);
        if (FENCE_CLOSE.test(lineText)) {
            closeLine = l;
            break;
        }
        body.push(state.src.slice(from, state.eMarks[l]));
    }
    if (closeLine < 0) return false; // 没闭合

    if (!silent) {
        pushBlock(state, line, closeLine + 1, body.join("\n").trim());
    }
    state.line = closeLine + 1;
    return true;
}

/** 推一个 math_block token。map 是右开的（末行 + 1），和 markdown-it 自己的规矩一致 */
function pushBlock(state: StateBlock, fromLine: number, toLine: number, content: string): void {
    const token = state.push("math_block", "", 0);
    token.block = true;
    token.content = content;
    token.markup = "$$";
    token.map = [fromLine, toLine];
}

/**
 * 装到 markdown-it 实例上。
 *
 * inline 挂在 `escape` **之后**：`\$` 那类转义要先由 escape 规则处理掉，
 * 否则 `$5\$3$` 这种（写「5 美元 3 美元」）会被当成公式的起止。
 */
export function registerMath(md: { inline: { ruler: unknown }; block: { ruler: unknown } }): void {
    const inlineRuler = md.inline.ruler as { after: (name: string, id: string, fn: unknown, opts?: unknown) => void };
    const blockRuler = md.block.ruler as { before: (name: string, id: string, fn: unknown, opts?: unknown) => void };
    inlineRuler.after("escape", "math_inline", mathInline as never, { alt: ["escape"] });
    blockRuler.before("fence", "math_block", mathBlock as never, { alt: ["paragraph", "reference", "blockquote", "list"] });
}
