import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import MenuIcon from "@mui/icons-material/Menu";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";
import { AttachmentPreviewProvider } from "../../utils/attachmentPreview";
import AttachmentManager from "../AttachmentManager";
import AttachmentPreviewDialog from "../AttachmentPreviewDialog";
import NoteGraphDialog from "../NoteGraphDialog";
import NotesCommandPalette from "../NotesCommandPalette";
import NoteShareDialog from "../NoteShareDialog";
import NotesShortcutsDialog from "../NotesShortcutsDialog";
import NoteVersionHistoryDialog from "../NoteVersionHistoryDialog";
import NotesConfirmLayer from "./NotesConfirmLayer";
import NotesEditorPane from "./NotesEditorPane";
import NotesListPane from "./NotesListPane";
import NotesNavPanel from "./NotesNavPanel";
import NotesOverlayLayer from "./NotesOverlayLayer";
import type { NotesPageCtx } from "./notesPageCtx";
import NotesSidePane from "./NotesSidePane";
import NoteTemplateMenu from "./NoteTemplateMenu";
import { ColResizeHandle } from "./paneChrome";
import type { useNotesPageModel } from "./useNotesPageModel";

export default function NotesPageShell({
    SIDE_SPLIT_KEY,
    bindSiteNoteId,
    setBindSiteNoteId,
    accountName,
    active,
    activeFolder,
    activeFolderName,
    activeId,
    activeMenuAnchor,
    activeTag,
    activeTagNames,
    appearanceFolderId,
    askName,
    attManagerOpen,
    attachmentRefCounts,
    backlinks,
    backlinksOpen,
    backupApi,
    boundSite,
    boundSiteMissing,
    bp,
    bulkArchive,
    bulkDelete,
    bulkDeleteOpen,
    charCount,
    checked,
    checkedNotes,
    closeNamePrompt,
    closeRemove,
    closeRowMenu,
    closeSide,
    completionSources,
    copyText,
    dirty,
    draft,
    draggingNoteId,
    emptyArt,
    emptyCopy,
    exportAllData,
    exportAllZip,
    exportAnchor,
    exportHtmlOne,
    exportOne,
    exportPdfOne,
    exportPick,
    exportTarget,
    filtered,
    folderCounts,
    folderTags,
    folders,
    handleAttach,
    handleOpenEmbedNote,
    handleSideToggleTask,
    handleToggleTask,
    handleUpload,
    highlightRanges,
    importNotesFile,
    jumpToNote,
    jumpToOffset,
    keyword,
    lazyListGroups,
    listCollapsed,
    listGroups,
    listHidden,
    listW,
    liveRender,
    liveRenderer,
    mainShortcutActions,
    menuClosing,
    moveDrawerNoteId,
    multiSelect,
    namePrompt,
    narrowLayout,
    navW,
    noteLink,
    noteTags,
    noteWordTotal,
    notes,
    notesCommands,
    notesInFolder,
    onClose,
    onCreate,
    onDatasetChanged,
    onDelete,
    onEmptyTrash,
    onNotify,
    onOpenBoundSite,
    onPurgeTrashed,
    onRestoreTrashed,
    onToggleArchive,
    onTogglePin,
    onToggleStar,
    onUpdate,
    openAttachmentFromEditor,
    openInSide,
    openNote,
    openRevisions,
    outgoingLinks,
    outline,
    outlineActiveLine,
    outlineOpen,
    pane,
    pinnedCount,
    previewFeatures,
    previewScrollRef,
    removeTarget,
    renderSearchField,
    replaceDetachedUpload,
    reset,
    resolveNote,
    rowActionsSuppressed,
    rowMenu,
    save,
    saveState,
    savedAt,
    searchRef,
    searchRefNarrow,
    searchSnippets,
    selectAnchorRef,
    setActiveFolder,
    setActiveId,
    setActiveMenuAnchor,
    setActiveTag,
    setAppearanceFolderId,
    setAttManagerOpen,
    setBacklinkAnchor,
    setBacklinksOpen,
    setBulkDeleteOpen,
    setChecked,
    setDraft,
    setDraggingNoteId,
    setExportAnchor,
    setExportPick,
    setGraphOpen,
    setLightbox,
    setListCollapsed,
    setLiveRender,
    setMiddleHidden,
    setMobileDetail,
    setMoveDrawerNoteId,
    setMultiSelect,
    setNavDrawerOpen,
    setOutlineActiveLine,
    setOutlineOpen,
    setPane,
    setRemoveTarget,
    setRowActionsSuppressed,
    setRowMenu,
    setSettingsOpen,
    setShareId,
    setSideDraft,
    setSideLiveRender,
    setSideMode,
    setSideSplitRatio,
    setSortAnchor,
    setSortKey,
    setSplitRatio,
    setTagColorId,
    setTagPick,
    setUiSettings,
    setView,
    settingsOpen,
    shareApi,
    siteLinkApi,
    sideDirty,
    sideDraft,
    sideId,
    sideLiveRender,
    sideMode,
    sideNote,
    sideRef,
    sideSaveState,
    sideSavedAt,
    sideShortcutActions,
    sideSplitBoxRef,
    sideSplitRatio,
    sideSplitRatioRef,
    sideTick,
    sideTools,
    sortAnchor,
    sortKey,
    splitBoxRef,
    splitRatio,
    splitRatioRef,
    startCreateInFolder,
    openTemplatePicker,
    startDrag,
    startSideSplitDrag,
    startSplitDrag,
    submitNamePrompt,
    submitRemove,
    switchTo,
    syncPreviewScroll,
    tagColorByName,
    tagColorId,
    tagCounts,
    tagPick,
    tags,
    textareaRef,
    tick,
    toggleChecked,
    tools,
    trashedNotes,
    uiSettings,
    uploadApi,
    uploadFileForSideEditor,
    uploadImageForEditor,
    userClearedRef,
    view,
    viewCounts,
    visibleIds,
    wordCount,
    zenMode,
    setZenMode,
    previewController,
    pageRef,
    shareId,
    templatePick,
    createFromTemplate,
    setTemplatePick,
    graphOpen,
    setPreviewTarget,
    previewTarget,
    notesCmdOpen,
    setNotesCmdOpen,
    recentNoteIds,
    shortcutsOpen,
    setShortcutsOpen,
    revisionsOpen,
    revisions,
    loadRevisionContent,
    doRestoreRevision,
    setRevisionsOpen,
    setRevisions,
    lightbox,
    lightboxRef,
    setImageScale,
    setImageFailed,
    imageScale,
    imageFailed,
    backlinkAnchor,
    mobileDetail,
    middleHidden,
    paneRowRef,
    sideResizing,
    paneRatio,
    startPaneDrag,
    resetPaneRatio,
    nudgePaneRatio,
    navDrawerOpen
}: ReturnType<typeof useNotesPageModel>) {
    const paneBase = useMemo(() => ({
        SIDE_SPLIT_KEY,
        bindSiteNoteId,
        setBindSiteNoteId,
        accountName,
        active,
        activeFolder,
        activeFolderName,
        activeId,
        activeMenuAnchor,
        activeTag,
        activeTagNames,
        appearanceFolderId,
        askName,
        attManagerOpen,
        attachmentRefCounts,
        backlinks,
        backlinksOpen,
        backupApi,
        // #477 笔记侧反查：这篇绑在哪个站点上（boundSiteMissing = 那张卡片已被删）
        boundSite,
        boundSiteMissing,
        bp,
        bulkArchive,
        bulkDelete,
        bulkDeleteOpen,
        charCount,
        checked,
        checkedNotes,
        closeNamePrompt,
        closeRemove,
        closeRowMenu,
        closeSide,
        completionSources,
        copyText,
        dirty,
        draft,
        draggingNoteId,
        emptyArt,
        emptyCopy,
        exportAllData,
        exportAllZip,
        exportAnchor,
        exportHtmlOne,
        exportOne,
        exportPdfOne,
        exportPick,
        exportTarget,
        filtered,
        folderCounts,
        folderTags,
        folders,
        handleAttach,
        handleOpenEmbedNote,
        handleSideToggleTask,
        handleToggleTask,
        handleUpload,
        highlightRanges,
        importNotesFile,
        jumpToNote,
        jumpToOffset,
        keyword,
        lazyListGroups,
        listCollapsed,
        listGroups,
        listHidden,
        listW,
        liveRender,
        liveRenderer,
        mainShortcutActions,
        menuClosing,
        moveDrawerNoteId,
        multiSelect,
        namePrompt,
        narrowLayout,
        navW,
        noteLink,
        noteTags,
        noteWordTotal,
        notes,
        notesCommands,
        notesInFolder,
        onClose,
        onCreate,
        onDatasetChanged,
        onDelete,
        onEmptyTrash,
        onNotify,
        onOpenBoundSite,
        onPurgeTrashed,
        onRestoreTrashed,
        onToggleArchive,
        onTogglePin,
        onToggleStar,
        onUpdate,
        openAttachmentFromEditor,
        openInSide,
        openNote,
        openRevisions,
        outgoingLinks,
        outline,
        outlineActiveLine,
        outlineOpen,
        pane,
        pinnedCount,
        previewFeatures,
        previewScrollRef,
        removeTarget,
        renderSearchField,
        replaceDetachedUpload,
        reset,
        resolveNote,
        rowActionsSuppressed,
        rowMenu,
        save,
        saveState,
        savedAt,
        searchRef,
        searchRefNarrow,
        searchSnippets,
        selectAnchorRef,
        setActiveFolder,
        setActiveId,
        setActiveMenuAnchor,
        setActiveTag,
        setAppearanceFolderId,
        setAttManagerOpen,
        setBacklinkAnchor,
        setBacklinksOpen,
        setBulkDeleteOpen,
        setChecked,
        setDraft,
        setDraggingNoteId,
        setExportAnchor,
        setExportPick,
        setGraphOpen,
        setLightbox,
        setListCollapsed,
        setLiveRender,
        setMiddleHidden,
        setMobileDetail,
        setMoveDrawerNoteId,
        setMultiSelect,
        setNavDrawerOpen,
        setOutlineActiveLine,
        setOutlineOpen,
        setPane,
        setRemoveTarget,
        setRowActionsSuppressed,
        setRowMenu,
        setSettingsOpen,
        setShareId,
        setSideDraft,
        setSideLiveRender,
        setSideMode,
        setSideSplitRatio,
        setSortAnchor,
        setSortKey,
        setSplitRatio,
        setTagColorId,
        setTagPick,
        setUiSettings,
        setView,
        settingsOpen,
        shareApi,
        siteLinkApi,
        sideDirty,
        sideDraft,
        sideId,
        sideLiveRender,
        sideMode,
        sideNote,
        sideRef,
        sideSaveState,
        sideSavedAt,
        sideShortcutActions,
        sideSplitBoxRef,
        sideSplitRatio,
        sideSplitRatioRef,
        sideTick,
        sideTools,
        sortAnchor,
        sortKey,
        splitBoxRef,
        splitRatio,
        splitRatioRef,
        startCreateInFolder,
        openTemplatePicker,
        startDrag,
        startSideSplitDrag,
        startSplitDrag,
        submitNamePrompt,
        submitRemove,
        switchTo,
        syncPreviewScroll,
        tagColorByName,
        tagColorId,
        tagCounts,
        tagPick,
        tags,
        textareaRef,
        tick,
        toggleChecked,
        tools,
        trashedNotes,
        uiSettings,
        uploadApi,
        uploadFileForSideEditor,
        uploadImageForEditor,
        userClearedRef,
        view,
        viewCounts,
        visibleIds,
        wordCount,
        zenMode,
        setZenMode,
    }), [
        SIDE_SPLIT_KEY,
        bindSiteNoteId,
        setBindSiteNoteId,
        accountName,
        active,
        activeFolder,
        activeFolderName,
        activeId,
        activeMenuAnchor,
        activeTag,
        activeTagNames,
        appearanceFolderId,
        askName,
        attManagerOpen,
        attachmentRefCounts,
        backlinks,
        backlinksOpen,
        backupApi,
        boundSite,
        boundSiteMissing,
        bp,
        bulkArchive,
        bulkDelete,
        bulkDeleteOpen,
        charCount,
        checked,
        checkedNotes,
        closeNamePrompt,
        closeRemove,
        closeRowMenu,
        closeSide,
        completionSources,
        copyText,
        dirty,
        draft,
        draggingNoteId,
        emptyArt,
        emptyCopy,
        exportAllData,
        exportAllZip,
        exportAnchor,
        exportHtmlOne,
        exportOne,
        exportPdfOne,
        exportPick,
        exportTarget,
        filtered,
        folderCounts,
        folderTags,
        folders,
        handleAttach,
        handleOpenEmbedNote,
        handleSideToggleTask,
        handleToggleTask,
        handleUpload,
        highlightRanges,
        importNotesFile,
        jumpToNote,
        jumpToOffset,
        keyword,
        lazyListGroups,
        listCollapsed,
        listGroups,
        listHidden,
        listW,
        liveRender,
        liveRenderer,
        mainShortcutActions,
        menuClosing,
        moveDrawerNoteId,
        multiSelect,
        namePrompt,
        narrowLayout,
        navW,
        noteLink,
        noteTags,
        noteWordTotal,
        notes,
        notesCommands,
        notesInFolder,
        onClose,
        onCreate,
        onDatasetChanged,
        onDelete,
        onEmptyTrash,
        onNotify,
        onOpenBoundSite,
        onPurgeTrashed,
        onRestoreTrashed,
        onToggleArchive,
        onTogglePin,
        onToggleStar,
        onUpdate,
        openAttachmentFromEditor,
        openInSide,
        openNote,
        openRevisions,
        outgoingLinks,
        outline,
        outlineActiveLine,
        outlineOpen,
        pane,
        pinnedCount,
        previewFeatures,
        previewScrollRef,
        removeTarget,
        renderSearchField,
        replaceDetachedUpload,
        reset,
        resolveNote,
        rowActionsSuppressed,
        rowMenu,
        save,
        saveState,
        savedAt,
        searchRef,
        searchRefNarrow,
        searchSnippets,
        selectAnchorRef,
        setActiveFolder,
        setActiveId,
        setActiveMenuAnchor,
        setActiveTag,
        setAppearanceFolderId,
        setAttManagerOpen,
        setBacklinkAnchor,
        setBacklinksOpen,
        setBulkDeleteOpen,
        setChecked,
        setDraft,
        setDraggingNoteId,
        setExportAnchor,
        setExportPick,
        setGraphOpen,
        setLightbox,
        setListCollapsed,
        setLiveRender,
        setMiddleHidden,
        setMobileDetail,
        setMoveDrawerNoteId,
        setMultiSelect,
        setNavDrawerOpen,
        setOutlineActiveLine,
        setOutlineOpen,
        setPane,
        setRemoveTarget,
        setRowActionsSuppressed,
        setRowMenu,
        setSettingsOpen,
        setShareId,
        setSideDraft,
        setSideLiveRender,
        setSideMode,
        setSideSplitRatio,
        setSortAnchor,
        setSortKey,
        setSplitRatio,
        setTagColorId,
        setTagPick,
        setUiSettings,
        setView,
        settingsOpen,
        shareApi,
        siteLinkApi,
        sideDirty,
        sideDraft,
        sideId,
        sideLiveRender,
        sideMode,
        sideNote,
        sideRef,
        sideSaveState,
        sideSavedAt,
        sideShortcutActions,
        sideSplitBoxRef,
        sideSplitRatio,
        sideSplitRatioRef,
        sideTick,
        sideTools,
        sortAnchor,
        sortKey,
        splitBoxRef,
        splitRatio,
        splitRatioRef,
        startCreateInFolder,
        openTemplatePicker,
        startDrag,
        startSideSplitDrag,
        startSplitDrag,
        submitNamePrompt,
        submitRemove,
        switchTo,
        syncPreviewScroll,
        tagColorByName,
        tagColorId,
        tagCounts,
        tagPick,
        tags,
        textareaRef,
        tick,
        toggleChecked,
        tools,
        trashedNotes,
        uiSettings,
        uploadApi,
        uploadFileForSideEditor,
        uploadImageForEditor,
        userClearedRef,
        view,
        viewCounts,
        visibleIds,
        wordCount,
        zenMode,
        setZenMode,
    ]);

    const navInner = useMemo(() => <NotesNavPanel {...paneBase} />, [paneBase]);

    const paneCtx: NotesPageCtx = useMemo(() => ({ ...paneBase, navInner }), [paneBase, navInner]);
    return (
        // 附件预览弹窗的控制器（2026-10-19）：正文渲染层（markdownToReact）隔着好几层，
        // 靠 context 才能「点链接 → 开这里这个弹窗」，不必把回调一路透传下去。
        // ⚠️ value 必须稳定（useMemo 空依赖）：一变就会让整棵预览子树重渲染。
        <AttachmentPreviewProvider value={previewController}>
            <Box
                ref={pageRef}
                data-notes-root=''
                sx={{
                    position: "fixed",
                    inset: 0,
                    // ⚠️ 必须显式铺到 100vw，光靠 `inset: 0` 铺不满。
                    // `scrollbar-gutter: stable`（src/index.css）让 html 和 body 各留一条
                    // 恒定 10px 的滚动条槽位；fixed 层的 containing block 是 **html 的内容盒**，
                    // 所以 inset:0 只得到视口宽减 10 —— 剩下那道 10px 的缝里，
                    // 底下还挂着的主界面（极光背景层）就从缝里冒出一条来。
                    // 这就是真机上看到的「右边显示了一点」。100vw 把槽位一起盖住。
                    width: "100vw",
                    // 明确禁止这一层滚动：它是整页，**页面级滚动条本身就是缺陷**
                    //（该滚的是预览区内部）。之前某一层漏了 minHeight: 0，内容顶出视口、
                    // 连带 body 出现滚动条；inset + overflow 才彻底按住。
                    overflow: "hidden",
                    zIndex: (t: { zIndex: { modal: number } }) => t.zIndex.modal,
                    display: "flex",
                    // ⚠️ 2026-10-07 改为**横向**：顶栏只压在最左边的导航列上方（inkstone 布局），
                    // 中栏列表与编辑区各自带头部、直达页面顶部 —— 全宽顶栏会把三栏都压低一截，
                    // 而顶栏上那排按钮实际只对「当前编辑的这篇」有意义，摆在页首纯属浪费纵深。
                    // ⚠️ 2026-10-08：tablet 改成**列**方向 —— 顶部多一条 44px 全宽栏
                    // （「导航栏」按钮 + 搜索，inkstone AppShell 的顶栏同位），下面才是三栏行。
                    // 桌面 / mobile 仍是 row：顶栏只压在最左导航列上方。
                    flexDirection: bp === "tablet" ? "column" : "row",
                    // 「背景色」设置：暖白（纸感）/ 纯白。深色模式下「暖白」不成立，
                    // 照旧走主题默认色 —— 否则会得到一块刺眼的白底配深色文字。
                    bgcolor: (t: { palette: { mode: string; background: { default: string; paper: string } } }) =>
                        uiSettings.bgcolor === "pure"
                            ? t.palette.background.paper
                            : t.palette.mode === "light"
                                ? "#faf8f1"
                                : t.palette.background.default,
                }}
                // 「界面密度」与「强调色」都作用在整个记事本根元素上：
                // 强调色用 --accent（页内选中态/图标），密度用 data 属性（index.css 里收紧行距）
                data-notes-density={uiSettings.density}
                // 空串 = 跟随主题 → 注入 var(--notes-accent)，由 index.css 按亮/暗分态给值
                //（亮 #a03c32 压亮纸面达标；暗 #d18276 —— 2026-10-31 才达标：
                // 旧暗值 #c96e60 压「列表选中项 12% 淡底」实测 4.25:1，小字线 4.5 没过，
                // 之前暗色扫描主题漂移、量的其实是亮色，这处一直假绿，那次修扫描才暴露）。
                // 这里**不能**写死一个具体色：过去默认的 #b0433a 在暖白底 4.18:1、
                // 暗底 3.19:1，默认外观本身就是不达标的（2026-10-24 扩审计面时抓到）。
                // 用 var() 而不是在 JS 里判断亮暗，是为了让主题切换时不必重渲这一层。
                style={
                    {
                        "--accent": uiSettings.accent || "var(--notes-accent)",
                    } as React.CSSProperties
                }
            >
                {shareId !== null && shareApi && (
                    <NoteShareDialog
                        key={shareId}
                        id={shareId}
                        api={shareApi}
                        noteTitle={notes.find(n => n.id === shareId)?.title}
                        onClose={() => setShareId(null)}
                    />
                )}
                {/* 设置：记事本自己的外观 / 编辑器设置（不是导航站那个弹窗） */}
                <NotesOverlayLayer {...paneCtx} />
                {/* 「新建笔记」的模板选择（B3）：中栏头部 / 空态 / 左栏文件夹标题旁
                三处按钮都开这一个菜单，落点用当前选中文件夹。 */}
                <NoteTemplateMenu
                    open={templatePick !== null}
                    anchorEl={templatePick?.el ?? null}
                    onPick={id => void createFromTemplate(id)}
                    onClose={() => setTemplatePick(null)}
                />
                <NoteGraphDialog
                    folders={folders}
                    tags={tags}
                    noteTags={noteTags}
                    open={graphOpen}
                    onCreateNote={title => { void onCreate({ title }); setGraphOpen(false); }}
                    notes={notes}
                    activeId={activeId}
                    onOpenNote={id => {
                        setGraphOpen(false);
                        void jumpToNote(id);
                    }}
                    onClose={() => setGraphOpen(false)}
                />

                {/* 全库待办面板已按用户要求彻底去掉（2026-10-19）；正文里的
                `- [ ]` 勾选能力不受影响（预览 / 源码两处照旧）。 */}

                {/* 附件管理器（2026-10-19 从设置 → 数据搬到这里常驻）：
                右下角滑出的抽屉（anchor='right'），列表 / 预览 / 重命名 / 删除 /
                清理都在里面自持。数据源与设置页那处**同一个** uploadApi，
                引用计数也共用 attachmentRefCounts，两处口径不会各算各的。
                ⚠️ 只在三个方法都齐时才挂：老部署没有对应端点时不该出现入口
                （上面那行 NavRow 已经用 listAttachments 做过门控，这里再兜一次）。 */}
                {attManagerOpen && uploadApi?.listAttachments && uploadApi?.deleteAttachment && (
                    <AttachmentManager
                        open
                        onClose={() => setAttManagerOpen(false)}
                        mgr={{
                            list: () => uploadApi.listAttachments!(),
                            remove: async id => {
                                await uploadApi.deleteAttachment!(id);
                            },
                            prune: uploadApi.pruneAttachments
                                ? () => uploadApi.pruneAttachments!()
                                : undefined,
                        }}
                        countRefs={id => attachmentRefCounts.get(id) ?? 0}
                        onNotify={onNotify}
                        onPreview={file => setPreviewTarget({ id: file.id, filename: file.filename, mime: file.mime })}
                    />
                )}

                {/* 附件预览 / 编辑弹窗（2026-10-19）：正文点链接与附件管理器点文件名
                共用这一个。能力按「有没有方法」降级 —— 老部署只有只读预览。 */}
                <AttachmentPreviewDialog
                    target={previewTarget}
                    onClose={() => setPreviewTarget(null)}
                    onNotify={onNotify}
                    onSaveContent={
                        uploadApi?.updateAttachmentContent
                            ? (id, text) => uploadApi.updateAttachmentContent!(id, text).then(r => ({ size: r.size }))
                            : undefined
                    }
                    onRename={
                        uploadApi?.renameAttachment
                            ? (id, filename) => uploadApi.renameAttachment!(id, filename)
                            : undefined
                    }
                    // 重命名会改正文里的链接文字 → 本地 notes 还是旧的，必须重拉，
                    // 否则用户在这条笔记里再保存一次就把服务端的新名字覆盖回去了。
                    onChanged={reason => {
                        if (reason === "rename") void onDatasetChanged?.();
                    }}
                />

                {/* 记事本命令面板（N1）：⌘K 打开。搜笔记/文件夹/标签 + 执行命令；
                远端 /search 命中带摘要并上浮；空查询给最近打开；无结果用输入建笔记。 */}
                <NotesCommandPalette
                    open={notesCmdOpen}
                    onClose={() => setNotesCmdOpen(false)}
                    notes={notes}
                    folders={folderTags?.folders ?? []}
                    tags={folderTags?.tags ?? []}
                    commands={notesCommands}
                    recentNoteIds={recentNoteIds}
                    onSearchRemote={folderTags?.onSearchRemote}
                    onOpenNote={note => {
                        if (note.id == null) return;
                        void jumpToNote(note.id).then(switched => {
                            if (!switched) return;
                            setView("all");
                            setActiveFolder(null);
                            setActiveTag(null);
                        });
                    }}
                    onOpenFolder={id => {
                        setActiveFolder(id);
                        setActiveTag(null);
                        setView("all");
                    }}
                    onOpenTag={id => {
                        setActiveTag(id);
                        setActiveFolder(null);
                        setView("all");
                    }}
                    onCreateNote={title => void onCreate({ title })}
                />
                <NotesShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
                <NoteVersionHistoryDialog
                    open={revisionsOpen}
                    noteTitle={active?.title || ""}
                    revisions={revisions}
                    currentContent={draft?.content ?? active?.content ?? ""}
                    onLoad={loadRevisionContent}
                    onRestore={doRestoreRevision}
                    onClose={() => {
                        setRevisionsOpen(false);
                        setRevisions(null);
                    }}
                />

                {/* 图片灯箱（inkstone 的 Lightbox）：点预览里的图片放大看。
                ⚠️ Esc 关闭走 keydown 监听 —— 它是一个 portal 之外的 overlay，
                MUI Dialog 的 onClose 拿不到这里；点空白处也关（inkstone 同款）。 */}
                {lightbox && (
                    <Box
                        ref={lightboxRef}
                        // tabIndex=-1：只能由脚本聚焦（焦点由脚本送进来 ≠ 它自己排队等 Tab）
                        tabIndex={-1}
                        data-lightbox='1'
                        onWheel={e => {
                            if (e.ctrlKey || e.metaKey) {
                                e.preventDefault();
                                setImageScale(s => Math.max(0.3, Math.min(6, s - e.deltaY * 0.002)));
                            }
                        }}
                        role='dialog'
                        aria-modal='true'
                        aria-label={lightbox.alt || "图片预览"}
                        onClick={() => setLightbox(null)}
                        sx={{
                            position: "fixed",
                            inset: 0,
                            zIndex: 1300,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            p: 3,
                            bgcolor: "var(--scrim)",
                            cursor: "zoom-out",
                        }}
                    >
                        <Box
                            component='img'
                            src={lightbox.src}
                            alt={lightbox.alt}
                            onError={() => setImageFailed(true)}
                            onClick={e => e.stopPropagation()}
                            onDoubleClick={() => setImageScale(s => s === 1 ? 2 : 1)}
                            style={{ transform: `scale(${imageScale})` }}
                            data-lightbox-img='1'
                            sx={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 1 }}
                        />
                        <Box onClick={e => e.stopPropagation()} sx={{ position: "absolute", top: 12, left: 12, bgcolor: "background.paper", borderRadius: 1, p: 1 }}>
                            <Button disabled={imageFailed || imageScale <= 0.3} onClick={() => setImageScale(s => Math.max(0.3, s - 0.25))}>缩小</Button>
                            <Typography component='span' aria-live='polite'>{Math.round(imageScale * 100)}%</Typography>
                            <Button disabled={imageFailed || imageScale >= 6} onClick={() => setImageScale(s => Math.min(6, s + 0.25))}>放大</Button>
                            <Button component='a' href={lightbox.src} download target='_blank' rel='noreferrer'>下载原图</Button>
                            {imageFailed && <Typography role='status'>图片加载失败</Typography>}
                        </Box>
                        <Typography sx={{ position: "absolute", bottom: 16, color: "var(--on-scrim)", maxWidth: "80%" }} noWrap>{lightbox.alt}</Typography>
                        <IconButton
                            aria-label='关闭图片预览'
                            data-lightbox-close='1'
                            onClick={e => {
                                e.stopPropagation();
                                setLightbox(null);
                            }}
                            sx={{ position: "absolute", top: 12, right: 12, color: "var(--on-scrim)" }}
                        >
                            <CloseIcon fontSize='small' />
                        </IconButton>
                    </Box>
                )}

                {/* 反向链接面板：谁引用了这条笔记。上半是「链出去的」，
                下半是「链进来的」—— 两者都是纯前端算的，不查库。 */}
                <Menu
                    open={Boolean(backlinkAnchor)}
                    anchorEl={backlinkAnchor}
                    onClose={() => setBacklinkAnchor(null)}
                    slotProps={{ paper: { sx: { maxHeight: "min(380px, 45dvh)", overflowY: "auto", minWidth: 240 } } }}
                >
                    <MenuItem disabled data-backlinks='outgoing-label'>
                        链出去的笔记（{outgoingLinks.length}）
                    </MenuItem>
                    {outgoingLinks.length === 0 ? (
                        <MenuItem disabled data-backlinks='outgoing-empty'>
                            正文里用 [[标题]] 链到别的笔记，就会出现在这里
                        </MenuItem>
                    ) : (
                        outgoingLinks.map(n => (
                            <MenuItem
                                key={`out-${n.id}`}
                                data-backlink-target={n.id}
                                onClick={() => {
                                    setBacklinkAnchor(null);
                                    void jumpToNote(n.id);
                                }}
                            >
                                <LinkIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.6 }} />
                                {n.title || "未命名笔记"}
                            </MenuItem>
                        ))
                    )}
                    <Divider />
                    <MenuItem disabled data-backlinks='incoming-label'>
                        引用了这里的笔记（{backlinks.length}）
                    </MenuItem>
                    {backlinks.length === 0 ? (
                        <MenuItem disabled data-backlinks='incoming-empty'>
                            还没有笔记链接到这里
                        </MenuItem>
                    ) : (
                        backlinks.map(n => (
                            <MenuItem
                                key={`in-${n.id}`}
                                data-backlink-source={n.id}
                                onClick={() => {
                                    setBacklinkAnchor(null);
                                    void jumpToNote(n.id);
                                }}
                            >
                                <LinkOffIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.6 }} />
                                {n.title || "未命名笔记"}
                            </MenuItem>
                        ))
                    )}
                </Menu>

                {/* ⚠️ tablet（768~1180）：44px 全宽顶栏（inkstone AppShell 同款）——
                左边「导航栏」按钮开/关 272px 左侧抽屉（内容与桌面导航列同源），
                右边搜索框（与 mobile 列表列头部那份互斥挂载，共用 searchRefNarrow）。
                专注模式（A9）下整条顶栏也让位：外围一概不露，只留正文。 */}
                {bp === "tablet" && !zenMode && (
                    <Box
                        data-tablet-bar='1'
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 1,
                            px: 1.5,
                            height: 44,
                            flexShrink: 0,
                            bgcolor: "var(--bg-sunken)",
                            borderBottom: "1px solid var(--neutral-hairline)",
                        }}
                    >
                        <IconButton
                            size='small'
                            aria-label='导航栏'
                            data-tool='nav-drawer'
                            onClick={() => setNavDrawerOpen(o => !o)}
                        >
                            <MenuIcon fontSize='small' />
                        </IconButton>
                        <Box sx={{ width: "min(360px, 60%)", pt: 0.5 }}>
                            {renderSearchField(searchRefNarrow)}
                        </Box>
                        {/* 返回箭头贴**整页右上角**（2026-10-09 用户明确）：
                        不能放在抽屉/最左栏的头部 —— 顶栏最右端才是页面右上角。 */}
                        <IconButton
                            size='small'
                            aria-label='返回导航站'
                            data-tool='back-out'
                            onClick={onClose}
                            sx={{ ml: "auto" }}
                        >
                            {/* ⚠️ 箭头**朝左**（2026-10-09 用户明确）：这是「返回导航站」，
                            用 ArrowBackIcon 原方向，不要 scaleX(-1) 翻成朝右。 */}
                            <ArrowBackIcon fontSize='small' />
                        </IconButton>
                    </Box>
                )}

                {/* 主体：desktop 三栏并排；tablet 收掉导航列；mobile 在「列表 / 编辑」之间切。
                ⚠️ 2026-10-07：原来这里靠 MUI 的 `md:`（900px）做两屏切换，
                但三栏宽度是写死的像素、又没有断点，缩放一放大（CSS 视口 < 900）
                编辑区就被压成 0 宽 —— 整块看不见（用户报「右边内容超出不可见」）。
                现在改成用 usePanelBreakpoint 的三档（1180 / 768），与 inkstone 一致。 */}
                {/* ⚠️ minWidth: 0 不能少（2026-10-07 用户报「编辑区有代码时右边超出范围」）。
                flex 子项的 `min-width` 默认是 `auto`，意思是「至少撑到内容的 min-content」。
                于是一个超长代码块的 `<pre>`（本该自己横向滚动）会把**这一整行**顶宽：
                真机量到 1080 视口下这一行被顶到 **1209px**、编辑区 992px，
                于是工具栏右端、状态栏、「分栏」按钮全被推出屏幕（46 个元素越界）。
                注入 min-width:0 后编辑区立刻回到 863px（= 1080 − 左栏 217），正好。
                inkstone 那边每个 flex 容器都显式写了 min-w-0，就是这个原因。 */}
                <Box sx={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
                    {/* 左栏**不能**加 flex:1 —— 它内部已经定宽了（flexShrink:0）。
                    外层再来一个 flex:1，容器会被 flex 撑开，而里面的列表是定宽的，
                    剩下的就是「中间那块空白」。宽度只由内层决定：flex: 0 0 auto。
                    ⚠️ 专注模式（A9）下整块左区（导航列 + 列表列）**不渲染**（条件渲染，
                    不是 display:none —— 卸载掉连里面的副作用都停掉：图标批量请求、
                    搜索防抖、SWR 校准，一样都不该在「只留正文」的时候还活着）。
                    退出即原样恢复，各列宽度/折叠态都没动过。 */}
                    {!zenMode && (
                        <Box
                            sx={{
                                // mobile：两屏切换（列表 ⇄ 编辑）；tablet/desktop：常驻。
                                // ⚠️ tablet 关中栏（middleHidden）后整个左区让位给编辑区
                                // （inkstone 的 showList = !listCollapsed）。导航走顶部栏
                                // 「导航栏」按钮手动开 —— 不要自动弹抽屉（2026-10-09 用户明确）。
                                display:
                                    (bp === "mobile" && mobileDetail) || (bp === "tablet" && middleHidden)
                                        ? "none"
                                        : "flex",
                                flex: "0 0 auto",
                                minWidth: 0,
                                minHeight: 0,
                            }}
                        >
                            <NotesListPane {...paneCtx} />
                        </Box>
                    )}
                    {/* 右栏占满剩余空间。minHeight:0 同样要加：缺了它，内部内容会把这层
                    撑高、进而把最外层的 fixed 容器顶出视口 —— 表现就是页面级滚动条。
                    ⚠️ 外层改成了**列**方向：编辑区本体在上，移动端的「回到列表」压在底下
                    （根容器 2026-10-07 起是 row，这条不能再挂在根上，否则会横着排到右边）。 */}
                    <Box
                        sx={{
                            // mobile 且没打开笔记时，右边不占位（否则会把 0 宽的 flex 项
                            // 留在行里，列表被挤窄）。tablet/desktop 永远显示。
                            // ⚠️ 专注模式（A9）下 mobile 也要显示编辑区：zenMode 进得去，
                            // 就得看得见里面的内容（mobileDetail 此时可能还是 false）。
                            display: bp === "mobile" && !mobileDetail && !zenMode ? "none" : "flex",
                            flex: 1,
                            minWidth: 0,
                            minHeight: 0,
                            flexDirection: "column",
                        }}
                    >
                        <Box
                            ref={paneRowRef}
                            data-pane-row={sideResizing ? "resizing" : undefined}
                            sx={{
                                flex: 1,
                                display: "flex",
                                minHeight: 0,
                                minWidth: 0,
                                // 拖动过程中禁掉选中，否则鼠标一划会整片选中文字
                                userSelect: sideResizing ? "none" : undefined,
                            }}
                        >
                            {/* 侧边编辑器打开时主编辑器让出一半（两个文档同时编辑，inkstone 的分屏）
                            ⚠️ 判据用 sideNote（= 侧边那条笔记真的还在），不能用 sideId：
                            侧边那条被删掉/回收后 sideId 还留着，按它分屏会让主编辑区
                            白白让出一半、右边空着一条（2026-10-06）
                            ⚠️ 比例可拖（2026-10-07 用户要求）：默认 50/50，中间那条缝能拖，
                            拖完记住（notes.paneRatio）；双击回 50/50。 */}
                            <Box
                                data-pane-divider={sideNote !== null ? "drag" : undefined}
                                sx={{
                                    // ⚠️ 宽度必须写成 `0 0 auto` + 百分比，**不能**写 `1 1 X%`。
                                    // `1 1 X%` 的两个 flex-basis 加起来正好 100%，再加上中间那条
                                    // 9px 把手就超了 → 浏览器按 shrink 因子回缩两栏，
                                    // 而侧栏里那台编辑器的 min-content 宽度会参与回缩计算，
                                    // 于是「点一下侧边的分栏、内容重排、分割线就跳一下」。
                                    // inkstone 的写法是左栏 `width: X%`、右栏 `flex: 1`：
                                    // 左栏宽度**只由比例决定**，右栏吃剩下的，分割线位置恒定。
                                    ...(sideNote !== null
                                        ? { flex: "0 0 auto", width: `${paneRatio * 100}%` }
                                        : { flex: 1 }),
                                    minWidth: 0,
                                    minHeight: 0,
                                    display: "flex",
                                }}
                            >
                                <NotesEditorPane {...paneCtx} />
                            </Box>
                            {sideNote !== null && !zenMode && (
                                <ColResizeHandle
                                    label='拖动调整两栏的比例（双击回到对半）'
                                    onDrag={startPaneDrag}
                                    onReset={resetPaneRatio}
                                    onNudge={nudgePaneRatio}
                                    ratio={paneRatio}
                                />
                            )}
                            {/* 专注模式（A9）下侧边编辑器也让位：分屏是「两篇对照着改」的
                            场景，与「只留一篇安静写」互斥。sideNote 状态不动，
                            退出专注自然回来。 */}
                            {sideNote && !zenMode ? <NotesSidePane {...paneCtx} /> : null}
                        </Box>
                        {/* 移动端从编辑态回列表。
                        ⚠️ 同样不能用 `md:`（900px）：两屏切换现在由 bp === "mobile"（768）
                        决定，按钮要跟它**同一个判据**，否则会出现「按钮在、列表也在」的矛盾态。
                        ⚠️ 专注模式（A9）下不渲染：列表列整个卸载了，「回到列表」没有去处，
                        要回去先退出专注（Esc 或标题行那颗退出键）。 */}
                        {mobileDetail && bp === "mobile" && !zenMode && (
                            <Box sx={{ display: "flex", p: 1, borderTop: "1px solid var(--neutral-border)", flexShrink: 0 }}>
                                <Button
                                    startIcon={<EditIcon />}
                                    onClick={() => setMobileDetail(false)}
                                    size='small'
                                >
                                    回到列表
                                </Button>
                            </Box>
                        )}
                    </Box>
                </Box>

                {/* tablet 导航抽屉（inkstone AppShell 同款）：272px 左侧滑出，内容与
                桌面导航列同源（navInner）。「收起列表」与顶栏按钮都能开它；
                抽屉里点视图 / 文件夹 / 笔记会自带 setNavDrawerOpen(false)。 */}
                <Drawer
                    anchor='left'
                    open={bp === "tablet" && navDrawerOpen}
                    onClose={() => setNavDrawerOpen(false)}
                    slotProps={{
                        paper: {
                            sx: {
                                width: 272,
                                // ⚠️ 必须用**实底色**，不能用 --bg-sunken：它是 rgba(15,23,42,0.035)
                                // 的近透明色，做内嵌列的背景没问题，做浮层纸面会让整个抽屉
                                // 透明（2026-10-08 用户报「页面透明虚化」）。
                                bgcolor: (t: { palette: { mode: string } }) =>
                                    t.palette.mode === "light" ? "#eef1f5" : "#171b26",
                            },
                        },
                        backdrop: {
                            // 遮罩用深色实色，不用毛玻璃（导航站的全局样式会给浮层加
                            // backdrop-filter，叠在记事本上就成了「透明虚化」）。
                            sx: {
                                backgroundColor: "var(--scrim)",
                                backdropFilter: "none !important",
                            },
                        },
                    }}
                >
                    <Box
                        data-nav-drawer='1'
                        sx={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            flexDirection: "column",
                            py: 1,
                            overflow: "hidden",
                            bgcolor: "transparent",
                        }}
                    >
                        <NotesNavPanel {...paneCtx} />
                    </Box>
                </Drawer>

                {/* 分类相关的弹窗：新建 / 重命名（NamePromptDialog）与删除二次确认
                （ConfirmDialog）。原来这些走的是 window.prompt / window.confirm ——
                样式突兀，且部分 WebView 直接拦掉，表现为「点了没反应」。 */}
                <NotesConfirmLayer {...paneCtx} />
            </Box>
        </AttachmentPreviewProvider>
    );
}
