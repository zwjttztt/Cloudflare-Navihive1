import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import NoteAddIcon from "@mui/icons-material/NoteAddOutlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import LastPageIcon from "@mui/icons-material/LastPage";
import PushPinIcon from "@mui/icons-material/PushPin";
import StarIcon from "@mui/icons-material/Star";
import SortIcon from "@mui/icons-material/Sort";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import Checkbox from "@mui/material/Checkbox";
import { summarize } from "../../utils/noteSummary";
import Highlighted from "../Highlighted";
import { formatWhen } from "../../utils/noteTime";
import { EmptyState } from "../EmptyArt";
import { LazyGroup } from "../notes/lazyGroup";
import { tagNamesOf, anchorAtMouse } from "../notes/sidebarSection";
import { ColResizeHandle } from "../notes/paneChrome";
import type { NotesPageCtx } from "./notesPageCtx";
import NotesTrashPane from "./NotesTrashPane";


export default function NotesListPane(props: Pick<NotesPageCtx, "activeFolder" | "activeId" | "activeTag" | "bp" | "bulkArchive" | "checked" | "checkedNotes" | "dirty" | "draggingNoteId" | "emptyArt" | "emptyCopy" | "filtered" | "highlightRanges" | "keyword" | "lazyListGroups" | "listCollapsed" | "listGroups" | "listHidden" | "listW" | "menuClosing" | "multiSelect" | "narrowLayout" | "navInner" | "navW" | "noteTags" | "notes" | "notesCommands" | "onClose" | "onEmptyTrash" | "onPurgeTrashed" | "onRestoreTrashed" | "openNote" | "openTemplatePicker" | "pinnedCount" | "renderSearchField" | "reset" | "rowActionsSuppressed" | "rowMenu" | "searchRefNarrow" | "searchSnippets" | "selectAnchorRef" | "setBulkDeleteOpen" | "setChecked" | "setDraggingNoteId" | "setListCollapsed" | "setMiddleHidden" | "setMultiSelect" | "setRowActionsSuppressed" | "setRowMenu" | "setSortAnchor" | "startDrag" | "switchTo" | "tagColorByName" | "tags" | "toggleChecked" | "trashedNotes" | "uiSettings" | "view" | "visibleIds">) {
    const { activeFolder, activeId, activeTag, bp, bulkArchive, checked, checkedNotes, dirty, draggingNoteId, emptyArt, emptyCopy, filtered, highlightRanges, keyword, lazyListGroups, listCollapsed, listGroups, listHidden, listW, menuClosing, multiSelect, narrowLayout, navInner, navW, noteTags, notes, notesCommands, onClose, onEmptyTrash, onPurgeTrashed, onRestoreTrashed, openNote, openTemplatePicker, pinnedCount, renderSearchField, reset, rowActionsSuppressed, rowMenu, searchRefNarrow, searchSnippets, selectAnchorRef, setBulkDeleteOpen, setChecked, setDraggingNoteId, setListCollapsed, setMiddleHidden, setMultiSelect, setRowActionsSuppressed, setRowMenu, setSortAnchor, startDrag, switchTo, tagColorByName, tags, toggleChecked, trashedNotes, uiSettings, view, visibleIds } = props;
    return (
        <Box
            sx={{
                // 阶段二：折叠后收成 44px 的图标轨（平时是【导航列 + 列表列】两列并排）
                // ⚠️ 两条缝（9px 命中区）也算进总宽，否则拖到最宽时右边界会溢出一点。
                // 选中文件夹时只剩导航列一栏（笔记内联在里面），总宽要把列表列那份让出来。
                //
                // ⚠️ 2026-10-07 重写：原来写的是 `{ xs: "100%", md: navW + listW + 14 }`。
                // `xs: "100%"` 是个**陷阱**：窄屏下它让左栏吃掉整行，编辑区就被压成 0 宽
                // （真机量到 edW=0，整块看不见）。而 MUI 的 md 是 900px，
                // 跟 inkstone 的 1180/768 两条线根本不是一回事。
                // 现在按 usePanelBreakpoint 的三档显式给宽度：
                //   mobile  100%（两屏切换时它就是整屏）
                //   tablet  只有列表列（导航列不内联渲染，走顶部 44px 栏 + 抽屉；
                //           中栏关掉时整个左区让位给编辑区，见主行那层的 display）
                //   desktop listHidden → 只剩导航列；否则导航 + 列表
                //
                // ⚠️⚠️ 「两条缝」只值 **1px**，不是 9px，更不是 18px（2026-10-07 用户报
                // 「拖动绿线右边有一条竖长条」，红框圈的就是这段空隙）。
                //
                // 几何账：每条把手 `width: 9px` + `mx: -4px` —— 负边距让它向两侧各溢出 4px，
                // 所以它**净占 9 − 4 − 4 = 1px**。之前这里写 `+18`（= 9 + 9，把两条把手
                // 都按满宽算），于是：
                //   真实右边界 = navW + listW + 5   （最后一条把手只露 5px）
                //   给定宽度   = navW + listW + 18
                //   多出 13px 的**空白带**，夹在列表列与编辑区之间。真机逐列读像素确认：
                //   列表列 right=336 → 编辑区 left=354，中间 337..353 什么都没有，
                //   而发丝线在 337 —— 视觉上就是「一条竖长条」。
                //
                // inkstone 那边压根不给这个数（AppShell.tsx:95-107：每列各自
                // `shrink-0` + 定宽，Resizer 是它们之间的兄弟节点，浏览器自然排布，
                // 零死空间）。我们把两列塞进同一个容器，只能自己算这个账，
                // 那就按 `每条把手净占 1px` 来算：
                //   两条把手 = +2；最后一条把手还会往右露 5px（9 − 4），那 5px 归容器。
                // 所以总数 = navW + listW + 9 - 4 + 1×1 = navW + listW + 6。
                width: bp === "mobile"
                    ? "100%"
                    : bp === "tablet"
                      ? listCollapsed
                        ? 44
                        : listW + 5
                      : listCollapsed
                        ? 44
                        : listHidden
                          ? navW + 5
                          : navW + listW + 6,
                flexShrink: 0,
                // 折叠成 44px 轨道时，任何子元素都不许溢出压到右边的编辑区
                overflow: "hidden",
                // ⚠️ 这里**不能**再画右边框（2026-10-07 用户报「分割线太粗」）。
                // 两条缝（nav|list、list|editor）各自有一个 9px 命中区 + 1px 发丝线，
                // 线就画在命中区正中；这个盒子是它们的**共同祖先**，它的 borderRight
                // 落在最右那条命中区的右边 12px 处，于是屏幕上出现两条线：
                //   x=487 发丝线（list|editor 那条）
                //   x=500 本行的 borderRight
                // 看着就是「分割线粗了一截」。inkstone 那边同理 —— AppShell 的
                // flex 容器不带边框，边框只由 Resizer 的那根 span 负责。
                // 真机量过：去掉之后 list|editor 边界上只剩 1 条 1px 线。
                // borderRight: { md: "1px solid var(--card-border)" },
                // ⚠️ 这里改成了**横向**排列：左栏现在自己就是两列（导航 | 列表）。
                // 原来是一整个竖列里塞「搜索框 + 六个视图按钮 + 笔记列表」——
                // 300px 宽里三样挤一起，列表只剩 200 出头，月份分组标题一换行就漏字。
                display: "flex",
                alignItems: "stretch",
                minHeight: 0,
            }}
        >
            {/* ⚠️ 折叠态必须把**搜索框和视图导航也一起藏掉**：
                之前只藏了计数和列表，44px 宽的轨道里塞着三个「全部/最近/收藏」按钮，
                文字直接溢出压到右边的编辑区上（用户报「收齐后文字重叠」）。
                轨道里只留一个展开按钮。 */}
            {listCollapsed ? (
                // 折叠态：44px 轨道里只留两个按钮（2026-10-10 用户要求再调整）：
                // **「展开笔记列表」在上、「返回导航站」在下**。
                // 历史沿革：2026-10-07 先按 inkstone 把展开键挪到轨道底部；用户实际用下来
                // 觉得「返回」更该占底部（和左下角导出/归档那排同一高度、顺手），
                // 于是两个按钮整体互换。样式/尺寸/间距一律不动（size='small'、gap 0.5、
                // justifyContent: space-between），只换 DOM 顺序。
                <Box
                    data-collapsed-rail='1'
                    sx={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "space-between",
                        py: 1,
                        gap: 0.5,
                    }}
                >
                    <Tooltip title='展开笔记列表' placement='right'>
                        <IconButton
                            aria-label='展开笔记列表'
                            data-tool='expand-pane'
                            size='small'
                            onClick={() => setListCollapsed(false)}
                        >
                            <LastPageIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title='返回导航站'>
                        <IconButton aria-label='返回导航站' onClick={onClose} size='small'>
                            <ArrowBackIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
                </Box>
            ) : (
            <>
            {/* ================= 第一列：导航 / 文件夹 / 标签 =================
                这一列自己滚（overflowY: auto）：整块一起滚会把搜索框顶出视野，
                而搜索框是「随时都想用得上」的，不能被笔记列表推走。 */}
            {!narrowLayout && (
            <Box
                data-nav-col='1'
                sx={{
                    width: navW,
                    flexShrink: 0,
                    // 导航列 desktop 常驻；窄屏走顶部 44px 栏 + 272px 导航抽屉（内容同 navInner）。
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    // ⚠️ 这里原来有 borderRight，已去掉（2026-10-07）。
                    // 右边已经有「拖动调整导航列宽度」那条带发丝线的把手了，
                    // 两者叠在一起 = 2px 粗线。inkstone 的 Sidebar 也没有边框
                    // （`bg-[var(--bg-sunken)]` 而已），线只由 Resizer 负责。
                    // 真机量过：nav|list 边界只剩 1 条 1px 线。
                    // borderRight: "1px solid var(--card-border)",
                    // ⚠️ 这一列**自己不再滚**：改成「上半可滚 + 底部固定」。
                    // 之前整列 overflowY:auto，归档/回收站/账号被文件夹挤到视野外。
                    overflow: "hidden",
                    py: 1,
                    // 三栏背景分层（inkstone）：导航站最沉（--bg-sunken）
                    bgcolor: "var(--bg-sunken)",
                }}
            >
            {navInner}
            </Box>
            )}
            {/* 导航列 ↔ 列表列之间的可拖缝。
                ⚠️⚠️ 它必须在导航列这个 Box **外面**：里面是 flex-direction: column，
                放进去会被压成 0 高度、贴到 x=0，真实鼠标根本点不中 ——
                而页内 dispatchEvent 合成事件是直接派发给元素的、不做命中测试，
                所以单测和合成事件探针都会「通过」，真机却拖不动（2026-10-06 踩过）。
                ⚠️ 选中文件夹时中间栏整个不渲染，但这条缝**仍要保留** ——
                否则关闭列表后导航列就再也拖不宽了（2026-10-08 用户报）。
                只有「导航列本身不显示」时才收：tablet 起整列 display:none、收起态只剩 44px 轨道。
                ⚠️ tablet 起导航列整列 display:none，这条缝也要一起收 ——
                否则左边凭空多出一条 9px 命中区，视觉上像「还有第三栏」。 */}
            {!listCollapsed && !narrowLayout && (
                <ColResizeHandle
                    label='拖动调整导航列宽度'
                    onDrag={startDrag('nav')}
                    onReset={reset('nav')}
                />
            )}

            {/* ================= 第二列：笔记列表 =================
                ⚠️ 选中文件夹时**整列不渲染**（inkstone 的文件夹树）：
                笔记已经直接列在左栏那个文件夹下面了，中间再来一栏是同一批内容，
                白占 200 多 px，还会让人以为是两份不同的笔记。
                ⚠️ mobile（<768）例外：**永远渲染**这一列。关中栏/聚焦文件夹都是
                桌面/平板态，mobile 没有导航抽屉可回，列表列是唯一入口 ——
                就算带着残留状态缩到 mobile，也不能藏成空白带。 */}
            {(!listHidden || bp === "mobile") && (
            <>
            <Box
                data-list-col='1'
                sx={{
                    width: listW,
                    // ⚠️ 不能留 `flex: 1`：那会让浏览器按容器剩余空间重新分配，
                    // 实测「设定 208 → 量出来 221」，于是拖完存进 localStorage 的值
                    // 和真正渲染出来的宽度差 13px，刷新后列宽会莫名其妙跳一下。
                    // 宽度既然由用户拖定了，就让它**设定即所得**。
                    flexShrink: 0,
                    minWidth: 0,
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    // ⚠️ 2026-10-07：原来这里是 py:1（上下各 8px）。顶栏拆掉后
                    // 「直达页顶」就靠这一栏 —— 留着上内边距的话，中栏头部会比
                    // 导航列低一截，看着还是像被什么压着。留 pb 就行。
                    pb: 1,
                    // 三栏背景分层（inkstone）：中栏是 --bg-base，夹在
                    // 导航站的 --bg-sunken 与编辑区的 --bg-editor 之间。
                    bgcolor: "var(--bg-base)",
                }}
            >
            {/* ⚠️ 搜索框只在 mobile 挂在列表列头部；tablet 的搜索搬到了顶部
                44px 栏（见 data-tablet-bar，与 inkstone 的顶栏同位）。两个位置
                互斥挂载，共用 searchRefNarrow 不会打架。 */}
            {bp === "mobile" && (
                <Box sx={{ px: 1.5, pt: 1, pb: 0.5, flexShrink: 0 }}>
                    {renderSearchField(searchRefNarrow)}
                </Box>
            )}
            {/* 中栏头部（inkstone：视图名 + 右上角 排序 / 新建 / 收起）。
                回收站视图不給这三个按钮（那里没有「新建」语义，排序无意义）。 */}
            {view !== "trash" && (
                <Box
                    data-list-header='1'
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.25,
                        px: 1.5,
                        pt: 1,
                        pb: 0.5,
                        flexShrink: 0,
                    }}
                >
                    <Typography
                        variant='body2'
                        sx={{ flex: 1, fontWeight: 600, fontSize: 13.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                        {view === "search"
                            ? "全文搜索"
                            : view === "all"
                              ? "所有笔记"
                              : view === "recent"
                                ? "最近"
                                : view === "starred"
                                  ? "收藏"
                                  : view === "uncategorized"
                                    ? "未归类"
                                    : "归档"}
                    </Typography>                    {/* 多选（2026-10-09，inkstone 的批量条）：开了才在每行显示勾选框，
                        底部出现批量条。平时不显示 —— 128px 的窄列表里常驻一列勾选框
                        会把标题挤没，而批量操作（归档 / 删除一批）本来就是低频动作。 */}
                    <Tooltip title={multiSelect ? "退出多选" : "多选"}>
                        <IconButton
                            size='small'
                            aria-label={multiSelect ? "退出多选" : "多选"}
                            data-tool='multiselect'
                            onClick={() => {
                                setMultiSelect(v => !v);
                                setChecked(new Set());
                            }}
                            sx={{
                                p: 0.4,
                                color: multiSelect ? "var(--accent)" : "text.secondary",
                            }}
                        >
                            {multiSelect ? (
                                <CheckBoxIcon fontSize='inherit' />
                            ) : (
                                <CheckBoxOutlineBlankIcon fontSize='inherit' />
                            )}
                        </IconButton>
                    </Tooltip>
                    <Tooltip title='排序'>
                        <IconButton
                            size='small'
                            aria-label='排序'
                            data-tool='sort'
                            onClick={e => setSortAnchor(e.currentTarget)}
                            sx={{ p: 0.4 }}
                        >
                            <SortIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title='新建笔记'>
                        <IconButton
                            size='small'
                            aria-label='新建笔记'
                            data-tool='list-new-note'
                            // B3：先开模板选择（空白 / 日报 / 会议 / 读书），
                            // 选中文件夹作为落点。「不选模板直接建」的快捷通道
                            // 在右键菜单「在此新建笔记」与命令面板里。
                            onClick={e => openTemplatePicker(e.currentTarget, activeFolder)}
                            sx={{ p: 0.4 }}
                        >
                            <NoteAddIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title='收起列表'>
                        <IconButton
                            size='small'
                            aria-label='收起列表'
                            data-tool='collapse-list'
                            // mobile 不给这个入口：mobile 没有导航抽屉可回，
                            // 关掉列表列 = 屏幕上没有任何导航入口（inkstone 同）。
                            // tablet 关掉后左区让位给编辑区，导航走顶部 44px 栏的
                            // 「导航栏」按钮手动开（2026-10-09 用户明确：不要自动弹抽屉）。
                            onClick={() => setMiddleHidden(true)}
                            sx={{ p: 0.4, ...(bp === "mobile" ? { display: "none" } : {}) }}
                        >
                            <CloseIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                    {/* 返回箭头贴页面右上角（2026-10-09 用户明确）：mobile 列表屏的
                        退出入口挂在中栏头部行最右（tablet 在顶部 44px 栏最右）。 */}
                    {bp === "mobile" && (
                        <Tooltip title='返回导航站'>
                            <IconButton
                                size='small'
                                aria-label='返回导航站'
                                data-tool='back-out'
                                onClick={onClose}
                                sx={{ p: 0.4 }}
                            >
                                {/* ⚠️ 箭头**朝左**（2026-10-09 用户明确）：这里是「返回导航站」，
                                    ArrowBackIcon 本身就是朝左的，不要再 scaleX(-1) 翻成朝右。 */}
                                <ArrowBackIcon fontSize='inherit' />
                            </IconButton>
                        </Tooltip>
                    )}
                </Box>
            )}

            {notes.length > 0 && (                <Typography
                    variant='caption'
                    color='text.secondary'
                    sx={{ px: 2, pb: 0.75 }}
                >
                    {view === "search" && keyword.trim()
                        ? `搜到 ${filtered.length} 条`
                        : `共 ${filtered.length} 条`}
                    {pinnedCount > 0 ? `，${pinnedCount} 条置顶` : ""}
                </Typography>
            )}

            <Box
                data-note-list='1'
                sx={{
                    flex: 1,
                    overflowY: "auto",
                    minHeight: 0,
                    pb: 1,
                    // ⚠️ P1-5：切视图 / 切文件夹时整列淡入（inkstone 同款）。
                    // 注意 inkstone 是把动画挂在**列表容器**上（NoteList.tsx:310
                    // `anim-view-content`），不是每一行 —— 逐行动画会让长列表像在逐个蹦。
                    // key 用 view + 文件夹 + 标签，跟 inkstone 的
                    // `key={`${view}:${folderId ?? ''}:${tag ?? ''}`}` 一致。
                    animation: "noteListFadeIn 220ms cubic-bezier(0.2, 0, 0, 1) both",
                }}
                key={`${view}:${activeFolder ?? ''}:${activeTag ?? ''}`}
            >
                {view === "trash" ? (
                    // 阶段三：回收站。条目不能点开编辑（它已经不在 notes 表里了），
                    // 只给「还原」和「彻底删除」两个动作。
                    <NotesTrashPane
                        trashedNotes={trashedNotes}
                        onRestoreTrashed={onRestoreTrashed}
                        onPurgeTrashed={onPurgeTrashed}
                        onEmptyTrash={onEmptyTrash}
                    />
                ) : filtered.length === 0 ? (
                    // 空状态：照 inkstone 的 8 种场景各给一句文案 + 一张手绘插画。
                    // ⚠️ 之前只有一句「还没有笔记 / 没有匹配的笔记」，
                    // 同一个空白出现在 6 种情况下，用户不知道是「没笔记」还是「筛没了」。
                    <EmptyState
                        art={emptyArt}
                        title={emptyCopy.title}
                        description={emptyCopy.desc}
                        action={
                            // ⚠️ P1-7（2026-10-07）：条件对齐 inkstone（NoteList.tsx:684）
                            //   `view !== 'trash' && view !== 'archived'`
                            // 之前只有 `all` / `search` 两个视图给按钮，于是
                            // 「最近」「收藏」「未归类」「某个文件夹」空的时候
                            // 只有一句说明、没有下一步入口 —— 而这几种视图里
                            // 「新建一条」完全合理（甚至更该给）。
                            //
                            // ⚠️ `view !== "trash"` 这个判断在**这个分支里是恒真的**：
                            // 回收站在进列表之前就被 `view === "trash"` 提前短路了
                            //（TS2367 会报 "no overlap"，它说得对）。
                            // 所以这里只需排除「归档」—— 归档是唯一还能走到列表
                            // 却不该给「新建」入口的视图（在归档里新建没有语义）。
                            view !== "archived" ? (
                                <Box sx={{ display: "flex", gap: 1, justifyContent: "center", flexWrap: "wrap" }}>
                                {notes.length === 0 && <Button size='small' onClick={() => notesCommands.find(command => command.id === "welcome")?.run()}>
                                    创建欢迎示例笔记
                                </Button>}
                                <Button
                                    size='small'
                                    variant='outlined'
                                    startIcon={<NoteAddIcon fontSize='inherit' />}
                                    data-tool='list-new-note-empty'
                                    onClick={e => openTemplatePicker(e.currentTarget, activeFolder)}
                                >
                                    新建笔记
                                </Button>
                                </Box>
                            ) : undefined
                        }
                    />
                ) : (
                    listGroups.map(group => (
                        <Box key={group.key}>
                            {/* 分组标题：10.5px / 加粗 / 0.06em 字距（inkstone 的
                                `text-[10.5px] font-semibold tracking-[0.06em]`）。
                                中文没有「全大写」，靠字距 + 更淡的颜色区分层次。
                                ⚠️ label 为空 = 按标题排序时的「不分组」，整条不渲染 ——
                                inkstone 那边也是 label 为 null 就不画标题。 */}
                            {group.label && (
                                <Typography
                                    variant='caption'
                                    color='text.disabled'
                                    data-month={group.label}
                                    sx={{
                                        display: "block",
                                        px: 2,
                                        pt: 1.5,
                                        pb: 0.5,
                                        fontSize: 10.5,
                                        fontWeight: 600,
                                        letterSpacing: "0.06em",
                                        borderRadius: "6px",
                                        // ⚠️ P1-4：分组标题加一点 hover 反馈。
                                        // inkstone 的分组标题是纯静态的（NoteList.tsx:312），
                                        // 没有 hover —— 它靠 `motion-note-row` 的入场动画
                                        // 表达「这批是新的」。我们补一个极轻的底色，
                                        // 纯装饰、不改字号（改字号会让整列在 hover 时抖）。
                                        transition: "background-color 120ms ease",
                                        "@media (hover: hover) and (pointer: fine)": {
                                            "&:hover": { bgcolor: "var(--neutral-wash)" },
                                        },
                                    }}
                                >
                                    {group.label}
                                </Typography>
                            )}
                            {/* 组级懒挂载：长列表里视口外的组先不建 React 元素 / DOM。
                                条数低于阈值时 enabled=false，渲染期直接短路成全量渲染。 */}
                            <LazyGroup
                                enabled={lazyListGroups}
                                placeholderHeight={
                                    group.items.length *
                                    (uiSettings.density === "compact" ? 56 : 96)
                                }
                            >
                            {group.items.map(note => {
                        const isActive = note.id === activeId;
                        // ⚠️ 菜单锚点状态必须挂在组件上，**不能**在 map 回调里 useState：
                        // map 是普通回调不是组件，hooks 在里面就是违反规则
                        // （渲染顺序一变，状态就会串到别的行上）。
                        const menuOpen = rowMenu?.noteId === note.id;
                        return (
                            <Box
                                key={note.id}
                                data-note-id={note.id}
                                className='note-dense-row'
                                draggable={note.id !== undefined}
                                onDragStart={e => {
                                    e.dataTransfer.setData("application/navihive-note", String(note.id));
                                    e.dataTransfer.effectAllowed = "move";
                                    setDraggingNoteId(note.id ?? null);
                                }}
                                onDragEnd={() => setDraggingNoteId(null)}
                                role='button'
                                tabIndex={0}
                                // 行内时间戳删掉之后，精确时刻改挂到整行上：
                                // 想要「上周三下午改的」仍然 hover 一下就有。
                                title={formatWhen(note.updated_at || note.created_at)}
                                onClick={e => {
                                    const id = note.id;
                                    if (id === undefined) return;
                                    // ⌘/Ctrl+点 = 切换这一条选中。
                                    // 顺手 **进入多选态**：要 Ctrl 点的人就是想选多条，
                                    // 再让他先去点那个「多选」按钮是多一遍 sneak-preview 的流程。
                                    if (e.metaKey || e.ctrlKey) {
                                        e.preventDefault();
                                        setMultiSelect(true);
                                        toggleChecked(id);
                                        selectAnchorRef.current = id;
                                        return;
                                    }
                                    // Shift+点 = 从锚点一路选到这一条（两端都算）。
                                    // ⚠️ 按**渲染顺序**取、
                                    // e.preventDefault 是为了不让浏览器选中一屏文字。
                                    if (e.shiftKey) {
                                        e.preventDefault();
                                        const anchor = selectAnchorRef.current;
                                        const a = anchor === null ? -1 : visibleIds.indexOf(anchor);
                                        const b = visibleIds.indexOf(id);
                                        setMultiSelect(true);
                                        if (a >= 0 && b >= 0) {
                                            const [lo, hi] = a <= b ? [a, b] : [b, a];
                                            setChecked(new Set(visibleIds.slice(lo, hi + 1)));
                                        } else {
                                            // 没有可用的锚点（刚进页面还没点过行）→ 退化成切这一条
                                            toggleChecked(id);
                                        }
                                        // ⚠️ 锚点**不跟着 Shift 点移动**：连着 Shift 点第三次时，
                                        // 该从最初那条算起，而不是第二次那条（否则范围会越缩越小）。
                                        return;
                                    }
                                    selectAnchorRef.current = id;
                                    if (dirty) void switchTo(id);
                                    else openNote(note);
                                }}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        openNote(note);
                                    }
                                }}
                                onContextMenu={e => {
                                    // 右键行 = 打开完整操作菜单（inkstone 同款交互）
                                    e.preventDefault();
                                    // ⚠️ 开菜单前必须把焦点摘掉（2026-10-07/10-18 两轮
                                    // 「白色圆点」）：焦点停在行或行内「⋯」按钮上时，
                                    // 菜单关掉后 Modal 把焦点还原回来，圆形按钮常显。
                                    // 活动元素可能是行内按钮，行自身 blur 摘不掉它。
                                    (e.currentTarget as HTMLElement).blur();
                                    (document.activeElement as HTMLElement | null)?.blur?.();
                                    if (note.id === undefined) return;
                                    // ⚠️ 锚在鼠标处：锚整行左上角的话菜单跟指针没关系（用户报「固定位置」）
                                    setRowMenu({
                                        noteId: note.id,
                                        el: anchorAtMouse(e.clientX, e.clientY),
                                        source: "list",
                                    });
                                }}
                                onMouseLeave={() => {
                                    // 菜单关闭后的悬停抑制到「离开这一行」为止：
                                    // 离开再进来是新的悬停意图（见 rowActionsSuppressed）
                                    setRowActionsSuppressed(prev => (prev === note.id ? null : prev));
                                }}
                                sx={{
                                    // 列表不在视口里的行跳过渲染（布局仍占位）—— inkstone 的
                                    // NoteList.tsx:497 同款写法。几百条笔记时这是差别最大的一处：
                                    // 每次打字/滚动，浏览器都只需要重算「当前这一屏」的行。
                                    // ⚠️ containIntrinsicSize 必须给：它是「没渲染时先占多高」的
                                    // 估计值。不给的话离屏行按 0 高算，滚动条长度会随滚动跳动。
                                    // 数值照 inkstone 的两档（紧凑 42 / 舒适 72），但我们的行
                                    // 多了标签徽章那一行，所以各放宽到它的合理量级。
                                    contentVisibility: "auto",
                                    containIntrinsicSize:
                                        uiSettings.density === "compact" ? "auto 56px" : "auto 96px",
                                    // ⚠️ P0-2：行内操作按钮改成绝对定位后，行必须是定位上下文
                                    position: "relative",
                                    mx: 0.75,
                                    mb: 0.25,
                                    px: 1.25,
                                    // 右侧给绝对定位的「⋯」预留位置（inkstone 的 pr-11）——
                                    // 不预留的话标题会顶到按钮底下
                                    pr: 5,
                                    py: 0.9,
                                    borderRadius: 1.5,
                                    cursor: "pointer",
                                    // ⚠️ 2026-10-07 去掉 3px 左边框 + 强调色：它在「选中文件夹 →
                                    // 笔记内联在左栏」时被拉成贯穿整屏的青绿色带（真机读像素：
                                    // rgb(20,184,166)，y=0..911 全中，x=599..601）。用户原话
                                    // 「拖动绿线的右边笔记编辑的左边有一竖长条去除他」。
                                    // inkstone 的选中行没有左边框（NoteList.tsx:519-523），
                                    // 靠软底 + 淡描边表达选中 —— 照它改。
                                    border: "1px solid",
                                    borderColor: isActive
                                        ? "color-mix(in srgb, var(--accent) 40%, transparent)"
                                        : "transparent",
                                    bgcolor: isActive
                                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                        : "transparent",
                                    // 拖起来的那一行半透明：告诉用户「手上抓的是这条」
                                    opacity: draggingNoteId === note.id ? 0.45 : 1,
                                    transition: "background-color 120ms ease, opacity 120ms ease, transform var(--dur-base, 220ms) var(--ease-out, ease)",
                                    // 菜单按钮平时藏起来，hover / 键盘聚焦才出 —— 和 inkstone 一致，
                                    // 128px 的窄列里常驻一个按钮会把标题挤没。
                                    // ⚠️ 不能用 :focus-within（2026-10-18 用户再报「右键菜单关掉
                                    // 后留一颗白色圆圈」）：菜单关闭时 MUI Modal 会把焦点**还原**
                                    // 给打开前的元素（之前点过 ⋯ 按钮就是它），还原焦点虽是
                                    // 程序化 focus，:focus-within 一样命中 → ⋯ 常显成一颗圆点。
                                    // 改用 :has(:focus-visible)：程序化还原不匹配（最后一次
                                    // 交互是指针），键盘 Tab 进按钮仍然匹配 —— 两头都对。
                                    // ⚠️ hover 显隐还要看行级抑制（第五报）：菜单关闭时指针
                                    // 仍停在该行，300ms 抑制一过 hover 规则会把「⋯」突然
                                    // 弹出来（右键点多在行右侧 = ⋯ 的位置，用户看着就是
                                    // 「关闭瞬间闪白圈」）。被抑制的行 hover 不显示，
                                    // 直到 onMouseLeave 清除。
                                    "&:hover .note-row-actions": {
                                        opacity: rowActionsSuppressed === note.id ? 0 : 1,
                                    },
                                    "&:has(.note-row-actions:focus-visible) .note-row-actions": {
                                        opacity: 1,
                                    },
                                    "&:hover": { bgcolor: "var(--neutral-wash)" },
                                    // inkstone 的「悬停时整行右移 2px」——
                                    // 一个很小的动作，但让列表「活」起来：指针扫过去时
                                    // 能看出当前落在哪一条上，光靠底色变化是不够的。
                                    // ⚠️ 必须限在 `@media (hover: hover) and (pointer: fine)`：
                                    // 触屏上 sticky hover 会在点完那一瞬间还生效，行会歪一下。
                                    "@media (hover: hover) and (pointer: fine)": {
                                        "&:hover": { transform: "translateX(2px)" },
                                    },
                                }}
                            >
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 0.5,
                                    }}
                                >
                                    {/* 多选态：行首勾选框。⚠️ 点击必须 stopPropagation ——
                                        整行自己是 role='button'，不拦住就顺手把笔记打开了。 */}
                                    {multiSelect && (
                                        <Checkbox
                                            size='small'
                                            slotProps={{
                                                input: {
                                                    "aria-label": `选择「${note.title || "无标题"}」`,
                                                    "data-note-check": String(note.id),
                                                } as never,
                                            }}
                                            checked={note.id !== undefined && checked.has(note.id)}
                                            onClick={e => e.stopPropagation()}
                                            onChange={() => {
                                                if (note.id === undefined) return;
                                                setChecked(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(note.id!)) next.delete(note.id!);
                                                    else next.add(note.id!);
                                                    return next;
                                                });
                                            }}
                                            sx={{ p: 0.25, ml: -0.5, flexShrink: 0 }}
                                        />
                                    )}
                                    {/* ⚠️ 必须先转布尔：pinned 存的是 0/1，
                                        `0 && <Icon/>` 在 JS 里返回 0，React 会把它
                                        当文本渲染出来 —— 列表里就冒出一个孤零零的 "0" */}
                                    {Boolean(note.pinned) && (
                                        <PushPinIcon fontSize='inherit' sx={{ color: "var(--accent)" }} />
                                    )}
                                    {/* 收藏的星标：与置顶分开显示（2026-10-09） */}
                                    {Boolean(note.starred) && (
                                        <StarIcon fontSize='inherit' sx={{ color: "var(--accent)" }} />
                                    )}
                                    <Typography
                                        variant='body2'
                                        // ⚠️ P0-1（2026-10-07）：字号对齐 inkstone 的四档阶梯
                                        // （NoteList.tsx:530/539/544）：
                                        //   标题 13px / 摘要 11.5px / 标签 10.5px
                                        // 我们之前全交给 MUI 的 variant.body2/caption，在
                                        // 128px 窄列里显得偏大 —— 摘要是两行、标签换行，
                                        // 一行笔记能占掉 3~4 行，列表密度明显比 inkstone 稀。
                                        sx={{
                                            fontSize: 13,
                                            lineHeight: 1.375,
                                            // inkstone：选中用 semibold + accent 色，未选中 medium + 主色
                                            fontWeight: isActive ? 600 : 500,
                                            color: isActive ? "var(--accent)" : "var(--text-primary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            flex: 1,
                                            minWidth: 0,
                                        }}
                                    >
                                        <Highlighted
                                            text={note.title || "无标题"}
                                            query={keyword.trim() || undefined}
                                            ranges={highlightRanges.get(note.id ?? -1)}
                                        />
                                    </Typography>
                                    {/* ⚠️ P0-2（2026-10-07）：行尾操作区改**绝对定位**（inkstone 同款）。
                    之前这个「⋯」按钮在标题行的正常流里，hover 时 opacity 0→1 ——
                    按钮「出现」会占位，把标题/摘要/标签**挤窄一点再重排**，
                    于是指针扫过列表时每行都在抖。
                    inkstone 的做法（NoteList.tsx:519 + 555）：
                    行上 `pr-11 md:pr-10` **给按钮预留固定空间**，按钮本身
                    `absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100`。
                    这样标题宽度恒定，只有按钮在淡入。 */}
                                    <IconButton
                                        // 菜单关闭动画期间打 --closing 硬压 opacity
                                        // （CSS !important，见 index.css）—— 防「弹窗
                                        // 消失的瞬间冒出白圈」（2026-10-18 第四报）
                                        className={`note-row-actions${menuClosing ? " note-row-actions--closing" : ""}`}
                                        data-note-menu={note.id}
                                        aria-label={`${note.title || "无标题"} 的操作`}
                                        size='small'
                                        onClick={e => {
                                            // ⚠️ 必须 stopPropagation：这一行自己是 role='button'，
                                            // 不拦住的话点菜单会顺带把笔记打开/切换过去。
                                            e.stopPropagation();
                                            // note.id 是可选类型（新建出来的那一瞬可能还没有），
                                            // 这里窄化一次再用，别让 undefined 混进 state。
                                            const id = note.id;
                                            if (id === undefined) return;
                                            setRowMenu(
                                                menuOpen ? null : { noteId: id, el: e.currentTarget, source: "list" }
                                            );
                                        }}
                                        sx={{
                                            position: "absolute",
                                            top: 6,
                                            right: 4,
                                            opacity: menuOpen ? 1 : 0,
                                            // 关闭时不能淡出：淡出帧本身就是用户看到的闪白圈。
                                            transition: menuClosing || rowActionsSuppressed === note.id ? "none" : "opacity 120ms ease",
                                            visibility: menuClosing || rowActionsSuppressed === note.id ? "hidden" : "visible",
                                            flexShrink: 0,
                                            p: 0.25,
                                            color: "text.secondary",
                                            bgcolor: "var(--bg-base)",
                                            borderRadius: "50%",
                                        }}
                                    >
                                        <MoreVertIcon fontSize='inherit' />
                                    </IconButton>
                                </Box>
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    sx={{
                                        display: "-webkit-box",
                                        WebkitLineClamp: 2,
                                        WebkitBoxOrient: "vertical",
                                        overflow: "hidden",
                                        // ⚠️ P0-1：inkstone 的摘要是 11.5px/1.5（NoteList.tsx:539），
                                        // 我们跟着走 —— 之前用 caption（12px）偏大，两行就顶满一行笔记的高度
                                        fontSize: 11.5,
                                        lineHeight: 1.5,
                                        mt: 0.5,
                                    }}
                                >
                                    {/* 服务端给了命中片段就优先显示它（能看到**命中在哪**），
                                        没有就照旧显示正文开头那一段 */}
                                    {searchSnippets.get(note.id ?? -1) ||
                                        summarize(note.content) ||
                                        "空白笔记"}
                                </Typography>
                                {/* ⚠️ 这里原来有一行「3分钟前 / 昨天」的行内时间戳，
                                    2026-10-07 按 inkstone 删掉了：时间信息已经由
                                    **分组标题**承担（今天 / 昨天 / 本周 / 本月…），
                                    每行再重复一遍就是同一句话说两遍 ——
                                    而且窄列里这行字会把标签徽章挤到第二行。
                                    精确时刻仍然拿得到：整行的 title 上有。 */}
                                {/* 标签小徽章：让「这条笔记打了哪些标签」在列表里直接看得见，
                                    不用点进去看。左栏那个标签视图才有意义也靠它。 */}
                                {tagNamesOf(note, noteTags, tags).length > 0 && (
                                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
                                        {tagNamesOf(note, noteTags, tags).map(name => {
                                            // 设了颜色的标签：文字与描边用本色、底色是它 12% 的薄涂 ——
                                            // 直接填满本色的話，深色标签上的深色文字会看不清。
                                            const c = tagColorByName.get(name.trim());
                                            return (
                                            <Box
                                                key={name}
                                                data-note-tag={name}
                                                data-note-tag-color={c ?? ""}
                                                sx={{
                                                    px: 0.75,
                                                    py: 0.1,
                                                    fontSize: 10.5,
                                                    lineHeight: 1.6,
                                                    borderRadius: 999,
                                                    ...(c
                                                        ? {
                                                              border: "1px solid transparent",
                                                              borderColor: c,
                                                              color: c,
                                                              bgcolor: `color-mix(in srgb, ${c} 12%, transparent)`,
                                                          }
                                                        : {
                                                              border: "1px solid var(--card-border)",
                                                              color: "text.secondary",
                                                              bgcolor: "var(--neutral-wash)",
                                                          }),
                                                }}
                                            >
                                                {name}
                                            </Box>
                                            );
                                        })}
                                    </Box>
                                )}
                            </Box>
                        );
                    })}
                            </LazyGroup>
                        </Box>
                    ))
                )}
            </Box>

            {/* 批量条（2026-10-09，inkstone 的批量操作条）：只在多选态出现，
                逐条走各自的 onToggleArchive / onDelete —— 不新造批量接口，
                省得「批量归档成功一半」这种中间态没人处理。 */}
            {multiSelect && (
                <Box
                    data-bulk-bar='1'
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        px: 1,
                        py: 0.75,
                        flexShrink: 0,
                        // 窄列表里四个按钮排不下会挤成两截 —— 允许换行，别把字压扁
                        flexWrap: "wrap",
                        borderTop: "1px solid var(--neutral-hover)",
                        bgcolor: "var(--neutral-wash)",
                    }}
                >
                    <Typography variant='caption' sx={{ flex: 1, minWidth: 0 }}>
                        已选 {checkedNotes.length} 条
                    </Typography>
                    <Button
                        size='small'
                        variant='text'
                        disabled={checked.size === 0}
                        data-bulk-action='select-all'
                        onClick={() =>
                            setChecked(
                                checkedNotes.length === filtered.length
                                    ? new Set()
                                    : new Set(
                                          filtered
                                              .map(n => n.id)
                                              .filter((id): id is number => id !== undefined)
                                      )
                            )
                        }
                    >
                        {checkedNotes.length === filtered.length && filtered.length > 0
                            ? "全不选"
                            : "全选"}
                    </Button>
                    <Button
                        size='small'
                        variant='text'
                        disabled={checked.size === 0}
                        data-bulk-action='archive'
                        onClick={() => void bulkArchive()}
                    >
                        归档
                    </Button>
                    <Button
                        size='small'
                        variant='text'
                        color='error'
                        disabled={checked.size === 0}
                        data-bulk-action='delete'
                        onClick={() => setBulkDeleteOpen(true)}
                    >
                        删除
                    </Button>
                </Box>
            )}

            </Box>
            {/* 列表列 ↔ 编辑区之间的可拖缝。同样必须在列表列这个 Box **外面** ——
                里面是 flex-direction: column，放进去会塌成 0 高度、真实鼠标点不中。 */}
            <ColResizeHandle
                label='拖动调整笔记列表宽度'
                onDrag={startDrag('list')}
                onReset={reset('list')}
            />
            </>
            )}
            </>
            )}
        </Box>
    );
}
