// src/utils/markdownClipChip.ts
// 行内「复制胶囊」语法：`{{clip:内容}}` —— 选中一段行内文字，点工具栏的
// 「复制胶囊」，它被包成这个语法；预览 / 阅读 / 分享页里渲染成一枚虚线小胶囊，
// 点一下就把内容写进剪贴板。
//
// 为什么是 `{{clip:…}}`（定界符选型，2026-11-06 逐条 grep 过 src/ 与 docs/）：
//   `` `行内代码` `` / `==高亮==` / `$…$` `\(…\)` 行内数学 / `$$…$$` 块级数学 /
//   `#标签` / `[[双链]]`（含 `![[…]]` 嵌入与 `![[笔记#^块ID]]` 块引用）/
//   `%%隐藏注释%%` / `> [!NOTE]` 内容块 / `:::tabs … :::` / `---` 分隔线 ——
//   以上全都已占用，而 `{{` 在 src/ 里**只出现在 JSX 的对象字面量**（`sx={{…}}`），
//   在笔记语法里一处都没有（docs/ 里仅有的几处是 docker 的 `--format '{{...}}'`
//   示例，不会被当笔记正文解析）。花括号形态同时满足「肉眼一眼能看出是机器标记」
//   与「不会被正文随手写出来」，所以选它。
//
// 为什么**不**做嵌套（内容里再写 `**粗体**` / `` `代码` ``）：
//   1. 语义上胶囊的产出是「复制这段文本」，而复制出去的就是**纯文本**。把内层
//      语法解析出来渲染成粗体，反而制造「看到的是粗体、复制出去是星号」的错觉；
//   2. 技术上要支持就得在 inline 规则里递归跑一遍 `md.inline.parse` 并把 token 的
//      level / children 搬回外层游标，踩的是 markdown-it 内部状态（本项目渲染层
//      只把 markdown-it 当解析器，token 流是单向的），收益远小于风险；
//   3. v32 刚把「复制块」整体下线过一轮，新形态**越简单越安全**。
//   因此内容按**纯文本**渲染（含 `` 与 `**` 都原样显示），这与「复制出去的东西」
//   完全一致 —— 所见即所得。
//
// 判据（宁可漏认也不误伤正文）：
//   - 必须整串以 `{{clip:` 开头，闭合符是第一处 `}}`；
//   - 不跨行（遇到 `\n` 就放弃，交给后面的规则/普通文本）；
//   - 内容（去掉首尾空白后）为空 → 不认；
//   - 转义：`\{{clip:x}}` 里的 `\{` 会被 markdown-it 的 `escape` 规则先吃掉，
//     本规则排在 `escape` **之后**，所以被转义的那种不会被当成胶囊。
//
// 注册顺序：`ruler.after("escape", …)` —— 与 `==高亮==` 同款。
// 排在 `backticks` 之前不会抢走行内代码：`text` 规则遇到 `{` 就停，
// 而落在反引号里的 `{{clip:…}}` 由 `backticks` 整段吃掉（本规则只在当前位置
// 是 `{` 时才可能命中，位置对不上就返回 false）。

import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

/** 开标记。工具链（工具栏 / hook）与解析器共用同一份常量，避免两边写歪 */
export const CLIP_CHIP_OPEN = "{{clip:";
/** 闭标记 */
export const CLIP_CHIP_CLOSE = "}}";
/** 没选中内容时插入的占位文本（用户直接在上面改） */
export const CLIP_CHIP_PLACEHOLDER = "要复制的内容";
/** token 类型名（渲染层按它分流）。刻意不含任何大写 COPY —— 旧复制块守卫盯着那几个字面量 */
export const CLIP_CHIP_TOKEN = "clip_chip";
/** 「已复制」态保持时长（毫秒）：够看清变色，又不至于让人等 */
export const CLIP_CHIP_RESET_MS = 1200;

/**
 * 行内规则：读 `{{clip:内容}}`。
 *
 * 返回 false 表示「这次不匹配」—— 此时**绝不能**动 `state.pos`，
 * 否则后面的解析会整段跑偏（markdown-it 的硬约定）。
 */
export function clipInline(state: StateInline, silent: boolean): boolean {
    const start = state.pos;
    const src = state.src;
    if (src.slice(start, start + CLIP_CHIP_OPEN.length) !== CLIP_CHIP_OPEN) return false;

    const bodyStart = start + CLIP_CHIP_OPEN.length;
    let pos = bodyStart;
    let end = -1;
    while (pos < state.posMax) {
        const ch = src[pos];
        if (ch === "\n") break; // 行内胶囊不跨行
        if (ch === "}" && src[pos + 1] === "}") {
            end = pos;
            break;
        }
        pos++;
    }
    if (end < 0) return false;

    const content = src.slice(bodyStart, end);
    // 空内容（`{{clip:}}` / `{{clip:   }}`）不认：那多半是用户手抖写出来的，
    // 渲染成一枚点了没东西可复制的空胶囊比留着原文更糟
    if (!content.trim()) return false;

    if (!silent) {
        const token = state.push(CLIP_CHIP_TOKEN, "", 0);
        token.content = content;
        token.markup = CLIP_CHIP_OPEN;
    }
    state.pos = end + CLIP_CHIP_CLOSE.length;
    return true;
}

/** 把本语法装进一个 markdown-it 实例（解析层；渲染层的映射在 markdownToReact.tsx） */
export function registerClipChip(md: { inline: { ruler: unknown } }): void {
    const inlineRuler = md.inline.ruler as {
        after: (name: string, id: string, fn: unknown, opts?: unknown) => void;
    };
    inlineRuler.after("escape", CLIP_CHIP_TOKEN, clipInline as never, { alt: [] });
}

/**
 * 单行里的胶囊替换：内容非空才替换（与解析器同一把尺子）。
 *
 * ⚠️ 前面那组 `(\\*)` 不是装饰：markdown-it 的 `escape` 规则会**成对**吃掉连续
 * 反斜杠（N 枚 → floor(N/2) 枚字面反斜杠），剩最后一枚（奇数）时才去转义紧跟的
 * 标点。所以 `\{{clip:甲}}` 在预览里是：反斜杠被吃掉、第一个 `{` 原样吐出，
 * 剩下的 `{clip:甲}}` 凑不出双花括号 → **不是胶囊**，用户看到的是字面量
 * `{{clip:甲}}`。
 *
 * 降级函数如果只看 `{{clip:…}}` 就把定界符摘掉，会输出 `\甲` —— 用户看到
 * `{{clip:甲}}`、导出/分享页复制出去却是 `\甲`，两条链路判据不一致。
 * 因此奇数枚反斜杠时：去掉那枚转义反斜杠、整段**原样保留**（连定界符一起留着），
 * 纯文本输出与预览字面严格相等；偶数枚（含 0 枚）时反斜杠是字面量，胶囊照常降级。
 *
 * 范围说明：这里只对齐「胶囊开标记被转义」这一种情形，不去模拟 markdown-it
 * `escape` 对其它标点（如 `\{`、`\*`）的全套行为 —— 那属于另一条链路的既有差异，
 * 不在本次修复范围内（别为了一个 bug 把降级函数重写成 Markdown 解析器）。
 */
const CHIP_LINE_RE = /(\\*)\{\{clip:([^\n]*?)\}\}/g;
function replaceChips(text: string): string {
    return text.replace(
        CHIP_LINE_RE,
        (whole: string, slashes: string, body: string) => {
            const literalSlashes = "\\".repeat(Math.floor(slashes.length / 2));
            if (slashes.length % 2 === 1) {
                // 转义过的开标记：只摘掉那枚转义反斜杠，定界符一个都不动
                return literalSlashes + whole.slice(slashes.length);
            }
            // 没转义（或偶数枚反斜杠）：内容非空才降级成纯文本
            return literalSlashes + (body.trim() ? body : whole.slice(slashes.length));
        }
    );
}

/**
 * 行内代码段原样保留，其余部分做胶囊替换。
 *
 * 为什么要管行内代码：`{{clip:x}}` 写在反引号里时，解析器**不会**把它当胶囊
 * （`backticks` 整段吃掉），降级函数如果照样替换，就会出现
 * 「预览里是代码、导出的文件里变成内容」的错位。
 */
function stripOutsideInlineCode(line: string): string {
    let out = "";
    let i = 0;
    while (i < line.length) {
        if (line[i] !== "`") {
            const next = line.indexOf("`", i);
            const stop = next < 0 ? line.length : next;
            out += replaceChips(line.slice(i, stop));
            i = stop;
            continue;
        }
        // 数连续反引号的个数：```…``` 里嵌套单个 ` 是合法写法
        let run = 0;
        while (line[i + run] === "`") run++;
        const fence = "`".repeat(run);
        const close = line.indexOf(fence, i + run);
        if (close < 0) {
            // 没闭合的反引号按普通文本处理（markdown-it 也是这么办的）
            out += replaceChips(line.slice(i));
            break;
        }
        out += line.slice(i, close + run); // 代码段原样留下
        i = close + run;
    }
    return out;
}

/**
 * 纯文本降级：把 `{{clip:内容}}` 还原成 `内容`，定界符一个都不带出去。
 *
 * 用在哪（三处都是「用户要把正文抄走」的路径）：
 *   - 公开分享页的「复制为 Markdown」（PublicNotePage.copyMarkdown）；
 *   - 笔记导出（noteExport.buildNoteMarkdown → .md 文件 / 导出 HTML 的正文）；
 *   - 阅读态 Ctrl+A 复制**不需要**它：渲染层把内容放成纯文本节点、尾部字形
 *     带 `user-select: none`，浏览器复制出来天然只有内容。
 *
 * 围栏代码块（``` / ~~~）里的内容整段跳过 —— 那是示例代码，不是语法。
 */
export function clipChipsToPlainText(markdown: string): string {
    if (!markdown || !markdown.includes(CLIP_CHIP_OPEN)) return markdown;
    const out: string[] = [];
    let fence: string | null = null;
    for (const line of markdown.split("\n")) {
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            if (
                fenceMatch &&
                fenceMatch[1][0] === fence[0] &&
                fenceMatch[1].length >= fence.length
            ) {
                fence = null; // 闭合围栏
            }
            out.push(line);
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1];
            out.push(line);
            continue;
        }
        out.push(stripOutsideInlineCode(line));
    }
    return out.join("\n");
}
