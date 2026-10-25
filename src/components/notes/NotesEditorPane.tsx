import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import EditIcon from "@mui/icons-material/Edit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import LinkIcon from "@mui/icons-material/Link";
import HistoryIcon from "@mui/icons-material/History";
import ShareIcon from "@mui/icons-material/Share";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import BacklinksPanel from "../BacklinksPanel";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import { formatWhenFull } from "../../utils/noteTime";
import { outlineIndent } from "../../utils/noteOutline";
import NoteEditor from "../NoteEditor";
import { EmptyState } from "../EmptyArt";
import { MarkdownPreview, MarkdownToolbar } from "../notes/markdownToolbar";
import { PANE_HEADER_H, SPLIT_KEY, STATUSBAR_H, SaveDot } from "../notes/paneChrome";
import { findIndexedSite } from "../../utils/siteIndex";
import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesEditorPane(props: Pick<NotesPageCtx, "active" | "activeFolderName" | "activeId" | "activeTagNames" | "backlinks" | "backlinksOpen" | "boundSite" | "boundSiteMissing" | "charCount" | "checked" | "completionSources" | "dirty" | "draft" | "folderTags" | "handleAttach" | "handleOpenEmbedNote" | "handleToggleTask" | "handleUpload" | "jumpToNote" | "jumpToOffset" | "liveRender" | "liveRenderer" | "mainShortcutActions" | "narrowLayout" | "notes" | "onClose" | "onNotify" | "onOpenBoundSite" | "onTogglePin" | "onToggleStar" | "openAttachmentFromEditor" | "openRevisions" | "outline" | "outlineActiveLine" | "outlineOpen" | "pane" | "previewFeatures" | "previewScrollRef" | "replaceDetachedUpload" | "resolveNote" | "saveState" | "savedAt" | "setActiveFolder" | "setActiveMenuAnchor" | "setActiveTag" | "setBacklinksOpen" | "setDraft" | "setExportAnchor" | "setLightbox" | "setLiveRender" | "setOutlineActiveLine" | "setOutlineOpen" | "setPane" | "setShareId" | "setSplitRatio" | "setView" | "shareApi" | "sideId" | "splitBoxRef" | "splitRatio" | "splitRatioRef" | "startSplitDrag" | "syncPreviewScroll" | "tags" | "textareaRef" | "tick" | "tools" | "uiSettings" | "uploadApi" | "uploadImageForEditor" | "view" | "wordCount" | "zenMode" | "setZenMode">) {
    const { active, activeFolderName, activeTagNames, backlinks, backlinksOpen, boundSite, boundSiteMissing, charCount, completionSources, dirty, draft, folderTags, handleAttach, handleOpenEmbedNote, handleToggleTask, handleUpload, jumpToNote, jumpToOffset, liveRender, liveRenderer, mainShortcutActions, narrowLayout, notes, onNotify, onOpenBoundSite, onTogglePin, onToggleStar, openAttachmentFromEditor, openRevisions, outline, outlineActiveLine, outlineOpen, pane, previewFeatures, previewScrollRef, replaceDetachedUpload, resolveNote, saveState, savedAt, setActiveFolder, setActiveMenuAnchor, setActiveTag, setBacklinksOpen, setDraft, setExportAnchor, setLightbox, setLiveRender, setOutlineActiveLine, setOutlineOpen, setPane, setShareId, setSplitRatio, setView, shareApi, sideId, splitBoxRef, splitRatio, splitRatioRef, startSplitDrag, syncPreviewScroll, tags, textareaRef, tick, tools, uiSettings, uploadApi, uploadImageForEditor, view, wordCount, zenMode, setZenMode } = props;
    return (
        <Box
            data-editor-pane='1'
            sx={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                minWidth: 0,
                minHeight: 0,
                // 三栏背景分层（inkstone）：编辑区最亮（--bg-editor）——
                // 写字的那块板要最「平」，不然正文像贴在别的卡片上。
                bgcolor: "var(--bg-editor)",
            }}
        >
            {view === "trash" ? (
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <EmptyState
                        art='trash'
                        title='回收站里的笔记不能直接编辑'
                        description='先「还原」回全部笔记，或者「彻底删除」。'
                    />
                </Box>
            ) : !active ? (
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <EmptyState
                        art='select'
                        title='左边选一条笔记，或者新建一条'
                        description='从中间那列点开就能编辑；按 Ctrl/⌘ + N 直接新建。'
                    />
                </Box>
            ) : (
                <>
                    {/* 标题行（2026-10-07）：右侧是**这一栏自己的**按键栏 ——
                        模式切换（编辑/分栏/预览）+「更多操作」。分屏时每栏各有一套，
                        顶栏那排只对当前笔记生效的问题就没了（inkstone 同款布局）。 */}
                    <Box data-pane-header='main' sx={{ display: "flex", alignItems: "center", flexShrink: 0, pr: 1, height: PANE_HEADER_H }}>
                        <TextField
                            variant='standard'
                            value={draft?.title ?? ""}
                            onChange={e =>
                                setDraft(d => (d ? { ...d, title: e.target.value } : d))
                            }
                            placeholder='无标题'
                            slotProps={{ input: { "aria-label": "笔记标题" } }}
                            sx={{
                                flex: 1,
                                minWidth: 0,
                                px: 2,
                                // ⚠️ 高度/字号要与侧栏**完全一致**（PANE_HEADER_H / 18px）：
                                // 两栏并排时头部一高一低，标题与工具栏就错位（用户报）。
                                height: PANE_HEADER_H,
                                "& .MuiInputBase-root": { fontSize: 18, fontWeight: 600 },
                                "& .MuiInput-input": { padding: "6px 0" },
                            }}
                        />
                        {/* 即时渲染（inkstone 顶栏同名开关）。
                            ⚠️ 窄屏（<900px）不渲染（条件渲染，不是 display:none
                            —— 得真的从 DOM 里卸掉）：同一个开关在「更多操作」菜单里
                            有一份（见下面 data-active-op='live-render'）。
                            ⚠️ 2026-10-10 用户明确：分屏（侧边打开）时主栏头部要和
                            侧边栏头部**一模一样**（只是没有关闭键）—— 侧边栏头部
                            常显这个开关，主栏也常显，不再收进菜单。
                            ⚠️ 专注模式（A9）下不渲染：头部只留标题 + 退出键。 */}
                        {!narrowLayout && !zenMode && (
                        <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, flexShrink: 0, mr: 0.5 }}>
                            <Typography variant='caption' color='text.secondary' sx={{ fontSize: 11, whiteSpace: "nowrap" }}>
                                即时渲染
                            </Typography>
                            <Switch
                                size='small'
                                checked={liveRender}
                                onChange={e => setLiveRender(e.target.checked)}
                                slotProps={{ input: { "aria-label": "即时渲染" } }}
                                data-tool='live-render'
                                sx={{ ml: 0 }}
                            />
                        </Box>
                        )}
                        {/* 真·专注模式（A9）入口。与设置里那个「专注模式」（淡化非当前行）
                            是两个独立开关：那个在**编辑器内部**管注意力，这个把**页面外围**
                            （导航列 / 列表列 / 工具栏 / 状态栏）整个收掉，只留标题与正文。
                            Esc 退出，所以 tooltip 要把这句说出来 —— 不然用户不知道咋出去。 */}
                        {!zenMode && (
                            <Tooltip title='专注模式（Esc 退出）'>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label='专注模式'
                                        data-tool='zen'
                                        disabled={!active}
                                        onClick={() => setZenMode(true)}
                                        sx={{
                                            width: 28, height: 28, flexShrink: 0,
                                            color: "text.secondary",
                                        }}
                                    >
                                        <CenterFocusStrongIcon fontSize='small' />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        )}
                        {/* 模式切换：**框起来的一组图标**（inkstone 同款）。
                            ⚠️ 之前是「宽屏文字按钮 + 小屏图标」两套，宽屏下三个
                            「编辑/分栏/预览」文字把标题行撑得很宽，两栏并排时
                            标题与工具栏都对不齐（用户报）。现在统一成图标 +
                            外框，选中项填底色。aria-label 保持中文，测试与读屏不受影响。
                            ⚠️ 2026-10-10 用户明确：分屏时这一组**回到头部常驻**，
                            与侧边栏头部一致（侧边栏那组一直常显，半宽塞得下；
                            之前收进菜单反而造成左右两侧头部不对称）。
                            ⚠️ 专注模式（A9）下不渲染。 */}
                        {!zenMode && (
                        <Box
                            data-pane-modes='1'
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
                                        aria-label={label}
                                        title={label}
                                        size='small'
                                        onClick={() => setPane(key)}
                                        sx={{
                                            width: 30,
                                            height: 28,
                                            p: 0,
                                            borderRadius: 0,
                                            color: pane === key ? "var(--accent)" : "text.secondary",
                                            bgcolor:
                                                pane === key
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
                        )}
                        {/* 保存状态（inkstone 的 SaveIndicator 就挂在头部这一排）。
                            之前它写在状态栏右端，于是那一行既报长度又报状态，26px 塞不下。
                            ⚠️ 专注模式（A9）下**保留**：它是唯一还在报「存没存」的东西，
                            藏了用户会以为专注模式下不自动保存、写完不敢退。 */}
                        <SaveDot state={saveState} dirty={dirty} savedAt={savedAt} now={tick} />
                        {/* 专注模式退出键： Esc 的同义词，给不用键盘的人。
                            放在 SaveDot 右边（原来 pin 组的位置）—— 头部 zen 态就
                            「标题 + 保存状态 + 这一颗」。 */}
                        {zenMode && (
                            <Tooltip title='退出专注模式（Esc）'>
                                <IconButton
                                    size='small'
                                    aria-label='退出专注模式'
                                    data-tool='zen-exit'
                                    onClick={() => setZenMode(false)}
                                    sx={{
                                        width: 28, height: 28, flexShrink: 0, mr: 0.5,
                                        color: "var(--accent)",
                                    }}
                                >
                                    <FullscreenExitIcon fontSize='small' />
                                </IconButton>
                            </Tooltip>
                        )}
                        {/* ⚠️ P0-3（2026-10-07）：把两个高频动作从「⋯」里提到头部常驻。
                            inkstone 的头部右侧是平铺的一排图标（Workspace.tsx:425-472）：
                            更多 / 收藏 / 反向链接 / 版本历史 / 导出 / 大纲 / 分享。
                            我们把分享/版本/大纲/反链都收进了「⋯」—— 收着不算错（窄栏更合理），
                            但「收藏」和「大纲」是随手要用的，让用户先点开菜单再点一项太绕。
                            所以只把这两个提成常驻按钮，其余仍留在「⋯」里。
                            ⚠️ 2026-10-09 用户明确：**分屏（侧边打开）时照 inkstone 收进「更多」** ——
                            半宽的两栏塞不下这排，头部只留三档 + 保存状态 + 「⋯」。
                            条件渲染（不是 display:none）：元素要真的从 DOM 卸掉。 */}
                        {sideId === null && !zenMode && (
                        <Box sx={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 0.25, mr: 0.5 }}>
                            <Tooltip title={active?.pinned ? "取消置顶" : "置顶"}>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label={active?.pinned ? "取消置顶" : "置顶"}
                                        data-tool='pin'
                                        disabled={!active}
                                        onClick={() => active && void onTogglePin(active)}
                                        sx={{
                                            width: 28, height: 28,
                                            color: active?.pinned ? "var(--accent)" : "text.secondary",
                                        }}
                                    >
                                        {active?.pinned ? <PushPinIcon fontSize='small' /> : <PushPinOutlinedIcon fontSize='small' />}
                                    </IconButton>
                                </span>
                            </Tooltip>
                            {/* 收藏（与置顶分离，2026-10-09）：置顶管排序、收藏管「收藏」视图。
                                老部署（onToggleStar 没传）不显示这一颗 —— 那时两套是同一个开关。 */}
                            {onToggleStar && (
                            <Tooltip title={active?.starred ? "取消收藏" : "收藏"}>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label={active?.starred ? "取消收藏" : "收藏"}
                                        data-tool='star'
                                        disabled={!active}
                                        onClick={() => active && void onToggleStar(active)}
                                        sx={{
                                            width: 28, height: 28,
                                            color: active?.starred ? "var(--accent)" : "text.secondary",
                                        }}
                                    >
                                        {active?.starred ? <StarIcon fontSize='small' /> : <StarBorderIcon fontSize='small' />}
                                    </IconButton>
                                </span>
                            </Tooltip>
                            )}
                            <Tooltip title='大纲（本文标题列表）'>
                                <IconButton
                                    size='small'
                                    aria-label='大纲'
                                    data-tool='outline'
                                    disabled={!active}
                                    onClick={() => {
                                        setOutlineOpen(o => !o);
                                        setActiveMenuAnchor(null);
                                    }}
                                    sx={{
                                        width: 28, height: 28,
                                        color: outlineOpen ? "var(--accent)" : "text.secondary",
                                    }}
                                >
                                    <ListIcon fontSize='small' />
                                </IconButton>
                            </Tooltip>
                        </Box>
                        )}
                        {/* 桌面端把高频操作直接平铺（2026-10-08 照 inkstone Workspace 头部：
                            收藏 / 反链 / 版本历史 / 导出 / 大纲 / 分享直接显示，
                            「⋯」桌面端不再收纳它们；窄屏标题行窄，不渲染这组，仍走「⋯」）。
                            ⚠️ 2026-10-09：分屏（侧边打开）时同样不渲染 —— 半宽塞不下，
                            inkstone 分屏也是全收进 groupedItems 菜单，对应菜单项在
                            分屏时会重新出现（见下面那组 narrowLayout || sideOpen 条件）。 */}
                        {!narrowLayout && sideId === null && !zenMode && (
                        <Box
                            data-desktop-actions='1'
                            sx={{ flexShrink: 0, alignItems: "center", gap: 0.25, mr: 0.5, display: "flex" }}
                        >
                            <Tooltip title={`反向链接（${backlinks.length}）`}>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label='反向链接'
                                        data-tool='backlinks'
                                        disabled={!active}
                                        onClick={() => setBacklinksOpen(o => !o)}
                                        sx={{
                                            width: 28, height: 28,
                                            color: backlinksOpen ? "var(--accent)" : "text.secondary",
                                        }}
                                    >
                                        <LinkIcon fontSize='small' />
                                    </IconButton>
                                </span>
                            </Tooltip>
                            <Tooltip title='版本历史'>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label='版本历史'
                                        data-tool='revisions'
                                        disabled={!active || !folderTags?.onListRevisions}
                                        onClick={() => active && void openRevisions()}
                                        sx={{ width: 28, height: 28, color: "text.secondary" }}
                                    >
                                        <HistoryIcon fontSize='small' />
                                    </IconButton>
                                </span>
                            </Tooltip>
                            <Tooltip title='导出'>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label='导出'
                                        data-tool='export'
                                        disabled={!active}
                                        onClick={e => setExportAnchor(e.currentTarget)}
                                        sx={{ width: 28, height: 28, color: "text.secondary" }}
                                    >
                                        <FileDownloadIcon fontSize='small' />
                                    </IconButton>
                                </span>
                            </Tooltip>
                            <Tooltip title='只读分享'>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label='只读分享'
                                        data-tool='share'
                                        disabled={!active || !shareApi || (active.id ?? 0) <= 0}
                                        onClick={() => active.id && setShareId(active.id)}
                                        sx={{ width: 28, height: 28, color: "text.secondary" }}
                                    >
                                        <ShareIcon fontSize='small' />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        </Box>
                        )}
                        {/* 当前笔记的操作入口。顶栏拆掉后，只读分享 / 版本历史 / 大纲 /
                            反向链接也收进了这个菜单（见下面 data-active-op 那几项）。
                            专注模式（A9）下不渲染。 */}
                        {/* 「更多操作」独立成组，紧贴模式控件右侧 */}
                        {!zenMode && (
                        <Box sx={{ display: "flex", flexShrink: 0 }}>
                            <Tooltip title='更多操作'>
                                <IconButton
                                    size='small'
                                    data-tool='note-more'
                                    aria-label='更多操作'
                                    aria-haspopup='menu'
                                    disabled={!active}
                                    onClick={e => setActiveMenuAnchor(e.currentTarget)}
                                    sx={{ width: 28, height: 28, color: "text.secondary" }}
                                >
                                    <MoreVertIcon fontSize='small' />
                                </IconButton>
                        </Tooltip>
                        </Box>
                        )}
                    </Box>

                    {/* 格式工具栏：照 inkstone 那一排。放在标题与内容区之间，
                        点一下在光标处插入语法 —— 省得手打 `**` 和 `- [ ]`。
                        设置里可以整个关掉（uiSettings.showToolbar）；
                        专注模式（A9）下同样不渲染（「只留正文」包括这条）。 */}
                    {uiSettings.showToolbar && !zenMode && (
                    <MarkdownToolbar
                        onInsert={tools.insertAtCursor}
                        onLinePrefix={tools.toggleLinePrefix}
                        onSetHeading={tools.setHeadingLevel}
                        onCodeLanguage={tools.applyCodeLanguage}
                        onTable={tools.applyTable}
                        onFormula={tools.applyFormula}
                        onFootnoteRef={tools.insertFootnoteRef}
                        onCallout={tools.insertCallout}
                        onInsertEmbed={tools.onInsertEmbed}
                        onInsertBlockRef={tools.onInsertBlockRef}
                        onInsertBlockId={tools.onInsertBlockId}
                        onInsertFrontMatter={tools.onInsertFrontMatter}
                        onInsertTag={tools.onInsertTag}
                        onInsertWikiLink={tools.onInsertWikiLink}
                        onInsertHiddenComment={tools.onInsertHiddenComment}
                        onInsertFold={tools.onInsertFold}
                        onInsertTabs={tools.onInsertTabs}
                        onInsertDivider={tools.onInsertDivider}
                        onNotify={onNotify}
                        activeId={active?.id ?? null}
                        onUploadImage={handleUpload}
                        onAttachFile={uploadApi ? (file, noteId) => handleAttach(file, noteId, false) : undefined}
                        // 预览模式下编辑器不挂载：上传会成功但插不进正文（见 canInsert 的说明）
                        canInsert={pane !== "preview"}
                    />
                    )}

                    {/* 内容区：源码 | 预览 | 大纲面板。外层再包一行，
                        大纲面板（outlineOpen）作为第三列贴在预览右侧（inkstone 布局）。 */}
                    <Box sx={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
                    <Box
                        ref={splitBoxRef}
                        sx={{
                            flex: 1,
                            display: "flex",
                            minHeight: 0,
                            minWidth: 0,
                            // ⚠️ 这里必须有水平内边距。编辑区是 `flex:1` 吃掉整条剩余宽度的，
                            // 而记事本这层全屏又铺到 100vw —— 不留边距的话源码 / 预览
                            // 两栏会**贴死视口右边缘**：预览的右边框和滚动条被顶出屏幕，
                            // 看起来就是「右边显示不全」。px:2 与标题 / 工具栏 / 状态栏对齐。
                            //
                            // ⚠️⚠️ 垂直内边距必须去掉（2026-10-07 用户报「分屏两侧高度不一致」）：
                            // 主编辑区这一层有 py:1 而侧边栏没有，于是主栏的状态栏比
                            // 侧边栏高 16px，两栏底部对不齐。改成只留 px，交给各自的
                            // 头部 / 工具栏 / 状态栏负责上下留白。
                            px: 2,
                        }}
                    >
                        {pane !== "preview" && (
                            <Box
                                sx={{
                                    // ⚠️ 两栏都用 `flex: 1 1 0`（basis 0）才会严格对半。
                                    // 之前一边是 `1 1 50%`（basis 445）一边是 `1`（basis 0），
                                    // 剩余空间再按 grow 分 —— 结果源码 667px、预览 222px，
                                    // 看着就像「预览被挤没了」。
                                    // 分栏时用 flexBasis 吃比例；单栏时独占
                                    ...(pane === "edit"
                                        ? { flex: 1 }
                                        : {
                                              flex: "0 0 auto",
                                              width: `${splitRatio * 100}%`,
                                          }),
                                    minWidth: 0,
                                    // ⚠️ 之前分屏时给两栏都加了**完整边框 + 圆角 + 淡底色**，
                                    // 看着像「两张卡片拼在一起」，边界又粗又脏（用户报「太丑」）。
                                    // inkstone 的分栏是**无框**的：只有中间那根 1px 发丝线，
                                    // 两栏共用同一层背景。分隔由那条线负责就够了。
                                    border: "none",
                                    borderRadius: 0,
                                    outline: "none",
                                    resize: "none",
                                    // 常显滚动条：默认 overlay 会让人以为「预览窗没滚轮」
                                    p: 0,
                                    minHeight: 0,
                                    overflow: "hidden",
                                    font: "inherit",
                                    fontFamily: "ui-monospace, monospace",
                                    fontSize: 14,
                                    lineHeight: 1.75,
                                    color: "inherit",
                                    bgcolor: "transparent",
                                }}
                            >
                                <NoteEditor
                                    // 行号/拼写/缩进开关会重建编辑器（CodeMirror 的扩展只能在建时定），
                                    // 拼进 key；字体/字号走 CSS 变量，不用重建。
                                    key={`${active.id}|${uiSettings.lineNumbers ? 1 : 0}|${uiSettings.spellcheck ? 1 : 0}|${uiSettings.indentWidth}`}
                                    editorRef={textareaRef}
                                    value={draft?.content ?? ""}
                                    onChange={content => setDraft(d => d ? { ...d, content } : d)}
                                    lineNumbers={uiSettings.lineNumbers}
                                    spellcheck={uiSettings.spellcheck}
                                    font={uiSettings.editorFont}
                                    fontSize={uiSettings.editorFontSize}
                                    indentWidth={uiSettings.indentWidth}
                                    onScrollRatio={syncPreviewScroll}
                                    liveRender={liveRender ? liveRenderer : null}
                                    onOpenAttachmentLink={openAttachmentFromEditor}
                                    focusMode={uiSettings.focusMode}
                                    typewriterMode={uiSettings.typewriterMode}
                                    shortcutActions={mainShortcutActions}
                                    uploadImage={uploadApi ? uploadImageForEditor : undefined}
                                    onDetachedUpload={(placeholder, replacement) => replaceDetachedUpload(active.id!, placeholder, replacement)}
                                    completionSources={completionSources}
                                />
                            </Box>
                        )}
                        {pane === "split" && (
                            <Box
                                role='separator'
                                aria-orientation='vertical'
                                aria-label='拖动调整源码与预览的比例'
                                title='拖动调整比例（双击回到对半）'
                                onPointerDown={startSplitDrag}
                                onDoubleClick={() => {
                                    setSplitRatio(0.5);
                                    // 同步 ref：不然「双击归中 → 立刻再拖 → 松手」这一串里，
                                    // 松手存的还是归中之前那个旧值。
                                    splitRatioRef.current = 0.5;
                                    try {
                                        localStorage.setItem(SPLIT_KEY, "0.5");
                                    } catch {
                                        /* 隐私模式写不了，忽略 */
                                    }
                                }}
                                sx={{
                                    // 与 ColResizeHandle 同一套（inkstone 的 Resizer）：
                                    // 命中区 9px + 负边距 −4px，内含 1px 发丝线，
                                    // hover/拖动变 2px 强调色。之前这里是「透明 + hover 才出色块」，
                                    // 静止时看不见线，和右边的分隔条长得也不一样。
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
                        )}
                        {pane !== "edit" && (
                            <Box
                                ref={previewScrollRef}
                                data-preview-scroll='1'
                                sx={{
                                    // 与源码区同一个 basis（0），两栏才严格对半
                                    flex: 1,
                                    minWidth: 0,
                                    // ⚠️ minHeight:0 不能少：flex 子项默认 min-height:auto，
                                    // Markdown 一长就把这一层撑高、连带整页出现滚动条。
                                    minHeight: 0,
                                    overflowY: "auto",
                                    // 左右留白跟着「内容宽度」联动（2026-10-25 笔记美化）：
                                    // 窄档 24 / 标准 32 / 宽 48 / 满 40。以前固定 20px，
                                    // 宽档 980 时正文贴到屏幕边，长行回来很难找行首。
                                    py: 2.5,
                                    px:
                                        uiSettings.contentWidth === "narrow"
                                            ? 3
                                            : uiSettings.contentWidth === "standard"
                                              ? 4
                                              : uiSettings.contentWidth === "wide"
                                                ? 6
                                                : 5,
                                    // 设置面板「外观」：预览正文字号 / 行高 / 字体直接在这里生效
                                    fontSize: uiSettings.previewFontSize,
                                    lineHeight: uiSettings.lineHeight,
                                    fontFamily:
                                        uiSettings.previewFont === "serif"
                                            ? 'Georgia, "Songti SC", "Noto Serif CJK SC", serif'
                                            : "inherit",
                                    // 同源码区：分屏无框，只有中间那根线（inkstone 同款）
                                    border: "none",
                                    borderRadius: 0,
                                    bgcolor: "transparent",
                                    // 「单栏阅读」模式给一层纸面（2026-10-25）：
                                    // 分屏时必须无框（两栏中间只有一根线），但**只剩预览**时
                                    // 正文直接铺在整页暖白上，没有任何承载物 —— 与导航页
                                    // 「内容都在玻璃卡上」的语言完全脱节。
                                    // 所以只在 pane === "preview" 时加：淡纸面 + 细描边 + 极轻阴影，
                                    // 980 上限居中（宽屏不拉成长条）。
                                    ...(pane === "preview"
                                        ? {
                                              maxWidth: 980,
                                              mx: "auto",
                                              my: 2,
                                              bgcolor: "var(--surface-raised)",
                                              border: "1px solid var(--card-border)",
                                              borderRadius: "var(--notes-radius-row, 12px)",
                                              boxShadow: "var(--shadow-chip, none)",
                                          }
                                        : null),
                                }}
                            >
                                {/* 「即时渲染」只作用于**编辑区**：预览区永远是渲染后的结果，
                                    始终跟随编辑内容（2026-10-07 用户澄清）。 */}
                                <Box
                                    data-preview-content='1'
                                    sx={{
                                        // 设置面板「内容宽度」：窄/标准/宽/满 四档，
                                        // 窄于可用宽度时居中（inkstone 的预览排版同款）
                                        width: "100%",
                                        maxWidth:
                                            uiSettings.contentWidth === "narrow"
                                                ? 560
                                                : uiSettings.contentWidth === "standard"
                                                  ? 760
                                                  : uiSettings.contentWidth === "wide"
                                                    ? 980
                                                    : "100%",
                                        mx: "auto",
                                        // ⚠️ 光有 break-word 不够：中文长句没有空格，
                                        // 会被当成一个超长单词而不断行（同下面预览层
                                        // 的注释）。要 `anywhere` 才在任意字符间断。
                                        overflowWrap: "anywhere",
                                        wordBreak: "break-word",
                                    }}
                                
                                onDoubleClick={e => {
                                    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-inline-tag]");
                                    const tag = tags.find(t => t.name === target?.dataset.inlineTag);
                                    if (tag?.id !== undefined) {
                                        setActiveTag(tag.id); setActiveFolder(null); setView("all");
                                    }
                                }} onClick={e => {
                                    // 图片灯箱（inkstone 的 Preview → ui.lightbox）：
                                    // 点预览里的图片放大看。用**事件委托**而不是给每个
                                    // <img> 挂 onClick —— 渲染层是 markdown-it 的产物，
                                    // 改它的 API 会把导出/嵌入那几条链路一起牵动。
                                    const img = (e.target as HTMLElement).closest("img");
                                    if (img) {
                                        e.preventDefault();
                                        setLightbox({
                                            src: img.currentSrc || img.src,
                                            alt: img.alt || "",
                                        });
                                        return;
                                    }
                                    // `[[双链]]` 单击即跳。它是 <a> 但**没有 href**：
                                    // 真 href 会让浏览器做新页面导航（全屏 overlay 里
                                    // 直接白掉），所以这里只用 data 属性 + 委托点击，
                                    // 保留 <a> 的语义与可点外观。
                                    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-wiki-link]");
                                    const title = link?.dataset.wikiLink;
                                    if (!title) return;
                                    const hit = notes.find(n => (n.title || "").trim().toLowerCase() === title.trim().toLowerCase());
                                    if (hit?.id !== undefined) {
                                        e.preventDefault();
                                        void jumpToNote(hit.id);
                                    } else if (findIndexedSite(title)) {
                                        // D2 双向绑定：没有同名笔记、但有同名（或同网址）
                                        // **站点** 时，跳的是那个站点 —— 导航站里的条目
                                        // 本来就是「关于这个东西的主页」，比新建一条笔记合理。
                                        // ⚠️ 笔记优先：同名时仍然跳笔记，这里是**退化路径**，
                                        // 原本这类链接点了只会报「没找到」，不会改变既有行为。
                                        const site = findIndexedSite(title)!;
                                        e.preventDefault();
                                        // noopener + noreferrer：新标签页拿不到本站的
                                        // window.opener，也带不走来源
                                        window.open(site.url, "_blank", "noopener,noreferrer");
                                        onNotify?.(`已打开站点「${site.name}」`, "info");
                                    } else {
                                        // ⚠️ 死链必须给反馈，不能点了毫无反应 ——
                                        // 用户会以为是按钮坏了。多数情况是标题改了或还没建。
                                        e.preventDefault();
                                        onNotify?.(`没有找到名为「${title}」的笔记`, "error");
                                    }
                                }}><MarkdownPreview
                                    // 预览区**始终**渲染编辑区（草稿）的内容，不受「即时渲染」影响
                                    source={draft?.content || ""}
                                    resolveNote={resolveNote}
                                    onOpenNote={handleOpenEmbedNote}
                                    features={previewFeatures}
                                    // 预览里的任务复选框可勾选 → 回写草稿（同上这份 source）
                                    onToggleTask={handleToggleTask}
                                /></Box>
                            </Box>
                        )}
                    </Box>
                    {/* 大纲面板：当前这条笔记的标题层级，常驻在预览右侧。
                        没标题时给一句说明，别给一块空白让人以为功能坏了。
                        专注模式（A9）下不渲染。 */}
                    {outlineOpen && !zenMode && (
                        <Box
                            data-outline-panel='1'
                            sx={{
                                width: 190,
                                flexShrink: 0,
                                borderLeft: "1px solid var(--neutral-hairline)",
                                overflowY: "auto",
                                py: 1,
                                px: 0.75,
                                display: narrowLayout ? "none" : "block",
                            }}
                        >
                            <Typography
                                variant='caption'
                                sx={{ display: "block", px: 1, pb: 0.5, fontSize: 11, color: "text.disabled" }}
                            >
                                大纲
                            </Typography>
                            {outline.length === 0 ? (
                                <Typography
                                    variant='caption'
                                    data-outline='empty'
                                    sx={{ display: "block", px: 1, fontSize: 11.5, color: "text.secondary" }}
                                >
                                    这条笔记还没有标题（用 # 标题 就能出现在这里）
                                </Typography>
                            ) : (
                                outline.map(item => (
                                    <Box
                                        key={`${item.line}-${item.offset}`}
                                        component='button'
                                        type='button'
                                        data-outline-item={item.line}
                                        style={outlineActiveLine === item.line ? { color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)", fontWeight: 600 } : undefined}
                                        aria-current={outlineActiveLine === item.line ? "location" : undefined}
                                        className={outlineActiveLine === item.line ? "outline-current" : undefined}
                                        onClick={() => {
                                            setOutlineActiveLine(item.line);
                                            if (pane === "preview") previewScrollRef.current?.querySelector<HTMLElement>(`[data-line="${item.line}"]`)?.scrollIntoView({ block: "start" });
                                            else jumpToOffset(item.offset);
                                        }}
                                        sx={{
                                            display: "block",
                                            width: "100%",
                                            appearance: "none",
                                            border: "none",
                                            m: 0,
                                            font: "inherit",
                                            cursor: "pointer",
                                            textAlign: "left",
                                            minWidth: 0,
                                            pl: 1 + Math.min(outlineIndent(item.level), 6),
                                            pr: 0.5,
                                            py: 0.4,
                                            borderRadius: 1,
                                            bgcolor: "transparent",
                                            color: "text.secondary",
                                            fontWeight: item.level <= 2 ? 600 : 400,
                                            fontSize: 12.5,
                                            "&:hover": {
                                                bgcolor: "var(--neutral-hover)",
                                                color: "text.primary",
                                            },
                                        }}
                                    >
                                        <Typography
                                            component='span'
                                            sx={{
                                                display: "block",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                                font: "inherit",
                                                fontWeight: "inherit",
                                                fontSize: "inherit",
                                            }}
                                        >
                                            {item.text}
                                        </Typography>
                                    </Box>
                                ))
                            )}
                        </Box>
                    )}
                    {/* 反链右侧常驻面板（N4）：与大纲面板同一列位置。
                        窄屏不渲染（头部那组平铺按钮窄屏本来就不出现，反链仍走「⋯」菜单）。
                        专注模式（A9）下不渲染。 */}
                    {backlinksOpen && !narrowLayout && !zenMode && (
                        <BacklinksPanel
                            open
                            onClose={() => setBacklinksOpen(false)}
                            notes={notes}
                            currentId={active?.id}
                            currentTitle={active?.title ?? ""}
                            onOpenNote={id => {
                                void jumpToNote(id);
                            }}
                        />
                    )}
                    </Box>

                    {/* 状态栏：照 inkstone 的 footer —— **26px 一条**，
                        内容就六项：字数 / 字符 / 读完要几分钟 / 所在文件夹 / 标签 / 创建于。
                        ⚠️ 两处刻意与之前不同：
                        ① 不再显示行号与光标位置（inkstone 也没有，行号是编辑器的东西，
                           摆在状态栏只会跟 CodeMirror 的行号槽重复）；
                        ② 保存状态搬去了标题行（inkstone 的 SaveIndicator 就在头部），
                           这里只管「这篇多长、它是谁」。
                        ⚠️ 专注模式（A9）下整条不渲染：「只留正文」就只剩标题 + 正文 + 保存点。 */}
                    {!zenMode && (
                    <Box
                        data-statusbar='1'
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
                        <span>{wordCount} 字</span>
                        <span>{charCount} 字符</span>
                        <span>约 {Math.max(1, Math.ceil(wordCount / 400))} 分钟读完</span>
                        {/* 所在文件夹：相当于一个位置指示 —— 这篇是从哪儿打开的。
                            没归类的不显示（inkstone 同样只在该笔记真在文件夹里时给）。 */}
                        {activeFolderName && (
                            <span
                                data-note-folder
                                style={{ opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}
                            >
                                {activeFolderName}
                            </span>
                        )}
                        {/* 所在站点（#477 双向绑定的笔记那一侧）：点一下关掉记事本、
                            滚到那张卡片并闪一下轮廓（App 的 jumpToSite）。
                            站点已删时照实写「站点已删除」—— 悬空引用是刻意保留的
                            （卡片删了笔记要留下），藏起来反而让人以为绑定丢了。 */}
                        {boundSite && (
                            <Box
                                component='button'
                                type='button'
                                data-note-site={boundSite.id ?? ""}
                                onClick={onOpenBoundSite}
                                title={`打开站点卡片：${boundSite.name}`}
                                sx={{
                                    border: 0,
                                    background: "none",
                                    p: 0,
                                    font: "inherit",
                                    color: "var(--accent)",
                                    cursor: "pointer",
                                    maxWidth: 160,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    "&:hover": { textDecoration: "underline" },
                                }}
                            >
                                {boundSite.name}
                            </Box>
                        )}
                        {boundSiteMissing && (
                            <span
                                data-note-site-missing
                                style={{ opacity: 0.85, whiteSpace: "nowrap" }}
                                title='绑定的站点已被删除，笔记本身不受影响'
                            >
                                站点已删除
                            </span>
                        )}
                        {/* 标签（inkstone 状态栏有，最多摆 4 个） */}
                        {activeTagNames.length > 0 && (
                            <Box sx={{ display: "flex", gap: 0.75, minWidth: 0, overflow: "hidden" }}>
                                {activeTagNames.slice(0, 4).map(name => (
                                    <span
                                        key={name}
                                        data-status-tag={name}
                                        style={{ color: "var(--accent)", whiteSpace: "nowrap" }}
                                    >
                                        #{name}
                                    </span>
                                ))}
                            </Box>
                        )}
                        <Box sx={{ flex: 1 }} />
                        {/* 右端：创建时间。解析不出就不显示 —— 宁可少一项，也别给「Invalid Date」。 */}
                        {active.created_at && formatWhenFull(active.created_at) && (
                            <span data-note-created style={{ whiteSpace: "nowrap" }}>
                                创建于 {formatWhenFull(active.created_at)}
                            </span>
                        )}
                    </Box>
                    )}
                </>
            )}
        </Box>
    );
}
