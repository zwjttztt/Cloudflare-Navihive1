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

/**
 * 站点侧提供给记事本的能力（#477 双向绑定的**笔记那一侧**）。
 *
 * 站名 / 站点清单都不在记事本手里 —— 那是 App 的分组树。所以两边通过这个口子
 * 对接：记事本负责「我要什么」，App 负责「从内存里查」。
 *
 * 2026-10-23 扩了 list / bind：笔记右键加了「绑定网站…」，方向反过来也要能绑。
 */
export interface NotesSiteLinkApi {
    /** 站点还存在就返回名字；站点已被删（site_id 悬空）返回 null */
    resolve: (siteId: number) => { id?: number; name: string } | null;
    /** 关掉记事本并滚到那张卡片（App 的 jumpToSite，会闪一下轮廓） */
    open: (siteId: number) => void;
    /** 全部网站；带 note_id / note_title 便于选择器提示「这个站已经绑了『X』」 */
    list: () => { id?: number; name: string; note_id?: number | null; note_title?: string | null }[];
    /**
     * 绑定关系变了，让 App 重取一次卡片数据。
     *
     * ⚠️ 这里**只刷新、不写入**：写库由笔记自己走 `onUpdate(noteId, { site_id })` ——
     * 那条路会同时更新记事本本地的 notes 状态（状态栏那行「绑在哪个站」立刻变），
     * 再在这里二次写一遍只会多打一次请求，还会让两边的乐观更新打架。
     */
    refresh: () => void;
}

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
    /** #477 笔记侧反查：这篇笔记绑在哪个站点上；null = 没绑 */
    boundSite: { id?: number; name: string } | null;
    /** #477：site_id 有值但站点已不存在（卡片被删，悬空引用照实显示） */
    boundSiteMissing: boolean;
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
    /** #477：关掉记事本并滚到绑定的那张卡片（App 的 jumpToSite） */
    onOpenBoundSite: () => void;
    onPurgeTrashed: (recycleId: number) => Promise<void>;
    onRestoreTrashed: (recycleId: number) => Promise<void>;
    onToggleArchive: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
    onToggleStar: ((note: Note) => Promise<void>) | undefined;
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void | boolean>;
    openAttachmentFromEditor: (id: string) => void;
    openInSide: (note: Note) => void;
    openNote: (note: Note) => void;
    /**
     * 打开「新建笔记」的模板选择菜单（B3）。anchor 是触发那颗按钮 ——
     * 菜单要贴在它旁边；传 null 时菜单会退到页面左上角（只在没有锚点的
     * 老入口上用，正常路径都有按钮）。
     */
    openTemplatePicker: (anchor: HTMLElement | null, folderId: number | null) => void;
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
    /** 右键「绑定网站…」选中的笔记 id（null = 弹窗关着） */
    bindSiteNoteId: number | null;
    setBacklinkAnchor: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
    setBindSiteNoteId: React.Dispatch<React.SetStateAction<number | null>>;
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
    /** 站点侧能力（#477）：状态栏反查 + 右键「绑定网站…」的选择器都要它 */
    siteLinkApi: NotesSiteLinkApi | undefined;
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
    /** 真·专注模式（A9，2026-10-22）：隐藏导航列 / 列表列 / 工具栏 / 状态栏，只留标题与正文。
     *  与 uiSettings.focusMode（淡化非当前行）是**两个独立开关**，可以同时开。
     *  页面级状态、不持久化：刷新或退出记事本自然恢复。 */
    zenMode: boolean;
    setZenMode: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * NotesPage 的 props 契约（2026-10-25 从 NotesPage.tsx 搬来，#538 收尾）。
 *
 * 它本来就是**纯类型**，和这个文件里的 NotesPageCtx / NotesSiteLinkApi 是同一类东西；
 * 留在组件文件顶部只会把「一页组件的装配逻辑」和「它的对外契约」混在一起。
 * 没有外部文件 import NotesPageProps（已核），所以搬走不需要回导，NotesPage.tsx 从这里 import 即可。
 */
export interface NotesPageProps {
    shareApi?: NoteShareApi;
    /**
     * 摘要模式（?fields=list）下补全文：列表只给了开头 200 字，打开哪条就补哪条。
     *
     * 可选：老后端 / mock 没有 getNote 时不传，此时前端阈值也没到（列表永远带全文），
     * 缺失即退化为老行为，不会多打请求。
     */
    onEnsureFullNote?: (id: number) => Promise<Note | null>;
    /**
     * 图片上传能力（2026-07）。
     *
     * ⚠️ 刻意**可选**：后端没配存储（R2 / KV 都没绑）时这个能力就不存在，
     * 那时工具栏的「上传图片」会自动置灰、并在 tooltip 里说明原因 ——
     * 而不是点了才报一个看不懂的错误。与 shareApi 同一个套路
     * （NotesOverlay.tsx:137 那一行）。
     */
    uploadApi?: {
        uploadAttachment(
            file: File,
            noteId?: number | null
        ): Promise<{ id: string; url: string; filename: string; mime: string; size: number }>;
        /** 附件统计 / 清理（2026-10-08 设置→数据）。可选：老部署的 api 没有这两个方法 */
        listAttachments?(): Promise<
            { id: string; size: number; filename: string; mime: string }[]
        >;
        pruneAttachments?(): Promise<{ removed: number; freedBytes: number }>;
        /** 附件管理器里逐条删除（inkstone 的 AttachmentManager 同款） */
        deleteAttachment?(id: string): Promise<{ ok: boolean }>;
        /**
         * 附件重命名（2026-10-19）。只改 filename，id / object_key 不动，
         * 正文链接因此不会失效；服务端顺手把正文里的显示名同步掉。
         */
        renameAttachment?(
            id: string,
            filename: string
        ): Promise<{ filename: string; updatedNotes: number }>;
        /** 原地改写 txt / json 内容（预览弹窗的「编辑」）。 */
        updateAttachmentContent?(id: string, text: string): Promise<{ size: number; mime: string }>;
    };
    /**
     * 打开就直接跳到这条笔记（D2 双向绑定：站点设置里点「相关笔记」）。
     *
     * 只在本次挂载里生效一次 —— 之后用户点别的笔记完全不受它影响。
     * 不传 = 照常打开（选中上次那条 / 列表第一条）。
     */
    focusNoteId?: number;
    /**
     * 站点侧的两个能力（#477 站点↔笔记双向绑定的**笔记那一侧**）。
     *
     * 站名不在记事本手里 —— 为了一个名字去拉一遍站点列表不值得，所以由 App
     * 通过这个口子回答「这个 id 是哪个站」和「跳回导航页并定位到那张卡片」。
     *
     * 不传 = 状态栏不显示站点那一项（老调用方照常工作）。
     */
    siteLinkApi?: NotesSiteLinkApi;
    /**
     * 记事本备份能力（2026-10-09 照 inkstone 的 BackupSettings）。
     *
     * ⚠️ 与 shareApi / uploadApi 同一个套路：可选，NotesOverlay 只在 api 实例
     * 真的有 notesBackupUpload 与 getConfig 时才传。没传时设置里的「备份」页不出现
     * （老部署没有对应端点），而不是点了才报一个看不懂的错误。
     */
    backupApi?: {
        getState(): Promise<NotesBackupState>;
        save(patch: NotesBackupSavePatch): Promise<void>;
        test(): Promise<{ success: boolean; message: string }>;
        run(): Promise<{ success: boolean; message: string }>;
        /** 列出网盘上的笔记备份文件（备份闭环的「取回」一半，2026-10-09） */
        listRemote(): Promise<{
            success: boolean;
            files: { name: string; size: number; lastModified: string }[];
            message: string;
        }>;
        /** 下载并解密一份网盘备份；code 用来判断「要不要口令 / 口令对不对」 */
        fetch(filename: string, password: string): Promise<{
            success: boolean;
            message: string;
            payload?: NotesImportPayload;
            /** ZIP 备份（2026-10-11 起默认格式）：base64，交给 onImportFile 走附件回传链路 */
            zipBase64?: string;
            code?: WebDavErrorCode;
        }>;
        /** 删除网盘上的一份备份文件（最近备份的删除按钮，2026-10-10） */
        deleteRemote?(filename: string): Promise<{ success: boolean; message: string }>;
    };
    /**
     * 数据集级变更广播（2026-10-11，阶段 2）：导入 / 恢复成功后喊一声，
     * 让其它标签页能提示刷新。可选：老调用方没传时导入照常，只是少了跨页提醒。
     */
    onDatasetChanged?: () => void | Promise<void>;
    /**
     * 最近一轮跨设备轮询发现的「被改笔记 id」（阶段①）。当前打开的笔记
     * 命中时给一句定向提示——保存时 rev 守卫仍会拦住静默覆盖。
     */
    syncChangedNoteIds?: number[];
    notes: Note[];
    onClose: () => void;
    /**
     * 左下角显示的账号名（inkstone 那样的「用户名 + 头像」）。
     *
     * 可选：没传就只显示一个匿名的默认头像 —— 记事本自己不该依赖
     * 登录态，知道有账号的人传进来显示 nicer，不传也不会坏。
     */
    accountName?: string;
    onCreate: (draft?: Partial<Note>) => Promise<Note | null>;
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void | boolean>;
    onDelete: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
    /** 收藏（2026-10-09 与置顶分离）：置顶管排序、收藏管筛选。老部署没传时这个动作不出现 */
    onToggleStar?: (note: Note) => Promise<void>;
    // ---------- 阶段三：回收站 + 归档 ----------
    /** 回收站里的笔记（只含 kind='note' 的），从 useNotes 传进来 */
    trashedNotes: TrashedNote[];
    onLoadTrash: () => Promise<void>;
    onRestoreTrashed: (recycleId: number) => Promise<void>;
    onPurgeTrashed: (recycleId: number) => Promise<void>;
    onEmptyTrash: () => Promise<void>;
    onToggleArchive: (note: Note) => Promise<void>;
    /**
     * 提示条（可选）。导出成功 / 失败要有个回执 ——
     * 「点了没反应」在下载场景里最容易被误判成功能坏了。
     * 严重级别与 useNotify 的 NotifySeverity 保持一致（success / error / info）。
     */
    onNotify?: (
        message: string,
        severity?: "success" | "error" | "info"
    ) => void;
    // ---------- 阶段三收尾：文件夹 / 标签 ----------
    /**
     * 左栏第一列要的东西打包成一个对象传进来（不是一个一个 props）：
     * 这一块有 8 个回调，拆成 8 个 props 会让调用方的 JSX 没法读，
     * 而它们本来就只服务「导航列这一个区域」。
     *
     * 全部**可选**：老部署上没这几个方法时，导航列退化成「只有那六个视图」，
     * 而不是把整个记事本打崩（和回收站那几个可选方法一个处理）。
     */
    folderTags?: {
        folders: NoteFolder[];
        tags: NoteTag[];
        /** { [noteId]: tagId[] }——左栏算「每个标签几条」要用 */
        noteTags?: Record<number, number[]>;
        onCreateFolder: (name: string, parentId?: number | null) => Promise<NoteFolder | null>;
        onMoveFolder?: (id: number, parentId: number | null) => Promise<void>;
        /** 同级内前后挪一位（inkstone 的「向前/向后移动」） */
        onReorderFolder?: (id: number, dir: -1 | 1) => Promise<void>;
        onRenameFolder: (id: number, name: string) => Promise<void>;
        onRemoveFolder: (id: number) => Promise<void>;
        onCreateTag: (name: string) => Promise<NoteTag | null>;
        onRenameTag: (id: number, name: string) => Promise<void>;
        onRemoveTag: (id: number) => Promise<void>;
        // 返回值故意留成 `Promise<NoteTag[] | null>` 而不是 `Promise<void>`：
        // `Promise<T>` 不能赋给 `Promise<void>`（void 的那条宽松规则只在函数返回类型上生效，
        // 套一层 Promise 就不认了），写 void 会让调用方的实现没法返回查到的最新清单。
        onAssignTags: (noteId: number, tagIds: number[]) => Promise<NoteTag[] | null>;
        /** 文件夹外观（icon / color）：交给上层走 updateFolder */
        onStyleFolder?: (
            id: number,
            patch: { icon?: string | null; color?: string | null }
        ) => Promise<void>;
        /**
         * 标签颜色（`note_tag.color` 这列早就有了，只是界面没用它）。
         * 给颜色是为了「一眼扫出旋钮」：几十个标签里，靠颜色分批比逐字读名字快得多
         * （inkstone 的 NoteList 拿 `tagColors` Map 做同一件事）。
         */
        onStyleTag?: (id: number, color: string | null) => Promise<void>;
        /** 版本历史：列快照 / 恢复 */
        onListRevisions?: (noteId: number) => Promise<NoteRevision[]>;
        onRestoreRevision?: (noteId: number, revisionId: number) => Promise<Note | null>;
        /** 取某一版的完整正文（列表里只给字符数，要做 diff 得单独拉一份） */
        onGetRevision?: (noteId: number, revisionId: number) => Promise<NoteRevision | null>;
        /**
         * 服务端全文检索（2026-10-09）。
         * 可选：没传 / 调用失败 → 退回本地模糊搜索（本地本来就持有全文）。
         */
        onSearchRemote?: (query: string, limit?: number) => Promise<NoteSearchResult | null>;
    };
}
