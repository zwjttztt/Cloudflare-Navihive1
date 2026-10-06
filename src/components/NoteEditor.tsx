import { useEffect, useLayoutEffect, useRef, useImperativeHandle, type Ref } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";

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
}

export default function NoteEditor({
    value,
    onChange,
    editorRef,
    lineNumbers: showLineNumbers = true,
    spellcheck = false,
    font = "mono",
    fontSize = 14,
}: NoteEditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const changeRef = useRef(onChange);
    useLayoutEffect(() => { changeRef.current = onChange; }, [onChange]);
    useLayoutEffect(() => {
        const view = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: value,
                extensions: [
                    markdown(), history(), bracketMatching(),
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
                        if (update.docChanged) changeRef.current(update.state.doc.toString());
                    }),
                ],
            }),
        });
        viewRef.current = view;
        return () => { view.destroy(); viewRef.current = null; };
        // 组件由笔记 id + 行号/拼写开关做 key；输入期间不重建编辑器或丢撤销历史。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showLineNumbers, spellcheck]);
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
