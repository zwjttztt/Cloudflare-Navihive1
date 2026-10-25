import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import EditIcon from "@mui/icons-material/Edit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import { formatWhenFull } from "../../utils/noteTime";
import NoteEditor from "../NoteEditor";
import { MarkdownPreview, MarkdownToolbar } from "../notes/markdownToolbar";
import { PANE_HEADER_H, STATUSBAR_H, SaveDot } from "../notes/paneChrome";
import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesSidePane(props: Pick<NotesPageCtx, "SIDE_SPLIT_KEY" | "activeId" | "checked" | "closeSide" | "completionSources" | "dirty" | "handleAttach" | "handleOpenEmbedNote" | "handleSideToggleTask" | "handleUpload" | "liveRender" | "liveRenderer" | "narrowLayout" | "onNotify" | "openAttachmentFromEditor" | "pane" | "previewFeatures" | "replaceDetachedUpload" | "resolveNote" | "savedAt" | "setRowMenu" | "setSideDraft" | "setSideLiveRender" | "setSideMode" | "setSideSplitRatio" | "sideDirty" | "sideDraft" | "sideLiveRender" | "sideMode" | "sideNote" | "sideRef" | "sideSaveState" | "sideSavedAt" | "sideShortcutActions" | "sideSplitBoxRef" | "sideSplitRatio" | "sideSplitRatioRef" | "sideTick" | "sideTools" | "startSideSplitDrag" | "uiSettings" | "uploadApi" | "uploadFileForSideEditor">) {
    const { SIDE_SPLIT_KEY, closeSide, completionSources, handleAttach, handleOpenEmbedNote, handleSideToggleTask, handleUpload, liveRenderer, narrowLayout, onNotify, openAttachmentFromEditor, previewFeatures, replaceDetachedUpload, resolveNote, setRowMenu, setSideDraft, setSideLiveRender, setSideMode, setSideSplitRatio, sideDirty, sideDraft, sideLiveRender, sideMode, sideNote, sideRef, sideSaveState, sideSavedAt, sideShortcutActions, sideSplitBoxRef, sideSplitRatio, sideSplitRatioRef, sideTick, sideTools, startSideSplitDrag, uiSettings, uploadApi, uploadFileForSideEditor } = props;

    // 调用方只在「侧边真有一条笔记」时才挂载本组件；这里再挡一道，
    // 既让下面的 sideNote 收窄成非空，也保证万一被单独渲染时不会炸。
    if (!sideNote) return null;

    return (
        <Box
            data-side-editor='1'
            sx={{
                // ⚠️ 必须是 `flex: 1`（吃掉把手之外剩下的全部），不能写
                // `1 1 ${(1 - paneRatio) * 100}%` —— 那样两个 basis 加起来超过 100%，
                // 浏览器会按 shrink 回缩两栏，侧栏内容一变（切分栏/切预览）分割线就跳。
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                // ⚠️ 2026-10-07 补上底色（用户报「侧边打开时框颜色不一样」）。
                // 主编辑区那一层写了 `bgcolor: var(--bg-editor)`，侧边这层没写 →
                // 它透出父容器（--bg-base / --bg-sunken），于是两栏底色深浅不同，
                // 看着像「两个框」。
                // inkstone 两栏是**同一个**底色：Workspace.tsx:378
                //   `flex h-full min-col-0 flex-col bg-[var(--bg-editor)]`
                // 唯一差别是「当前激活的那栏」顶部多一道 2px 强调色
                // （shadow-[inset_0_2px_0_var(--accent)]），靠 pointer/focus 捕获切换。
                // 那道激活条需要一套「哪栏是激活态」的状态，本批只修用户报的颜色不一致，
                // 激活条留到后续（见交付报告 P1）。
                bgcolor: "var(--bg-editor)",
            }}
        >
            {/* 头部（2026-10-07）：inkstone 每栏右上角都有自己的按键栏 ——
                标题 + 编辑/预览 + 更多操作（作用于**侧边这条**）+ 关闭。 */}
            <Box data-pane-header='side' sx={{ display: "flex", alignItems: "center", gap: 0.25, pr: 0.75, flexShrink: 0, height: PANE_HEADER_H }}>
                <TextField
                    variant='standard'
                    value={sideDraft?.title ?? ""}
                    onChange={e => setSideDraft(d => (d ? { ...d, title: e.target.value } : d))}
                    placeholder='无标题'
                    slotProps={{ input: { "aria-label": "侧边笔记标题" } }}
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        px: 2,
                        // 与主栏同一个高度常量，两栏头部齐平（否则工具栏错位）
                        height: PANE_HEADER_H,
                        "& .MuiInputBase-root": { fontSize: 18, fontWeight: 600 },
                        "& .MuiInput-input": { padding: "6px 0" },
                    }}
                />
                {/* 即时渲染（inkstone 同名开关）：关掉后预览停在「已存库的内容」，
                    打字不再触发整篇重解析 —— 长文里体感差别很大。 */}
                <Box sx={{ display: narrowLayout ? "none" : "flex", alignItems: "center", gap: 0.25, flexShrink: 0, mr: 0.5 }}>
                    <Typography variant='caption' color='text.secondary' sx={{ fontSize: 11, whiteSpace: "nowrap" }}>
                        即时渲染
                    </Typography>
                    <Switch
                        size='small'
                        checked={sideLiveRender}
                        onChange={e => setSideLiveRender(e.target.checked)}
                        slotProps={{ input: { "aria-label": "侧边即时渲染" } }}
                        data-tool='side-live-render'
                        sx={{ ml: 0 }}
                    />
                </Box>
                {/* 模式：编辑 / 分栏 / 预览（与主栏同款：框起来的一组图标） */}
                <Box
                    data-side-modes='1'
                    sx={{
                        display: "flex",
                        flexShrink: 0,
                        border: "1px solid var(--card-border)",
                        borderRadius: "var(--notes-radius-row, 12px)",
                        overflow: "hidden",
                    }}
                >
                    {(
                        [
                            ["edit", "编辑", <EditIcon fontSize='inherit' key='i' />],
                            ["split", "分栏", <VerticalSplitIcon fontSize='inherit' key='s' />],
                            ["preview", "预览", <VisibilityIcon fontSize='inherit' key='v' />],
                        ] as const
                    ).map(([key, label, icon]) => (
                        <Tooltip key={key} title={label}>
                            <IconButton
                                size='small'
                                aria-label={`侧边${label}`}
                                data-tool={`side-mode-${key}`}
                                aria-pressed={sideMode === key}
                                onClick={() => setSideMode(key)}
                                sx={{
                                    width: 30,
                                    height: 28,
                                    p: 0,
                                    borderRadius: 0,
                                    color: sideMode === key ? "var(--accent)" : "text.secondary",
                                    bgcolor:
                                        sideMode === key
                                            ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                            : "transparent",
                                    "&:hover": { bgcolor: "var(--neutral-hover)" },
                                    "& + &": { borderLeft: "1px solid var(--card-border)" },
                                }}
                            >
                                {icon}
                            </IconButton>
                    </Tooltip>
                    ))}
                </Box>
                {/* 保存状态：与主栏同款，也挂在头部（inkstone 每栏各自一份） */}
                <SaveDot
                    state={sideSaveState}
                    dirty={sideDirty}
                    savedAt={sideSavedAt}
                    now={sideTick}
                />
                {/* 更多操作：直接复用列表行的全量菜单，只是锚在侧边栏头部、
                    作用于侧边这条笔记（顶栏那套只管主编辑区的问题到此为止）。 */}
                <Tooltip title='更多操作'>
                    <IconButton
                        size='small'
                        data-tool='side-more'
                        aria-label='侧边笔记更多操作'
                        aria-haspopup='menu'
                        onClick={e =>
                            sideNote.id !== undefined &&
                            setRowMenu({ noteId: sideNote.id, el: e.currentTarget, source: "list" })
                        }
                        sx={{ width: 28, height: 28, flexShrink: 0, color: "text.secondary" }}
                    >
                        <MoreVertIcon fontSize='small' />
                    </IconButton>
                    </Tooltip>
                {/* 关闭键常显（inkstone 同款 ✕）：藏在 hover 里的话分屏时根本找不到 */}
                <Tooltip title='关闭侧边编辑器'>
                    <IconButton
                        size='small'
                        aria-label='关闭侧边编辑器'
                        data-side-close='1'
                        onClick={closeSide}
                        sx={{ flexShrink: 0, color: "text.secondary" }}
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                    </Tooltip>
            </Box>
            {uiSettings.showToolbar && sideMode !== "preview" && (
                <MarkdownToolbar
                    onInsert={sideTools.insertAtCursor}
                    onLinePrefix={sideTools.toggleLinePrefix}
                    onSetHeading={sideTools.setHeadingLevel}
                    onCodeLanguage={sideTools.applyCodeLanguage}
                    onTable={sideTools.applyTable}
                    onFormula={sideTools.applyFormula}
                    onFootnoteRef={sideTools.insertFootnoteRef}
                    onCallout={sideTools.insertCallout}
                    onInsertEmbed={sideTools.onInsertEmbed}
                    onInsertBlockRef={sideTools.onInsertBlockRef}
                    onInsertBlockId={sideTools.onInsertBlockId}
                    onInsertFrontMatter={sideTools.onInsertFrontMatter}
                    onInsertTag={sideTools.onInsertTag}
                    onInsertWikiLink={sideTools.onInsertWikiLink}
                    onInsertHiddenComment={sideTools.onInsertHiddenComment}
                    onInsertFold={sideTools.onInsertFold}
                    onInsertTabs={sideTools.onInsertTabs}
                    onInsertDivider={sideTools.onInsertDivider}
                    onNotify={onNotify}
                    activeId={sideNote?.id ?? null}
                    onUploadImage={handleUpload}
                    onAttachFile={uploadApi ? (file, noteId) => handleAttach(file, noteId, true) : undefined}
                />
            )}
            <Box
                sx={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    overflow: "hidden",
                    borderLeft: "none",
                    borderRight: "none",
                    borderTop: "none",
                    borderBottom: "none",
                }}
            >
                {sideMode === "preview" ? (
                    /* 侧边预览：与主编辑区同一套 Markdown 渲染（token→React，无 HTML sink）。
                       关掉「即时渲染」时渲染的是**已存库**的那份，不是草稿 —— 这正是
                       那个开关的意义（打字时不再整篇重解析）。 */
                    <Box data-side-preview='1' sx={{ height: "100%", overflowY: "auto", px: 2, py: 1, fontSize: uiSettings.previewFontSize, lineHeight: uiSettings.lineHeight }}>
                        <MarkdownPreview
                            source={sideDraft?.content ?? ""}
                            resolveNote={resolveNote}
                            onOpenNote={handleOpenEmbedNote}
                            features={previewFeatures}
                            onToggleTask={handleSideToggleTask}
                        />
                    </Box>
                ) : sideMode === "split" ? (
                    /* 「分栏」= 源码在左、预览在右（2026-10-07 用户要求：之前是上下排，
                       和主栏的左右排不一致，两栏并排看时习惯会打架）。
                       2026-10-08：中间那条缝现在能拖（startSideSplitDrag），比例存 localStorage。 */
                    <Box
                        ref={sideSplitBoxRef}
                        sx={{ display: "flex", flexDirection: "row", height: "100%", minHeight: 0, minWidth: 0 }}
                    >
                        {/* ⚠️ minWidth: 0 不能少（2026-10-07 用户报「右边显示不全」）。
                            flex 子项默认 min-width:auto = 内容的 min-content 宽度；
                            CodeMirror 的 .cm-content 一旦比这半栏宽，左边这一格就拒绝收缩，
                            把右边的预览推出可视区 —— 右边就被裁掉一块。
                            inkstone 从根到右栏每一层都写 min-w-0，就是防这个。
                            ⚠️ 分栏时用 `0 0 auto` + 百分比宽度吃比例（和主栏 split 同款），
                            双击缝归中、拖动改比例、松手记住。 */}
                        <Box sx={{
                            ...(sideMode === "split"
                                ? { flex: "0 0 auto", width: `${sideSplitRatio * 100}%` }
                                : { flex: 1 }),
                            minWidth: 0,
                            minHeight: 0,
                            overflow: "hidden",
                        }}>
                            <NoteEditor
                                key={`side-${sideNote.id}|${uiSettings.lineNumbers ? 1 : 0}|${uiSettings.spellcheck ? 1 : 0}|${uiSettings.indentWidth}`}
                                editorRef={sideRef}
                                value={sideDraft?.content ?? ""}
                                onChange={content => setSideDraft(d => (d ? { ...d, content } : d))}
                                lineNumbers={uiSettings.lineNumbers}
                                spellcheck={uiSettings.spellcheck}
                                font={uiSettings.editorFont}
                                fontSize={uiSettings.editorFontSize}
                                indentWidth={uiSettings.indentWidth}
                                liveRender={sideLiveRender ? liveRenderer : null}
                                onOpenAttachmentLink={openAttachmentFromEditor}
                                focusMode={uiSettings.focusMode}
                                typewriterMode={uiSettings.typewriterMode}
                                shortcutActions={sideShortcutActions}
                                uploadImage={uploadApi ? uploadFileForSideEditor : undefined}
                                onDetachedUpload={(placeholder, replacement) => replaceDetachedUpload(sideNote.id!, placeholder, replacement)}
                                completionSources={completionSources}
                            />
                        </Box>
                        {/* 侧栏分栏里的那条线：与主栏同一套发丝线（1px，hover 加粗）。
                            之前只写了一条 borderLeft，与主栏的分隔条粗细不一，看着不齐。
                            2026-10-08：补上拖动（startSideSplitDrag）+ 双击归中，和主栏 split 一样能调比例。 */}
                        <Box
                            role='separator'
                            aria-orientation='vertical'
                            aria-label='拖动调整侧栏源码与预览的比例'
                            title='拖动调整比例（双击回到对半）'
                            onPointerDown={startSideSplitDrag}
                            onDoubleClick={() => {
                                setSideSplitRatio(0.5);
                                sideSplitRatioRef.current = 0.5;
                                try {
                                    localStorage.setItem(SIDE_SPLIT_KEY, "0.5");
                                } catch {
                                    /* 隐私模式下写不了，忽略 */
                                }
                            }}
                            sx={{
                                width: 9,
                                mx: "-4px",
                                flexShrink: 0,
                                cursor: "col-resize",
                                position: "relative",
                                zIndex: 1,
                                alignSelf: "stretch",
                                touchAction: "none",
                                userSelect: "none",
                                "& > span": {
                                    position: "absolute",
                                    top: 0,
                                    bottom: 0,
                                    left: "50%",
                                    // 同上：写 '1px'，别写 1（MUI 会当 100%）
                                    width: "1px",
                                    transform: "translateX(-50%)",
                                    bgcolor: "var(--card-border)",
                                    transition:
                                        "background-color var(--dur-base, 220ms) var(--ease-out, ease), width var(--dur-base, 220ms) var(--ease-out, ease)",
                                    pointerEvents: "none",
                                },
                                "&:hover > span, &:active > span": {
                                    width: "2px",
                                    bgcolor: "var(--accent)",
                                },
                            }}
                        >
                            <span aria-hidden="true" />
                        </Box>
                        <Box data-side-preview='1' sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", px: 1.5, py: 1, fontSize: uiSettings.previewFontSize, lineHeight: uiSettings.lineHeight }}>
                            <MarkdownPreview
                                source={sideLiveRender ? (sideDraft?.content ?? "") : (sideNote.content || "")}
                                resolveNote={resolveNote}
                                onOpenNote={handleOpenEmbedNote}
                                features={previewFeatures}
                                // 只有渲染草稿时才允许回写：渲染「已存库那份」时行号属于老文本，
                                // 勾一下会把草稿尚未保存的内容冲掉（即时渲染关 = 明确不想被重建）。
                                onToggleTask={sideLiveRender ? handleSideToggleTask : undefined}
                            />
                        </Box>
                    </Box>
                ) : (
                    <NoteEditor
                        key={`side-${sideNote.id}|${uiSettings.lineNumbers ? 1 : 0}|${uiSettings.spellcheck ? 1 : 0}`}
                        editorRef={sideRef}
                        value={sideDraft?.content ?? ""}
                        onChange={content => setSideDraft(d => (d ? { ...d, content } : d))}
                        lineNumbers={uiSettings.lineNumbers}
                        spellcheck={uiSettings.spellcheck}
                        font={uiSettings.editorFont}
                        fontSize={uiSettings.editorFontSize}
                        indentWidth={uiSettings.indentWidth}
                        liveRender={sideLiveRender ? liveRenderer : null}
                        focusMode={uiSettings.focusMode}
                        typewriterMode={uiSettings.typewriterMode}
                        shortcutActions={sideShortcutActions}
                        uploadImage={uploadApi ? uploadFileForSideEditor : undefined}
                                onDetachedUpload={(placeholder, replacement) => replaceDetachedUpload(sideNote.id!, placeholder, replacement)}
                        completionSources={completionSources}
                    />
                )}
            </Box>
            {/* 侧栏状态栏：与主栏**完全同款**（inkstone 的 footer）。
                高度、内边距、字号都取同一批常量，两栏并排时脚下齐平。 */}
            <Box
                data-side-statusbar='1'
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    px: 1.5,
                    height: STATUSBAR_H,
                    flexShrink: 0,
                    borderTop: "1px solid var(--card-border)",
                    fontSize: 11,
                    color: "text.disabled",
                    overflow: "hidden",
                }}
            >
                <span>{(sideDraft?.content ?? "").replace(/\s+/g, "").length} 字</span>
                <span>{(sideDraft?.content ?? "").length} 字符</span>
                <span>
                    约 {Math.max(1, Math.ceil((sideDraft?.content ?? "").replace(/\s+/g, "").length / 400))} 分钟读完
                </span>
                <Box sx={{ flex: 1 }} />
                {sideNote.created_at && formatWhenFull(sideNote.created_at) && (
                    <span data-side-created style={{ whiteSpace: "nowrap" }}>
                        创建于 {formatWhenFull(sideNote.created_at)}
                    </span>
                )}
            </Box>
        </Box>
    );
}
