// src/hooks/useEditorTools.ts
// 编辑器「插入语法」工具集的**可复用工厂**（2026-10-06 从 NotesPage 抽出）。
//
// 为什么值得抽：这批回调（undoableInsert / insertAtCursor / 表格 / 公式 / 块…）
// 原来全部写在 NotesPage 组件体内、绑定组件自己的 textareaRef 与 setDraft。
// 「在侧边打开」要**第二台**编辑器（两个文档同时编辑），两台各自要有独立的
// 插入逻辑与「再点一次撤销」状态 —— 逻辑一字不差，只有「操作哪个编辑器、
// 写回哪份草稿」不同。抽成 hook 之后，主/侧编辑器各调一次，天然隔离：
//
//   - lastInsertRef / footnoteRefRef / lastToolRef（撤销状态）随 hook 实例独立，
//     主编辑器撤销不会误伤侧编辑器刚插入的片段；
//   - 所有回调仍然从 **textareaRef.current.value**（DOM/CM 状态）读正文，
//     不读 React 草稿 —— 连点两次按钮读到旧 state 的坑依然被绕开。
//
// ⚠️ hooks 不能条件调用：主/侧两个实例都要无条件挂载（侧编辑器没开时
// sideRef.current 是 null，回调内部本来就有判空，不会有副作用）。
import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import type { NoteEditorHandle } from "../utils/noteEditorHandle";
import { withBlockId, buildTabSource, buildFoldSource } from "../utils/noteBlocks";
import { buildFrontMatter, type FrontMatterEntry } from "../utils/noteFrontMatter";
import {
    addColumnRight,
    addRowBelow,
    buildTable,
    removeColumn,
    removeRow,
} from "../utils/markdownTable";

/** 草稿形状（与 NotesPage 的 draft / sideDraft 一致） */
export interface EditorDraft {
    title: string;
    content: string;
}

/** setDraft 的形状：函数式更新，null 表示当前没有打开的笔记 */
export type DraftSetter = (
    updater: (d: EditorDraft | null) => EditorDraft | null
) => void;

/** 工具栏能发出的表格操作（kind 决定走哪条纯函数）。NotesPage 的工具栏 prop 用同一份 */
export type TableOp =
    | { kind: "insert"; rows: number; cols: number }
    | { kind: "addRow" }
    | { kind: "delRow" }
    | { kind: "addCol" }
    | { kind: "delCol" };

/**
 * 拿到一整套「插入 Markdown 语法」的回调，绑定到指定的编辑器句柄与草稿 setter。
 * 每个回调的详细语义注释在原实现里（搬过来时逐字保留），这里只列清单。
 */
export function useEditorTools(
    textareaRef: RefObject<NoteEditorHandle | null>,
    setDraft: DraftSetter
) {
    /**
     * 上一次插入的片段（起止偏移 + 原文 + 是**哪个**按钮插的）。
     * 只靠位置判断取消是不行的：插完后光标落在整段之后，其两侧未必还是
     * 那两枚标记（比如在文末就什么都没有），硬判取消会把用户刚敲的 `**` 删掉。
     * ⚠️ before/after 必须一起记：少了这层校验，点完「粗体」再点「斜体」，
     * 斜体会把上一段粗体当成「同名按钮的第二次点击」给撤掉（浏览器实测抓出来的）。
     */
    const lastInsertRef = useRef<{
        start: number;
        snippet: string;
        /** 插进去的正文（`selected`，可能是占位符） */
        body: string;
        /** 这次插入是「包住一段真实选区」还是「没选东西、只塞了个占位符」 */
        hadSelection: boolean;
        before: string;
        after: string;
    } | null>(null);

    /** 「链接与引用」上一次插入的位置，用于「再点一次撤掉」 */
    const footnoteRefRef = useRef<{
        /** 正文里那个引用所在的位置 */
        refAt: number;
        snippet: string;
        definition: string;
        /** 插入时被引用替换掉的原文，撤掉时要还原回去 */
        body: string;
        /** 插入后光标停在哪。只有用户没动过光标才允许「再点一次撤掉」 */
        caretAfter: number;
    } | null>(null);

    /**
     * 通用「插一段 → 再点一次撤掉」开关。
     * 判据与 insertAtCursor 一致，缺一不可：
     *   - **同一个工具**（换了按钮就不算，不能拿别的按钮撤掉这一段）
     *   - **上次插的那段字还在原位**（用户改过别处就说明不是想「取消」，这时段对不上，
     *     当成一次新的插入，绝不误删正文）
     */
    const lastToolRef = useRef<{ tool: string; at: number; snippet: string } | null>(null);

    /** 包住一次「插入」。`build` 收到当前编辑器内容，算出插入后的文本与插入片段 */
    const undoableInsert = useCallback(
        (
            tool: string,
            build: (value: string) => {
                next: string;
                /** 插入内容在 next 里的起点 */
                at: number;
                /** 插进去的那一段（撤销时整段删掉） */
                snippet: string;
                caret: number;
                selEnd: number;
            } | null
        ) => {
            const el = textareaRef.current;
            if (!el) return;
            const value = el.value;
            const write = (next: string, caret: number, selEnd: number) => {
                el.value = next;
                el.focus();
                el.setSelectionRange(caret, selEnd);
                setDraft(d => (d ? { ...d, content: next } : d));
            };
            const last = lastToolRef.current;
            if (
                last &&
                last.tool === tool &&
                value.slice(last.at, last.at + last.snippet.length) === last.snippet
            ) {
                lastToolRef.current = null;
                const next =
                    value.slice(0, last.at) + value.slice(last.at + last.snippet.length);
                write(next, Math.min(last.at, next.length), Math.min(last.at, next.length));
                return;
            }
            const built = build(value);
            if (!built) return;
            lastToolRef.current = { tool, at: built.at, snippet: built.snippet };
            write(built.next, built.caret, built.selEnd);
        },
        [textareaRef, setDraft]
    );

    /**
     * 在光标处插入一段 Markdown 语法 —— **同名按钮是开关**。
     * 三条路径：① 连点同一个按钮 → 撤销上一次插入（真实选区只拆标记留正文）；
     * ② 选区已带标记 → 摘掉；③ 其余 → 包一层（没有选区就放占位符）。
     */
    const insertAtCursor = useCallback(
        (before: string, after: string, placeholder: string) => {
            const el = textareaRef.current;
            if (!el) return;
            // ⚠️ **内容要从编辑器句柄读，不能从 draft（React state）读**。
            // setDraft 是异步的：连点两下按钮时，第二次拿到的 draft 还是上一次
            // 插入之前的值，于是又从旧的 selectionStart 插一遍 —— 内容堆成一团。
            const content = el.value;
            const start = el.selectionStart ?? content.length;
            const end = el.selectionEnd ?? start;

            const writeBack = (next: string, caret: number, selEnd = caret) => {
                el.value = next;
                el.setSelectionRange(caret, selEnd);
                el.focus();
                setDraft(d => (d ? { ...d, content: next } : d));
            };

            // ① 连点**同一个**按钮 → 撤销上一次插入（用户要的「第二下取消」）
            const last = lastInsertRef.current;
            const sameTool = last && last.before === before && last.after === after;
            if (sameTool && content.slice(last.start, last.start + last.snippet.length) === last.snippet) {
                const at = last.start;
                lastInsertRef.current = null;
                if (last.hadSelection) {
                    // ② 只取消这层格式：摘掉 before/after，把选中的正文原样留在原地
                    const next =
                        content.slice(0, at) + last.body + content.slice(at + last.snippet.length);
                    writeBack(
                        next,
                        Math.min(at, next.length),
                        Math.min(at + last.body.length, next.length)
                    );
                } else {
                    // ③ 纯占位符插入（当时没选东西），第二下直接把这段撤掉
                    const next =
                        content.slice(0, at) + content.slice(at + last.snippet.length);
                    writeBack(next, Math.min(at, next.length));
                }
                return;
            }

            const seg = content.slice(start, end) || "";
            const pre = content.slice(start - before.length, start);
            const post = content.slice(end, end + after.length);
            const segHasMarks =
                seg.length > before.length + after.length &&
                seg.startsWith(before) &&
                seg.endsWith(after);
            const segBare = !seg.startsWith(before) && !seg.endsWith(after);
            const surrounding = pre === before && post === after;

            // ② 已经有这层格式 → 摘掉（取消加粗/斜体…）
            if (segHasMarks || (segBare && surrounding)) {
                const body = segHasMarks ? seg.slice(before.length, seg.length - after.length) : seg;
                const from = segHasMarks ? start : start - before.length;
                const to = segHasMarks ? end : end + after.length;
                const next = content.slice(0, from) + body + content.slice(to);
                lastInsertRef.current = null;
                writeBack(next, Math.min(from, next.length), Math.min(from + body.length, next.length));
                return;
            }

            // ③ 包一层。⚠️ 光标必须落在**整段**之后（含 after），否则接着打字会插进标记里。
            const selected = seg || placeholder;
            const next =
                content.slice(0, start) + before + selected + after + content.slice(end);
            lastInsertRef.current = {
                start,
                snippet: before + selected + after,
                body: selected,
                hadSelection: seg.length > 0,
                before,
                after,
            };
            // 有选区时把刚包上的正文重新选上（再点一下「取消」要靠它）
            if (seg.length > 0) {
                const bodyFrom = start + before.length;
                writeBack(next, bodyFrom, Math.min(bodyFrom + selected.length, next.length));
            } else {
                writeBack(
                    next,
                    Math.min(next.length, start + before.length + selected.length + after.length)
                );
            }
        },
        [textareaRef, setDraft]
    );

    /** 内容块（inkstone 工具栏「内容块」）：插一个 `> [!NOTE]` 骨架 */
    const insertCallout = useCallback((type: string) => {
        undoableInsert(`callout:${type}`, value => {
            const pos = textareaRef.current?.selectionStart ?? value.length;
            const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
            // 已经在引用块里就别再套一层 `>`，否则会变成 `>> [!NOTE]`
            const inQuote = value.slice(lineStart, pos).startsWith(">");
            const snippet = inQuote ? `[!${type}] ` : `> [!${type}] `;
            const caret = lineStart + snippet.length;
            return {
                next: value.slice(0, lineStart) + snippet + value.slice(lineStart),
                at: lineStart,
                snippet,
                caret,
                selEnd: caret,
            };
        });
    }, [undoableInsert, textareaRef]);

    /** 「链接与引用」：把**选中的文字**变成一条脚注引用（文末补定义） */
    const insertFootnoteRef = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        const content = el.value;
        const start = el.selectionStart ?? content.length;
        const end = el.selectionEnd ?? start;
        const writeBack = (next: string, caret: number, selEnd = caret) => {
            el.value = next;
            el.setSelectionRange(caret, selEnd);
            el.focus();
            setDraft(d => (d ? { ...d, content: next } : d));
        };

        // ① 连点第二下 → 撤掉上一次插入的这条引用。
        //    两个前置条件缺一不可：片段还在原位 + 光标仍停在插入后的位置
        //    （用户挪过光标就说明不是想「取消」）。
        const last = footnoteRefRef.current;
        const caretNow = el.selectionStart ?? content.length;
        if (
            last &&
            content.slice(last.refAt, last.refAt + last.snippet.length) === last.snippet &&
            caretNow === last.caretAfter
        ) {
            const restored =
                content.slice(0, last.refAt) + last.body + content.slice(last.refAt + last.snippet.length);
            const defAt = restored.indexOf(last.definition);
            const cleaned = (
                defAt >= 0
                    ? restored.slice(0, defAt) + restored.slice(defAt + last.definition.length)
                    : restored
            ).replace(/\s+$/, "");
            footnoteRefRef.current = null;
            writeBack(cleaned, Math.min(last.refAt, cleaned.length));
            return;
        }

        // ② 编号：文末已有脚注的最大序号 + 1（固定从 1 开始会写出同名定义）
        let max = 0;
        for (const m of content.matchAll(/\[\^(\d+)\]/g)) {
            const n = Number(m[1]);
            if (n > max) max = n;
        }
        const num = max + 1;
        const snippet = `[^${num}]`;
        const body = content.slice(start, end).trim() || "引用内容";

        // 先在正文把选区换成引用，再在文末补定义 —— 顺序反了引用会落在定义之后
        const withRef =
            content.slice(0, start) + snippet + content.slice(end);
        const trimmedEnd = withRef.replace(/\s+$/, "");
        const definition = `\n\n[^${num}]: ${body}`;
        const next = `${trimmedEnd}${definition}`;
        const caret = trimmedEnd.length + definition.length;
        footnoteRefRef.current = { refAt: start, snippet, definition, body, caretAfter: caret };
        writeBack(next, caret);
    }, [textareaRef, setDraft]);

    /** 给代码块定语言：在围栏里只改围栏行；不在就插一个新围栏 */
    const applyCodeLanguage = useCallback((lang: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const end = el.selectionEnd ?? pos;

        const lines = value.split("\n");
        const cursorLine = value.slice(0, pos).split("\n").length - 1;
        const isFence = (s: string) => /^\s*```/.test(s);

        let openLine = -1;
        for (let i = Math.min(cursorLine, lines.length - 1); i >= 0; i--) {
            if (isFence(lines[i])) {
                openLine = i;
                break;
            }
        }
        let closeLine = -1;
        if (openLine >= 0) {
            for (let i = openLine + 1; i < lines.length; i++) {
                if (isFence(lines[i])) {
                    closeLine = i;
                    break;
                }
            }
        }
        // ⚠️ 判「在不在围栏里」必须同时找到开和闭两行，且光标夹在中间
        const insideFence =
            openLine >= 0 && closeLine > openLine && cursorLine >= openLine && cursorLine <= closeLine;

        let next: string;
        let caret: number;
        let caretEnd: number;

        if (insideFence) {
            lines[openLine] = "```" + lang;
            next = lines.join("\n");
            const delta = lines[openLine].length - value.split("\n")[openLine].length;
            caret = Math.min(pos + delta, next.length);
            caretEnd = Math.min(end + delta, next.length);
        } else {
            const body = value.slice(pos, end) || "代码";
            const block = "```" + lang + "\n" + body + "\n```";
            const head = value.slice(0, pos);
            const tail = value.slice(end);
            const lead = head && !head.endsWith("\n") ? "\n" : "";
            const trail = tail && !tail.startsWith("\n") ? "\n" : "";
            next = head + lead + block + trail + tail;
            const bodyStart = head.length + lead.length + lang.length + 3 + 1; // ```lang + \n
            caret = bodyStart;
            caretEnd = Math.min(bodyStart + body.length, next.length);
        }

        el.value = next;
        el.focus();
        el.setSelectionRange(caret, caretEnd);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, [textareaRef, setDraft]);

    /** 表格的插入 / 增删行列（纯函数在 utils/markdownTable） */
    const applyTable = useCallback((op: TableOp) => {
        if (op.kind === "insert") {
            // 「插入表格」也要能再点一次撤掉；增删行列改的是已有表格，不走开关
            undoableInsert(`table:${op.rows}x${op.cols}`, value => {
                const p = textareaRef.current?.selectionStart ?? value.length;
                const lineEnd = value.indexOf("\n", p);
                const stop = lineEnd < 0 ? value.length : lineEnd;
                // 同 insertBlock：按整行切，别把光标所在行的正文丢掉
                const above = value.slice(0, stop);
                const below = value.slice(stop);
                const table = buildTable(op.rows, op.cols);
                const lead = above && !above.endsWith("\n") ? "\n" : "";
                const trail = below && !below.startsWith("\n") ? "\n" : "";
                const snippet = lead + ["", ...table, ""].join("\n") + trail;
                const next = above + snippet + below;
                const at = above.length;
                const caret = at + lead.length;
                return { next, at, snippet, caret, selEnd: caret };
            });
            return;
        }

        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const lines = value.split("\n");
        const cursorLine = value.slice(0, pos).split("\n").length - 1;
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const cursorCol = pos - lineStart;

        let next: string[];
        switch (op.kind) {
            case "addRow":
                next = addRowBelow(lines, cursorLine);
                break;
            case "delRow":
                next = removeRow(lines, cursorLine);
                break;
            case "addCol":
                next = addColumnRight(lines, cursorLine, cursorCol);
                break;
            case "delCol":
                next = removeColumn(lines, cursorLine, cursorCol);
                break;
        }

        const nextValue = next.join("\n");
        const targetLine = Math.min(cursorLine, next.length - 1);
        const before = next.slice(0, targetLine).join("\n").length + (targetLine > 0 ? 1 : 0);
        const caret = Math.min(before + cursorCol, nextValue.length);

        el.value = nextValue;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: nextValue } : d));
    }, [undoableInsert, textareaRef, setDraft]);

    /** 插入公式：行内走 insertAtCursor；块级必须独占行，按整行切开插 */
    const applyFormula = useCallback(
        (kind: "inline" | "block" | "inlineTex" | "blockTex") => {
            const tex = kind === "inlineTex" || kind === "blockTex";
            const [open, close] = tex ? ["\\(", "\\)"] : ["$", "$"];
            if (kind === "inline" || kind === "inlineTex") {
                insertAtCursor(open, close, "公式");
                return;
            }
            const fence = tex ? ["\\[", "\\]"] : ["$$", "$$"];
            undoableInsert(`formula:${kind}`, value => {
                const pos = textareaRef.current?.selectionStart ?? value.length;
                const end = textareaRef.current?.selectionEnd ?? pos;
                const body = value.slice(pos, end) || "公式";
                // ⚠️ 按「整行」切，不能只留行首之前的内容 ——
                // 否则光标停在行中间时那一行的正文会被整段丢掉。
                const lineEnd = value.indexOf("\n", pos);
                const stop = lineEnd < 0 ? value.length : lineEnd;
                const above = value.slice(0, stop);
                const below = value.slice(stop);
                const lead = above && !above.endsWith("\n") ? "\n" : "";
                const trail = below && !below.startsWith("\n") ? "\n" : "";
                const snippet = lead + [fence[0], body, fence[1]].join("\n") + trail;
                const next = above + snippet + below;
                const at = above.length;
                const caret = at + lead.length + fence[0].length + 1;
                return { next, at, snippet, caret, selEnd: caret + body.length };
            });
        },
        [insertAtCursor, undoableInsert, textareaRef]
    );

    /** 行首插入前缀（标题 `# `、引用 `> `、列表 `- `） */
    const insertLinePrefix = useCallback((prefix: string) => {
        undoableInsert(`prefix:${prefix}`, value => {
            const pos = textareaRef.current?.selectionStart ?? value.length;
            // ⚠️ lastIndexOf 第二个参数用 pos - 1 且夹到 0：第 0 个字符前没有行首
            const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
            const caret = lineStart + prefix.length;
            return {
                next: value.slice(0, lineStart) + prefix + value.slice(lineStart),
                at: lineStart,
                snippet: prefix,
                caret,
                selEnd: caret,
            };
        });
    }, [undoableInsert, textareaRef]);

    /**
     * 在光标所在行**下面**插入一整块（嵌入 / 折叠 / 标签页 / 分隔线都走这条）。
     * ⚠️ 必须按「整行」切开而不是「行首」—— 否则光标所在行的正文会被整段丢掉。
     */
    const insertBlock = useCallback((tool: string, block: string) => {
        undoableInsert(`block:${tool}`, value => {
            const pos = textareaRef.current?.selectionStart ?? value.length;
            const lineEnd = value.indexOf("\n", pos);
            const end = lineEnd < 0 ? value.length : lineEnd;
            const above = value.slice(0, end);
            const below = value.slice(end);
            const lead = above && !above.endsWith("\n") ? "\n" : "";
            const trail = below && !below.startsWith("\n") ? "\n" : "";
            const snippet = lead + block + trail;
            const next = above + snippet + below;
            const at = above.length;
            const caret = at + lead.length;
            return { next, at, snippet, caret, selEnd: caret + block.length };
        });
    }, [undoableInsert, textareaRef]);

    /** 笔记嵌入 `![[标题]]`（块级，单独成行） */
    const onInsertEmbed = useCallback(() => {
        insertBlock("embed", "![[笔记标题]]");
    }, [insertBlock]);

    /** 块引用 `![[标题#^块ID]]`（块级，单独成行） */
    const onInsertBlockRef = useCallback(() => {
        insertBlock("blockref", "![[笔记标题#^块ID]]");
    }, [insertBlock]);

    /** 给当前行追加一个块 ID（` ^abc12`），供 `![[标题#^块ID]]` 引用 */
    const onInsertBlockId = useCallback(() => {
        undoableInsert("blockid", value => {
            const pos = textareaRef.current?.selectionStart ?? value.length;
            const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
            const lineEnd = value.indexOf("\n", pos);
            const end = lineEnd < 0 ? value.length : lineEnd;
            const line = value.slice(lineStart, end);
            const id = Math.random().toString(36).slice(2, 7);
            const newLine = withBlockId(line, id);
            // 记的 snippet 是**新追加的那一截**，撤销时只删它，正文一个字都不动
            const snippet = newLine.slice(line.length);
            const at = lineStart + line.length;
            return {
                next: value.slice(0, lineStart) + newLine + value.slice(end),
                at,
                snippet,
                caret: at + snippet.length,
                selEnd: at + snippet.length,
            };
        });
    }, [undoableInsert, textareaRef]);

    /** 在笔记最前面插入 YAML 属性块 */
    const onInsertFrontMatter = useCallback(() => {
        undoableInsert("frontmatter", value => {
            const entries: FrontMatterEntry[] = [{ key: "tags", value: "", list: [] }];
            const fm = buildFrontMatter(entries);
            const snippet = fm + (value && !value.startsWith("\n") ? "\n" : "");
            return {
                next: snippet + value,
                at: 0,
                snippet,
                caret: snippet.length,
                selEnd: snippet.length,
            };
        });
    }, [undoableInsert]);

    /** 插入标签 `#标签`（行内） */
    const onInsertTag = useCallback(() => {
        insertAtCursor("#", "", "标签");
    }, [insertAtCursor]);

    /** 插入双链 `[[标题]]`（行内，可点跳转） */
    const onInsertWikiLink = useCallback(() => {
        insertAtCursor("[[", "]]", "笔记标题");
    }, [insertAtCursor]);

    /** 插入隐藏注释 `%%…%%`（预览不显示） */
    const onInsertHiddenComment = useCallback(() => {
        insertAtCursor("%%", "%%", "隐藏注释");
    }, [insertAtCursor]);

    /** 插入折叠块 `> [!FOLD] 标题` */
    const onInsertFold = useCallback(() => {
        insertBlock("fold", buildFoldSource(""));
    }, [insertBlock]);

    /** 插入标签页容器 `:::tabs … :::` */
    const onInsertTabs = useCallback(() => {
        insertBlock("tabs", buildTabSource());
    }, [insertBlock]);

    /** 插入分隔线 `---` */
    const onInsertDivider = useCallback(() => {
        insertBlock("divider", "---");
    }, [insertBlock]);

    /**
     * 大纲跳转：把光标送到那一行并**选中整行**。
     * 只挪光标不选中的话，长笔记里落点在哪一格根本看不见。
     */
    const jumpToOffset = useCallback((offset: number) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const from = offset;
        const nl = value.indexOf("\n", from);
        const to = nl === -1 ? value.length : nl;
        el.focus();
        el.setSelectionRange(from, to);
    }, [textareaRef]);

    return {
        undoableInsert,
        insertAtCursor,
        insertCallout,
        insertFootnoteRef,
        applyCodeLanguage,
        applyTable,
        applyFormula,
        insertLinePrefix,
        insertBlock,
        onInsertEmbed,
        onInsertBlockRef,
        onInsertBlockId,
        onInsertFrontMatter,
        onInsertTag,
        onInsertWikiLink,
        onInsertHiddenComment,
        onInsertFold,
        onInsertTabs,
        onInsertDivider,
        jumpToOffset,
    };
}

export type EditorTools = ReturnType<typeof useEditorTools>;
