import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";

/** 工具栏同步编辑接口，读取 CM 状态而非滞后的 React 草稿。 */
export interface NoteEditorHandle {
    value: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    setSelectionRange(from: number, to: number): void;
    focus(): void;
    /**
     * 打开编辑器内「查找/替换」面板（@codemirror/search 的 openSearchPanel）。
     * 工具栏「查找」按钮和 ⌘F 都走它；面板 UI 样式在 NoteEditor 的 searchPanelTheme。
     */
    openSearch(): void;
    /**
     * 滚动比例（0~1）。阅读位置记忆用它存取 ——
     * 记比例而不是像素：窗口大小、面板宽度、是否分屏都会变，
     * 像素在不同环境下指的不是同一段内容。
     */
    scrollRatio(): number;
    /** 恢复到某个滚动比例（内容还没量高时调用会自动等一帧再试）。 */
    restoreScrollRatio(ratio: number): void;
    /**
     * 当前视口**顶部**那一行在文档里的行号（1 基，与 CM 的 lineAt 一致）。
     *
     * 分栏滚动同步按「行」而不是「比例」定位（2026-10-17，对齐 inkstone 的
     * sync-scroll.ts）：两栏总高度不一样，按比例映射必然漂移
     * （真机量到源码 2722px / 预览 2174px，差 20%）。
     */
    topLineNumber(): number;
    /** 文档总行数（给锚点曲线补末端点用）。 */
    lineCount(): number;
    /** 让第 line 行（1 基）贴到视口顶部。 */
    scrollToLineNumber(line: number): void;
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
        openSearch() { openSearchPanel(view); },
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
        topLineNumber() {
            // ⚠️ 用 CM 的 lineBlockAtHeight(0) 拿「视口顶部那个块」。
            // 不能用「scrollTop / 行高」硬算 —— 代码块折行时视觉行 ≠ 文档行，
            // 折行一多就偏（CM 的高度参数都是相对 documentTop 的）。
            const b = view.lineBlockAtHeight(0);
            if (!b) return 1;
            return view.state.doc.lineAt(b.from).number; // 转成文档行号（1 基）
        },
        lineCount() {
            return view.state.doc.lines;
        },
        scrollToLineNumber(line) {
            const total = view.state.doc.lines;
            const target = Math.max(1, Math.min(total, line));
            const block = view.lineBlockAt(target);
            if (!block) return;
            // documentTop 是文档顶部相对滚动容器的偏移，减掉它换算回 scrollTop
            view.scrollDOM.scrollTop = Math.max(0, block.top - view.documentTop);
        },
    };
}
