// src/components/notes/NotesOverlayLayer.tsx
// 设置弹窗 / 各类右键菜单 / 移动抽屉 / 分组外观 / 标签颜色。
//
// 从 NotesPage.tsx 主 return 里整段搬过来，JSX 与表达式逐字未改。
// 这些浮层（Dialog / Menu / Drawer）都是 MUI 的 portal，挂在哪一层 DOM 上不影响
// 视觉层级，所以搬出去**不改变任何可见行为** —— 只是让主文件不再是「一屏装不下」。
import Divider from "@mui/material/Divider";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import FolderIcon from "@mui/icons-material/Folder";
import ArchiveIcon from "@mui/icons-material/Archive";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";

import LinkIcon from "@mui/icons-material/Link";
import HistoryIcon from "@mui/icons-material/History";
import ShareIcon from "@mui/icons-material/Share";
import BoltIcon from "@mui/icons-material/Bolt";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import StarIcon from "@mui/icons-material/Star";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import SearchIcon from "@mui/icons-material/Search";
import HubIcon from "@mui/icons-material/Hub";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaletteIcon from "@mui/icons-material/Palette";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FolderAppearanceDialog from "../FolderAppearanceDialog";
import TagColorDialog from "../TagColorDialog";
import MoveFolderDrawer from "../MoveFolderDrawer";
import NotesSettingsDialog from "../NotesSettingsDialog";
import { tagOf } from "../notes/sidebarSection";

import type { NotesPageCtx } from "./notesPageCtx";

export default function NotesOverlayLayer(props: Pick<NotesPageCtx, "active" | "activeMenuAnchor" | "appearanceFolderId" | "attachmentRefCounts" | "backlinks" | "backupApi" | "closeRowMenu" | "copyText" | "dirty" | "exportAllData" | "exportAllZip" | "exportAnchor" | "exportHtmlOne" | "exportOne" | "exportPdfOne" | "exportPick" | "exportTarget" | "folderTags" | "folders" | "importNotesFile" | "jumpToNote" | "liveRender" | "moveDrawerNoteId" | "narrowLayout" | "noteLink" | "noteTags" | "noteWordTotal" | "notes" | "onClose" | "onDatasetChanged" | "onDelete" | "onEmptyTrash" | "onNotify" | "onToggleArchive" | "onTogglePin" | "onToggleStar" | "onUpdate" | "openInSide" | "openRevisions" | "outgoingLinks" | "outlineOpen" | "pane" | "rowMenu" | "save" | "setActiveId" | "setActiveMenuAnchor" | "setAppearanceFolderId" | "setBacklinkAnchor" | "setExportAnchor" | "setExportPick" | "setGraphOpen" | "setLiveRender" | "setMobileDetail" | "setMoveDrawerNoteId" | "setOutlineOpen" | "setSettingsOpen" | "setShareId" | "setSortAnchor" | "setSortKey" | "setTagColorId" | "setTagPick" | "setUiSettings" | "settingsOpen" | "shareApi" | "sideId" | "sortAnchor" | "sortKey" | "tagColorId" | "tagPick" | "tags" | "textareaRef" | "trashedNotes" | "uiSettings" | "uploadApi" | "userClearedRef" | "setZenMode">) {
    const { active, activeMenuAnchor, appearanceFolderId, attachmentRefCounts, backlinks, backupApi, closeRowMenu, copyText, dirty, exportAllData, exportAllZip, exportAnchor, exportHtmlOne, exportOne, exportPdfOne, exportPick, exportTarget, folderTags, folders, importNotesFile, jumpToNote, liveRender, moveDrawerNoteId, narrowLayout, noteLink, noteTags, noteWordTotal, notes, onDatasetChanged, onDelete, onEmptyTrash, onNotify, onToggleArchive, onTogglePin, onToggleStar, onUpdate, openInSide, openRevisions, outgoingLinks, outlineOpen, pane, rowMenu, save, setActiveId, setActiveMenuAnchor, setAppearanceFolderId, setBacklinkAnchor, setExportAnchor, setExportPick, setGraphOpen, setLiveRender, setMobileDetail, setMoveDrawerNoteId, setOutlineOpen, setSettingsOpen, setShareId, setSortAnchor, setSortKey, setTagColorId, setTagPick, setUiSettings, settingsOpen, shareApi, sideId, sortAnchor, sortKey, tagColorId, tagPick, tags, textareaRef, trashedNotes, uiSettings, uploadApi, userClearedRef, setZenMode } = props;
    return (
        <>
            <NotesSettingsDialog
                open={settingsOpen}
                settings={uiSettings}
                onChange={setUiSettings}
                onClose={() => setSettingsOpen(false)}
                // 分享列表页要用的三个方法（老部署/未登录时 shareApi 为空，那一页自动不出现）
                shareApi={shareApi ?? null}
                // 数据页（2026-10-08 照 inkstone 的 DataSettings）：概览 / 导出 / 维护。
                data={{
                    stats: {
                        notes: notes.length,
                        folders: folders.length,
                        tags: tags.length,
                        // 总字数（inkstone 概览里的同一格）：中文按字、英文按词，
                        // 与状态栏那套算法一致（两处不能各算各的）。
                        words: noteWordTotal,
                        trashed: Array.isArray(trashedNotes) ? trashedNotes.length : null,
                    },
                    onExportAll: exportAllData,
                    onExportZip: uploadApi?.listAttachments ? () => exportAllZip() : undefined,
                    onImportFile: importNotesFile,
                    onEmptyTrash: () => onEmptyTrash(),
                    onLoadAttachments: uploadApi?.listAttachments
                        ? () => uploadApi.listAttachments!()
                        : undefined,
                    onPruneAttachments: uploadApi?.pruneAttachments
                        ? () => uploadApi.pruneAttachments!()
                        : undefined,
                    onDeleteAttachment: uploadApi?.deleteAttachment
                        ? (id: string) => uploadApi.deleteAttachment!(id).then(() => undefined)
                        : undefined,
                    // 预览 / 编辑 / 重命名（2026-10-19）：设置页那条入口与左下角
                    // 那个管理器共用同一套能力，不给的话设置页里点文件名只会是死文本。
                    onSaveAttachmentContent: uploadApi?.updateAttachmentContent
                        ? (id: string, text: string) =>
                              uploadApi.updateAttachmentContent!(id, text).then(r => ({ size: r.size }))
                        : undefined,
                    onRenameAttachment: uploadApi?.renameAttachment
                        ? (id: string, filename: string) => uploadApi.renameAttachment!(id, filename)
                        : undefined,
                    // 附件被多少条笔记引用（管理器里「引用 N 次 / 未引用」那格）：
                    // 从已加载的正文里现算，按笔记去重（一条笔记里写两次也算 1 个引用）
                    countAttachmentRefs: attachmentRefCounts
                        ? (id: string) => attachmentRefCounts.get(id) ?? 0
                        : undefined,
                    // 「双链 / 版本历史」全站计数：shareApi 就是完整的 NavigationClient
                    // （NotesOverlay 传入），老部署没有 notesStats 方法时自动显示「—」
                    onNotesStats: shareApi?.notesStats
                        ? () => shareApi.notesStats!()
                        : undefined,
                    // 导入「记事本导出」JSON：同一条链路（NotesPage 自己导出的文件）。
                    // 成功后广播一次数据集变更（阶段 2）：网盘恢复不经 useNotes，
                    // 不广播的话其它标签页对这次恢复一无所知。
                    onImportNotes: shareApi?.importNotes
                        ? async (payload, onProgress) => {
                              const stats = await shareApi.importNotes!(payload);
                              // 数据页 JSON 直导 / 网盘恢复旧格式都走这条：同样等重拉完
                              // 才返回，上层成功提示弹出时列表已更新（同 2026-10-17 空窗）
                              onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
                              await onDatasetChanged?.();
                              return stats;
                          }
                        : undefined,
                    // 备份页（2026-10-09 照 inkstone 的 BackupSettings）：能力由
                    // NotesOverlay 探测好传进来，老部署没有时整页不出现
                    onNotesBackupGetState: backupApi?.getState,
                    onNotesBackupSave: backupApi?.save,
                    onNotesBackupTest: backupApi?.test,
                    onNotesBackupRun: backupApi?.run,
                    // 「从网盘恢复」：列出 → 选一份 →（需要时填口令）→ 下载 → 走同一条导入
                    onNotesBackupListRemote: backupApi?.listRemote,
                    onNotesBackupFetch: backupApi?.fetch,
                    onNotesBackupDeleteRemote: backupApi?.deleteRemote,
                }}
                onNotify={onNotify}
                onOpenNote={id => {
                    setSettingsOpen(false);
                    void jumpToNote(id);
                }}
            />

            {/* ---------- 浮层：菜单 / 抽屉 / 弹窗 ----------
                ⚠️⚠️ 2026-10-07：这组必须待在**根层**，不能放进中栏那个
                `{!listHidden && …}` 里。选中文件夹时中栏整列不渲染（笔记内联在左栏），
                而左栏内联笔记的右键菜单正是靠它们渲染 —— 一旦被条件块裹进去，
                表现就是「右键左栏笔记没反应，等点别处、切回列表视图菜单才冒出来，
                而且位置还是错的」（用户 2026-10-07 报的）。
                MUI 的 Menu/Drawer/Dialog 默认 portal 到 body，放根层不影响定位。 */}
            {/* ---------- 笔记的操作菜单（右键 / hover「⋯」都能打开） ----------
                与 inkstone 对齐的两套菜单（2026-10-17 精简：去掉复制标题/ID/直链、
                创建副本这几个低频项；三个导出格式收进「导出」二级菜单）：
                  - list（中栏列表行，右键或 ⋯）：在侧边打开、置顶、收藏、归档、
                    移动到文件夹、编辑标签、导出、移到回收站；
                  - rail（左栏内联笔记右键）：精简版 —— 在侧边打开/收藏/移动到文件夹/
                    归档/移到回收站。
                菜单带图标（inkstone 的菜单行是「图标 + 文字」）。 */}
            <Menu
                open={Boolean(rowMenu)}
                anchorEl={rowMenu?.el ?? null}
                // ⚠️ 白圈**第六报**（2026-10-19 用户：「白圈出现的地方是之前右键
                // 点击的地方」）的正根在这里。右键菜单的锚点是 `anchorAtMouse`
                // 造的 0×0 虚拟元素，而 MUI Menu 的退出过渡是 Grow（scale）：
                // paper 从 161×329 一路缩到 12×9，transform-origin 又正好落在
                // 锚点上 —— 于是**鼠标点位置始终被 paper 覆盖**，那十几帧里
                // 用户看到的就是一个白色小圆点一闪而过。
                // 实测记录（script/probe-white-dot.mjs）：覆盖锚点的帧 12 个、
                // 宽度 16→12px、opacity 0.79→0，paper 到 207ms 才卸载。
                // 前五轮修的「⋯ 按钮被焦点还原点亮」是**另一条**路径，两者叠加
                // 才让这个 bug 报了六次。修法：退出不缩放（enter 保留默认动画，
                // 用户没有抱怨「出现」时难看）。
                transitionDuration={{ enter: 225, exit: 0 }}
                onClose={() => {
                    closeRowMenu();
                }}
                // 右键菜单无键盘触发器，不还原指针点位的焦点；普通 ⋯ 菜单保留键盘焦点返回。
                // Menu → Popover → Modal 会透传此属性（已核对当前 MUI 实现）。
                disableRestoreFocus={!(rowMenu?.el instanceof HTMLElement)}
                slotProps={{
                    transition: {
                        onExited: () => {
                            const el = document.activeElement as HTMLElement | null;
                            if (el && el.classList.contains("note-row-actions")) el.blur();
                        },
                    },
                }}
            >
                {(() => {
                    const note = rowMenu ? notes.find(n => n.id === rowMenu.noteId) : null;
                    if (!note) return null;
                    const source = rowMenu?.source ?? "list";
                    const done = async (fn: () => Promise<unknown> | void) => {
                        closeRowMenu();
                        await fn();
                    };
                    const moveToFolder = () => {
                        closeRowMenu();
                        if (note.id !== undefined) setMoveDrawerNoteId(note.id);
                    };
                    // 左栏内联笔记的精简菜单（inkstone 的左栏右键）
                    if (source === "rail") {
                        return (
                            <>
                                <MenuItem data-row-op='open-side' onClick={() => void done(() => openInSide(note))}>
                                    <OpenInNewIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                    在侧边打开
                                </MenuItem>
                                <MenuItem data-row-op='pin' onClick={() => void done(() => onTogglePin(note))}>
                                    <PushPinIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                    {note.pinned ? "取消置顶" : "置顶"}
                                </MenuItem>
                                {onToggleStar && (
                                <MenuItem data-row-op='star' onClick={() => void done(() => onToggleStar!(note))}>
                                    {note.starred ? <StarIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} /> : <StarBorderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />}
                                    {note.starred ? "取消收藏" : "收藏"}
                                </MenuItem>
                                )}
                                <MenuItem data-row-op='folder' onClick={moveToFolder}>
                                    <FolderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                    移动到文件夹…
                                </MenuItem>
                                <MenuItem data-row-op='archive' onClick={() => void done(() => onToggleArchive(note))}>
                                    <ArchiveIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                    {note.archived ? "取消归档" : "归档"}
                                </MenuItem>
                                <Divider />
                                <MenuItem
                                    data-row-op='delete'
                                    onClick={() => void done(() => onDelete(note))}
                                    sx={{ color: "error.main" }}
                                >
                                    <DeleteOutlineIcon fontSize='small' sx={{ mr: 1, fontSize: 16 }} />
                                    移到回收站
                                </MenuItem>
                            </>
                        );
                    }
                    return (
                        <>
                            <MenuItem data-row-op='open-side' onClick={() => void done(() => openInSide(note))}>
                                <OpenInNewIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                在侧边打开
                            </MenuItem>
                            <MenuItem data-row-op='pin' onClick={() => void done(() => onTogglePin(note))}>
                                <PushPinIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                {note.pinned ? "取消置顶" : "置顶"}
                            </MenuItem>
                            {onToggleStar && (
                            <MenuItem data-row-op='star' onClick={() => void done(() => onToggleStar!(note))}>
                                {note.starred ? <StarIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} /> : <StarBorderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />}
                                {note.starred ? "取消收藏" : "收藏"}
                            </MenuItem>
                            )}
                            <MenuItem data-row-op='archive' onClick={() => void done(() => onToggleArchive(note))}>
                                <ArchiveIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                {note.archived ? "取消归档" : "归档"}
                            </MenuItem>
                            <MenuItem data-row-op='folder' onClick={moveToFolder}>
                                <FolderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                移动到文件夹…
                            </MenuItem>
                            <MenuItem
                                data-row-op='tags'
                                onClick={() => {
                                    const pick = rowMenu;
                                    const id = note.id;
                                    closeRowMenu();
                                    if (pick && id !== undefined) {
                                        setTagPick({ el: pick.el, noteId: id });
                                    }
                                }}
                            >
                                <PaletteIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                编辑标签…
                            </MenuItem>
                            <Divider />
                            <MenuItem
                                data-row-op='export'
                                onClick={() => {
                                    const pick = rowMenu;
                                    const id = note.id;
                                    closeRowMenu();
                                    if (pick && id !== undefined) {
                                        setExportPick({ el: pick.el, noteId: id });
                                    }
                                }}
                            >
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出…
                            </MenuItem>
                            <Divider />
                            <MenuItem
                                data-row-op='delete'
                                onClick={() => void done(() => onDelete(note))}
                                sx={{ color: "error.main" }}
                            >
                                <DeleteOutlineIcon fontSize='small' sx={{ mr: 1, fontSize: 16 }} />
                                移到回收站
                            </MenuItem>
                        </>
                    );
                })()}
            </Menu>

            {/* 「排序」菜单（中栏头部） */}
            <Menu
                open={Boolean(sortAnchor)}
                anchorEl={sortAnchor}
                onClose={() => setSortAnchor(null)}
            >
                {(
                    [
                        ["default", "默认（置顶优先）"],
                        ["title", "按标题"],
                        ["created", "按创建时间"],
                    ] as const
                ).map(([key, label]) => (
                    <MenuItem
                        key={key}
                        data-sort-op={key}
                        selected={sortKey === key}
                        onClick={() => {
                            setSortKey(key);
                            setSortAnchor(null);
                        }}
                    >
                        {sortKey === key ? "✓ " : ""}
                        {label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 「移动到文件夹」右侧抽屉（inkstone 的做法：右侧滑出、带搜索） */}
            <MoveFolderDrawer
                open={moveDrawerNoteId !== null}
                noteTitle={
                    moveDrawerNoteId !== null
                        ? notes.find(n => n.id === moveDrawerNoteId)?.title || ""
                        : ""
                }
                folders={folders.map(f => ({ id: f.id!, name: f.name || "未命名", icon: f.icon, color: f.color }))}
                currentFolderId={
                    moveDrawerNoteId !== null
                        ? notes.find(n => n.id === moveDrawerNoteId)?.folder_id ?? null
                        : null
                }
                onPick={(folderId) => {
                    const id = moveDrawerNoteId;
                    setMoveDrawerNoteId(null);
                    if (id !== null) void onUpdate(id, { folder_id: folderId });
                }}
                onCreateFolder={async (name) => {
                    // 直接走 folderTags（不经过 createFolder 包装）：那层会顺手把左栏
                    // 视图切到新文件夹，而这里创建完马上就把笔记移进去并关抽屉，
                    // 抢视图只会让「我明明没点左栏」的跳动显得莫名。创建是根目录级别，
                    // 子文件夹场景先不支持（左栏建子夹入口已够用）。
                    const created = await folderTags?.onCreateFolder(name, null);
                    return created?.id ?? null;
                }}
                onClose={() => setMoveDrawerNoteId(null)}
            />

            {/* 文件夹外观弹窗（icon / color，走 updateFolder 落库） */}
            <FolderAppearanceDialog
                open={appearanceFolderId !== null}
                folder={
                    (() => {
                        const f =
                            appearanceFolderId !== null
                                ? folders.find(x => x.id === appearanceFolderId)
                                : null;
                        // 弹窗要的是「确定存在」的形状（id: number），这里窄化一次
                        return f?.id !== undefined
                            ? { id: f.id, name: f.name || "未命名", icon: f.icon, color: f.color }
                            : null;
                    })()
                }
                onSave={async (icon, color) => {
                    if (appearanceFolderId !== null) {
                        await folderTags?.onStyleFolder?.(appearanceFolderId, { icon, color });
                    }
                }}
                onClose={() => setAppearanceFolderId(null)}
            />

            {/* 标签颜色弹窗（走 updateTag 落库，与文件夹外观同一组约定色） */}
            <TagColorDialog
                open={tagColorId !== null}
                tag={(() => {
                    const t = tagColorId !== null ? tags.find(x => x.id === tagColorId) : null;
                    return t?.id !== undefined
                        ? { id: t.id, name: t.name || "未命名", color: t.color }
                        : null;
                })()}
                onSave={async color => {
                    if (tagColorId !== null) {
                        await folderTags?.onStyleTag?.(tagColorId, color);
                    }
                }}
                onClose={() => setTagColorId(null)}
            />

            {/* ⚠️ 原来这里有一个「归入文件夹」的锚点 Menu，2026-10-06 删掉了：
                「移动到文件夹」改成 inkstone 那种**右侧抽屉**（见 MoveFolderDrawer），
                这个 Menu 从此没有任何入口能把它打开 —— 留着就是一段永远不渲染的
                死代码，改文件夹逻辑时很容易改错地方。 */}

            {/* 编辑标签：勾选式多选，一次性整组保存（后端就是「整组替换」语义） */}
            <Menu
                open={Boolean(tagPick)}
                anchorEl={tagPick?.el ?? null}
                onClose={() => setTagPick(null)}
            >
                {tags.length === 0 && (
                    <MenuItem disabled>还没有标签（左栏「标签」右边 + 新建）</MenuItem>
                )}
                {tags.map(t => {
                    const target = notes.find(n => n.id === tagPick?.noteId);
                    const on = target ? tagOf(target, noteTags).has(t.id!) : false;
                    return (
                        <MenuItem
                            key={t.id}
                            data-tag-pick={t.id}
                            onClick={async () => {
                                const pick = tagPick;
                                if (!pick || t.id === undefined) return;
                                const current = notes.find(n => n.id === pick.noteId);
                                const next = new Set(current ? tagOf(current, noteTags) : []);
                                if (on) next.delete(t.id);
                                else next.add(t.id);
                                await folderTags?.onAssignTags?.(pick.noteId, [...next]);
                            }}
                        >
                            {on ? "✓ " : ""}
                            {t.name}
                        </MenuItem>
                    );
                })}
            </Menu>
            {/* 导出下拉（2026-10-08）：桌面头部「导出」按钮（data-tool='export'）用，
                三格式与 inkstone 的导出菜单一致；窄屏仍走「⋯」里的三件套。 */}
            <Menu
                open={Boolean(exportAnchor)}
                anchorEl={exportAnchor}
                onClose={() => setExportAnchor(null)}
            >
                {active && (
                    <>
                        <MenuItem
                            onClick={() => {
                                setExportAnchor(null);
                                const t = exportTarget();
                                // 刚打的字还在 3s 自动保存窗口里时，导完顺手把草稿存掉，两边收敛
                                if (dirty) void save();
                                exportOne({ ...active, title: t.title, content: t.content });
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 Markdown
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                setExportAnchor(null);
                                const t = exportTarget();
                                if (dirty) void save();
                                exportHtmlOne({ ...active, title: t.title, content: t.content });
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 HTML
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                setExportAnchor(null);
                                const t = exportTarget();
                                if (dirty) void save();
                                exportPdfOne({ ...active, title: t.title, content: t.content });
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 PDF
                        </MenuItem>
                    </>
                )}
            </Menu>

            {/* 列表行右键的「导出」二级菜单（2026-10-17 精简：三个格式收进一个入口） */}
            <Menu
                open={Boolean(exportPick)}
                anchorEl={exportPick?.el ?? null}
                onClose={() => setExportPick(null)}
            >
                {(() => {
                    const target = notes.find(n => n.id === exportPick?.noteId);
                    if (!target) return null;
                    return (
                        <>
                            <MenuItem
                                data-export-op='md'
                                onClick={() => {
                                    setExportPick(null);
                                    void exportOne(target);
                                }}
                            >
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 Markdown
                            </MenuItem>
                            <MenuItem
                                data-export-op='html'
                                onClick={() => {
                                    setExportPick(null);
                                    void exportHtmlOne(target);
                                }}
                            >
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 HTML
                            </MenuItem>
                            <MenuItem
                                data-export-op='pdf'
                                onClick={() => {
                                    setExportPick(null);
                                    void exportPdfOne(target);
                                }}
                            >
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 PDF
                            </MenuItem>
                        </>
                    );
                })()}
            </Menu>

            {/* 当前笔记的「⋯」菜单：与右键菜单同一套（全量版）。 */}
            <Menu
                open={Boolean(activeMenuAnchor)}
                anchorEl={activeMenuAnchor}
                onClose={() => setActiveMenuAnchor(null)}
            >
                {active && (
                    <>
                        {/* 真·专注模式（A9）：标题行那颗图标钮的菜单版。
                            放在第一项 —— 它跟「写」直接相关，且 Esc 退出这点必须
                            在文案里说出来（不然用户进了专注不知道怎么出来）。 */}
                        <MenuItem
                            data-active-op='zen'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                setZenMode(true);
                            }}
                        >
                            <CenterFocusStrongIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            专注模式（Esc 退出）
                        </MenuItem>
                        {/* 分享 / 版本 / 大纲 / 反链：桌面端已平铺到头部（2026-10-08），
                            这几项只留给窄屏与**分屏态**（半宽的头部放不下平铺组，
                            2026-10-09 用户明确照 inkstone 收进菜单）。 */}
                        {(narrowLayout || sideId !== null) && (
                        <>
                        <MenuItem
                            data-active-op='share'
                            disabled={!shareApi || (active.id ?? 0) <= 0}
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                if (active.id) setShareId(active.id);
                            }}
                        >
                            <ShareIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            只读分享…
                        </MenuItem>
                        <MenuItem
                            data-active-op='revisions'
                            disabled={!folderTags?.onListRevisions}
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void openRevisions();
                            }}
                        >
                            <HistoryIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            版本历史…
                        </MenuItem>
                        <MenuItem
                            data-active-op='outline'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                setOutlineOpen(o => !o);
                            }}
                        >
                            <ListIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            {outlineOpen ? "收起大纲" : "大纲"}
                        </MenuItem>
                        <MenuItem
                            data-active-op='backlinks'
                            disabled={backlinks.length === 0}
                            onClick={e => {
                                setActiveMenuAnchor(null);
                                setBacklinkAnchor(e.currentTarget);
                            }}
                        >
                            <LinkIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            反向链接（{backlinks.length}）
                        </MenuItem>
                        </>
                        )}
                        {/* 关系图谱（2026-10-09）：双链攒多了以后「谁连谁」在列表里是暗的，
                            这里一次摊开。入口只在有双链时出现 —— 一条链接都没有时
                            图上就一个孤点，点了只会让人以为坏了。 */}
                        {(backlinks.length > 0 || outgoingLinks.length > 0) && (
                        <MenuItem
                            data-active-op='graph'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                setGraphOpen(true);
                            }}
                        >
                            <HubIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            关系图谱
                        </MenuItem>
                        )}
                        {/* 编辑器内查找/替换（N2）：⌘F 也能开，这里给个鼠标入口。
                            走 editorRef.openSearch() → @codemirror/search 的 openSearchPanel。 */}
                        <MenuItem
                            data-active-op='find'
                            disabled={pane === "preview"}
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                textareaRef.current?.openSearch();
                            }}
                        >
                            <SearchIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            查找 / 替换…
                        </MenuItem>
                        <Divider />
                        {/* 窄屏头部放不下「即时渲染」，这里补一个入口（同一个状态）；
                            桌面态（含分屏，2026-10-10）头部已有开关，这项不再重复出现。 */}
                        {narrowLayout && (
                        <MenuItem
                            data-active-op='live-render'
                            onClick={() => setLiveRender(v => !v)}
                        >
                            <BoltIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            {liveRender ? "关掉编辑区实时渲染" : "打开编辑区实时渲染"}
                        </MenuItem>
                        )}
                        <MenuItem
                            data-active-op='copy-title'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void copyText(active.title || "", "已复制标题");
                            }}
                        >
                            <DriveFileRenameOutlineIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            复制标题
                        </MenuItem>
                        <MenuItem
                            data-active-op='copy-link'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void copyText(noteLink(active), "已复制直链");
                            }}
                        >
                            <LinkIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            复制直链
                        </MenuItem>
                        <Divider />
                        <MenuItem
                            data-active-op='pin'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void onTogglePin(active);
                            }}
                        >
                            <PushPinIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            {active.pinned ? "取消置顶" : "置顶"}
                        </MenuItem>
                        {onToggleStar && (
                        <MenuItem
                            data-active-op='star'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void onToggleStar(active);
                            }}
                        >
                            {active.starred ? <StarIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} /> : <StarBorderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />}
                            {active.starred ? "取消收藏" : "收藏"}
                        </MenuItem>
                        )}
                        <MenuItem
                            data-active-op='archive'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                void onToggleArchive(active);
                            }}
                        >
                            <ArchiveIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            {active.archived ? "取消归档" : "归档"}
                        </MenuItem>
                        <MenuItem
                            data-active-op='folder'
                            onClick={() => {
                                const id = active.id;
                                setActiveMenuAnchor(null);
                                if (id !== undefined) setMoveDrawerNoteId(id);
                            }}
                        >
                            <FolderIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            移动到文件夹…
                        </MenuItem>
                        {/* 导出三件套：桌面端已收进头部「导出」下拉（data-tool='export'），
                            这里只留给窄屏与分屏态。 */}
                        {(narrowLayout || sideId !== null) && (
                        <>
                        <MenuItem
                            data-active-op='export'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                exportOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 Markdown
                        </MenuItem>
                        <MenuItem
                            data-active-op='export-html'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                exportHtmlOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 HTML
                        </MenuItem>
                        <MenuItem
                            data-active-op='export-pdf'
                            onClick={() => {
                                setActiveMenuAnchor(null);
                                exportPdfOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 PDF
                        </MenuItem>
                        </>
                        )}
                        <Divider />
                        <MenuItem
                            data-active-op='delete'
                            onClick={async () => {
                                setActiveMenuAnchor(null);
                                await onDelete(active);
                                // ⚠️ 这是用户**主动**清空选择：标记一下，别让自动选中
                                // 立刻把另一条顶上来（他要的是空状态，自己挑下一条）。
                                userClearedRef.current = true;
                                setActiveId(null);
                                setMobileDetail(false);
                            }}
                            sx={{ color: "error.main" }}
                        >
                            <DeleteOutlineIcon fontSize='small' sx={{ mr: 1, fontSize: 16 }} />
                            移到回收站
                        </MenuItem>
                    </>
                )}
            </Menu>

            {/* 版本历史面板（inkstone 的 VersionsPanel）：左列快照 + 右栏行级 diff。
                替换掉原来那个「点了直接恢复」的 Menu —— 恢复前能看清改了什么。 */}
        </>
    );
}
