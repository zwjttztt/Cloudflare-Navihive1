import Box from "@mui/material/Box";
import Avatar from "@mui/material/Avatar";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import LastPageIcon from "@mui/icons-material/LastPage";
import SettingsIcon from "@mui/icons-material/Settings";
import AttachmentIcon from "@mui/icons-material/AttachFile";
import { tagNamesOf, NavRow, FolderTagSection } from "../notes/sidebarSection";
import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesNavPanel(props: Pick<NotesPageCtx, "accountName" | "activeFolder" | "activeId" | "activeTag" | "askName" | "attManagerOpen" | "folderCounts" | "folderTags" | "folders" | "jumpToNote" | "keyword" | "listCollapsed" | "narrowLayout" | "noteTags" | "notes" | "notesInFolder" | "onClose" | "onCreate" | "onUpdate" | "renderSearchField" | "searchRef" | "setActiveFolder" | "setActiveTag" | "setAppearanceFolderId" | "setAttManagerOpen" | "setListCollapsed" | "setMiddleHidden" | "setNavDrawerOpen" | "setRemoveTarget" | "setRowMenu" | "setSettingsOpen" | "setTagColorId" | "setView" | "startCreateInFolder" | "tagCounts" | "tags" | "uploadApi" | "view" | "viewCounts">) {
    const { accountName, activeFolder, activeId, activeTag, askName, attManagerOpen, folderCounts, folderTags, folders, jumpToNote, keyword, listCollapsed, narrowLayout, noteTags, notes, notesInFolder, onClose, onUpdate, renderSearchField, searchRef, setActiveFolder, setActiveTag, setAppearanceFolderId, setAttManagerOpen, setListCollapsed, setMiddleHidden, setNavDrawerOpen, setRemoveTarget, setRowMenu, setSettingsOpen, setTagColorId, setView, startCreateInFolder, tagCounts, tags, uploadApi, view, viewCounts } = props;
    return (
            <>
            {/* 迷你顶栏（2026-10-10 调整）：返回箭头贴左（箭头朝左），「记事本」居中，
                「收起笔记列表」占返回箭头原来的位置（右上角）。收起 / 展开从左下角
                挪上来 —— 低频但它本来就是控制这一列的，放列顶比挤在账号行里更直白。 */}
            <Box
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    px: 1,
                    pt: 0.25,
                    pb: 0.75,
                    flexShrink: 0,
                }}
            >
                {/* 返回箭头（2026-10-10 用户明确）：贴左侧栏最左边、箭头**朝左**（回导航站的方向）；
                    窄屏（tablet/mobile）的返回箭头仍贴**整页右上角**（顶部 44px 栏最右端），
                    不落在抽屉里。占位 Box 让标题在两种布局下都居中。 */}
                {!narrowLayout ? (
                    <IconButton
                        aria-label='返回导航站'
                        onClick={onClose}
                        size='small'
                        sx={{ flexShrink: 0, ml: -0.5 }}
                    >
                        <ArrowBackIcon fontSize='small' />
                    </IconButton>
                ) : (
                    <Box aria-hidden='true' sx={{ width: 30, flexShrink: 0 }} />
                )}
                <Typography
                    variant='subtitle2'
                    component='div'
                    sx={{ fontWeight: 600, flex: 1, textAlign: "center", fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                    记事本
                </Typography>
                {/* 收起 / 展开整个左栏：从左下角（账号行）挪到顶栏右侧 —— 返回箭头原来的位置。
                    只在桌面导航列显示；tablet 抽屉里没有「收起」概念（整个抽屉关掉就是收起）。 */}
                {!narrowLayout && (
                    <Tooltip title={listCollapsed ? "展开笔记列表" : "收起笔记列表"}>
                        <IconButton
                            size='small'
                            aria-label={listCollapsed ? "展开笔记列表" : "收起笔记列表"}
                            data-tool='collapse-pane'
                            onClick={() => setListCollapsed(c => !c)}
                            sx={{ flexShrink: 0, mr: -0.5 }}
                        >
                            {listCollapsed ? (
                                <LastPageIcon fontSize='inherit' />
                            ) : (
                                <FirstPageIcon fontSize='inherit' />
                            )}
                        </IconButton>
                    </Tooltip>
                )}
            </Box>
            {/* 可滚动的上半：搜索框 + 视图导航 + 文件夹 + 标签 */}
            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
            {/* 搜索框：桌面导航列与 tablet 导航抽屉共用这一份 navInner（两者互斥挂载，
                searchRef 不会打架）；mobile 的搜索在列表列头部（searchRefNarrow）。 */}
            <Box sx={{ px: 1.5, pb: 1 }}>
                {renderSearchField(searchRef)}
            </Box>

            {/* 左栏视图导航：inkstone 那种纵向条目 —— 一个入口一行、名字靠左、
                条数靠右一行。
                ⚠️ 「搜索」不再占一行（2026-10-06 去掉）：上面那个搜索框本身就是
                全文搜索的入口（聚焦即打开全文搜索中栏），重复的两行只会让人
                分不清哪个管哪个。
                ⚠️ 归档 / 回收站也不在这一组里：它们是低频入口，压在导航列表中间
                会把「全部 / 最近 / 收藏」这些高频的挤开。挪到左下角单独一组
                （与 inkstone 一致），见本列底部。 */}
            <Stack sx={{ px: 0.75, gap: 0.25, pb: 1 }}>
                {(
                    [
                        ["all", "全部", viewCounts.all],
                        ["recent", "最近", viewCounts.recent],
                        ["starred", "收藏", viewCounts.starred],
                        ["uncategorized", "未归类", viewCounts.uncategorized],
                    ] as const
                ).map(([key, label, count]) => (
                    <NavRow
                        key={key}
                        label={label}
                        count={count}
                        selected={view === key}
                        onClick={() => {
                            setView(key);
                            setActiveFolder(null);
                            setActiveTag(null);
                            setMiddleHidden(false);
                            setNavDrawerOpen(false);
                        }}
                        data-view={key}
                    />
                ))}
            </Stack>

            {/* 文件夹 / 标签两节：阶段三收尾，左栏第一列现在真正成了「导航列」 */}
            <FolderTagSection
                title='文件夹'
                items={folders.map(f => ({
                    id: f.id!,
                    name: f.name || "未命名",
                    parent_id: f.parent_id,
                    count: folderCounts.get(f.id!) ?? 0,
                    icon: f.icon,
                    color: f.color,
                    // 同级排序位：菜单的「向前/向后移动」按它算能不能移、移几位
                    order_num: f.order_num,
                }))}
                selectedId={activeFolder}
                onSelect={id => {
                    setActiveFolder(id);
                    setActiveTag(null);
                    setNavDrawerOpen(false);
                    // ⚠️ 点文件夹 = 进入该文件夹的视图（2026-10-18 用户报
                    // 「标题名为 123 的笔记属于 123 文件夹但不在 123 文件夹下方」）：
                    // 原来非 null 时不切 view，「全部 3」行还高亮着，中栏却只剩
                    // 该文件夹的一条 —— 视觉上像没切过去。清空（点「全部」同义）才回 all。
                    setView(id === null ? "all" : "folder");
                    // ⚠️ 不 setMiddleHidden(false)：用户明示「中间栏不需要出现」——
                    // 点文件夹不该把用户收起的列表又放出来。中栏显示与否交给用户
                    // 自己的「收起列表」控制；显示着时就显示该文件夹的笔记。
                }}
                onCreate={() => askName("folder")}
                onCreateChild={id => askName("folder", { parentId: id })}
                onMove={folderTags?.onMoveFolder ? (id, parent) => void folderTags.onMoveFolder?.(id, parent) : undefined}
                onDropNote={(id, folder) => void onUpdate(id, { folder_id: folder })}
                onAskRename={(id, currentName) =>
                    askName("folder", {
                        renameId: id,
                        defaultValue: currentName,
                        title: "重命名文件夹",
                        description: "改完立刻生效，笔记的归类不受影响。",
                    })
                }
                onAskRemove={(id, name) => setRemoveTarget({ kind: "folder", id, name })}
                onCreateNote={() => void startCreateInFolder(activeFolder)}
                childrenOf={notesInFolder}
                activeNoteId={activeId}
                onOpenNote={id => { setNavDrawerOpen(false); void jumpToNote(id); }}
                onCreateNoteIn={id => void startCreateInFolder(id)}
                onReorder={
                    folderTags?.onReorderFolder
                        ? (id, dir) => void folderTags.onReorderFolder?.(id, dir)
                        : undefined
                }
                onAppearance={
                    folderTags?.onStyleFolder
                        ? id => setAppearanceFolderId(id)
                        : undefined
                }
                // 未归入任何文件夹的笔记直接列在文件夹树下（inkstone 布局）
                unfiledNotes={
                    notes
                        .filter(n => !n.archived && (n.folder_id === null || n.folder_id === undefined))
                        // ⚠️ 搜索时这一组也要跟着筛（2026-10-06）：左栏留着没命中的
                        // 笔记、中栏却只剩命中的，用户会以为「搜索坏了」。
                        // 判据与 searchHits 一致：标题 / 正文 / 标签名任一命中。
                        .filter(n => {
                            const kw = keyword.trim().toLowerCase();
                            if (!kw) return true;
                            if ((n.title || "").toLowerCase().includes(kw)) return true;
                            if ((n.content || "").toLowerCase().includes(kw)) return true;
                            return tagNamesOf(n, noteTags, tags).some(t =>
                                t.toLowerCase().includes(kw)
                            );
                        })
                        .sort((a, b) =>
                            String(b.updated_at || b.created_at || "").localeCompare(
                                String(a.updated_at || a.created_at || "")
                            )
                        )
                        .map(n => ({ id: n.id!, title: n.title || "" }))
                }
                onNoteContext={(noteId, el) => setRowMenu({ noteId, el, source: "rail" })}
            />
                {/* ---------- 标签 ----------
                    `color` 从库里直接带来（note_tag.color 早就有这一列，上一轮之前界面没用它）；
                    有色就画圆点，列表里那条笔记的标签片也跟着上同一个颜色。 */}
                <FolderTagSection
                    title='标签'
                    items={tags.map(t => ({
                        id: t.id!,
                        name: t.name || "未命名",
                        count: tagCounts.get(t.id!) ?? 0,
                        color: t.color,
                    }))}
                selectedId={activeTag}
                onSelect={id => {
                    setActiveTag(id);
                    setActiveFolder(null);
                    setMiddleHidden(false);
                    setNavDrawerOpen(false);
                    if (id === null) setView("all");
                }}
                onCreate={() => askName("tag")}
                onAskRename={(id, currentName) =>
                    askName("tag", {
                        renameId: id,
                        defaultValue: currentName,
                        title: "重命名标签",
                        description: "已经打上这个标签的笔记会跟着改名，不用重新分类。",
                    })
                }
                onAskRemove={(id, name) => setRemoveTarget({ kind: "tag", id, name })}
                // 这个组件被文件夹 / 标签两节共用，删除项的文案按节区分 ——
                // 2026-10-17 用户报「标签右键菜单里写着删除文件夹」
                removeLabel='删除标签'
                onAskColor={
                    typeof folderTags?.onStyleTag === "function"
                        ? id => setTagColorId(id)
                        : undefined
                }
            />
            </Box>

            {/* ---------- 左下角：归档 / 回收站 / 账号 / 设置（inkstone 布局） ----------
                固定在底部不跟着滚：这几个都是「平时不动、出事才找」的低频入口，
                之前混在导航列表中间，文件夹一多就被顶出视野了。 */}
            <Box
                data-nav-footer='1'
                sx={{
                    flexShrink: 0,
                    borderTop: "1px solid rgba(128,128,128,0.18)",
                    pt: 0.5,
                    pb: 0.5,
                    position: "sticky",
                    bottom: 0,
                    // ⚠️ 同上：这块以前写死 background.paper，于是「背景色」设置
                    // （暖白 / 纯白）对它无效 —— 用户报「左下角归档和用户名那一块
                    // 的颜色不会变」。透明即可跟随页面根背景。
                    bgcolor: "transparent",
                }}
            >
                <Stack sx={{ px: 0.75, gap: 0.25 }}>
                    {/* 附件管理（2026-10-19 取代原来的「待办」行）：点开右侧抽屉，
                        列表 / 预览 / 重命名 / 删除 / 清理全在里面。
                        ⚠️ 门控要和管理器本体一致（list + delete 都得有）：
                        只按 listAttachments 判断的话，老部署上会出现一个入口，
                        点开却因为删除能力缺失而整个抽屉挂掉。
                        ⚠️ 这里刻意**不给 data-view**：它不是视图，选中态也就没有意义
                        （原来那行待办也不是视图，但挂了 data-view="todo"，
                        导致 `button[data-view]` 的视图清单里混进一个非视图）。 */}
                    {uploadApi?.listAttachments && uploadApi?.deleteAttachment && (
                        <NavRow
                            label="附件"
                            count={0}
                            icon={<AttachmentIcon sx={{ fontSize: 15 }} />}
                            selected={attManagerOpen}
                            onClick={() => {
                                setAttManagerOpen(true);
                                setNavDrawerOpen(false);
                            }}
                            data-nav-attachments='1'
                            title='管理附件（预览 / 重命名 / 删除 / 清理未引用）'
                        />
                    )}                    {(
                        [
                            ["archived", "归档", viewCounts.archived],
                            ["trash", "回收站", viewCounts.trash],
                        ] as const
                    ).map(([key, label, count]) => (
                        <NavRow
                            key={key}
                            label={label}
                            count={count}
                            selected={view === key}
                            onClick={() => {
                                setView(key);
                                setActiveFolder(null);
                                setActiveTag(null);
                                // ⚠️ 这两个入口也要把中栏放出来：用户刚点过「收起列表」，
                                // 再点归档 / 回收站会只剩导航列 —— 屏幕上什么都没有，
                                // 看着就像这两个入口坏了（顶部四个入口已经处理过）。
                                setMiddleHidden(false);
                                setNavDrawerOpen(false);
                            }}
                            data-view={key}
                        />
                    ))}
                </Stack>
                {/* 账号 + 设置：inkstone 左下角那一行。没传账号名就显示「未登录」，
                    点设置没回调就不给按钮（老部署/未登录都不该是死按钮）。 */}
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        px: 0.75,
                        pt: 0.5,
                        mt: 0.25,
                        borderTop: "1px solid rgba(128,128,128,0.12)",
                    }}
                >
                    <Avatar
                        data-nav-account='1'
                        alt={accountName || "未登录"}
                        sx={{ width: 22, height: 22, fontSize: 11, bgcolor: "var(--accent)" }}
                    >
                        {(accountName || "?").slice(0, 1).toUpperCase()}
                    </Avatar>
                    <Typography
                        variant='body2'
                        data-account-name='1'
                        sx={{
                            flex: 1,
                            minWidth: 0,
                            fontSize: 12,
                            color: "text.secondary",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {accountName || "未登录"}
                    </Typography>
                    {/* 设置：打开记事本自己的设置（外观 / 编辑器），不再复用导航站配置。
                        「收起笔记列表」2026-10-10 挪到顶栏右侧（原返回箭头的位置）。 */}
                    <Tooltip title='设置'>
                        <IconButton
                            size='small'
                            aria-label='设置'
                            data-tool='settings'
                            onClick={() => setSettingsOpen(true)}
                            sx={{ p: 0.25 }}
                        >
                            <SettingsIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                </Box>
            </Box>
            </>
    );
}
