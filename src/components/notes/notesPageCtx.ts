// src/components/notes/notesPageCtx.ts
// 记事本页「面板共享上下文」的类型。
//
// 这个文件的字段类型是用 TypeScript 编译器从 NotesPage.tsx 的真实代码里**导出**的
//（不是手写）：一百来个字段全由 useState / useMemo / useCallback 推出来，手写既慢又
// 容易抄错，而编译器算出来的一定与真实用法一致。
//
// 意义：五个面板组件各自用 Pick<NotesPageCtx, ...> 取需要的字段，NotesPage 组装一次
// 整体下发 —— 以后改一个字段的类型只需改这里，不用在五个组件里同步。
//
// ⚠️ 纯类型文件（只有 import type 与 interface）：运行时一行都不产生，
// 也不会把 NotesPage 拖进任何面板的 chunk。
import type { ReactNode } from "react";
import type { Note, NoteFolder, NoteImportProgress, NoteImportStats, NoteRevision, NoteSearchResult, NoteTag, NotesBackupSavePatch, NotesBackupState, NotesImportPayload, WebDavErrorCode } from "../../API/types";
import type { ResolvedWikiLink } from "../../utils/noteWikiLink";
import type { PanelBreakpoint } from "../../hooks/usePanelBreakpoint";
import type { CompletionSources } from "../../utils/noteCompletion";
import type { MenuAnchor } from "./sidebarSection";
import type { CommandItem } from "../CommandPalette";
import type { OutlineItem } from "../../utils/noteOutline";
import type { RenderFeatures } from "../../utils/markdownToReact";
import type { NoteEmbedTarget } from "../NoteEmbedNode";
import type { EditorDraft, TableOp } from "../../hooks/useEditorTools";
import type { NotesUiSettings } from "../../utils/notesSettings";
import type { NoteShareApi } from "../NoteShareDialog";
import type { NoteEditorHandle } from "../../utils/noteEditorHandle";
import type { TrashedNote } from "../../hooks/useNotes";

/** 把编辑区拆成「源码 | 预览」两栏 */
export type Pane = "edit" | "split" | "preview";

/** 左栏视图 */
export type NoteView =
    | "all"
    | "recent"
    | "starred"
    | "archived"
    | "uncategorized"
    | "trash"
    // 「选中某个文件夹」的视图键（2026-10-18）：点文件夹时切到这里，
    // 左栏「全部 / 最近」等行不再保持高亮 —— 否则计数还显示「全部 3」
    // 而中栏只有该文件夹的 1 条，用户以为没切过去（报「笔记不在文件夹下方」）。
    | "folder"
    // 「搜索」是 2026-10-06 加的独立视图：inkstone 左栏第一项就是它。
    // 之前只有列表上方那个输入框（搜标题+正文），搜不到标签、也不给命中数。
    | "search";

export interface NotesPageCtx {
    SIDE_SPLIT_KEY: string;
    accountName: string | undefined;
    active: Note | null;
    activeFolder: number | null;
    activeFolderName: string;
    activeId: number | null;
    activeMenuAnchor: HTMLElement | null;
    activeTag: number | null;
    activeTagNames: Array<string>;
    appearanceFolderId: number | null;
    askName: (kind: "folder" | "tag", options?: { parentId?: number | null; defaultValue?: string; title?: string; description?: string; renameId?: number; }) => void;
    attManagerOpen: boolean;
    attachmentRefCounts: ReadonlyMap<string, number>;
    backlinks: Array<ResolvedWikiLink>;
    backlinksOpen: boolean;
    backupApi: { getState(): Promise<NotesBackupState>; save(patch: NotesBackupSavePatch): Promise<void>; test(): Promise<{ success: boolean; message: string; }>; run(): Promise<{ success: boolean; message: string; }>; listRemote(): Promise<{ success: boolean; files: { name: string; size: number; lastModified: string; }[]; message: string; }>; fetch(filename: string, password: string): Promise<{ success: boolean; message: string; payload?: NotesImportPayload; zipBase64?: string; code?: WebDavErrorCode; }>; deleteRemote?(filename: string): Promise<{ success: boolean; message: string; }>; } | undefined;
    bp: PanelBreakpoint;
    bulkArchive: () => Promise<void>;
    bulkDelete: () => Promise<void>;
    bulkDeleteOpen: boolean;
    charCount: number;
    checked: Set<number>;
    checkedNotes: Array<Note>;
    closeNamePrompt: () => void;
    closeRemove: () => void;
    closeRowMenu: () => void;
    closeSide: () => void;
    completionSources: () => CompletionSources;
    copyText: (text: string, okMsg: string) => Promise<void>;
    dirty: boolean;
    draft: { title: string; content: string; } | null;
    draggingNoteId: number | null;
    emptyArt: "notes" | "folder" | "tag" | "starred" | "trash" | "search" | "archive";
    emptyCopy: { title: string; desc: string; };
    exportAllData: () => void;
    exportAllZip: () => Promise<void>;
    exportAnchor: HTMLElement | null;
    exportHtmlOne: (note: Note) => void;
    exportOne: (note: Note) => void;
    exportPdfOne: (note: Note) => void;
    exportPick: { el: MenuAnchor; noteId: number; } | null;
    exportTarget: () => { title: string; content: string; };
    filtered: Array<Note>;
    folderCounts: Map<number, number>;
    folderTags: { folders: NoteFolder[]; tags: NoteTag[]; noteTags?: Record<number, number[]>; onCreateFolder: (name: string, parentId?: number | null) => Promise<NoteFolder | null>; onMoveFolder?: (id: number, parentId: number | null) => Promise<void>; onReorderFolder?: (id: number, dir: -1 | 1) => Promise<void>; onRenameFolder: (id: number, name: string) => Promise<void>; onRemoveFolder: (id: number) => Promise<void>; onCreateTag: (name: string) => Promise<NoteTag | null>; onRenameTag: (id: number, name: string) => Promise<void>; onRemoveTag: (id: number) => Promise<void>; onAssignTags: (noteId: number, tagIds: number[]) => Promise<NoteTag[] | null>; onStyleFolder?: (id: number, patch: { icon?: string | null; color?: string | null; }) => Promise<void>; onStyleTag?: (id: number, color: string | null) => Promise<void>; onListRevisions?: (noteId: number) => Promise<NoteRevision[]>; onRestoreRevision?: (noteId: number, revisionId: number) => Promise<Note | null>; onGetRevision?: (noteId: number, revisionId: number) => Promise<NoteRevision | null>; onSearchRemote?: (query: string, limit?: number) => Promise<NoteSearchResult | null>; } | undefined;
    folders: Array<NoteFolder>;
    handleAttach: (file: File, noteId: number | null, side: boolean) => Promise<void>;
    handleOpenEmbedNote: (title: string) => void;
    handleSideToggleTask: (line: number, checked: boolean) => void;
    handleToggleTask: (line: number, checked: boolean) => void;
    handleUpload: (file: File, noteId: number | null) => Promise<{ url: string; filename: string; size: number; }>;
    highlightRanges: Map<number, Array<[number, number]>>;
    importNotesFile: (file: File, onProgress?: (p: NoteImportProgress) => void) => Promise<NoteImportStats>;
    jumpToNote: (id: number) => Promise<boolean>;
    jumpToOffset: (offset: number) => void;
    keyword: string;
    lazyListGroups: boolean;
    listCollapsed: boolean;
    listGroups: Array<{ key: string; label: string; items: Note[]; }>;
    listHidden: boolean;
    listW: number;
    liveRender: boolean;
    liveRenderer: (source: string) => Promise<ReactNode>;
    mainShortcutActions: Record<string, () => void>;
    menuClosing: boolean;
    moveDrawerNoteId: number | null;
    multiSelect: boolean;
    namePrompt: { kind: "folder" | "tag"; title: string; description?: string; defaultValue?: string; confirmText: string; parentId: number | null; renameId?: number; } | null;
    narrowLayout: boolean;
    navInner: React.JSX.Element;
    navW: number;
    noteLink: (note: Note) => string;
    noteTags: Record<number, Array<number>>;
    noteWordTotal: number;
    notes: Array<Note>;
    notesCommands: Array<CommandItem>;
    notesInFolder: (folderId: number) => Array<{ id: number; title: string; }>;
    onClose: () => void;
    onCreate: (draft?: Partial<Note>) => Promise<Note | null>;
    onDatasetChanged: (() => void | Promise<void>) | undefined;
    onDelete: (note: Note) => Promise<void>;
    onEmptyTrash: () => Promise<void>;
    onNotify: ((message: string, severity?: "success" | "error" | "info") => void) | undefined;
    onPurgeTrashed: (recycleId: number) => Promise<void>;
    onRestoreTrashed: (recycleId: number) => Promise<void>;
    onToggleArchive: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
    onToggleStar: ((note: Note) => Promise<void>) | undefined;
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void | boolean>;
    openAttachmentFromEditor: (id: string) => void;
    openInSide: (note: Note) => void;
    openNote: (note: Note) => void;
    openRevisions: () => Promise<void>;
    outgoingLinks: Array<ResolvedWikiLink>;
    outline: Array<OutlineItem>;
    outlineActiveLine: number | null;
    outlineOpen: boolean;
    pane: Pane;
    pinnedCount: number;
    previewFeatures: RenderFeatures;
    previewScrollRef: React.RefObject<HTMLDivElement | null>;
    removeTarget: { kind: "folder" | "tag"; id: number; name: string; } | null;
    renderSearchField: (inputRef: React.RefObject<HTMLInputElement | null>) => React.JSX.Element;
    replaceDetachedUpload: (noteId: number, placeholder: string, replacement: string) => Promise<void>;
    reset: (which: "nav" | "list") => () => void;
    resolveNote: (title: string) => NoteEmbedTarget | null;
    rowActionsSuppressed: number | null;
    rowMenu: { noteId: number; el: MenuAnchor; source: "list" | "rail"; } | null;
    save: () => Promise<boolean>;
    saveState: "idle" | "pending" | "saving" | "saved";
    savedAt: number | null;
    searchRef: React.RefObject<HTMLInputElement | null>;
    searchRefNarrow: React.RefObject<HTMLInputElement | null>;
    searchSnippets: Map<number, string>;
    selectAnchorRef: React.RefObject<number | null>;
    setActiveFolder: React.Dispatch<React.SetStateAction<number | null>>;
    setActiveId: React.Dispatch<React.SetStateAction<number | null>>;
    setActiveMenuAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
    setActiveTag: React.Dispatch<React.SetStateAction<number | null>>;
    setAppearanceFolderId: React.Dispatch<React.SetStateAction<number | null>>;
    setAttManagerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setBacklinkAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
    setBacklinksOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setBulkDeleteOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setChecked: React.Dispatch<React.SetStateAction<Set<number>>>;
    setDraft: React.Dispatch<React.SetStateAction<{ title: string; content: string; } | null>>;
    setDraggingNoteId: React.Dispatch<React.SetStateAction<number | null>>;
    setExportAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
    setExportPick: React.Dispatch<React.SetStateAction<{ el: MenuAnchor; noteId: number; } | null>>;
    setGraphOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setLightbox: React.Dispatch<React.SetStateAction<{ src: string; alt: string; } | null>>;
    setListCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
    setLiveRender: (updater: boolean | ((v: boolean) => boolean)) => void;
    setMiddleHidden: React.Dispatch<React.SetStateAction<boolean>>;
    setMobileDetail: React.Dispatch<React.SetStateAction<boolean>>;
    setMoveDrawerNoteId: React.Dispatch<React.SetStateAction<number | null>>;
    setMultiSelect: React.Dispatch<React.SetStateAction<boolean>>;
    setNavDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setOutlineActiveLine: React.Dispatch<React.SetStateAction<number | null>>;
    setOutlineOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setPane: React.Dispatch<React.SetStateAction<Pane>>;
    setRemoveTarget: React.Dispatch<React.SetStateAction<{ kind: "folder" | "tag"; id: number; name: string; } | null>>;
    setRowActionsSuppressed: React.Dispatch<React.SetStateAction<number | null>>;
    setRowMenu: React.Dispatch<React.SetStateAction<{ noteId: number; el: MenuAnchor; source: "list" | "rail"; } | null>>;
    setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setShareId: React.Dispatch<React.SetStateAction<number | null>>;
    setSideDraft: React.Dispatch<React.SetStateAction<EditorDraft | null>>;
    setSideLiveRender: React.Dispatch<React.SetStateAction<boolean>>;
    setSideMode: React.Dispatch<React.SetStateAction<"edit" | "split" | "preview">>;
    setSideSplitRatio: React.Dispatch<React.SetStateAction<number>>;
    setSortAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
    setSortKey: React.Dispatch<React.SetStateAction<"title" | "default" | "created">>;
    setSplitRatio: React.Dispatch<React.SetStateAction<number>>;
    setTagColorId: React.Dispatch<React.SetStateAction<number | null>>;
    setTagPick: React.Dispatch<React.SetStateAction<{ el: MenuAnchor; noteId: number; } | null>>;
    setUiSettings: React.Dispatch<React.SetStateAction<NotesUiSettings>>;
    setView: React.Dispatch<React.SetStateAction<NoteView>>;
    settingsOpen: boolean;
    shareApi: NoteShareApi | undefined;
    sideDirty: boolean;
    sideDraft: EditorDraft | null;
    sideId: number | null;
    sideLiveRender: boolean;
    sideMode: "edit" | "split" | "preview";
    sideNote: Note | null;
    sideRef: React.RefObject<NoteEditorHandle | null>;
    sideSaveState: "idle" | "pending" | "saving" | "saved";
    sideSavedAt: number | null;
    sideShortcutActions: Record<string, () => void>;
    sideSplitBoxRef: React.RefObject<HTMLDivElement | null>;
    sideSplitRatio: number;
    sideSplitRatioRef: React.RefObject<number>;
    sideTick: number;
    sideTools: { undoableInsert: (tool: string, build: (value: string) => { next: string; at: number; snippet: string; caret: number; selEnd: number; } | null) => void; insertAtCursor: (before: string, after: string, placeholder: string) => void; setHeadingLevel: (level: number) => void; insertCallout: (type: string) => void; insertFootnoteRef: () => void; applyCodeLanguage: (lang: string) => void; applyTable: (op: TableOp) => void; applyFormula: (kind: "inline" | "block" | "inlineTex" | "blockTex") => void; toggleLinePrefix: (prefix: string) => void; insertBlock: (tool: string, block: string) => void; onInsertEmbed: () => void; onInsertBlockRef: () => void; onInsertBlockId: () => void; onInsertFrontMatter: () => void; onInsertTag: () => void; onInsertWikiLink: () => void; onInsertHiddenComment: () => void; onInsertFold: () => void; onInsertTabs: () => void; onInsertDivider: () => void; jumpToOffset: (offset: number) => void; };
    sortAnchor: HTMLElement | null;
    sortKey: "title" | "default" | "created";
    splitBoxRef: React.RefObject<HTMLDivElement | null>;
    splitRatio: number;
    splitRatioRef: React.RefObject<number>;
    startCreateInFolder: (folderId: number | null) => Promise<void>;
    startDrag: (which: "nav" | "list") => (e: React.PointerEvent) => void;
    startSideSplitDrag: (e: React.PointerEvent) => void;
    startSplitDrag: (e: React.PointerEvent) => void;
    submitNamePrompt: (name: string) => Promise<void>;
    submitRemove: () => Promise<void>;
    switchTo: (id: number | null) => Promise<boolean>;
    syncPreviewScroll: (_ratio: number) => void;
    tagColorByName: Map<string, string>;
    tagColorId: number | null;
    tagCounts: Map<number, number>;
    tagPick: { el: MenuAnchor; noteId: number; } | null;
    tags: Array<NoteTag>;
    textareaRef: React.RefObject<NoteEditorHandle | null>;
    tick: number;
    toggleChecked: (id: number) => void;
    tools: { undoableInsert: (tool: string, build: (value: string) => { next: string; at: number; snippet: string; caret: number; selEnd: number; } | null) => void; insertAtCursor: (before: string, after: string, placeholder: string) => void; setHeadingLevel: (level: number) => void; insertCallout: (type: string) => void; insertFootnoteRef: () => void; applyCodeLanguage: (lang: string) => void; applyTable: (op: TableOp) => void; applyFormula: (kind: "inline" | "block" | "inlineTex" | "blockTex") => void; toggleLinePrefix: (prefix: string) => void; insertBlock: (tool: string, block: string) => void; onInsertEmbed: () => void; onInsertBlockRef: () => void; onInsertBlockId: () => void; onInsertFrontMatter: () => void; onInsertTag: () => void; onInsertWikiLink: () => void; onInsertHiddenComment: () => void; onInsertFold: () => void; onInsertTabs: () => void; onInsertDivider: () => void; jumpToOffset: (offset: number) => void; };
    trashedNotes: Array<TrashedNote>;
    uiSettings: NotesUiSettings;
    uploadApi: { uploadAttachment(file: File, noteId?: number | null): Promise<{ id: string; url: string; filename: string; mime: string; size: number; }>; listAttachments?(): Promise<{ id: string; size: number; filename: string; mime: string; }[]>; pruneAttachments?(): Promise<{ removed: number; freedBytes: number; }>; deleteAttachment?(id: string): Promise<{ ok: boolean; }>; renameAttachment?(id: string, filename: string): Promise<{ filename: string; updatedNotes: number; }>; updateAttachmentContent?(id: string, text: string): Promise<{ size: number; mime: string; }>; } | undefined;
    uploadFileForSideEditor: (file: File) => Promise<{ url: string; filename: string; }>;
    uploadImageForEditor: (file: File) => Promise<{ url: string; filename: string; }>;
    userClearedRef: React.RefObject<boolean>;
    view: NoteView;
    viewCounts: { all: number; recent: number; starred: number; archived: number; uncategorized: number; trash: number; };
    visibleIds: Array<number>;
    wordCount: number;
}
