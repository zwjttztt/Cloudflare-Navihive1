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
// 视图行的前置图标（2026-10-27，参考 inkstone 左栏）：纯文字的行堆在一起，
// 眼睛没有落脚点，四种视图看起来像四行一样的东西。图标给了每行一个身份。
import DescriptionIcon from "@mui/icons-material/Description";
import HistoryIcon from "@mui/icons-material/History";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import InboxIcon from "@mui/icons-material/Inbox";
import { tagNamesOf, NavRow, FolderTagSection } from "../notes/sidebarSection";
import { NOTES_NAV_CTRL_H } from "../../constants";
import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesNavPanel(props: Pick<NotesPageCtx, "accountName" | "activeFolder" | "activeId" | "activeTag" | "askName" | "attManagerOpen" | "folderCounts" | "folderTags" | "folders" | "jumpToNote" | "keyword" | "listCollapsed" | "narrowLayout" | "noteTags" | "notes" | "notesInFolder" | "onClose" | "onCreate" | "onUpdate" | "openTemplatePicker" | "renderSearchField" | "searchRef" | "setActiveFolder" | "setActiveTag" | "setAppearanceFolderId" | "setAttManagerOpen" | "setListCollapsed" | "setMiddleHidden" | "setNavDrawerOpen" | "setRemoveTarget" | "setRowMenu" | "setSettingsOpen" | "setTagColorId" | "setView" | "startCreateInFolder" | "tagCounts" | "tags" | "uploadApi" | "view" | "viewCounts">) {
    const { accountName, activeFolder, activeId, activeTag, askName, attManagerOpen, folderCounts, folderTags, folders, jumpToNote, keyword, listCollapsed, narrowLayout, noteTags, notes, notesInFolder, onClose, onUpdate, openTemplatePicker, renderSearchField, searchRef, setActiveFolder, setActiveTag, setAppearanceFolderId, setAttManagerOpen, setListCollapsed, setMiddleHidden, setNavDrawerOpen, setRemoveTarget, setRowMenu, setSettingsOpen, setTagColorId, setView, startCreateInFolder, tagCounts, tags, uploadApi, view, viewCounts } = props;
    return (
            <>
            {/* 头部（2026-10-26 统一高度）：**两行都在头部里，高度由变量定死** ——
                上行 = 返回站 / 「记事本」/ 收起列表（36px 玻璃控件那一行），
                下行 = 搜索框（同一个 36px 规格）。
                为什么不再「标题行 + 搜索框自然堆叠」：那样这一栏的头部高度是**内容算出来的**，
                中栏（pt8 + 标题 + pb4 + 描边 ≈45）和编辑区（常量 44）各算各的，
                三栏第一行内容就错开（实测 y = 66 / 60 / 53）。
                搜索框顺手从滚动区挪进来：它是「随时都要用」的，本来就不该被文件夹推走。 */}
            {/* 上行（2026-10-10 调整）：返回箭头贴左（箭头朝左），标题靠左，收起列表在右。
                ⚠️ 高度就是一个玻璃控件（NOTES_NAV_CTRL_H=30），不再带上下内边距 ——
                这一行 + 下面那行搜索框正好拼成 --notes-header-h，多一个 px 都会顶高。
                ⚠️ 2026-10-27：试过把「返回 + 搜索 + 收起」并成一行、真省 30px，
                在左栏默认 128px（NAV_COL_W，可拖到 104~260）下**搜索框只剩 66px**，
                占位符挤成两个字 —— 这一列是可调宽的，不能按宽栏假设排版，方案退回两行。
                真正治「拥挤」的是下面几条：去白底、标题靠左变轻、三条左边界统一到 8px。 */}
            <Box
                data-nav-header='1'
                sx={{
                    height: "var(--notes-header-h)",
                    boxSizing: "border-box",
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                }}
            >
            <Box
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.75,
                    px: 1,
                    height: NOTES_NAV_CTRL_H,
                    flexShrink: 0,
                    // 标题行与下方搜索框之间加一道分隔线：两行实体控件叠在 60px 头部里，
                    // 没有分隔会糊成一块（用户报「标题行 + 搜索框挤在一起」）。
                    // border-box 让 1px 落在 30px 行内，不顶高头部、不破坏三栏对齐。
                    boxSizing: "border-box",
                    // 用 --neutral-border（30% 灰）而不是 --neutral-hairline（18%）：
                    // 左栏是浅底，18% 灰线几乎看不见；30% 灰亮/暗两套主题里都读得出。
                    borderBottom: "1px solid var(--neutral-border)",
                }}
            >
                {/* 返回导航站（2026-10-27 去底）：原来是个 30px 玻璃方块 + --header-radius，
                    是这一列最重的一块白 —— 和右边的白搜索胶囊、下面的粉色选中行三块实色
                    堆在 90px 里，正是用户说的「太拥挤」。现在缩成 24px 行内图标按钮
                    （hover 才出淡底），左边界与搜索框、导航行统一在 8px。 */}
                {!narrowLayout && (
                    <IconButton
                        aria-label='返回导航站'
                        onClick={onClose}
                        sx={{
                            flexShrink: 0,
                            width: 24,
                            height: 24,
                            p: 0,
                            color: "text.secondary",
                            "&:hover": { bgcolor: "var(--neutral-hover)", color: "text.primary" },
                        }}
                    >
                        <ArrowBackIcon fontSize='small' />
                    </IconButton>
                )}
                {/* 标题（2026-10-27）：不再 14px 加粗**居中** —— 居中会让它和上下两条
                    左边界都对不齐，越看越乱。改成紧贴返回箭头、主色 14px/500 的
                    「品牌行」写法（inkstone 左栏第一行就是 app 名，不居中）。 */}
                <Typography
                    variant='subtitle2'
                    component='div'
                    sx={{ fontWeight: 500, flex: 1, textAlign: "left", fontSize: 14, color: "text.primary", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
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
            {/* 搜索框：桌面导航列与 tablet 导航抽屉共用这一份 navInner（两者互斥挂载，
                searchRef 不会打架）；mobile 的搜索在列表列头部（searchRefNarrow）。
                ⚠️ 2026-10-26：这段在**头部容器里面**（上面那个 data-nav-header），
                flex:1 + minHeight:0 让它吃满头部剩下的高度并垂直居中 ——
                靠自然堆叠会把头部撑高，那就白统一了。
                ⚠️ 2026-10-27：左右内边距 12→8，与上面标题行、下面导航行统一左边界。 */}
            {/* --notes-search-h：让这里的搜索框吃 30px（比顶栏小一档，用户反馈「白框太大」）；
                其它位置（tablet 顶栏 / mobile 列表）不设这个变量、回落到 36。
                ⚠️ 下面这行调用的**文本别改**（tests/notes.dom.test.tsx 用它的字面量
                和「3 处调用」的计数当守卫）—— 要调尺寸就改这个变量，别给调用加参数。 */}
            <Box
                sx={{
                    flex: 1,
                    minHeight: 0,
                    display: "flex",
                    alignItems: "center",
                    px: 1,
                    "--notes-search-h": `${NOTES_NAV_CTRL_H}px`,
                }}
            >
                {renderSearchField(searchRef)}
            </Box>
            </Box>
            {/* 可滚动的上半：视图导航 + 文件夹 + 标签 */}
            <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>

            {/* 左栏视图导航：inkstone 那种纵向条目 —— 一个入口一行、名字靠左、
                条数靠右一行。
                ⚠️ 「搜索」不再占一行（2026-10-06 去掉）：上面那个搜索框本身就是
                全文搜索的入口（聚焦即打开全文搜索中栏），重复的两行只会让人
                分不清哪个管哪个。
                ⚠️ 归档 / 回收站也不在这一组里：它们是低频入口，压在导航列表中间
                会把「全部 / 最近 / 收藏」这些高频的挤开。挪到左下角单独一组
                （与 inkstone 一致），见本列底部。 */}
            {/* 左边界统一到 8px（2026-10-27）：头部控件组、搜索框、这几行视图
                原来分别是 6 / 12 / 8，三条竖线对不齐 —— 视觉上的「乱」有一半来自这里。
                现在三者都是 px:1。 */}
            <Stack sx={{ px: 1, gap: 0.25, pb: 1 }}>
                {(
                    [
                        ["all", "全部", viewCounts.all, <DescriptionIcon key='i' sx={{ fontSize: 15 }} />],
                        ["recent", "最近", viewCounts.recent, <HistoryIcon key='i' sx={{ fontSize: 15 }} />],
                        ["starred", "收藏", viewCounts.starred, <StarBorderIcon key='i' sx={{ fontSize: 15 }} />],
                        ["uncategorized", "未归类", viewCounts.uncategorized, <InboxIcon key='i' sx={{ fontSize: 15 }} />],
                    ] as const
                ).map(([key, label, count, icon]) => (
                    <NavRow
                        key={key}
                        label={label}
                        count={count}
                        icon={icon}
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
                // B3：左栏这颗也走模板选择（anchor 由 sidebarSection 传进来）
                onCreateNote={anchor => openTemplatePicker(anchor, activeFolder)}
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
                    borderTop: "1px solid var(--neutral-hairline)",
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
                        borderTop: "1px solid var(--neutral-hover)",
                    }}
                >
                    <Avatar
                        data-nav-account='1'
                        alt={accountName || "未登录"}
                        // 文字色必须走 --on-accent：这是「强调色**底上**的字」专用 token，
                        // 亮色是白、暗色是深（因为 --notes-accent 暗色档是浅红）。
                        // 不写就会落到 MUI 默认的 background.default —— 暗色下那个是深色，
                        // 压在浅红底上只有 3.31:1（2026-10-24 对比度审计抓到的）。
                        sx={{ width: 22, height: 22, fontSize: 11, bgcolor: "var(--accent)", color: "var(--on-accent)" }}
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
                            sx={{ p: 0.375 }}
                        >
                            <SettingsIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                </Box>
            </Box>
            </>
    );
}
