import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    NotesImportPayload
} from "../../API/http";
import type { NoteImportProgress } from "../../API/types";
import { HEADER_CONTROL_H, HEADER_RADIUS } from "../../constants";
import { type EditorDraft } from "../../hooks/useEditorTools";
import { usePanelBreakpoint } from "../../hooks/usePanelBreakpoint";
import { useScrollLock } from "../../hooks/useScrollLock";
import { type AttachmentPreviewRequest } from "../../utils/attachmentPreview";
import {
    seedAttachmentDimensions
} from "../../utils/markdownToReact";
import type { NoteEditorHandle } from "../../utils/noteEditorHandle";
import { exportNoteAsMarkdown } from "../../utils/noteExport";
import { exportNoteAsHtml } from "../../utils/noteHtmlExport";
import { extractOutline } from "../../utils/noteOutline";
import {
    loadNotesSettings,
    saveNotesSettings,
    type NotesUiSettings,
} from "../../utils/notesSettings";
import { readReadingPosition, writeReadingPosition } from "../../utils/readingPosition";
import type { CommandItem } from "../CommandPalette";
import { exportAllNotesJson, exportAllNotesZip } from "./exportNotes";
import { importNotesFile as runImportNotesFile } from "./importNotesFile";
import type { NotesPageProps, Pane } from "./notesPageCtx";
import { MAX_RATIO, MIN_RATIO, readSplitRatio, useColumnResize } from "./paneChrome";
import { EMPTY_TAG_LINKS, tagNamesOf } from "./sidebarSection";
import { useBacklinks } from "./useBacklinks";
import { useNoteAutoSave } from "./useNoteAutoSave";
import { useNotesBulkOps } from "./useNotesBulkOps";
import { useNotesData } from "./useNotesData";
import { useNotesEditor } from "./useNotesEditor";
import { useNotesFilters } from "./useNotesFilters";
import { useNotesEmptyState, useNotesList, useNotesSearch } from "./useNotesList";
import { useNotesPanels } from "./useNotesPanels";
import { useNotesRowActions } from "./useNotesRowActions";
import { useNotesNavigation, useNotesRowMenuActions } from "./useNotesRowMenuActions";
import { useNotesTaxonomy } from "./useNotesTaxonomy";

const EMPTY_REF_COUNTS: ReadonlyMap<string, number> = new Map();

/** Compose page state and extracted behavior without adding a rendered wrapper. */
export function useNotesPageModel({
    shareApi,
    uploadApi,
    backupApi,
    onDatasetChanged,
    syncChangedNoteIds,
    notes,
    onClose,
    accountName,
    onCreate,
    onUpdate,
    onDelete,
    onTogglePin,
    trashedNotes,
    onLoadTrash,
    onRestoreTrashed,
    onPurgeTrashed,
    onEmptyTrash,
    onToggleArchive,
    onToggleStar,
    onNotify,
    folderTags,
    onEnsureFullNote,
    onLoadFullNotes,
    focusNoteId,
    siteLinkApi,
}: NotesPageProps) {
    const filters = useNotesFilters();

    const {
        keyword, setKeyword,
        view, setView,
        sortKey, setSortKey,
        sortAnchor, setSortAnchor,
        activeFolder, setActiveFolder,
        activeTag, setActiveTag,
        remoteSearch, setRemoteSearch,
        recentNoteIds, setRecentNoteIds,
    } = filters;
    const [attManagerOpen, setAttManagerOpen] = useState(false);
    const [previewTarget, setPreviewTarget] = useState<AttachmentPreviewRequest | null>(null);
    const [bindSiteNoteId, setBindSiteNoteId] = useState<number | null>(null);

    const previewController = useMemo(
        () => ({ open: (request: AttachmentPreviewRequest) => setPreviewTarget(request) }),
        []
    );

    const selectAnchorRef = useRef<number | null>(null);
    const [middleHidden, setMiddleHidden] = useState(false);
    const [navDrawerOpen, setNavDrawerOpen] = useState(false);

    const rowActions = useNotesRowActions();

    const {
        multiSelect, setMultiSelect, checked, setChecked,
        exportAnchor, setExportAnchor,
        namePrompt, setNamePrompt,
        removeTarget, setRemoveTarget, closeRemove,
        rowMenu, setRowMenu, menuClosing, setMenuClosing,
        rowActionsSuppressed, setRowActionsSuppressed,
        tagPick, setTagPick, exportPick, setExportPick,
        bulkDeleteOpen, setBulkDeleteOpen, bulkBusy, setBulkBusy,
    } = rowActions;
    const { askName, closeNamePrompt, submitNamePrompt, submitRemove } = useNotesTaxonomy({ folderTags, setActiveFolder, setView, setActiveTag, namePrompt, setNamePrompt, removeTarget, setRemoveTarget });
    const [listCollapsed, setListCollapsed] = useState(false);

    const { navW, listW, startDrag, reset } = useColumnResize();

    useEffect(() => {
        if (!menuClosing) return;
        const onFocusIn = (e: Event) => {
            const el = e.target as HTMLElement | null;
            if (el && el.classList.contains("note-row-actions")) el.blur();
        };
        document.addEventListener("focusin", onFocusIn, true);
        const timer = setTimeout(() => setMenuClosing(false), 300);
        return () => {
            document.removeEventListener("focusin", onFocusIn, true);
            clearTimeout(timer);
        };
    }, [menuClosing, setMenuClosing]);
    const [draggingNoteId, setDraggingNoteId] = useState<number | null>(null);
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    const [notesCmdOpen, setNotesCmdOpen] = useState(false);

    useEffect(() => {
        if (activeId == null) return;
        setRecentNoteIds(prev =>
            [activeId, ...prev.filter(id => id !== activeId)].slice(0, 8)
        );
    }, [activeId, setRecentNoteIds]);

    const userClearedRef = useRef(false);
    const [pane, setPane] = useState<Pane>("split");
    const [splitRatio, setSplitRatio] = useState(readSplitRatio);

    const splitRatioRef = useRef(splitRatio);

    const splitBoxRef = useRef<HTMLDivElement | null>(null);

    const textareaRef = useRef<NoteEditorHandle | null>(null);
    const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
    const [mobileDetail, setMobileDetail] = useState(false);
    const [zenMode, setZenMode] = useState(false);

    useEffect(() => {
        if (!zenMode) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (document.querySelector('[role="dialog"], [role="menu"], [data-lightbox]')) return;
            e.preventDefault();
            setZenMode(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [zenMode]);

    const bp = usePanelBreakpoint();

    const narrowLayout = bp !== "desktop";

    const sideRef = useRef<NoteEditorHandle | null>(null);
    const [sideId, setSideId] = useState<number | null>(null);
    const [sideDraft, setSideDraft] = useState<EditorDraft | null>(null);
    const [sideMode, setSideMode] = useState<"edit" | "split" | "preview">("edit");

    const SIDE_SPLIT_KEY = "notes.sideSplitRatio";
    const [sideSplitRatio, setSideSplitRatio] = useState<number>(() => {
        try {
            const raw = globalThis.localStorage?.getItem(SIDE_SPLIT_KEY);
            const n = raw == null ? NaN : Number(raw);
            return Number.isFinite(n) && n >= MIN_RATIO && n <= MAX_RATIO ? n : 0.5;
        } catch {
            return 0.5;
        }
    });

    const sideSplitRatioRef = useRef(sideSplitRatio);

    const sideSplitBoxRef = useRef<HTMLDivElement | null>(null);
    const [sideSaveState, setSideSaveState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
    const [sideSavedAt, setSideSavedAt] = useState<number | null>(null);
    const [sideTick, setSideTick] = useState(() => Date.now());
    const [uiSettings, setUiSettings] = useState<NotesUiSettings>(loadNotesSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);

    useEffect(() => {
        saveNotesSettings(uiSettings);
    }, [uiSettings]);
    const [sideResizing, setSideResizing] = useState(false);

    const previewScrollRef = useRef<HTMLDivElement | null>(null);

    const paneRowRef = useRef<HTMLDivElement | null>(null);
    const { openAttachmentFromEditor, tools, jumpToOffset, sideTools, mainShortcutActions, sideShortcutActions, liveRenderer, liveRender, setLiveRender, sideLiveRender, setSideLiveRender, autosaveMs, previewFeatures, paneRatio, startPaneDrag, resetPaneRatio, nudgePaneRatio, syncPreviewScroll, handleUpload, handleAttach, replaceDetachedUpload, uploadImageForEditor, uploadFileForSideEditor, startSplitDrag, startSideSplitDrag } = useNotesEditor({ textareaRef, sideRef, previewScrollRef, paneRowRef, splitBoxRef, sideSplitBoxRef, uiSettings, setUiSettings, setDraft, setSideDraft, notes, activeId, sideId, pane, splitRatioRef, setSplitRatio, sideSplitRatioRef, setSideSplitRatio, setSideResizing, uploadApi, onUpdate, onNotify, onEnsureFullNote, previewController });

    useScrollLock(true);

    const pageRef = useRef<HTMLDivElement | null>(null);

    // Listeners read current state through this ref, so typing does not rebind them.
    const overlayKeyState = useRef({
        dirty: false,
        save: null as null | (() => Promise<boolean>),
        blocking: false,
    });

    useEffect(() => {
        overlayKeyState.current = {
            dirty,
            save: () => save(),
            blocking: Boolean(namePrompt || removeTarget || rowMenu || backlinkAnchor),
        };
    });

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const { dirty: isDirty, save: doSave, blocking } = overlayKeyState.current;
            if (e.key === "Escape") {
                // 弹窗/菜单开着时让它们自己处理（它们的 onClose 也监听 Escape）
                if (blocking) return;
                e.preventDefault();
                if (isDirty) void doSave?.().finally(() => onClose());
                else onClose();
                return;
            }
            if (e.key !== "Tab") return;
            const root = pageRef.current;
            if (!root) return;
            // ⚠️ 别用 `offsetParent !== null` 过滤可见性：**jsdom 里它恒为 null**，
            // 那样单测会把可聚焦元素全滤掉（0 个 → 循环逻辑整段不执行，测了个空）。
            // 真正要排掉的是 disabled 与 tabindex="-1"，其余一律纳入；
            // 真机上被 display:none 藏起来的按钮本来也不会进 Tab 序列。
            const focusables = [
                ...root.querySelectorAll<HTMLElement>(
                    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ),
            ].filter(el => el.getAttribute("aria-hidden") !== "true");
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement as HTMLElement | null;
            if (!active || !root.contains(active)) {
                e.preventDefault();
                first.focus();
            } else if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    // Each rendered search input needs its own ref: sharing them causes repeated
    // detach/attach cycles when the narrow layout changes (including in jsdom).
    const searchRef = useRef<HTMLInputElement | null>(null);

    const searchRefNarrow = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!e.defaultPrevented && !e.isComposing && !e.repeat && !e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                // N1：⌘K 在记事本上下文打开命令面板（搜笔记/文件夹/标签 + 执行命令），
                // 不再只是聚焦搜索框。面板里也能搜笔记（含远端全文命中），体验更一致。
                setNotesCmdOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const folders = useMemo(() => folderTags?.folders ?? [], [folderTags]);

    const tags = useMemo(() => folderTags?.tags ?? [], [folderTags]);

    const noteTags = useMemo(() => folderTags?.noteTags ?? EMPTY_TAG_LINKS, [folderTags]);

    const { active, folderCounts, tagCounts, tagColorByName, notesByFolder } = useNotesData({
        notes,
        folders,
        tags,
        noteTags,
        activeId,
    });
    const { backlinkAnchor, setBacklinkAnchor, backlinksOpen, setBacklinksOpen, graphOpen, setGraphOpen, backlinks, outgoingLinks } = useBacklinks({ active, draft, notes, onLoadFullNotes });

    const panels = useNotesPanels({ activeId: active?.id, onListRevisions: folderTags?.onListRevisions });

    const {
        appearanceFolderId, setAppearanceFolderId,
        tagColorId, setTagColorId,
        moveDrawerNoteId, setMoveDrawerNoteId,
        outlineOpen, setOutlineOpen,
        activeMenuAnchor, setActiveMenuAnchor,
        revisionsOpen, setRevisionsOpen,
        revisions, setRevisions,
        openRevisions,
        lightbox, setLightbox,
        imageScale, setImageScale,
        imageFailed, setImageFailed,
        shortcutsOpen, setShortcutsOpen,
        shareId, setShareId,
    } = panels;
    const { toggleChecked, closeRowMenu, boundSite, boundSiteMissing, onOpenBoundSite, exportTarget, completionSources, handleToggleTask, handleSideToggleTask, exportOne, copyText, noteLink, openInSide, closeSide, exportHtmlOne, exportPdfOne } = useNotesRowMenuActions({ notes, activeId, active, draft, sideId, sideDraft, tags, tagCounts, setChecked, setDraft, setSideId, setSideMode, setSideDraft, setActiveId, setMobileDetail, setRowMenu, setRowActionsSuppressed, setMenuClosing, rowMenu, onUpdate, onNotify, onEnsureFullNote, siteLinkApi });

    useEffect(() => {
        if (view === "trash") void onLoadTrash();
    }, [view, onLoadTrash]);

    // Seed only on selection/full-content changes, never on ordinary note refresh.
    const activeForSeedRef = useRef(active);

    activeForSeedRef.current = active;

    useEffect(() => {
        const cur = activeForSeedRef.current;
        if (!cur) return;
        if (cur.content_truncated) {
            setDraft(null);
            return;
        }
        setDraft({ title: cur.title || "", content: cur.content || "" });
    }, [active?.id, active?.content_truncated]);

    const readPosAccount = accountName ?? "";

    useEffect(() => {
        if (!uiSettings.rememberPosition || activeId === null) return;
        const handle = textareaRef.current;
        if (!handle) return;
        // 切到新笔记：恢复它上次的位置
        const saved = readReadingPosition(readPosAccount, activeId);
        if (saved !== null && saved > 0) handle.restoreScrollRatio(saved);
        // 离开这一篇：把当前位置存下来
        return () => {
            writeReadingPosition(readPosAccount, activeId, handle.scrollRatio());
        };
    }, [activeId, uiSettings.rememberPosition, readPosAccount]);

    useEffect(() => {
        if (activeId !== null || userClearedRef.current) return;
        const first = notes.find(n => n.id !== undefined && !n.archived) ?? notes.find(n => n.id !== undefined);
        if (first?.id !== undefined) setActiveId(first.id);
    }, [activeId, notes]);

    const { searchableText, searchHits, searchSnippets, highlightRanges } = useNotesSearch({ notes, noteTags, tags, keyword, remoteSearch, setRemoteSearch, folderTags });

    const { filtered, lazyListGroups, listGroups, visibleIds } = useNotesList({
        notes,
        view,
        keyword,
        activeFolder,
        activeTag,
        sortKey,
        noteTags,
        searchHits,
        searchableText,
    });

    const viewCounts = useMemo(
        () => ({
            all: notes.filter(n => !n.archived).length,
            recent: notes.filter(n => !n.archived).length,
            starred: notes.filter(n => !n.archived && Boolean(n.starred)).length,
            archived: notes.filter(n => Boolean(n.archived)).length,
            uncategorized: notes.filter(
                // 与 filtered 里那个视图同一判据（folder_id 为空 = 没归到任何文件夹）。
                // 两处必须一致，否则左栏写着「未归类 3」点进去却空着。
                n => !n.archived && (n.folder_id === null || n.folder_id === undefined)
            ).length,
            trash: trashedNotes.length,
        }),
        [notes, trashedNotes]
    );

    const sideDirty =
        sideId !== null &&
        sideDraft !== null &&
        notes.some(
            n =>
                n.id === sideId &&
                (sideDraft.title !== (n.title || "") || sideDraft.content !== (n.content || ""))
        );

    useEffect(() => {
        if (sideId === null || !sideDraft) return;
        const note = notes.find(n => n.id === sideId);
        if (!note) return;
        const dirtySide =
            sideDraft.title !== (note.title || "") ||
            sideDraft.content !== (note.content || "");
        if (!dirtySide) {
            setSideSaveState(cur => (cur === "pending" ? "idle" : cur));
            return;
        }
        setSideSaveState("pending");
        const timer = setTimeout(async () => {
            setSideSaveState("saving");
            await onUpdate(sideId, { title: sideDraft.title, content: sideDraft.content });
            setSideSaveState("saved");
            setSideSavedAt(Date.now());
            setSideTick(Date.now());
        }, autosaveMs);

        // 失焦立即落盘（与主栏那处同理，是防抖放宽到 5 秒的补偿）
        const flush = () => {
            clearTimeout(timer);
            void onUpdate(sideId, { title: sideDraft.title, content: sideDraft.content }).then(() => {
                setSideSaveState("saved");
                setSideSavedAt(Date.now());
                setSideTick(Date.now());
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("blur", flush);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            clearTimeout(timer);
            window.removeEventListener("blur", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [sideDraft, sideId, notes, onUpdate, autosaveMs]);

    useEffect(() => {
        if (!syncChangedNoteIds?.length) return;
        if (active?.id === undefined || !syncChangedNoteIds.includes(active.id)) return;
        onNotify?.("当前打开的笔记在其他设备被修改：保存时会提示冲突（覆盖或放弃）", "info");
    }, [syncChangedNoteIds, active?.id, onNotify]);

    useEffect(() => {
        if (!uploadApi?.listAttachments) return;
        let cancelled = false;
        void uploadApi
            .listAttachments()
            .then(list => {
                if (!cancelled && Array.isArray(list)) seedAttachmentDimensions(list);
            })
            .catch(() => {
                // 元数据拉不到就退回纯客户端测量，不是错误
            });
        return () => {
            cancelled = true;
        };
    }, [uploadApi]);

    const attachmentRefCounts = useMemo(() => {
        if (!settingsOpen && !attManagerOpen) return EMPTY_REF_COUNTS;
        const map = new Map<string, number>();
        for (const n of notes) {
            const content = n.content || "";
            if (!content.includes("/api/notes/attachments/")) continue;
            const seen = new Set<string>();
            for (const m of content.matchAll(/\/api\/notes\/attachments\/([0-9a-zA-Z-]+)/g)) {
                if (seen.has(m[1])) continue;
                seen.add(m[1]);
                map.set(m[1], (map.get(m[1]) ?? 0) + 1);
            }
        }
        return map;
    }, [notes, settingsOpen, attManagerOpen]);

    const exportAllData = useCallback(async () => {
        const full = onLoadFullNotes ? await onLoadFullNotes() : notes;
        exportAllNotesJson({ notes: full, folderTags, uploadApi, onNotify });
    }, [notes, onLoadFullNotes, folderTags, uploadApi, onNotify]);

    const exportAllZip = useCallback(async () => {
        const full = onLoadFullNotes ? await onLoadFullNotes() : notes;
        await exportAllNotesZip({ notes: full, folderTags, uploadApi, onNotify });
    }, [notes, onLoadFullNotes, folderTags, uploadApi, onNotify]);

    const { checkedNotes, bulkArchive, bulkDelete } = useNotesBulkOps({ filtered, checked, onToggleArchive, onDelete, onNotify, setChecked, setBulkDeleteOpen, bulkBusy, setBulkBusy });

    const importNotesFile = useCallback(
        (file: File, onProgress?: (p: NoteImportProgress) => void) =>
            runImportNotesFile(
                {
                    // ⚠️ 包一层箭头函数：importNotes 是类方法（内部用 this.request），
                    // 直接传 `shareApi.importNotes` 会把这个引用 detached，this 变 undefined
                    importNotes: shareApi?.importNotes
                        ? (payload: NotesImportPayload) => shareApi.importNotes!(payload)
                        : undefined,
                    uploadApi,
                    onNotify,
                    onDatasetChanged,
                },
                file,
                onProgress
            ),
        [shareApi, uploadApi, onNotify, onDatasetChanged]
    );

    const notesCommands = useMemo<CommandItem[]>(() => {
        const list: CommandItem[] = [
            { id: "shortcuts", label: "键盘快捷键帮助", section: "帮助", run: () => setShortcutsOpen(true) },
            { id: "new", label: "新建笔记", section: "笔记", keywords: "new create 新建", run: () => void onCreate() },
            { id: "welcome", label: "创建欢迎示例笔记", section: "笔记", keywords: "welcome 教程 示例 帮助", run: () => void onCreate({ title: "欢迎使用记事本", content: "# 从这里开始\n\n用 Markdown 记录想法，编辑与预览会同步滚动。\n\n## 常用语法\n\n- **粗体**与 *斜体*\n- [ ] 点击预览中的复选框完成任务\n- [[我的第一条笔记]] 创建双链，使用图谱查看关系\n- 行内输入 #标签 可以补全标签\n\n## 快捷操作\n\nCtrl/⌘K 打开命令面板；Ctrl/⌘S 保存；图片可以粘贴或上传。\n\n## 数据安全\n\n在设置中导出 ZIP（包含附件），也可配置 WebDAV 备份。" }) },
            { id: "find", label: "查找 / 替换", section: "编辑", keywords: "find search 查找 替换", run: () => textareaRef.current?.openSearch() },
            { id: "insert-frontmatter", label: "插入 front-matter", section: "编辑", keywords: "frontmatter 属性 yaml", run: () => tools.onInsertFrontMatter() },
            { id: "insert-wikilink", label: "插入双链", section: "编辑", keywords: "wikilink 双链 链接", run: () => tools.onInsertWikiLink() },
            { id: "pane-edit", label: "布局：仅编辑", section: "视图", keywords: "edit 编辑", run: () => setPane("edit") },
            { id: "pane-split", label: "布局：分栏", section: "视图", keywords: "split 分栏", run: () => setPane("split") },
            { id: "pane-preview", label: "布局：仅预览", section: "视图", keywords: "preview 预览", run: () => setPane("preview") },
        ];
        if (active) {
            list.push(
                { id: "pin", label: "置顶当前笔记", section: "当前笔记", keywords: "pin 置顶", run: () => void onTogglePin(active) },
                { id: "star", label: "收藏当前笔记", section: "当前笔记", keywords: "star 收藏", run: () => void onToggleStar?.(active) },
                { id: "archive", label: "归档当前笔记", section: "当前笔记", keywords: "archive 归档", run: () => void onToggleArchive(active) },
                { id: "share", label: "分享当前笔记", section: "当前笔记", keywords: "share 分享", run: () => active.id != null && setShareId(active.id) },
                { id: "revisions", label: "版本历史", section: "当前笔记", keywords: "history 版本", run: () => void openRevisions() },
                { id: "graph", label: "关系图谱", section: "当前笔记", keywords: "graph 图谱 双链", run: () => setGraphOpen(true) },
                { id: "export-md", label: "导出 Markdown", section: "当前笔记", keywords: "export md markdown", run: () => { const t = exportTarget(); void exportNoteAsMarkdown(t.title, t.content); } },
                { id: "export-html", label: "导出 HTML", section: "当前笔记", keywords: "export html", run: () => { const t = exportTarget(); void exportNoteAsHtml(t.title, t.content); } },
                { id: "delete", label: "删除当前笔记", section: "当前笔记", keywords: "delete 删除", run: () => void onDelete(active) },
            );
        }
        return list.filter(command => {
            if (["find", "insert-frontmatter", "insert-wikilink"].includes(command.id)) return !!active && pane !== "preview";
            if (command.id === "star") return !!onToggleStar;
            if (command.id === "share") return !!shareApi;
            if (command.id === "revisions") return !!folderTags?.onGetRevision;
            return true;
        });
    }, [onCreate, tools, active, pane, shareApi, folderTags, onTogglePin, onToggleStar, onToggleArchive, onDelete, setShareId, openRevisions, setGraphOpen, exportTarget, setShortcutsOpen]);

    const loadRevisionContent = useCallback(
        async (revisionId: number): Promise<string | null> => {
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onGetRevision) return null;
            const rev = await folderTags.onGetRevision(noteId, revisionId);
            return rev ? rev.content : null;
        },
        [active?.id, folderTags]
    );

    const doRestoreRevision = useCallback(
        async (revisionId: number): Promise<boolean> => {
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onRestoreRevision) return false;
            const restored = await folderTags.onRestoreRevision(noteId, revisionId);
            if (!restored) return false;
            setRevisions(null);
            // ⚠️ 必须显式写回草稿：草稿只在「换了笔记」（active.id 变化）时重置，
            // 而版本恢复 id 是一样的 —— 不塞回去的话界面还停在恢复前的内容，
            // 看着像「点了没反应」。
            setDraft({ title: restored.title || "", content: restored.content || "" });
            onNotify?.("已恢复到该版本（恢复前的内容也存了一份快照）", "success");
            return true;
        },
        [active?.id, folderTags, onNotify, setRevisions]
    );

    useEffect(() => {
        if (!lightbox) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setLightbox(null);
                return;
            }
            // 输入类按键不要抢：万一将来灯箱里加了输入框
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            const zoom = (delta: number | "reset") => {
                e.preventDefault();
                setImageScale(s =>
                    delta === "reset" ? 1 : Math.max(0.3, Math.min(6, s + delta))
                );
            };
            if (e.key === "+" || e.key === "Add" || e.code === "Equal") zoom(0.25);
            else if (e.key === "-" || e.key === "Subtract" || e.code === "Minus") zoom(-0.25);
            else if (e.key === "0") zoom("reset");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [lightbox, setImageScale, setLightbox]);

    const lightboxRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!lightbox) return;
        const opener = document.activeElement as HTMLElement | null;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        // 焦点交给容器本身（tabIndex=-1 可编程聚焦），Tab 的起点就定了
        lightboxRef.current?.focus();
        const trap = (e: KeyboardEvent) => {
            if (e.key !== "Tab") return;
            const root = lightboxRef.current;
            if (!root) return;
            const focusable = [
                ...root.querySelectorAll<HTMLElement>(
                    "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
                ),
            ].filter(el => !el.hasAttribute("disabled"));
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", trap);
        return () => {
            window.removeEventListener("keydown", trap);
            document.body.style.overflow = prevOverflow;
            opener?.focus?.();
        };
    }, [lightbox]);

    const outline = useMemo(
        () => extractOutline(draft?.content ?? ""),
        [draft?.content]
    );
    const [outlineActiveLine, setOutlineActiveLine] = useState<number | null>(null);

    useEffect(() => {
        if (!outlineOpen) return;
        const scroller = previewScrollRef.current;
        if (!scroller) return;
        let raf = 0;
        const update = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                const top = scroller.getBoundingClientRect().top + 60;
                let current: number | null = null;
                for (const heading of outline) {
                    const element = scroller.querySelector<HTMLElement>(`[data-line="${heading.line}"]`);
                    if (element && element.getBoundingClientRect().top <= top) current = heading.line;
                }
                setOutlineActiveLine(current);
            });
        };
        update();
        scroller.addEventListener("scroll", update, { passive: true });
        return () => { cancelAnimationFrame(raf); scroller.removeEventListener("scroll", update); };
    }, [outlineOpen, outline, pane]);

    const dirty =
        !!active &&
        !!draft &&
        (draft.title !== (active.title || "") || draft.content !== (active.content || ""));

    const save = useCallback(async () => {
        if (!active?.id || !draft) return true;
        try {
            return (await onUpdate(active.id, { title: draft.title, content: draft.content })) !== false;
        } catch {
            // ⚠️ 这里**不再**自己弹提示（2026-10-25）：保存失败的通知统一交给
            // 下面的 `onSaveError`。两处都弹的话，一次失败会连着冒 3~4 条
            // 一模一样的通知（这一条 + useNotes 内部的「保存笔记失败」+
            // 自动保存放弃时的那条），用户只会觉得记事本在刷屏。
            // 返回 false 的语义不变：自动保存那边照旧记一次失败、照旧重试。
            return false;
        }
    }, [active, draft, onUpdate]);

    const { saveState, savedAt, tick } = useNoteAutoSave({
        dirty,
        draft,
        noteId: active?.id,
        autosaveMs,
        save,
        // 自动保存「连续失败到上限、已停止重试」时**报一次**（2026-10-25 接通）。
        // 之前这个入参没接，失败只体现在 saveState 的灰点上 —— 状态是对的，
        // 但用户看不到任何提示，关掉记事本就丢了内容。
        onSaveError: msg => onNotify?.(msg, "error"),
    });
    const [templatePick, setTemplatePick] = useState<{ folderId: number | null; el: HTMLElement | null } | null>(null);

    const openTemplatePicker = useCallback((anchor: HTMLElement | null, folderId: number | null) => {
        setTemplatePick({ folderId, el: anchor });
    }, []);
    const { openNote, startCreateInFolder, createFromTemplate, notesInFolder, switchTo, jumpToNote, resolveNote, handleOpenEmbedNote } = useNotesNavigation({ notes, notesByFolder, dirty, save, templatePick, setActiveId, setMobileDetail, setDraft, onCreate });

    const focusedRef = useRef<number | null>(null);

    useEffect(() => {
        if (focusNoteId == null) return;
        if (focusedRef.current === focusNoteId) return;
        if (!notes.some(n => n.id === focusNoteId)) return;
        focusedRef.current = focusNoteId;
        void jumpToNote(focusNoteId);
    }, [focusNoteId, notes, jumpToNote]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "/") {
                const el = textareaRef.current;
                if (!el) return;
                const focused = document.activeElement as HTMLElement | null;
                if (!focused || !focused.closest?.(".cm-editor, textarea")) return;
                e.preventDefault();
                tools.onInsertHiddenComment();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [tools, textareaRef]);

    const charCount = draft ? draft.content.length : 0;

    const wordCount = useMemo(() => {
        const s = draft?.content ?? "";
        return s.replace(/\s+/g, "").length;
    }, [draft?.content]);

    const noteWordTotal = useMemo(
        () =>
            // ⚠️ 同批处理：只在数据面板打开时才扫全部正文（每条笔记都要 replace 出一份
            // 去空白的新字符串 = 按字节数分配一遍内存），置顶/保存时不该付这笔钱。
            settingsOpen
                ? notes.reduce((sum, n) => sum + (n.content ?? "").replace(/\s+/g, "").length, 0)
                : 0,
        [notes, settingsOpen]
    );

    const activeFolderName = useMemo(() => {
        const fid = active?.folder_id;
        if (fid === null || fid === undefined) return "";
        return folders.find(f => f.id === fid)?.name ?? "";
    }, [active?.folder_id, folders]);

    const activeTagNames = useMemo(
        () => (active ? tagNamesOf(active, noteTags, tags) : []),
        [active, noteTags, tags]
    );

    const pinnedCount = notes.filter(n => Boolean(n.pinned)).length;

    const folderFocus = activeFolder !== null;

    const listHidden = folderFocus || middleHidden;

    const { emptyArt, emptyCopy } = useNotesEmptyState({ view, activeFolder, activeTag, notesLength: notes.length });

    const renderSearchField = useCallback((inputRef: React.RefObject<HTMLInputElement | null>) => (
        // 用 TextField + InputAdornment：之前是自己画的绝对定位图标，
        // 那个放大镜飘在框外面右下方，对不齐也很难看。
        <>
            <TextField
                fullWidth
                size='small'
                inputRef={inputRef}
                // 外观与导航页顶栏同一套（2026-10-25）：36px 高、圆角走 --header-radius、
                // 玻璃底 + 细描边。改造前是 MUI 默认外观（40px 高、4px 圆角、全色描边），
                // 和顶栏那排玻璃胶囊完全是两套语言。
                // ⚠️ 用外层 border 而不是 OutlinedInput 的 fieldset：fieldset 在 focused 时
                // 会被 MUI 换成 2px 描边、圆角也跟着变，压不住。
                sx={{
                    "& .MuiOutlinedInput-root": {
                        // 高度走变量：导航列那份由 NotesNavPanel 传 --notes-search-h（30，比顶栏
                        // 小一档，用户反馈「白框太大」）；tablet 顶栏 / mobile 列表不设变量，回落到 36。
                        height: `var(--notes-search-h, ${HEADER_CONTROL_H}px)`,
                        borderRadius: HEADER_RADIUS,
                        // 2026-10-27（参考 inkstone 左栏）：底色从「白胶囊」改成**透明**。
                        // 左栏是浅底，一块白填充加上描边，在 30px 行高里是这一列最重的元素 ——
                        // 和旁边返回箭头、下面选中行叠在一起就是「拥挤」。inkstone 那块搜索框
                        // 只有描边、没有填充，轻一档但仍然是「框」。
                        // ⚠️ 描边仍是 --neutral-border（30% 灰）：v16.0.2 踩过「描边看不见
                        // 就不像输入框」，别退回 --glass-border。
                        bgcolor: "transparent",
                        // 不能用 --glass-border（亮色是 rgba(255,255,255,0.6) 白底白边、
                        // 暗色是 0.12 白，都几乎看不见）—— 左栏是纯浅底，白边会让搜索框
                        // 糊成一根灰条、没有「输入框」的形。改用 --neutral-border（30% 灰），
                        // 正好是 MUI 默认 outlined 输入框的描边强度，亮/暗都读得出。
                        border: "1px solid var(--neutral-border)",
                        transition: "border-color 120ms ease, background-color 120ms ease",
                        "&:hover": {
                            borderColor: "color-mix(in srgb, var(--accent) 35%, var(--glass-border))",
                        },
                        "&.Mui-focused": { borderColor: "var(--accent)" },
                    },
                    "& .MuiOutlinedInput-notchedOutline": { border: "none" },
                }}
                value={keyword}
                onChange={e => {
                    setKeyword(e.target.value);
                    // 打字即进入「全文搜索」视图（inkstone 的做法：搜索框就是
                    // 全文搜索的入口，不再单独占一个导航行）。清空时留在搜索视图，
                    // 给出全部列表（与原来的空关键词回退一致）。
                    setView("search");
                    setActiveFolder(null);
                    setActiveTag(null);
                    setMiddleHidden(false);
                }}
                onFocus={() => {
                    // 点搜索框 = 打开全文搜索中栏（inkstone 同款交互）
                    setView("search");
                    setActiveFolder(null);
                    setActiveTag(null);
                    setMiddleHidden(false);
                }}
                // 2026-10-27（参考 inkstone）：占位符从「搜索标题与内容」缩成「搜索」。
                // 这个字段在三处复用，其中左栏是**可调宽**的（默认 128，最小 104）——
                // 七字占位符在 128px 下连着 ⌘K 胶囊只剩一半，实测被切成「搜」+ 半个「索」，
                // 看起来像渲染坏了。占位符缩到两字后 104px 也不会被切。
                // 语义信息不丢：aria-label 仍是「搜索笔记」，屏幕阅读器读得到。
                placeholder='搜索'
                slotProps={{
                    input: {
                        "aria-label": "搜索笔记",
                        startAdornment: (
                            <InputAdornment position='start'>
                                <SearchIcon fontSize='small' />
                            </InputAdornment>
                        ),
                        // 阶段二：搜索框右侧挂个 ⌘K 提示（⌘/Ctrl+K 会聚焦它）
                        // 2026-10-27（参考 inkstone）：字段本身变成透明底之后，这枚提示反过来
                        // 做成**白底小胶囊** —— inkstone 那块搜索框里也是「字段是平的、快捷键
                        // 是浮起来的白片」。原来的「描边 + 透明」在透明字段上会看不见。
                        endAdornment: (
                            <InputAdornment position='end'>
                                <Box
                                    component='kbd'
                                    aria-hidden='true'
                                    sx={{
                                        fontSize: 10,
                                        lineHeight: 1.4,
                                        px: 0.6,
                                        py: 0.1,
                                        borderRadius: 0.75,
                                        border: "1px solid var(--neutral-hairline)",
                                        bgcolor: "var(--glass-bg-hover)",
                                        // ⚠️ 不能用 text.disabled（38% 黑）：这枚胶囊现在是**白底**，
                                        // 38% 黑压在白底上实测淡到读不出（截图放大后是一团白），
                                        // 快捷键提示就白挂了。用 text.secondary（60% 黑）。
                                        color: "text.secondary",
                                        // ⚠️ 2026-10-27：窄列里这枚提示要**自动隐身**。
                                        // 算过账：字段宽 112（128 列减左右各 8）－ 内部左右各 14
                                        // 的内填充 － 放大镜 20+8 － 本胶囊 26.6+8 ⇒ 输入区只剩
                                        // 19px；16px 字号下连一个字都放不下，占位符被切成半个字。
                                        // 列宽 ≥ 148 时输入区还有 41px 以上，才值得挂这枚提示。
                                        // 容器名 notesnav 只在桌面左栏声明（NotesListPane 的
                                        // data-nav-col）—— tablet 抽屉 / 手机列表里没有这个容器，
                                        // 提示照常显示，不受影响。
                                        "@container notesnav (max-width: 147px)": { display: "none" },
                                    }}
                                >
                                    ⌘K
                                </Box>
                            </InputAdornment>
                        ),
                    },
                }}
            />
            {/* 全文检索降级提示：FTS5 不可用时服务端走 LIKE 全表扫（能搜但慢、且不排序）。
            以前只写在服务端日志里，用户看到的是「搜得越来越慢 / 有些搜不到」，
            却不知道是索引没建起来、也不知道能去「设置 → 数据」重建索引。 */}
            {remoteSearch?.mode === "like" ? (
                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ display: "block", mt: 0.5, px: 0.5 }}
                >
                    当前数据库不支持全文索引，搜索已降级为逐条匹配（结果不排序，笔记多时会变慢）。
                    可在「设置 → 数据」里重建索引试试。
                </Typography>
            ) : null}
        </>
    ), [keyword, setKeyword, setView, setActiveFolder, setActiveTag, setMiddleHidden, remoteSearch]);

    const sideNote = sideId !== null ? notes.find(n => n.id === sideId) ?? null : null;






    return {
        SIDE_SPLIT_KEY, bindSiteNoteId, setBindSiteNoteId, accountName, active, activeFolder,
        activeFolderName, activeId, activeMenuAnchor, activeTag, activeTagNames, appearanceFolderId,
        askName, attManagerOpen, attachmentRefCounts, backlinks, backlinksOpen, backupApi,
        boundSite, boundSiteMissing, bp, bulkArchive, bulkDelete, bulkDeleteOpen,
        charCount, checked, checkedNotes, closeNamePrompt, closeRemove, closeRowMenu,
        closeSide, completionSources, copyText, dirty, draft, draggingNoteId,
        emptyArt, emptyCopy, exportAllData, exportAllZip, exportAnchor, exportHtmlOne,
        exportOne, exportPdfOne, exportPick, exportTarget, filtered, folderCounts,
        folderTags, folders, handleAttach, handleOpenEmbedNote, handleSideToggleTask, handleToggleTask,
        handleUpload, highlightRanges, importNotesFile, jumpToNote, jumpToOffset, keyword,
        lazyListGroups, listCollapsed, listGroups, listHidden, listW, liveRender,
        liveRenderer, mainShortcutActions, menuClosing, moveDrawerNoteId, multiSelect, namePrompt,
        narrowLayout, navW, noteLink, noteTags, noteWordTotal, notes,
        notesCommands, notesInFolder, onClose, onCreate, onDatasetChanged, onDelete,
        onEmptyTrash, onNotify, onOpenBoundSite, onPurgeTrashed, onRestoreTrashed, onToggleArchive,
        onTogglePin, onToggleStar, onUpdate, openAttachmentFromEditor, openInSide, openNote,
        openRevisions, outgoingLinks, outline, outlineActiveLine, outlineOpen, pane,
        pinnedCount, previewFeatures, previewScrollRef, removeTarget, renderSearchField, replaceDetachedUpload,
        reset, resolveNote, rowActionsSuppressed, rowMenu, save, saveState,
        savedAt, searchRef, searchRefNarrow, searchSnippets, selectAnchorRef, setActiveFolder,
        setActiveId, setActiveMenuAnchor, setActiveTag, setAppearanceFolderId, setAttManagerOpen, setBacklinkAnchor,
        setBacklinksOpen, setBulkDeleteOpen, setChecked, setDraft, setDraggingNoteId, setExportAnchor,
        setExportPick, setGraphOpen, setLightbox, setListCollapsed, setLiveRender, setMiddleHidden,
        setMobileDetail, setMoveDrawerNoteId, setMultiSelect, setNavDrawerOpen, setOutlineActiveLine, setOutlineOpen,
        setPane, setRemoveTarget, setRowActionsSuppressed, setRowMenu, setSettingsOpen, setShareId,
        setSideDraft, setSideLiveRender, setSideMode, setSideSplitRatio, setSortAnchor, setSortKey,
        setSplitRatio, setTagColorId, setTagPick, setUiSettings, setView, settingsOpen,
        shareApi, siteLinkApi, sideDirty, sideDraft, sideId, sideLiveRender,
        sideMode, sideNote, sideRef, sideSaveState, sideSavedAt, sideShortcutActions,
        sideSplitBoxRef, sideSplitRatio, sideSplitRatioRef, sideTick, sideTools, sortAnchor,
        sortKey, splitBoxRef, splitRatio, splitRatioRef, startCreateInFolder, openTemplatePicker,
        startDrag, startSideSplitDrag, startSplitDrag, submitNamePrompt, submitRemove, switchTo,
        syncPreviewScroll, tagColorByName, tagColorId, tagCounts, tagPick, tags,
        textareaRef, tick, toggleChecked, tools, trashedNotes, uiSettings,
        uploadApi, uploadFileForSideEditor, uploadImageForEditor, userClearedRef, view, viewCounts,
        visibleIds, wordCount, zenMode, setZenMode, previewController, pageRef,
        shareId, templatePick, createFromTemplate, setTemplatePick, graphOpen, setPreviewTarget,
        previewTarget, notesCmdOpen, setNotesCmdOpen, recentNoteIds, shortcutsOpen, setShortcutsOpen,
        revisionsOpen, revisions, loadRevisionContent, doRestoreRevision, setRevisionsOpen, setRevisions,
        lightbox, lightboxRef, setImageScale, setImageFailed, imageScale, imageFailed,
        backlinkAnchor, mobileDetail, middleHidden, paneRowRef, sideResizing, paneRatio,
        startPaneDrag, resetPaneRatio, nudgePaneRatio, navDrawerOpen,
    };
}
