import { useEffect, useLayoutEffect, useRef, useImperativeHandle, useState, type Ref } from "react";
import { EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder, Decoration, type DecorationSet } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentUnit } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { Compartment } from "@codemirror/state";
import { livePreview, type LiveRenderer } from "./NoteEditorLivePreview";
import { editorHandle, type NoteEditorHandle } from "../utils/noteEditorHandle";
import { EDITOR_SHORTCUTS, comboFor, toCodeMirrorKey } from "../utils/editorShortcuts";
import { htmlToMarkdown, looksLikeMarkdown, markdownLink } from "../utils/htmlToMarkdown";
import { moveLineUp, moveLineDown, deleteLine, indentMore, indentLess, undo, redo } from "@codemirror/commands";
import { typewriter, typewriterCompartment } from "./NoteTypewriter";

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
        // ⚠️ overflow-x 也固定成 hidden：横向滚动条一旦来去，同样会挤窄内容、
        // 让 max-width:100% 的图片被等比重新缩放 —— 和「刚出现上下滚轮时抖动」同源。
        overflowX: "hidden",
        overflowY: "auto",
        // ⚠️ **这一条才是「编辑区拖到刚出上下滚动条就抖」的关门一脚**：
        // `overflow:auto` 下滚动条「出现/消失」会让内容宽度变 10px，而图片是
        // `max-width:100%; height:auto`，文字行也会因换行数变化而改总高 → 总高越过
        // 临界 → 滚动条又消失 → 宽度回来 → 高度又回来 → 滚动条又出现……无限循环。
        // `scrollbar-gutter: stable` 让滚动条槽位**恒定预留**，出不出滚动条宽度都不变，
        // 这个回路直接断开（2026-10-09 上一轮只补了 widget 的 ResizeObserver，没断这层）。
        scrollbarGutter: "stable",
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
 * 编辑器内查找/替换面板（@codemirror/search）的样式。
 * 走 `currentColor` + 半透明底：文字色跟随宿主（亮/暗色都自动对），
 * 背景是「当前文字色 10%  tint」的毛玻璃，跟应用其它弹层一个调性。
 * 不写死亮/暗 —— 编辑器不在 MUI 主题树里，拿不到 darkMode。
 */
const searchPanelTheme = EditorView.theme({
    ".cm-panel.cm-search": {
        backgroundColor: "color-mix(in srgb, currentColor 9%, transparent)",
        color: "inherit",
        border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
        borderRadius: "10px",
        padding: "6px 8px",
        margin: "6px",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        boxShadow: "0 6px 20px rgba(0,0,0,.18)",
    },
    ".cm-search .cm-textfield": {
        backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
        color: "inherit",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        borderRadius: "6px",
        padding: "4px 8px",
        fontFamily: "inherit",
        outline: "none",
    },
    ".cm-search .cm-textfield:focus": {
        borderColor: "var(--accent, #5b8def)",
    },
    ".cm-search .cm-button": {
        backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        color: "inherit",
        border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
        borderRadius: "6px",
        padding: "3px 10px",
        fontFamily: "inherit",
        cursor: "pointer",
    },
    ".cm-search .cm-button:hover": {
        backgroundColor: "color-mix(in srgb, currentColor 22%, transparent)",
    },
    ".cm-search .cm-button[aria-disabled='true']": {
        opacity: ".45",
        cursor: "default",
    },
    // 命中高亮：普通命中 + 当前命中，都用同色系但不同浓度，亮/暗都看得见
    ".cm-searchMatch": {
        backgroundColor: "rgba(120,170,255,.28)",
        outline: "1px solid rgba(120,170,255,.5)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "rgba(120,170,255,.6)",
        outline: "1px solid rgba(120,170,255,.9)",
    },
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

/** 在光标处插入文本并把光标移到插入内容之后 */
function insertText(view: EditorView, text: string): void {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.paste" });
}

/**
 * 粘贴 / 拖拽图片（N3）：先插「上传中…」占位符（独占一行，避免打断当前段），
 * 上传完把占位符里的随机 token 换成最终 url。多张图各自带不同 token，互不干扰。
 * 上传失败则把 token 换成「上传失败」，让用户看得见而不是凭空消失。
 */
async function uploadAndInsertImage(
    view: EditorView,
    file: File,
    uploadFn: (f: File) => Promise<{ url: string; filename: string }>,
    onDetachedUpload?: (placeholder: string, replacement: string) => Promise<void>
): Promise<void> {
    const token = `uploading-${Math.random().toString(36).slice(2, 8)}`;
    const placeholder = `上传中…<!-- ${token} -->`;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const at = line.to;
    const needsLead = at > 0 && view.state.doc.lineAt(at).length > 0;
    const text = (needsLead ? "\n" : "") + placeholder + "\n";
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
    const replaceToken = (replacement: string) => {
        if (!view.dom.isConnected) { void onDetachedUpload?.(placeholder, replacement); return; }
        const doc = view.state.doc.toString();
        const idx = doc.indexOf(placeholder);
        if (idx < 0) return;
        view.dispatch({ changes: { from: idx, to: idx + placeholder.length, insert: replacement }, userEvent: "input.paste" });
    };
    try {
        const { url, filename } = await uploadFn(file);
        replaceToken(markdownLink(filename, url, file.type.startsWith("image/")));
    } catch {
        replaceToken(`<!-- 上传失败：${file.name.replace(/[<>\r\n]/g, " ").replace(/--/g, "—")} -->`);
    }
}

/** 淡化一整行（专注模式用）。用 className 走主题变量，亮/暗色都能看得出层次。 */
const DIMMED_LINE_DECORATION = Decoration.line({ class: "cm-focus-dimmed" });

/** 承载专注模式的装饰集；null = 关闭。 */
const setFocusEffect = StateEffect.define<DecorationSet | null>();

/** 即时渲染的开关用 Compartment 换扩展 —— 重建编辑器会丢撤销历史，不能那么干。 */
const liveCompartment = new Compartment();

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
     * 「即时渲染」：非当前段落整块替换成渲染后的样子（inkstone 同款）。
     * 渲染函数由宿主注入（异步，因为 markdown-it 是动态 import）。
     * 传 null / undefined = 关掉，此时就是纯源码编辑。
     */
    liveRender?: LiveRenderer | null;
    /**
     * 打字机模式（inkstone 同名功能）：光标行始终垂直居中。
     * 走 Compartment 热插拔，不重建编辑器。
     */
    typewriterMode?: boolean;
    /**
     * 快捷键要执行的动作表（id → 执行）。
     *
     * ⚠️ 为什么用 prop 传而不是在编辑器里直接调工具函数：格式动作要作用于
     * **编辑器里真实的选区**，而工具函数走的是 `NoteEditorHandle`（宿主 ref）。
     * 把映射交给宿主注入，编辑器只负责「按到键就调对应 id」，
     * 这样快捷键和工具栏按钮走的是**同一套实现**，不会出现两边行为不一致。
     */
    shortcutActions?: Partial<Record<string, () => void>>;
    /**
     * 粘贴 / 拖拽图片进正文（N3）：有图时先插「上传中…」占位符，上传完替换成 `![](url)`。
     * 不传 = 不走这套（后端没配存储时，粘贴图片就是原生行为）。
     * 返回的是「最终可内嵌的 url」（小图可能已是 data URI，由宿主决定）。
     */
    uploadImage?: (file: File) => Promise<{ url: string; filename: string }>;
    onDetachedUpload?: (placeholder: string, replacement: string) => Promise<void>;
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
    liveRender = null,
    focusMode = false,
    typewriterMode = false,
    shortcutActions,
    uploadImage,
    onDetachedUpload,
}: NoteEditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const changeRef = useRef(onChange);
    // 上传能力放进 ref：换回调（比如存储从「没配」变「配了」）不该重建编辑器。
    const uploadRef = useRef(uploadImage);
    uploadRef.current = uploadImage;
    const detachedUploadRef = useRef(onDetachedUpload);
    detachedUploadRef.current = onDetachedUpload;
    // 滚动回调放进 ref：换回调不该重建编辑器（会丢撤销历史）
    const scrollRef = useRef(onScrollRatio);
    useLayoutEffect(() => { scrollRef.current = onScrollRatio; }, [onScrollRatio]);
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
    // 快捷键动作表同样走 ref：换回调只是换映射，不该重建编辑器。
    const shortcutRef = useRef(shortcutActions);
    shortcutRef.current = shortcutActions;
    useLayoutEffect(() => {
        const view = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: value,
                extensions: [
                    markdown(), history(), bracketMatching(), focusField,
                    // 编辑器内查找/替换（N2，inkstone 的 mod+f → openSearchPanel）：
                    // `search()` 自带 searchState 字段 + 面板逻辑；`searchKeymap` 提供
                    // Mod-f 开面板 / Mod-g、F3 跳下一个 / Mod-h 替换面板 / Mod-d 选下一个相同词。
                    // 面板 UI 样式在 searchPanelTheme 里（毛玻璃、跟随宿主文字色）。
                    search(), highlightSelectionMatches(),
                    liveCompartment.of([]),
                    typewriterCompartment.of([]),
                    // 缩进宽度（设置面板）：Tab / 自动缩进都认它
                    indentUnit.of(" ".repeat(indentWidth)),
                    // 行号是扩展不是样式：关掉它只能在建编辑器时决定 ——
                    // 所以设置里切这一项由调用方用 key 重建本组件（会丢撤销历史，可接受）
                    ...(showLineNumbers ? [lineNumbers()] : []),
                    highlightActiveLine(),
                    syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, theme, searchPanelTheme,
                    // 粘贴 / 拖拽图片进正文 + 富文本 HTML→MD（N3 + N5）。
                    // 永远挂上：没传 uploadImage 时处理器直接放行（原生行为），
                    // 传了才走「占位符 → 上传 → 回写」；upload 能力走 uploadRef 读最新值。
                    EditorView.domEventHandlers({
                        dragover(event) {
                            if (uploadRef.current && event.dataTransfer?.types.includes("Files")) event.preventDefault();
                            return false;
                        },
                        paste(event, view) {
                            const cdt = event.clipboardData;
                            if (!cdt) return false;
                            // N3：图片分支需要 upload 能力；没传 uploadImage 时放行原生行为
                            const upload = uploadRef.current;
                            const imageFiles = Array.from(cdt.files);
                            if (!imageFiles.length && !cdt.getData("text/html") && !cdt.getData("text/plain")) {
                                for (const item of Array.from(cdt.items ?? [])) {
                                    const file = item.kind === "file" ? item.getAsFile() : null;
                                    if (file) imageFiles.push(file);
                                }
                            }
                            if (upload && imageFiles.length > 0) {
                                event.preventDefault();
                                for (const f of imageFiles) void uploadAndInsertImage(view, f, upload, detachedUploadRef.current);
                                return true;
                            }
                            // N5：没图片、有 HTML、且没纯文本时，把 HTML 转 Markdown 粘进来。
                            // ⚠️ 这一支**不依赖** upload 能力 —— 后端没配存储也能粘 HTML。
                            const html = cdt.getData("text/html");
                            const plain = cdt.getData("text/plain");
                            if (/^https?:\/\/\S+$/i.test(plain.trim()) && !view.state.selection.main.empty) {
                                const range = view.state.selection.main;
                                event.preventDefault();
                                insertText(view, markdownLink(view.state.sliceDoc(range.from, range.to), plain.trim()));
                                return true;
                            }
                            if (html && !looksLikeMarkdown(plain)) {
                                const md = htmlToMarkdown(html);
                                if (md && md !== plain) {
                                    event.preventDefault();
                                    insertText(view, md);
                                    return true;
                                }
                            }
                            return false;
                        },
                        drop(event, view) {
                            const upload = uploadRef.current;
                            if (!upload) return false;
                            const dt = event.dataTransfer;
                            if (!dt) return false;
                            const imageFiles = Array.from(dt.files);
                            if (imageFiles.length > 0) {
                                event.preventDefault();
                                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                                if (pos != null) view.dispatch({ selection: { anchor: pos } });
                                for (const f of imageFiles) void uploadAndInsertImage(view, f, upload, detachedUploadRef.current);
                                return true;
                            }
                            return false;
                        },
                    }),
                    placeholder("支持 Markdown：标题、列表、公式和脚注"),
                    // ⚠️ 快捷键 keymap 必须排在 defaultKeymap/historyKeymap **前面**：
                    // CM 的 keymap 是「数组靠前优先级高」，放后面的话 Mod-B 会被
                    // 浏览器/CM 默认行为抢走，我们声明的组合键就成了摆设。
                    // 组合键字符串由 EDITOR_SHORTCUTS 单表生成（inkstone 同款设计），
                    // 所以「菜单上显示的」和「实际按的」永远一致。
                    keymap.of(
                        // ⚠️ 两个条件都要判：`combo` 在表里是可选的（有些动作只声明
                        // 不绑定，见 editorShortcuts 的说明），只判 run 的话
                        // toCodeMirrorKey 会收到 undefined。
                        EDITOR_SHORTCUTS.filter(s => s.combo).map(s => ({
                            key: toCodeMirrorKey(s.combo!),
                            preventDefault: true,
                            run: (view: EditorView) => {
                                const fn = shortcutRef.current?.[s.id];
                                if (!fn) return false;
                                fn();
                                view.focus();
                                return true;
                            },
                        }))
                    ),
                    // 查找/替换 keymap：必须排在 defaultKeymap 之前，否则有些键会被
                    // CM 默认行为抢走（Mod-g / F3 在 defaultKeymap 里没有，但放这里更稳）。
                    // 我们的自定义 keymap 在前、不绑 Mod-f/d，所以这些键自然落到这里。
                    keymap.of([
                        { key: toCodeMirrorKey(comboFor("move-line-up")!), run: moveLineUp }, { key: toCodeMirrorKey(comboFor("move-line-down")!), run: moveLineDown },
                        { key: toCodeMirrorKey(comboFor("delete-line")!), run: deleteLine }, { key: toCodeMirrorKey(comboFor("indent")!), run: indentMore },
                        { key: toCodeMirrorKey(comboFor("outdent")!), run: indentLess }, { key: toCodeMirrorKey(comboFor("undo")!), run: undo },
                        { key: toCodeMirrorKey(comboFor("redo")!), run: redo },
                        { key: toCodeMirrorKey(comboFor("task-done")!), run: view => {
                            const line = view.state.doc.lineAt(view.state.selection.main.head);
                            const match = /^\s*[-*+]\s+\[([ xX])\]/.exec(line.text);
                            if (!match) return false;
                            const at = line.from + match[0].lastIndexOf("[") + 1;
                            view.dispatch({ changes: { from: at, to: at + 1, insert: match[1] === " " ? "x" : " " } });
                            return true;
                        } },
                    ]),
                    keymap.of(searchKeymap),
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

    // 渲染函数用 ref 传给扩展：换函数不重配扩展（重配会重建所有装饰块，代价大）
    const liveRenderRef = useRef(liveRender);
    liveRenderRef.current = liveRender;
    const liveRenderStable = useRef<LiveRenderer | null>(null);
    if (!liveRenderStable.current) {
        // 只建一次：内部按当前 ref 取真正的渲染函数
        const fallback: LiveRenderer = (source, key) => {
            const fn = liveRenderRef.current;
            if (!fn) return Promise.resolve(null);
            return fn(source, key);
        };
        liveRenderStable.current = fallback;
    }
    const wantLive = liveRender ? 1 : 0;
    const [liveApplied, setLiveApplied] = useState(0);
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (liveApplied !== wantLive) {
            view.dispatch({
                effects: liveCompartment.reconfigure(
                    wantLive ? livePreview(liveRenderStable.current!) : []
                ),
            });
            setLiveApplied(wantLive);
        }
    }, [wantLive, liveApplied]);

    // 打字机模式：同样走 Compartment 热插拔（重建会丢撤销历史）。
    const wantTypewriter = typewriterMode ? 1 : 0;
    const [typewriterApplied, setTypewriterApplied] = useState(0);
    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (typewriterApplied !== wantTypewriter) {
            view.dispatch({
                effects: typewriterCompartment.reconfigure(wantTypewriter ? typewriter() : []),
            });
            setTypewriterApplied(wantTypewriter);
        }
    }, [wantTypewriter, typewriterApplied]);

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
