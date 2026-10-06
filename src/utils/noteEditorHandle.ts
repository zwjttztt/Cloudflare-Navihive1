import { EditorView } from "@codemirror/view";

/** 工具栏同步编辑接口，读取 CM 状态而非滞后的 React 草稿。 */
export interface NoteEditorHandle {
    value: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    setSelectionRange(from: number, to: number): void;
    focus(): void;
}
export function editorHandle(view: EditorView): NoteEditorHandle {
    return {
        get value() { return view.state.doc.toString(); },
        set value(next: string) {
            const old = view.state.doc.toString();
            if (old === next) return;
            let from = 0;
            while (from < old.length && from < next.length && old[from] === next[from]) from++;
            let end = old.length, nextEnd = next.length;
            while (end > from && nextEnd > from && old[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
            view.dispatch({ changes: { from, to: end, insert: next.slice(from, nextEnd) }, userEvent: "input.toolbar" });
        },
        get selectionStart() { return view.state.selection.main.from; },
        get selectionEnd() { return view.state.selection.main.to; },
        setSelectionRange(from, to) {
            const max = view.state.doc.length;
            view.dispatch({ selection: { anchor: Math.max(0, Math.min(max, from)), head: Math.max(0, Math.min(max, to)) }, scrollIntoView: true });
        },
        focus() { view.focus(); },
    };
}
