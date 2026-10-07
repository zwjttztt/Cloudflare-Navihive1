import { EditorView } from "@codemirror/view";

/** 工具栏同步编辑接口，读取 CM 状态而非滞后的 React 草稿。 */
export interface NoteEditorHandle {
    value: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    setSelectionRange(from: number, to: number): void;
    focus(): void;
    /**
     * 滚动比例（0~1）。阅读位置记忆用它存取 ——
     * 记比例而不是像素：窗口大小、面板宽度、是否分屏都会变，
     * 像素在不同环境下指的不是同一段内容。
     */
    scrollRatio(): number;
    /** 恢复到某个滚动比例（内容还没量高时调用会自动等一帧再试）。 */
    restoreScrollRatio(ratio: number): void;
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
        scrollRatio() {
            const el = view.scrollDOM;
            const max = el.scrollHeight - el.clientHeight;
            return max > 0 ? el.scrollTop / max : 0;
        },
        restoreScrollRatio(ratio) {
            const apply = () => {
                const el = view.scrollDOM;
                const max = el.scrollHeight - el.clientHeight;
                if (max <= 0) return false;
                el.scrollTop = Math.max(0, Math.min(1, ratio)) * max;
                return true;
            };
            // ⚠️ 切笔记时编辑器已经建好但**内容可能还没量高**（长文分几帧才撑开），
            // 这时 scrollHeight 还是 0，直接写 scrollTop 会被浏览器夹成 0 ——
            // 表现就是「位置记忆功能好像没生效」。所以量不到高度时等一帧再试。
            if (!apply()) requestAnimationFrame(() => apply());
        },
    };
}
