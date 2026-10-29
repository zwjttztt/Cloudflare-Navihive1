import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
    Note
} from "../../API/http";
import { useEditorTools, type EditorDraft } from "../../hooks/useEditorTools";
import { AttachmentPreviewProvider, type AttachmentPreviewRequest } from "../../utils/attachmentPreview";
import {
    renderMarkdownToReact,
    type RenderFeatures
} from "../../utils/markdownToReact";
import type { NoteEditorHandle } from "../../utils/noteEditorHandle";
import {
    type NotesUiSettings
} from "../../utils/notesSettings";
import { createScrollSync } from "../../utils/syncScroll";
import { resolveImageUpload } from "./markdownToolbar";
import type { NotesPageProps, Pane } from "./notesPageCtx";
import { AUTO_SAVE_MS, MAX_RATIO, MIN_RATIO, readPaneRatio, SPLIT_KEY, writePaneRatio } from "./paneChrome";

export interface NotesEditorDeps {
    textareaRef: React.RefObject<NoteEditorHandle | null>;
    sideRef: React.RefObject<NoteEditorHandle | null>;
    previewScrollRef: React.RefObject<HTMLDivElement | null>;
    paneRowRef: React.RefObject<HTMLDivElement | null>;
    splitBoxRef: React.RefObject<HTMLDivElement | null>;
    sideSplitBoxRef: React.RefObject<HTMLDivElement | null>;
    uiSettings: NotesUiSettings;
    setUiSettings: (updater: NotesUiSettings | ((cur: NotesUiSettings) => NotesUiSettings)) => void;
    setDraft: (updater: { title: string; content: string } | null | ((prev: { title: string; content: string } | null) => { title: string; content: string } | null)) => void;
    setSideDraft: (updater: EditorDraft | null | ((prev: EditorDraft | null) => EditorDraft | null)) => void;
    notes: Note[];
    activeId: number | null;
    sideId: number | null;
    pane: Pane;
    splitRatioRef: React.MutableRefObject<number>;
    setSplitRatio: (v: number | ((prev: number) => number)) => void;
    sideSplitRatioRef: React.MutableRefObject<number>;
    setSideSplitRatio: (v: number | ((prev: number) => number)) => void;
    setSideResizing: (v: boolean) => void;
    uploadApi?: NotesPageProps["uploadApi"];
    onUpdate: NotesPageProps["onUpdate"];
    onNotify?: NotesPageProps["onNotify"];
    onEnsureFullNote?: NotesPageProps["onEnsureFullNote"];
    previewController: { open: (request: AttachmentPreviewRequest) => void };
}

const SIDE_SPLIT_KEY = "notes.sideSplitRatio";
export function useNotesEditor(deps: NotesEditorDeps) {
    const { textareaRef, sideRef, previewScrollRef, paneRowRef, splitBoxRef, sideSplitBoxRef, uiSettings, setUiSettings, setDraft, setSideDraft, notes, activeId, sideId, pane, splitRatioRef, setSplitRatio, sideSplitRatioRef, setSideSplitRatio, setSideResizing, uploadApi, onUpdate, onNotify, onEnsureFullNote, previewController } = deps;

    const openAttachmentFromEditor = useCallback(
        (id: string) => previewController.open({ id, filename: "" }),
        [previewController]
    );

    const liveRenderer = useCallback(
        (source: string): Promise<ReactNode> =>
            // ⚠️ 即时渲染块是 LiveBlockWidget 里 createRoot 起的**独立 React root**，
            // NotesPage 顶层那个 AttachmentPreviewProvider 穿透不过去；不包一层的话，
            // 块里的 AttachmentLink 读到的 useAttachmentPreview() 是 null，会退回整页
            // 跳走的 <a>。这里把渲染结果整体用 Provider 包起来，编辑器内点链接才开弹窗。
            renderMarkdownToReact(source, {}).then(node =>
                createElement(AttachmentPreviewProvider, { value: previewController }, node)
            ),
        [previewController]
    );

    const tools = useEditorTools(textareaRef, setDraft);

    const jumpToOffset = tools.jumpToOffset;

    const sideTools = useEditorTools(sideRef, setSideDraft);

    const mainShortcutActions = useMemo<Record<string, () => void>>(
        () => ({
            bold: () => tools.insertAtCursor("**", "**", "粗体"),
            italic: () => tools.insertAtCursor("*", "*", "斜体"),
            strikethrough: () => tools.insertAtCursor("~~", "~~", "删除"),
            highlight: () => tools.insertAtCursor("==", "==", "高亮"),
            "inline-code": () => tools.insertAtCursor("`", "`", "code"),
            link: () => tools.insertAtCursor("[", "](https://)", "链接文字"),
            comment: () => tools.onInsertHiddenComment(),
            paragraph: () => tools.setHeadingLevel(0),
            h1: () => tools.setHeadingLevel(1),
            h2: () => tools.setHeadingLevel(2),
            h3: () => tools.setHeadingLevel(3),
            h4: () => tools.setHeadingLevel(4),
            h5: () => tools.setHeadingLevel(5),
            h6: () => tools.setHeadingLevel(6),
            "bullet-list": () => tools.toggleLinePrefix("- "),
            "ordered-list": () => tools.toggleLinePrefix("1. "),
            "task-list": () => tools.toggleLinePrefix("- [ ] "),
            quote: () => tools.toggleLinePrefix("> "),
        }),
        [tools]
    );

    const sideShortcutActions = useMemo<Record<string, () => void>>(
        () => ({
            bold: () => sideTools.insertAtCursor("**", "**", "粗体"),
            italic: () => sideTools.insertAtCursor("*", "*", "斜体"),
            strikethrough: () => sideTools.insertAtCursor("~~", "~~", "删除"),
            highlight: () => sideTools.insertAtCursor("==", "==", "高亮"),
            "inline-code": () => sideTools.insertAtCursor("`", "`", "code"),
            link: () => sideTools.insertAtCursor("[", "](https://)", "链接文字"),
            comment: () => sideTools.onInsertHiddenComment(),
            paragraph: () => sideTools.setHeadingLevel(0),
            h1: () => sideTools.setHeadingLevel(1),
            h2: () => sideTools.setHeadingLevel(2),
            h3: () => sideTools.setHeadingLevel(3),
            h4: () => sideTools.setHeadingLevel(4),
            h5: () => sideTools.setHeadingLevel(5),
            h6: () => sideTools.setHeadingLevel(6),
            "bullet-list": () => sideTools.toggleLinePrefix("- "),
            "ordered-list": () => sideTools.toggleLinePrefix("1. "),
            "task-list": () => sideTools.toggleLinePrefix("- [ ] "),
            quote: () => sideTools.toggleLinePrefix("> "),
        }),
        [sideTools]
    );

    const liveRender = uiSettings.liveRender;

    const setLiveRender = useCallback((updater: boolean | ((v: boolean) => boolean)) =>
        setUiSettings(cur => ({
            ...cur,
            liveRender: typeof updater === "function" ? updater(cur.liveRender) : updater,
        })), [setUiSettings]);

    const [sideLiveRender, setSideLiveRender] = useState(uiSettings.liveRender);

    const autosaveMs = uiSettings.autosaveMs || AUTO_SAVE_MS;

    const previewFeatures = useMemo<RenderFeatures>(
        () => ({
            math: uiSettings.mathRender,
            mermaid: uiSettings.mermaidRender,
            foldCode: uiSettings.foldCode,
            foldCodeLines: uiSettings.foldCodeLines,
        }),
        [uiSettings.mathRender, uiSettings.mermaidRender, uiSettings.foldCode, uiSettings.foldCodeLines]
    );

    const [paneRatio, setPaneRatio] = useState(() => readPaneRatio());

    const paneRatioRef = useRef(paneRatio);

    const startPaneDrag = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        const row = paneRowRef.current;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        const total = rect.width;
        if (total <= 0) return;
        setSideResizing(true);
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - rect.left) / total;
            const next = Math.min(0.8, Math.max(0.2, ratio));
            paneRatioRef.current = next;
            setPaneRatio(next);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            setSideResizing(false);
            writePaneRatio(paneRatioRef.current);
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, [paneRowRef, setSideResizing]);

    const resetPaneRatio = useCallback(() => {
        paneRatioRef.current = 0.5;
        setPaneRatio(0.5);
        writePaneRatio(0.5);
    }, []);

    const nudgePaneRatio = useCallback((delta: number) => {
        const next = Math.min(0.8, Math.max(0.2, paneRatioRef.current + delta));
        paneRatioRef.current = next;
        setPaneRatio(next);
        writePaneRatio(next);
    }, []);

    const syncPreviewScroll = useCallback((_ratio: number) => {
        // 真正的同步在 syncScrollRef 那条链路里；这里保留是为了兼容
        // NoteEditor 的 onScrollRatio 回调（它报的「比例」已不再用于定位）。
    }, []);

    const handleUpload = useCallback(
        async (file: File, noteId: number | null) => {
            if (!uploadApi) {
                throw new Error("服务器未配置图片存储，上传暂不可用");
            }
            const result = await uploadApi.uploadAttachment(file, noteId);
            // ⚠️ 别无条件把返回值往下传（2026-10-07 真机实测的坑）：
            // 只要后端/中间层回了个「200 但不是我们预期的 JSON」（错误页、代理拦截、
            // SPA 兜底把 /api/ 开头的路径回落成 index.html），拿到的就是 `{success:true}`
            // 之类的东西 —— url 与 filename 全是 undefined，而 fetch(undefined) 会
            // 去请求**当前页面**、拿到 HTML 还当成图片内嵌，正文里就出现
            // `![undefined](data:text/html;base64,...)`，用户根本看不懂哪里错了。
            // 宁可在这里拦下来报一句人话。
            if (!result?.url || !result?.filename) {
                throw new Error("上传返回的数据不完整（缺少图片地址），请重试");
            }
            return { url: result.url, filename: result.filename, size: result.size };
        },
        [uploadApi]
    );

    const attachmentTargets = useRef({ activeId, sideId, notes, onUpdate });

    attachmentTargets.current = { activeId, sideId, notes, onUpdate };

    const handleAttach = useCallback(
        async (file: File, noteId: number | null, side: boolean) => {
            const ref = side ? sideRef : textareaRef;
            const editor = ref.current;
            try {
                if (noteId === null || !editor) throw new Error("请先打开笔记并切换到编辑模式");
                const uploaded = await handleUpload(file, noteId);
                const safeFilename = uploaded.filename.replace(/[\\[\]\n\r]/g, " ");
                const link = `\n[${safeFilename}](<${uploaded.url}>)\n`;
                const current = attachmentTargets.current;
                if ((side ? current.sideId : current.activeId) === noteId && ref.current === editor) {
                    // 上传不是格式开关：直接插入，避免再次添加同一附件时撤掉旧链接。
                    const at = editor.selectionEnd ?? editor.value.length;
                    const content = editor.value.slice(0, at) + link + editor.value.slice(at);
                    editor.value = content;
                    editor.setSelectionRange(at + link.length, at + link.length);
                    (side ? setSideDraft : setDraft)(d => d ? { ...d, content } : d);
                } else {
                    // 上传期间切换笔记，绝不把附件写到新打开的笔记。
                    // ⚠️ 列表里的正文可能只是摘要（开头 200 字）：拿它拼链接写回去，
                    // 等于把这条笔记的尾巴整段砍掉。所以先补全文再拼；补不全就放弃写入，
                    // 附件本身已经存下来了，用户能在附件管理器里找回。
                    let original = current.notes.find(note => note.id === noteId) ?? null;
                    if (original?.content_truncated) {
                        const hydrated = await onEnsureFullNote?.(noteId);
                        if (hydrated && !hydrated.content_truncated) original = hydrated;
                    }
                    if (
                        !original ||
                        original.content_truncated ||
                        await current.onUpdate(noteId, { content: (original.content ?? "") + link }) === false
                    ) {
                        throw new Error("附件已上传，但原笔记回写失败，请在附件管理器找回");
                    }
                }
                onNotify?.(`已添加附件「${uploaded.filename}」，并在笔记中插入下载链接`, "success");
            } catch (error) {
                onNotify?.(error instanceof Error ? error.message : "附件上传失败", "error");
            }
        },
        [sideRef, textareaRef, handleUpload, onNotify, setSideDraft, setDraft, onEnsureFullNote]
    );

    const detachedNotesRef = useRef(notes);

    detachedNotesRef.current = notes;

    const detachedUpdateRef = useRef(onUpdate);

    detachedUpdateRef.current = onUpdate;

    const replaceDetachedUpload = useCallback(async (noteId: number, placeholder: string, replacement: string) => {
        const note = detachedNotesRef.current.find(n => n.id === noteId);
        if (!note?.content.includes(placeholder)) return;
        try {
            const saved = await detachedUpdateRef.current(noteId, { content: note.content.replace(placeholder, replacement) });
            if (saved === false) onNotify?.("附件已上传，但原笔记回写失败，请在附件管理器找回", "error");
        } catch { onNotify?.("附件已上传，但原笔记回写失败，请在附件管理器找回", "error"); }
    }, [onNotify]);

    const uploadImageForEditor = useCallback(
        (file: File) => resolveImageUpload(file, handleUpload, activeId ?? null),
        [handleUpload, activeId]
    );

    const uploadFileForSideEditor = useCallback(
        (file: File) => resolveImageUpload(file, handleUpload, sideId),
        [handleUpload, sideId]
    );

    const syncScrollRef = useRef<ReturnType<typeof createScrollSync> | null>(null);

    useEffect(() => {
        if (pane !== "split" || !uiSettings.scrollSync) return;
        // ⚠️ 不能一上来就 document.querySelector 再 return —— 切到分栏的**那一刻**
        // 预览层还没挂上，previewScrollRef.current 是 null，于是这个 effect
        // 直接退出、之后也不再重跑（依赖没变），滚动同步就永远不生效。
        // 真机症状：拖源码，预览纹丝不动。
        //
        // 解法：轮询等 ref 到位再绑定。
        // ⚠️⚠️ 这里**绝不能**用 useState 做「重新渲染」的触发器 —— 它在 useEffect
        // 内部调用，违反 Hooks 规则，真机直接白屏（React error #321:
        // "Invalid hook call"，因为 effect 里的 hook 顺序和渲染顺序对不上）。
        // 需要重跑时用 `activeId` / `pane` 这些**已经在依赖数组里**的量。
        let cancelled = false;
        let unbind: (() => void) | null = null;
        let tries = 0;
        const tryBind = () => {
            if (cancelled) return;
            const edScroll = document.querySelector<HTMLElement>(
                "[data-editor-pane='1'] .cm-scroller"
            );
            const pvScroll = previewScrollRef.current;
            if (!edScroll || !pvScroll) {
                // 最多等 ~1.2s（30 × 40ms）；超了就认为环境不对，放弃而不是无限轮询
                if (++tries < 30) window.setTimeout(tryBind, 40);
                return;
            }
            const ctrl = createScrollSync({
                editorScroller: edScroll,
                previewScroller: pvScroll,
                lineCount: () => textareaRef.current?.lineCount() ?? 1,
                editorScrollForLine: line => textareaRef.current?.scrollOffsetForLine(line) ?? 0,
                editorLineAtScroll: () => {
                    // 渲染出的 data-line 是 0 基，CM 的 topLineNumber() 是 1 基 —— 这里减 1 对齐。
                    // ⚠️ 减一次就够了：syncScroll 内部**不再**减（那边的注释也写明了口径），
                    // 两边各减一次就会整体滞后一行。
                    return Math.max(0, (textareaRef.current?.topLineNumber() ?? 1) - 1);
                },
                enabled: () => pane === "split" && uiSettings.scrollSync,
            });
            syncScrollRef.current = ctrl;
            unbind = ctrl.bind();
        };
        tryBind();
        return () => {
            cancelled = true;
            unbind?.();
            unbind = null;
            syncScrollRef.current = null;
        };
    }, [pane, uiSettings.scrollSync, activeId, previewScrollRef, textareaRef]);

    const startSplitDrag = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        const box = splitBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return;
        // ⚠️ 比例要按**内容盒**算，不能按 border-box：内容区加了 px:2 的内边距后，
        // 两栏的宽度是相对「扣掉左右内边距后的宽度」分的（textarea 的 width:% 同理）。
        // 不扣的话分隔条会跟手差 16px，看起来就是「拖不到头」。
        const cs = getComputedStyle(box);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const contentLeft = rect.left + padL;
        const contentWidth = rect.width - padL - padR;
        if (contentWidth <= 0) return;
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            // 拖动中 setState 不会回头改 onUp 那个闭包里的 splitRatio
            //（事件处理函数是 mousedown 那一刻挂上去的），所以最新值走 ref。
            splitRatioRef.current = clamped;
            setSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            try {
                // ⚠️⚠️ 这里原来写的是 `String(readSplitRatio())` —— 那是**从 localStorage 读**，
                // 读回来的必然是拖动开始之前的旧值：拖了半天松手，存回去的还是原来那个比例，
                // 刷新页面宽度就弹回去了（用户视角就是「拖不动」/「拖了没反应」）。
                // 而且这里也不能直接读 splitRatio：onUp 是 mousedown 那一刻挂上去的闭包，
                // 拖动中的 setState 改不到它 —— 只有 splitRatioRef 跟得住最新值。
                localStorage.setItem(SPLIT_KEY, String(splitRatioRef.current));
            } catch {
                /* 隐私模式下写不了，忽略 */
            }
        };
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, [setSplitRatio, splitBoxRef, splitRatioRef]);

    const startSideSplitDrag = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        const box = sideSplitBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return;
        const cs = getComputedStyle(box);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const contentLeft = rect.left + padL;
        const contentWidth = rect.width - padL - padR;
        if (contentWidth <= 0) return;
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            sideSplitRatioRef.current = clamped;
            setSideSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            try {
                localStorage.setItem(SIDE_SPLIT_KEY, String(sideSplitRatioRef.current));
            } catch {
                /* 隐私模式下写不了，忽略 */
            }
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    }, [setSideSplitRatio, sideSplitBoxRef, sideSplitRatioRef]);

    return { openAttachmentFromEditor, tools, jumpToOffset, sideTools, mainShortcutActions, sideShortcutActions, liveRenderer, liveRender, setLiveRender, sideLiveRender, setSideLiveRender, autosaveMs, previewFeatures, paneRatio, setPaneRatio, paneRatioRef, startPaneDrag, resetPaneRatio, nudgePaneRatio, syncPreviewScroll, handleUpload, handleAttach, replaceDetachedUpload, uploadImageForEditor, uploadFileForSideEditor, syncScrollRef, startSplitDrag, startSideSplitDrag };
}
