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
//   - 行内：`$x^2$` 或 `\(x^2\)`，跨行不成立；
//   - 块级：整行 `$$` 起、某行 `$$` 止（也支持一行写完 `$$x=1$$`）；
//     或整行 `\[` 起、某行 `\]` 止（也支持一行写完 `\[x=1\]`）；
//   - 没闭合的一律不当公式（退回普通文本），否则一整段会被吞掉。
//
// ⚠️ 两套定界符的**严格程度故意不同**：
//   - `$…$` 在正文里和「美元符号」撞车（`价格是 $100 和 $5`），所以内容首尾带空白一律不认；
//   - `\(` `\[` 是用户**明写**的意图标记（LaTeX 原生写法），不会与正文混淆，
//     所以只要求非空，首尾空白照收（`\( a+b \)` 这种两边留空格的写法很常见）。

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

/** `$$` 单独成行（或行尾只允许空白） */
const FENCE_LINE = /^\$\$[ \t]*$/;
/** 整行写完的块级公式：`$$x=1$$` */
const FENCE_SINGLE = /^\$\$([\s\S]*?)\$\$[ \t]*$/;
/** 结束行：`$$` 前可带缩进 */
const FENCE_CLOSE = /^[ \t]*\$\$[ \t]*$/;

/** LaTeX 原生块级定界符：`\[` / `\]`（单行写法与独占行写法各一条） */
const BRACKET_FENCE_LINE = /^\\\[[ \t]*$/;
const BRACKET_FENCE_SINGLE = /^\\\[([\s\S]*?)\\\][ \t]*$/;
const BRACKET_FENCE_CLOSE = /^[ \t]*\\\][ \t]*$/;

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
 * 行内公式（LaTeX 原生定界符）：读 `\(…\)` 与 `\[…\]`。
 *
 * ⚠️⚠️ 这条规则**必须注册在 `escape` 之前**，否则永远匹配不到：
 * markdown-it 的 `escape` 规则会把「反斜杠 + ASCII 标点」整个吃掉
 * （`\(` 属于 ASCII 标点转义），等到我们这条规则运行时，源码里已经是光秃秃的 `(` 了。
 * 这也是为什么 `$…$` 那条要挂在 escape **之后**——两条规则的注册位置是反的，各有各的理由。
 *
 * 另一处刻意的宽松：内容首尾的空白**照收**（只 trim 不拒绝）。
 * `$` 会和正文里的美元符号撞车，`\(` 不会 —— 用户都明写出来了，没理由再拦一道。
 */
export function mathParenInline(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    if (state.src[start] !== "\\") return false;
    const open = state.src[start + 1];
    // 只认 `\(` 与 `\[`；`\\(`（转义的反斜杠 + 括号）不认
    if (open !== "(" && open !== "[") return false;
    const close = open === "(" ? "\\)" : "\\]";

    let pos = start + 2;
    let end = -1;
    while (pos < state.posMax) {
        const ch = state.src[pos];
        if (ch === "\\") {
            if (state.src.startsWith(close, pos)) {
                end = pos;
                break;
            }
            pos += 2; // 公式里的其它转义（`\{`、`\alpha`、`\\` 换行）整体跳过
            continue;
        }
        if (ch === "\n") break; // 与 $ 版本一致：行内公式不跨行
        pos++;
    }
    if (end < 0) return false;
    const content = state.src.slice(start + 2, end).trim();
    if (!content) return false;

    if (!silent) {
        const token = state.push("math_inline", "", 0);
        token.content = content;
        token.markup = open === "(" ? "\\(" : "\\[";
    }
    state.pos = end + 2; // +2 是把闭合标记两个字符都吃掉
    return true;
}

/**
 * 块级公式：读 `$$\n…\n$$` 与 `\[\n…\n\]`。
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

    // 定界符风格：`$$…$$` 还是 `\[…\]`。两者结构一样，只是行首行尾的记号不同。
    const dollarSingle = FENCE_SINGLE.exec(text);
    const bracketSingle = BRACKET_FENCE_SINGLE.exec(text);
    const style = dollarSingle ? "dollar" : bracketSingle ? "bracket" : null;

    // ① 一行写完：`$$x=1$$` / `\[x=1\]`
    if (style) {
        if (!silent) {
            pushBlock(state, line, line + 1, (dollarSingle ?? bracketSingle)![1].trim(),
                style === "dollar" ? "$$" : "\\[");
        }
        state.line = line + 1;
        return true;
    }
    // ② 定界符独占首行，后面几行是公式体，再某行收尾
    const dollar = FENCE_LINE.test(text);
    const bracket = BRACKET_FENCE_LINE.test(text);
    if (!dollar && !bracket) return false;

    const body: string[] = [];
    let closeLine = -1;
    for (let l = line + 1; l < endLine; l++) {
        const from = state.bMarks[l] + state.tShift[l];
        const lineText = state.src.slice(from, state.eMarks[l]);
        if (dollar ? FENCE_CLOSE.test(lineText) : BRACKET_FENCE_CLOSE.test(lineText)) {
            closeLine = l;
            break;
        }
        body.push(state.src.slice(from, state.eMarks[l]));
    }
    if (closeLine < 0) return false; // 没闭合

    if (!silent) {
        pushBlock(state, line, closeLine + 1, body.join("\n").trim(),
            dollar ? "$$" : "\\[");
    }
    state.line = closeLine + 1;
    return true;
}

/** 推一个 math_block token。map 是右开的（末行 + 1），和 markdown-it 自己的规矩一致 */
function pushBlock(
    state: StateBlock,
    fromLine: number,
    toLine: number,
    content: string,
    markup: string
): void {
    const token = state.push("math_block", "", 0);
    token.block = true;
    token.content = content;
    token.markup = markup;
    token.map = [fromLine, toLine];
}

/**
 * 装到 markdown-it 实例上。
 *
 * 两条 inline 规则的注册位置**故意相反**，各有各的理由：
 *   - `\(` `\[` 挂在 `escape` **之前**：escape 会把「反斜杠 + ASCII 标点」整个吃掉
 *     （`\(` 就是 ASCII 标点转义），等我们跑到时源码里已经没有反斜杠了；
 *   - `$` 挂在 `escape` **之后**：`\$` 那类要先被 escape 处理掉，
 *     否则 `$5\$3$` 这种（写「5 美元 3 美元」）会被当成公式的起止。
 */
export function registerMath(md: {
    inline: { ruler: unknown };
    block: { ruler: unknown };
}): void {
    const inlineRuler = md.inline.ruler as {
        before: (name: string, id: string, fn: unknown, opts?: unknown) => void;
        after: (name: string, id: string, fn: unknown, opts?: unknown) => void;
    };
    const blockRuler = md.block.ruler as { before: (name: string, id: string, fn: unknown, opts?: unknown) => void };
    inlineRuler.before("escape", "math_paren_inline", mathParenInline as never, { alt: [] });
    inlineRuler.after("escape", "math_inline", mathInline as never, { alt: ["escape"] });
    blockRuler.before("fence", "math_block", mathBlock as never, { alt: ["paragraph", "reference", "blockquote", "list"] });
}
