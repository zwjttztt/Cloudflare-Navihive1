import { useEffect, useLayoutEffect, useRef, useImperativeHandle, useState, type Ref } from "react";
import { EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, Decoration, type DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentUnit } from "@codemirror/language";

import { editorHandle, type NoteEditorHandle } from "../utils/noteEditorHandle";

// 字体/字号走 CSS 变量而不是把值写死进 theme：设置面板改字号时不用重建编辑器
//（重建会丢撤销历史）。变量由宿主元素上的 style 提供。
const theme = EditorView.theme({
    "&": {
        height: "100%",
        color: "inherit",
        backgroundColor: "transparent",
        fontSize: "var(--note-editor-font-size, 14px)",
    },
    ".cm-scroller": {
        overflow: "auto",
        fontFamily: "var(--note-editor-font, ui-monospace, monospace)",
        lineHeight: "1.75",
    },
    ".cm-content": { padding: "16px 8px", minHeight: "100%", caretColor: "currentColor" },
    ".cm-gutters": { backgroundColor: "transparent", color: "inherit", opacity: "0.55", borderRight: "1px solid rgba(128,128,128,.2)" },
    ".cm-activeLine": { backgroundColor: "rgba(128,128,128,.08)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(100,140,220,.3)" },
});

/**
 * 取光标所在「段落」的范围：从光标行往上到空行为止、往下到空行为止。
 * 「编辑区实时渲染」与「专注模式」共用这一套判定 —— 两处口径必须一致，
 * 否则会出现「实时渲染的那段正好是被淡化的那段」的怪现象。
 */
function paragraphRange(state: EditorState, pos: number): { from: number; to: number } {
    const doc = state.doc;
    const line = doc.lineAt(pos);
    let start = line;
    while (start.number > 1) {
        const prev = doc.line(start.number - 1);
        if (prev.text.trim() === "") break;
        start = prev;
    }
    let end = line;
    while (end.number < doc.lines) {
        const next = doc.line(end.number + 1);
        if (next.text.trim() === "") break;
        end = next;
    }
    return { from: start.from, to: end.to };
}

/** 淡化一整行（专注模式用）。用 className 走主题变量，亮/暗色都能看得出层次。 */
const DIMMED_LINE_DECORATION = Decoration.line({ class: "cm-focus-dimmed" });

/** 承载专注模式的装饰集；null = 关闭。 */
const setFocusEffect = StateEffect.define<DecorationSet | null>();

const focusField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setFocusEffect)) return effect.value ?? Decoration.none;
        }
        return tr.docChanged || tr.selection ? value.map(tr.changes) : value;
    },
    provide: f => EditorView.decorations.from(f),
});

export interface NoteEditorProps {
    value: string;
    onChange: (value: string) => void;
    editorRef: Ref<NoteEditorHandle>;
    /** 显示行号（设置面板「显示行号」）。默认开。改这项会重建编辑器（key 由调用方拼） */
    lineNumbers?: boolean;
    /** 拼写检查（设置面板「拼写检查」）。默认关 —— 与 CodeMirror 的覆盖层配合不佳 */
    spellcheck?: boolean;
    /** 等宽 / 无衬线（设置面板「编辑器字体」），只换 CSS 变量，不重建 */
    font?: "mono" | "sans";
    /** 编辑器字号（px），只换 CSS 变量，不重建 */
    fontSize?: number;
    /** 缩进宽度（设置面板「缩进宽度」2/4）。是扩展：改了会重建编辑器（key 由调用方拼） */
    indentWidth?: 2 | 4;
    /**
     * 源码滚动时把「滚了多少比例」报出去（设置面板「滚动同步」用）。
     * 报比例而不是像素：预览与源码行高不同，像素对不齐，比例才稳。
     */
    onScrollRatio?: (ratio: number) => void;
    /**
     * 专注模式（inkstone 编辑器页同名功能）：把光标所在段落**以外**的内容淡化，
     * 只留当前这段是正常亮度。段落范围与「即时渲染」用的是同一套计算。
     */
    focusMode?: boolean;
    /**
     * 「即时渲染」用：把**光标所在段落**的原文报出去，由宿主渲染成 HTML 贴在编辑器里。
     *
     * ⚠️ 为什么是段落而不是整篇：整篇渲染等于把预览区复制一份到编辑区，
     * 大文档会卡到没法打字；只渲染当前段落既能实时看到效果，又不拖慢编辑。
     * 回调放进 ref：换回调不重建编辑器（重建会丢撤销历史）。
     */
    onCursorParagraph?: (text: string) => void;
}

export default function NoteEditor({
    value,
    onChange,
    editorRef,
    lineNumbers: showLineNumbers = true,
    spellcheck = false,
    font = "mono",
    fontSize = 14,
    indentWidth = 2,
    onScrollRatio,
    onCursorParagraph,
    focusMode = false,
}: NoteEditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const changeRef = useRef(onChange);
    // 滚动回调放进 ref：换回调不该重建编辑器（会丢撤销历史）
    const scrollRef = useRef(onScrollRatio);
    useLayoutEffect(() => { scrollRef.current = onScrollRatio; }, [onScrollRatio]);
    const paraRef = useRef(onCursorParagraph);
    useLayoutEffect(() => { paraRef.current = onCursorParagraph; }, [onCursorParagraph]);
    // 专注模式是**装饰**：它是纯视觉的开关，所以走 ref + 一个重绘 effect，
    // 绝不能进 extensions 依赖（那会让整台编辑器重建、撤销历史清空）。
    const focusRef = useRef(focusMode);
    focusRef.current = focusMode;
    /** 专注模式的重算函数挂到 ref：编辑器**建好后**内容才灌进来（挂载时 doc 是空的），
        之后任何一次 doc 变化都得重算一遍，否则淡化永远算在空文档上（实测 marks=0）。 */
    const focusRebuildRef = useRef<(() => void) | null>(null);
    const [focusTick, setFocusTick] = useState(0);
    useEffect(() => { setFocusTick(t => t + 1); }, [focusMode]);
    useLayoutEffect(() => { changeRef.current = onChange; }, [onChange]);
    useLayoutEffect(() => {
        const view = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: value,
                extensions: [
                    markdown(), history(), bracketMatching(), focusField,
                    // 缩进宽度（设置面板）：Tab / 自动缩进都认它
                    indentUnit.of(" ".repeat(indentWidth)),
                    // 行号是扩展不是样式：关掉它只能在建编辑器时决定 ——
                    // 所以设置里切这一项由调用方用 key 重建本组件（会丢撤销历史，可接受）
                    ...(showLineNumbers ? [lineNumbers()] : []),
                    highlightActiveLine(),
                    syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, theme,
                    placeholder("支持 Markdown：标题、列表、公式和脚注"),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.contentAttributes.of({
                        "aria-label": "笔记内容",
                        "aria-multiline": "true",
                        role: "textbox",
                        // 浏览器原生拼写检查默认跟随 lang；这里显式受设置控制
                        spellcheck: spellcheck ? "true" : "false",
                    }),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            changeRef.current(update.state.doc.toString());
                            // 正文变了 → 专注模式的「当前段落」可能换了一段，重算淡化
                            if (focusRef.current) focusRebuildRef.current?.();
                        }
                        // 光标所在段落：光标移动或正文改动都算（段落可能被改写）
                        if (update.docChanged || update.selectionSet) {
                            const pos = update.state.selection.main.head;
                            const range = paragraphRange(update.state, pos);
                            paraRef.current?.(update.state.sliceDoc(range.from, range.to));
                        }
                    }),
                ],
            }),
        });
        viewRef.current = view;
        // 滚动同步：报「滚了多少比例」给预览窗（设置面板可关）。
        // 监听挂在 scrollDOM 上而不是外层 div —— scroll 事件不冒泡，挂外面收不到。
        const onScroll = () => {
            const el = view.scrollDOM;
            const max = el.scrollHeight - el.clientHeight;
            scrollRef.current?.(max > 0 ? el.scrollTop / max : 0);
        };
        view.scrollDOM.addEventListener("scroll", onScroll);
        return () => {
            view.scrollDOM.removeEventListener("scroll", onScroll);
            view.destroy();
            viewRef.current = null;
        };
        // 组件由笔记 id + 行号/拼写/缩进开关做 key；输入期间不重建编辑器或丢撤销历史。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showLineNumbers, spellcheck, indentWidth]);
    /**
     * 专注模式：把当前段落之外的行淡化。
     * 实现成 ViewPlugin（每次 doc/selection 变化重算装饰），另有一个 effect 在开关
     * 变化时强制重绘 —— 因为开关本身不是 CM 的 state，不触发 transaction。
     */
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (!focusMode) {
            view.dispatch({ effects: setFocusEffect.of(null) });
            return;
        }
        const rebuild = () => {
            const range = paragraphRange(view.state, view.state.selection.main.head);
            // ⚠️ 必须用 Decoration.set(...) 造出真正的 **DecorationSet**。
            // 之前用 RangeSetBuilder，它 finish() 出来的是普通 RangeSet ——
            // 类型上勉强能塞进 StateEffect，但 CM6 的 decorations facet 拿到它
            // 不会给任何行加 class，表现为「开关打开了、什么都没变」（实测踩过）。
            const marks: ReturnType<Decoration["range"]>[] = [];
            const total = view.state.doc.lines;
            for (let n = 1; n <= total; n++) {
                const line = view.state.doc.line(n);
                if (n === 1) continue;                        // 第一行始终保持原样（否则标题行一进来就灰的）
                if (line.to >= range.from && line.from <= range.to) continue; // 当前段落
                marks.push(DIMMED_LINE_DECORATION.range(line.from));
            }
            view.dispatch({ effects: setFocusEffect.of(Decoration.set(marks, true)) });
        };
        focusRebuildRef.current = rebuild;
        rebuild();
        const onChange = () => focusRef.current && rebuild();
        view.dom.addEventListener("keyup", onChange);
        view.dom.addEventListener("mouseup", onChange);
        return () => {
            focusRebuildRef.current = null;
            view.dom.removeEventListener("keyup", onChange);
            view.dom.removeEventListener("mouseup", onChange);
        };
    }, [focusMode, focusTick]);

    useImperativeHandle(editorRef, () => editorHandle(viewRef.current!), []);
    useEffect(() => {
        const view = viewRef.current;
        if (view && view.state.doc.toString() !== value) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
        }
    }, [value]);
    return (
        <div
            ref={host}
            data-note-editor
            style={{
                height: "100%",
                minHeight: 0,
                overflow: "hidden",
                "--note-editor-font":
                    font === "sans"
                        ? "inherit, system-ui, sans-serif"
                        : "ui-monospace, monospace",
                "--note-editor-font-size": `${fontSize}px`,
            } as React.CSSProperties}
        />
    );
}
