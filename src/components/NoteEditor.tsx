import { useEffect, useLayoutEffect, useRef, useImperativeHandle, type Ref } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from "@codemirror/language";

import { editorHandle, type NoteEditorHandle } from "../utils/noteEditorHandle";

const theme = EditorView.theme({
    "&": { height: "100%", color: "inherit", backgroundColor: "transparent", fontSize: "14px" },
    ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, monospace", lineHeight: "1.75" },
    ".cm-content": { padding: "16px 8px", minHeight: "100%", caretColor: "currentColor" },
    ".cm-gutters": { backgroundColor: "transparent", color: "inherit", opacity: "0.55", borderRight: "1px solid rgba(128,128,128,.2)" },
    ".cm-activeLine": { backgroundColor: "rgba(128,128,128,.08)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgba(100,140,220,.3)" },
});

export default function NoteEditor({ value, onChange, editorRef }: {
    value: string;
    onChange: (value: string) => void;
    editorRef: Ref<NoteEditorHandle>;
}) {
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
                    markdown(), history(), bracketMatching(), lineNumbers(), highlightActiveLine(),
                    syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, theme,
                    placeholder("支持 Markdown：标题、列表、公式和脚注"),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.contentAttributes.of({ "aria-label": "笔记内容", "aria-multiline": "true", role: "textbox" }),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) changeRef.current(update.state.doc.toString());
                    }),
                ],
            }),
        });
        viewRef.current = view;
        return () => { view.destroy(); viewRef.current = null; };
        // 组件由笔记 id 做 key；输入期间不重建编辑器或丢撤销历史。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useImperativeHandle(editorRef, () => editorHandle(viewRef.current!), []);
    useEffect(() => {
        const view = viewRef.current;
        if (view && view.state.doc.toString() !== value) {
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
        }
    }, [value]);
    return <div ref={host} data-note-editor style={{ height: "100%", minHeight: 0, overflow: "hidden" }} />;
}
