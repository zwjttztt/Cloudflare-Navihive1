// src/components/NotesPage.tsx
// 记事本：**独立页面**（全屏），布局参考 inkstone ——
//
//   ┌──────────────────────────────────────────┐
//   │ Header：返回 · 搜索 · 新建                  │
//   ├────────────┬─────────────────────────────┤
//   │            │ 笔记标题（输入框）             │
//   │  笔记列表   ├─────────────────────────────┤
//   │  （置顶在前）│                             │
//   │            │  内容区：源码 | 预览（分栏）     │
//   │            │                             │
//   │            ├─────────────────────────────┤
//   │            │ 状态栏：字数 · 保存状态        │
//   └────────────┴─────────────────────────────┘
//
// 为什么是独立页面而不是右侧滑出的抽屉：记事本是「想到就写」的地方，
// 要的是一整屏能打字的地方；抽屉里再弹一个编辑框，等于两层套娃。
//
// 为什么全 Flex 而不是 Grid：和 inkstone 一致，且和项目里现有布局同源。
// 移动端按 inkstone 的做法切成「列表 / 编辑」两屏，而不是硬塞双栏。
import {
    Fragment,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import type { PopoverVirtualElement } from "@mui/material/Popover";
import Box from "@mui/material/Box";
import Avatar from "@mui/material/Avatar";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import FolderIcon from "@mui/icons-material/Folder";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import ArchiveIcon from "@mui/icons-material/Archive";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChecklistIcon from "@mui/icons-material/Checklist";
import CodeIcon from "@mui/icons-material/Code";
import CalculateIcon from "@mui/icons-material/Calculate";
import CloseIcon from "@mui/icons-material/Close";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import EditIcon from "@mui/icons-material/Edit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import MenuIcon from "@mui/icons-material/Menu";
import ImageIcon from "@mui/icons-material/Image";
import LastPageIcon from "@mui/icons-material/LastPage";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import HistoryIcon from "@mui/icons-material/History";
import ShareIcon from "@mui/icons-material/Share";
import BoltIcon from "@mui/icons-material/Bolt";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import SearchIcon from "@mui/icons-material/Search";
import SettingsIcon from "@mui/icons-material/Settings";
import SortIcon from "@mui/icons-material/Sort";
import StrikethroughIcon from "@mui/icons-material/StrikethroughS";
import TableRowsIcon from "@mui/icons-material/TableRows";
import UndoIcon from "@mui/icons-material/Undo";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import NoteAltIcon from "@mui/icons-material/NoteAlt";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaletteIcon from "@mui/icons-material/Palette";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
// —— 格式工具栏（对齐 inkstone 的 EditorToolbar：7 个下拉 + 独立图标组）——
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ViewHeadlineIcon from "@mui/icons-material/ViewHeadline";
import FormatListBulletedIcon from "@mui/icons-material/FormatListBulleted";
import FormatListNumberedIcon from "@mui/icons-material/FormatListNumbered";
import FormatColorTextIcon from "@mui/icons-material/FormatColorText";
import DataObjectIcon from "@mui/icons-material/DataObject";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import SubjectIcon from "@mui/icons-material/Subject";
import { Kbd } from "./Kbd";
import { comboFor } from "../utils/editorShortcuts";
import { readReadingPosition, writeReadingPosition } from "../utils/readingPosition";
import type {
    Note,
    NoteFolder,
    NoteRevision,
    NoteTag,
    NotesBackupSavePatch,
    NotesBackupState,
} from "../API/http";
import type { TrashedNote } from "../hooks/useNotes";
import { renderMarkdownToReact, type RenderFeatures } from "../utils/markdownToReact";
import type { NoteEmbedTarget } from "./NoteEmbedNode";
import { useScrollLock } from "../hooks/useScrollLock";
import { usePanelBreakpoint } from "../hooks/usePanelBreakpoint";
// 笔记时间统一走这里：SQLite 的 UTC 无时区串必须按 UTC 解释，
// 直接 `new Date(iso)` 在东八区会差 8 小时（「笔记时间不对」的根因）。
import { formatRelative, formatWhen, formatWhenFull, groupLabel } from "../utils/noteTime";
import { extractOutline, outlineIndent } from "../utils/noteOutline";
import { buildBacklinks, resolveWikiLinks } from "../utils/noteWikiLink";
import { exportNoteAsMarkdown } from "../utils/noteExport";
import { exportNoteAsHtml, printNoteAsPdf } from "../utils/noteHtmlExport";
import { isFolderColor, FOLDER_ICONS } from "../utils/folderAppearance";
import { createScrollSync } from "../utils/syncScroll";
import {
    loadNotesSettings,
    saveNotesSettings,
    type NotesUiSettings,
} from "../utils/notesSettings";
import { reportError } from "../utils/errorReporter";
import NoteEditor from "./NoteEditor";
// 空状态：插画 + 标题 + 说明 + 可选动作，对齐 inkstone 的 <Empty>
import { EmptyState } from "./EmptyArt";
import ConfirmDialog from "./ConfirmDialog";
import NamePromptDialog from "./NamePromptDialog";
import FolderAppearanceDialog from "./FolderAppearanceDialog";
import MoveFolderDrawer from "./MoveFolderDrawer";
import NotesSettingsDialog from "./NotesSettingsDialog";
import type { NoteEditorHandle } from "../utils/noteEditorHandle";
import { useEditorTools, type TableOp, type EditorDraft } from "../hooks/useEditorTools";

import NoteShareDialog, { type NoteShareApi } from "./NoteShareDialog";

export interface NotesPageProps {
    shareApi?: NoteShareApi;
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
    };
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
    };
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
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void>;
    onDelete: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
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
        /** 版本历史：列快照 / 恢复 */
        onListRevisions?: (noteId: number) => Promise<NoteRevision[]>;
        onRestoreRevision?: (noteId: number, revisionId: number) => Promise<Note | null>;
    };
}

/** 摘要：把 Markdown 源码压成一行预览（去掉语法符号，不解析） */
function summarize(source: string, max = 90): string {
    const flat = source
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}


/** 把编辑区拆成「源码 | 预览」两栏 */
type Pane = "edit" | "split" | "preview";

/** 左栏视图 */
type NoteView =
    | "all"
    | "recent"
    | "starred"
    | "archived"
    | "uncategorized"
    | "trash"
    // 「搜索」是 2026-10-06 加的独立视图：inkstone 左栏第一项就是它。
    // 之前只有列表上方那个输入框（搜标题+正文），搜不到标签、也不给命中数。
    | "search";

/**
 * 编辑区（以及左栏 / 列表 / 工具栏）的滚动条**不再本地定义**，直接吃
 * src/index.css 里那套全局规则 —— 也就是导航页看到的那根细圆角条。
 *
 * 为什么不能像以前那样在组件里写一份「本地版」：
 * 本地版里设了标准属性 `scrollbar-color`（本意是给 Firefox），但
 * **Chrome 121+ 只要认到 `scrollbar-color` / `scrollbar-width`，就会改用自家
 * 原生滚动条渲染，整套 `::-webkit-scrollbar` 被直接忽略** ——
 * 症状就是编辑器里出现一根又粗又灰的原生条（用户：「太难看了，换成导航页的」），
 * 而量伪元素样式还显示 10px / 0.32 都在，极具迷惑性。
 *
 * 全局规则用 `*` 选择器本来就覆盖所有元素（含 textarea），这里只要保证
 * 各滚动容器自己有 `overflow-y: auto` 就够了。
 */

/**
 * 左栏两列的宽度（阶段三收尾：左栏从单列改成 inkstone 那样两列）。
 *
 * 导航列刻意做窄（128）：它只有名字 + 一个条数，宽了就是浪费；
 * 笔记列表列给 208，比原来的 300 整列窄一些 —— 但换来的是「导航归导航、列表归列表」，
 * 月份分组标题不会再被挤到换行。两列加起来 336，只比原来宽 36px，
 * 编辑区在 1360 的窗口下仍有 1000 出头。
 */
export const NAV_COL_W = 128;
export const LIST_COL_W = 208;

/** 「这条笔记挂了哪些标签」。模块级常量，避免每次渲染新造一个 {} 让依赖失效 */
const EMPTY_TAG_LINKS: Record<number, number[]> = {};

/** 某个笔记的标签Id集合。空的也返回空集合（不是 undefined）—— 列表里要无条件渲染 */
function tagOf(note: Note, links: Record<number, number[]>): Set<number> {
    return new Set(links[note.id ?? 0] || []);
}

/** 某条笔记的标签**名字**列表（列表徽章 / 菜单里都要显示名字，不是 id） */
function tagNamesOf(
    note: Note,
    links: Record<number, number[]>,
    allTags: NoteTag[]
): string[] {
    const ids = tagOf(note, links);
    if (ids.size === 0) return [];
    return allTags.filter(t => typeof t.id === "number" && ids.has(t.id!)).map(t => t.name);
}

/**
 * 左栏第一列里的一行导航（inkstone 的调子：名字靠左、条数靠右、选中整行变底色）。
 *
 * 刻意用**真 <button>**（Box component='button'）而不是 div + role='button'：
 * 原生 button 自带 Enter / 空格激活、焦点环、可访问名，一套都齐，
 * 不用自己补 tabIndex + onKeyDown（之前那两个手写补法漏过一次焦点规则）。
 * 样式上要按 button 默认值逐个压掉（背景 / 边框 / 字体 / 内边距 / 文本对齐），
 * 否则它在 128px 的窄列里会鼓成一块方砖。
 */
function NavRow({
    label,
    count,
    selected,
    onClick,
    /** 可选的行首小图标（文件夹外观用）；不给就不渲染，保持原有两列排版 */
    icon,
    iconColor,
    ...rest
}: {
    label: string;
    count: number;
    selected: boolean;
    onClick: () => void;
    icon?: ReactNode;
    iconColor?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <Box
            component='button'
            type='button'
            onClick={onClick}
            // 「界面密度：紧凑」靠这个类名收紧上下留白（规则在 index.css）
            className='note-dense-row'
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 1.25,
                py: 0.45,
                width: "100%",
                borderRadius: 1.25,
                cursor: "pointer",
                minWidth: 0,
                // ---- 把 <button> 的默认外观压回「一张透明的行」----
                appearance: "none",
                border: "none",
                m: 0,
                font: "inherit",
                textAlign: "left",
                // inkstone 的选中态是「淡淡的强调色底」：比灰色底多一层「这是你正在看的」的指向
                bgcolor: selected ? "color-mix(in srgb, var(--accent) 10%, transparent)" : "transparent",
                color: selected ? "text.primary" : "text.secondary",
                transition: "background-color 120ms ease",
                "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                "&:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: 1 },
            }}
            {...rest}
        >
            {icon && (
                <Box
                    component='span'
                    aria-hidden
                    sx={{ display: "inline-flex", flexShrink: 0, color: iconColor ?? "inherit" }}
                >
                    {icon}
                </Box>
            )}
            <Typography
                variant='body2'
                sx={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: selected ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {label}
            </Typography>
            <Typography
                variant='caption'
                sx={{ fontSize: 11, color: "text.disabled", flexShrink: 0 }}
            >
                {count > 0 ? count : ""}
            </Typography>
        </Box>
    );
}

/**
 * 导航列里「文件夹 / 标签」这样一节：一个小节标题（右边跟一个 + 新建）＋ 若干条目。
 *
 * 条目自带 hover 菜单（重命名 / 删除）：128px 宽的列里塞不下按钮，
 * 所以把操作折进 hover 出现的 ⋯ 里。
 */

/**
 * `maybeChildId` 是不是 `ancestorId` 的后代（任意深度）。
 *
 * 拖文件夹进子文件夹会造出环（父的父变成子），后端会拒 —— 但界面先拦一道：
 * 让用户拖了半天再弹一个错，体验上等于「功能坏了」。
 * 数据里已有环时（脏数据）也不会死循环：seen 集合兜住。
 */
function isDescendant(
    items: readonly { id: number; parent_id?: number | null }[],
    ancestorId: number,
    maybeChildId: number
): boolean {
    const byId = new Map(items.map(i => [i.id, i.parent_id ?? null]));
    const seen = new Set<number>();
    let cursor = byId.get(maybeChildId) ?? null;
    while (cursor !== null && !seen.has(cursor)) {
        if (cursor === ancestorId) return true;
        seen.add(cursor);
        cursor = byId.get(cursor) ?? null;
    }
    return false;
}

/**
 * 右键菜单的锚点：要么是「⋯」按钮本身（左键点按钮开的菜单），要么是
 * **鼠标坐标**造出来的虚拟元素（MUI Popover 支持任何带 getBoundingClientRect
 * 的对象，见 @mui/material/Popover 的 PopoverVirtualElement）。
 *
 * ⚠️ 为什么右键要用虚拟锚点（2026-10-07 用户报的两条一起修）：
 *  - 右键弹窗「都在固定位置」：原来锚的是整行元素，MUI 默认锚到它的左上角 ——
 *    行有多长、列表滚到哪，菜单就钉死在哪，跟鼠标没关系；
 *  - 左栏内联笔记右键「点其他地方才出现、还错位」：整行 button 是 100% 宽，
 *    右键点在行中下部，菜单却出现在行顶 —— 视觉上就是「错位」；而行在
 *    状态更新后重渲染，锚点元素可能被 React 换掉，菜单一度拿不到位置。
 *    虚拟元素不受渲染影响，坐标即点即所得。
 */
export type MenuAnchor = HTMLElement | PopoverVirtualElement;

/** 用鼠标坐标构造一个 0×0 的虚拟锚点（菜单左上角 = 指针位置） */
/**
 * 每个笔记栏头部（标题行）的统一高度。
 * ⚠️ 主栏与侧栏必须用同一个值：之前主栏靠 `pt:1.5` 自然撑高、侧栏多了两个
 * 按钮也各自撑高，两栏并排时高度差 5~8px，标题与工具栏整排错位（2026-10-07 用户报）。
 * ⚠️ 2026-10-07 从 52 收到 44（inkstone 的 `h-11`）：52 是「标题 18px + 上下留白」
 * 猜出来的值，比 inkstone 高一截，三栏并排时上下就显空。44 正好放下 28px 的
 * 按键行 + 标题基线，且和 36px 的工具栏、26px 的状态栏成一套比例。
 */
const PANE_HEADER_H = 44;

/** 状态栏统一高度（inkstone 的 `--statusbar-h`），主栏与侧栏必须一致 */
const STATUSBAR_H = 26;

function anchorAtMouse(x: number, y: number): PopoverVirtualElement {
    return {
        nodeType: 1,
        getBoundingClientRect: () =>
            ({
                x,
                y,
                left: x,
                top: y,
                right: x,
                bottom: y,
                width: 0,
                height: 0,
                toJSON: () => ({}),
            }) as DOMRect,
    };
}

function FolderTagSection({
    title,
    items,
    selectedId,
    onSelect,
    onCreate,
    onCreateNote,
    onAskRename,
    onAskRemove,
    onCreateChild,
    onMove,
    onDropNote,
    childrenOf,
    activeNoteId,
    onOpenNote,
    onCreateNoteIn,
    onReorder,
    onAppearance,
    unfiledNotes,
    onNoteContext,
}: {
    title: string;
    items: {
        id: number;
        name: string;
        count: number;
        parent_id?: number | null;
        /** 文件夹外观（icon 名 / 颜色）—— 只有文件夹节会传 */
        icon?: string | null;
        color?: string | null;
    }[];
    onCreateChild?: (id: number) => void;
    onMove?: (id: number, parentId: number | null) => void;
    onDropNote?: (noteId: number, folderId: number) => void;
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onCreate: () => void;
    /**
     * 只有「文件夹」这一节传：把「新建笔记」挪到左栏文件夹标题右侧，
     * 和「新建文件夹」并排（参考 inkstone 布局），顶栏那个原位按钮就去掉了。
     */
    onCreateNote?: () => void;
    /**
     * 「重命名 / 删除」交给上层弹窗处理。
     * 之前这个组件内部直接调 window.prompt / window.confirm ——
     * 样式突兀，且部分 WebView 直接拦掉（点了没反应）。
     * 传 undefined 时菜单里就不给这两项（老部署的兜底）。
     */
    onAskRename?: (id: number, currentName: string) => void;
    onAskRemove?: (id: number, name: string) => void;
    /**
     * inkstone 的文件夹树：**笔记直接长在文件夹下面**，选中文件夹时中间那栏不出现。
     * 只给「文件夹」这一节传；标签节不传（标签是交叉维度，没有父子归属）。
     *
     * @param folderId 要展开的那个文件夹
     * @returns 该文件夹下的笔记（已按更新时间排好序）
     */
    childrenOf?: (folderId: number) => { id: number; title: string }[];
    /** 当前打开的笔记：内联那几条里要给它高亮 */
    activeNoteId?: number | null;
    /** 点内联笔记 → 打开它（有未保存改动时上层会先存） */
    onOpenNote?: (id: number) => void;
    /** 在这个文件夹**里面**新建笔记（inkstone 菜单里的「在此新建笔记」） */
    onCreateNoteIn?: (folderId: number) => void;
    /** 同级内前后挪一位（inkstone 的「向前/向后移动」） */
    onReorder?: (folderId: number, dir: -1 | 1) => void;
    /** 文件夹外观：打开图标/颜色选择弹窗 */
    onAppearance?: (folderId: number) => void;
    /**
     * 未归入任何文件夹的笔记（inkstone：直接列在文件夹树下）。
     * 只给「文件夹」节传；标签节没有归属概念。
     */
    unfiledNotes?: { id: number; title: string }[];
    /** 内联笔记（选中文件夹的 + 未归类的）右键菜单：交给上层统一弹。
     *  锚点用 MenuAnchor（右键=鼠标坐标虚拟元素，⋯按钮=元素本身）。 */
    onNoteContext?: (noteId: number, anchor: MenuAnchor) => void;
}) {
    const [menuId, setMenuId] = useState<number | null>(null);
    /** 「移动到…」二级菜单：要移动谁 + 锚点 */
    const [moveId, setMoveId] = useState<number | null>(null);
    const [moveAnchor, setMoveAnchor] = useState<MenuAnchor | null>(null);
    /**
     * 拖放反馈的两个状态（2026-10-06 补，之前完全没有）：
     *  - dragging 谁：拖起的那一行半透明，用户知道手上抓的是哪个
     *  - dropTarget 哪一行：可放置的目标行高亮，否则用户不知道能不能放、放在哪
     * 之前 `onDragOver` 只设了个 `dropEffect`，真机量下来目标行**样式毫无变化**，
     * 体验上等同于「拖了没反应」。
     */
    const [dragging, setDragging] = useState<number | null>(null);
    const [dropTarget, setDropTarget] = useState<number | null>(null);
    /** 拖拽结束后统一清理：dragend 在**源元素**上，drop 未必触发（拖到框外松手） */
    const endDrag = () => {
        setDragging(null);
        setDropTarget(null);
    };
    /**
     * 菜单锚点：**必须**是那个「⋯」按钮本身。
     * 之前这里是 `anchorEl={undefined}`，MUI 拿不到锚点就退化成锚到视口原点 ——
     * 真机实测菜单落在 `x:16 y:724`（屏幕左下角），而点击点在左栏上部，
     * 四个菜单项全都不在鼠标附近，用户只会以为「点击没反应」。
     * ⚠️ 这类错位 jsdom 测不出来（没有布局，getBoundingClientRect 全 0），
     * 所以 DOM 用例只能断言「菜单能打开」，位置必须真机量坐标。
     */
    const [anchorEl, setAnchorEl] = useState<MenuAnchor | null>(null);
    const treeItems = useMemo(() => {
        const output: (typeof items[number] & { depth: number })[] = [];
        const visited = new Set<number>();
        const visit = (item: typeof items[number], depth: number) => {
            if (visited.has(item.id)) return;
            visited.add(item.id);
            output.push({ ...item, depth });
            items.filter(child => child.parent_id === item.id).forEach(child => visit(child, depth + 1));
        };
        items.filter(item => !item.parent_id || !items.some(p => p.id === item.parent_id)).forEach(item => visit(item, 0));
        items.forEach(item => visit(item, 0));
        return output;
    }, [items]);
    return (
        <Box sx={{ px: 0.75, pb: 1 }}>
            <Box
                sx={{ display: "flex", alignItems: "center", px: 0.5, pb: 0.5, pt: 0.5 }}
            >
                <Typography variant='caption' sx={{ flex: 1, fontSize: 11, color: "text.disabled" }}>
                    {title}
                </Typography>
                <Tooltip title={`新建${title}`}>
                    <IconButton size='small' aria-label={`新建${title}`} onClick={onCreate} sx={{ p: 0.25 }}>
                        <AddIcon fontSize='inherit' />
                    </IconButton>
                    </Tooltip>
                {onCreateNote && (
                    <Tooltip title='新建笔记'>
                        <IconButton
                            size='small'
                            aria-label='新建笔记'
                            onClick={onCreateNote}
                            sx={{ p: 0.25 }}
                        >
                            <NoteAddIcon fontSize='inherit' />
                        </IconButton>
                    </Tooltip>
                )}
            </Box>
            {treeItems.map(item => (
                <Box
                    key={item.id}
                    data-folder-depth={item.depth}
                    data-drop-active={dropTarget === item.id ? '1' : undefined}
                    data-dragging={dragging === item.id ? '1' : undefined}
                    sx={{
                        position: "relative",
                        // 层级缩进：1 级 10px 往后递增；超过 6 级封顶（再深也分不出层级了），
                        // 配合 data-folder-depth 供真机/测试判定。
                        pl: Math.min(item.depth, 6) * 10,
                        borderRadius: 1,
                        // 拖动中的目标行高亮 —— 这是「能不能放」的唯一直观信号
                        bgcolor:
                            dropTarget === item.id
                                ? "rgba(128,128,128,0.18)"
                                : "transparent",
                        outline: dropTarget === item.id ? "1px dashed var(--accent)" : "none",
                        outlineOffset: -1,
                        transition: "background-color 100ms ease",
                        opacity: dragging === item.id ? 0.45 : 1,
                    }}
                    onDragOver={onMove || onDropNote ? e => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        // dragover 会以很高的频率反复触发（鼠标一动就来一次），
                        // 同一个目标就别再 setState 了，否则整棵列表跟着重渲染。
                        if (dropTarget !== item.id) setDropTarget(item.id);
                    } : undefined}
                    onDragLeave={onMove || onDropNote ? () => {
                        // 只有「确实要离开这一行」才清：relatedTarget 在行内移动时
                        // 也会触发 dragleave，不判一下高亮会一直闪。
                        setDropTarget(cur => (cur === item.id ? null : cur));
                    } : undefined}
                    onDrop={onMove || onDropNote ? e => {
                        e.preventDefault(); e.stopPropagation();
                        const folder = Number(e.dataTransfer.getData("application/navihive-folder"));
                        const note = Number(e.dataTransfer.getData("application/navihive-note"));
                        endDrag();
                        // 不能把文件夹拖进它自己或自己的子文件夹 —— 后端会拒，
                        // 但界面先拦一道更省事（也避免「拖了半天弹个错」）。
                        if (folder > 0) {
                            if (folder !== item.id && !isDescendant(items, item.id, folder)) {
                                onMove?.(folder, item.id);
                            }
                        } else if (note > 0) {
                            onDropNote?.(note, item.id);
                        }
                    } : undefined}>
                    <NavRow
                        label={item.name}
                        count={item.count}
                        selected={selectedId === item.id}
                        // 给一个稳定的测试抓手：文件夹视图的筛选用例和未来的 e2e 都靠它定位，
                        // 别去按文字找（名字是用户自己起的，随时会变）
                        data-folder-id={item.id}
                        // 文件夹外观：按存的 icon 名找组件；颜色不在调色板里就按默认画
                        icon={
                            (() => {
                                const spec =
                                    FOLDER_ICONS.find(i => i.key === (item.icon || "")) ??
                                    FOLDER_ICONS[0];
                                const Icon = spec.icon;
                                return <Icon fontSize='inherit' sx={{ fontSize: 14 }} />;
                            })()
                        }
                        iconColor={
                            isFolderColor(item.color)
                                ? item.color
                                : selectedId === item.id
                                  ? "var(--accent)"
                                  : "text.disabled"
                        }
                        draggable={Boolean(onMove)}
                        onDragStart={onMove ? e => {
                            e.dataTransfer.setData("application/navihive-folder", String(item.id));
                            e.dataTransfer.effectAllowed = "move";
                            setDragging(item.id);
                        } : undefined}
                        onDragEnd={onMove ? endDrag : undefined}
                        onClick={() => onSelect(selectedId === item.id ? null : item.id)}
                        onContextMenu={e => {
                            // 右键文件夹 = 直接开它的操作菜单（inkstone 同样支持右键）。
                            // ⚠️ 锚在鼠标处：锚到整行左上角的话，菜单位置与指针无关（用户报「固定位置」）。
                            e.preventDefault();
                            // 同列表行：右键后别让行一直留着焦点（否则「⋯」常驻成一颗白点）
                            (e.currentTarget as HTMLElement).blur();
                            setMenuId(item.id);
                            setAnchorEl(anchorAtMouse(e.clientX, e.clientY));
                        }}
                    />
                    <IconButton
                        size='small'
                        aria-label={`${item.name} 操作`}
                        onClick={e => {
                            setMenuId(item.id);
                            setAnchorEl(e.currentTarget);
                        }}
                        sx={{
                            position: "absolute",
                            right: 2,
                            top: "50%",
                            mt: "-14px",
                            p: 0.25,
                            opacity: 0,
                            // ⚠️ 不能写死 background.paper：页面背景色（暖白/纯白）是算出来的，
                            // 写死就会在暖白底上留一个纯白方块（用户报「颜色不会变」）。
                            bgcolor: "transparent",
                            "&:hover": { opacity: 1, bgcolor: "background.paper" },
                            // 触屏没有 hover：直接常显，否则在那边根本点不到
                            "@media (hover: none)": { opacity: 1 },
                        }}
                    >
                        <MoreVertIcon fontSize='inherit' />
                    </IconButton>
                </Box>
            ))}
            {/* 选中的文件夹把它的笔记直接列在下面（inkstone 的文件夹树）。
                ⚠️ 只展开**当前选中**的那一个：全展开的话左栏会被几十条笔记撑爆，
                而用户点开文件夹的目的就是「我要看这一份」。 */}
            {childrenOf &&
                selectedId !== null &&
                (() => {
                    const kids = childrenOf(selectedId);
                    if (kids.length === 0) return null;
                    const depth =
                        treeItems.find(i => i.id === selectedId)?.depth ?? 0;
                    return (
                        <Box data-folder-notes='1' sx={{ pb: 0.5 }}>
                            {kids.map(n => (
                                <Box
                                    key={n.id}
                                    component='button'
                                    type='button'
                                    data-folder-note={n.id}
                                    className='note-dense-row'
                                    aria-label={`打开笔记 ${n.title || "无标题"}`}
                                    onClick={() => onOpenNote?.(n.id)}
                                    onContextMenu={e => {
                                        if (!onNoteContext) return;
                                        e.preventDefault();
                                        // 菜单弹在鼠标处（原来锚整行顶部，右键行中下部会「错位」）
                                        onNoteContext(n.id, anchorAtMouse(e.clientX, e.clientY));
                                    }}
                                    sx={{
                                        display: "block",
                                        width: "100%",
                                        textAlign: "left",
                                        appearance: "none",
                                        border: "none",
                                        m: 0,
                                        font: "inherit",
                                        cursor: "pointer",
                                        minWidth: 0,
                                        px: 1.25,
                                        // 比文件夹行再缩进一档，父子关系一眼看得出。
                                        // ⚠️⚠️ 必须写**像素字符串**：这里的 pl 是 MUI 间距单位
                                        // （1 个单位 = 8px）。之前写成 1.25 + (depth+1)*10
                                        // → 第一层就是 90px 缩进，128px 宽的左栏里文字只剩
                                        // 25px，看起来就像「标题居中了」（用户报）。
                                        // 现在 22px 起步（与「未归类」那组基本齐平），每深一层 +12px。
                                        pl: `${22 + Math.min(depth, 4) * 12}px`,
                                        py: 0.35,
                                        borderRadius: 1.25,
                                        bgcolor:
                                            activeNoteId === n.id
                                                ? "rgba(128,128,128,0.14)"
                                                : "transparent",
                                        color:
                                            activeNoteId === n.id ? "text.primary" : "text.secondary",
                                        "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                                        "&:focus-visible": {
                                            outline: "2px solid var(--accent)",
                                            outlineOffset: 1,
                                        },
                                    }}
                                >
                                    <Typography
                                        component='span'
                                        sx={{
                                            display: "block",
                                            fontSize: 12.5,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                        }}
                                    >
                                        {n.title || "无标题"}
                                    </Typography>
                                </Box>
                            ))}
                        </Box>
                    );
                })()}
            {/* 未归入任何文件夹的笔记（inkstone：直接列在文件夹树下，不占中间那栏）。
                右键可移动到文件夹（右侧抽屉）/归档/移到回收站。 */}
            {unfiledNotes && unfiledNotes.length > 0 && (
                <Box data-unfiled-notes='1' sx={{ pb: 0.5 }}>
                    <Typography
                        variant='caption'
                        sx={{ display: "block", px: 1.25, pt: 0.5, pb: 0.25, fontSize: 11, color: "text.disabled" }}
                    >
                        未归类
                    </Typography>
                    {unfiledNotes.map(n => (
                        <Box
                            key={n.id}
                            component='button'
                            type='button'
                            data-unfiled-note={n.id}
                            className='note-dense-row'
                            aria-label={`打开笔记 ${n.title || "无标题"}`}
                            onClick={() => onOpenNote?.(n.id)}
                            onContextMenu={e => {
                                if (!onNoteContext) return;
                                e.preventDefault();
                                // 菜单弹在鼠标处（同上）
                                onNoteContext(n.id, anchorAtMouse(e.clientX, e.clientY));
                            }}
                            sx={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                appearance: "none",
                                border: "none",
                                m: 0,
                                font: "inherit",
                                cursor: "pointer",
                                minWidth: 0,
                                px: 1.25,
                                pl: 2.25,
                                py: 0.35,
                                borderRadius: 1.25,
                                bgcolor:
                                    activeNoteId === n.id
                                        ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                        : "transparent",
                                color:
                                    activeNoteId === n.id ? "text.primary" : "text.secondary",
                                "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                                "&:focus-visible": {
                                    outline: "2px solid var(--accent)",
                                    outlineOffset: 1,
                                },
                            }}
                        >
                            <Typography
                                component='span'
                                sx={{
                                    display: "block",
                                    fontSize: 12.5,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {n.title || "无标题"}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
            {items.length === 0 && (
                <Typography variant='caption' sx={{ display: "block", px: 1, fontSize: 11, color: "text.disabled" }}>
                    还没有{title}
                </Typography>
            )}
            {/* 重命名 / 删除就用系统 prompt：为这两个动作单独做一个带校验的弹窗，
                在 128px 的窄列里是杀鸡用牛刀，而且重命名根本没有别的输入方式 */}
            <Menu
                open={menuId !== null}
                anchorEl={anchorEl}
                onClose={() => {
                    setMenuId(null);
                    setAnchorEl(null);
                }}
                slotProps={{ paper: { sx: { minWidth: 140 } } }}
            >
                {onAskRename && (
                    <MenuItem
                        data-folder-op='rename'
                        onClick={() => {
                            const item = items.find(i => i.id === menuId);
                            setMenuId(null);
                            // 交给上层弹窗：这里不再直接 prompt() ——
                            // 系统弹窗样式突兀，且部分 WebView 会拦（2026-10-06 换掉）。
                            if (item) onAskRename(item.id, item.name);
                        }}
                    >
                        重命名
                    </MenuItem>
                )}
                {/* 在这个文件夹**里面**新建笔记。inkstone 也有这一项。
                    ⚠️ 左栏标题那颗「新建笔记」只在**选中**了文件夹时才落到该文件夹，
                    没选中时落到「未归类」；这里是从具体某个文件夹的菜单进的，落点是明确的。 */}
                {onCreateNoteIn && (
                    <MenuItem
                        data-folder-op='new-note-here'
                        onClick={() => {
                            const id = menuId;
                            setMenuId(null);
                            if (id !== null) onCreateNoteIn(id);
                        }}
                    >
                        在此新建笔记
                    </MenuItem>
                )}
                {onCreateChild && (
                    <MenuItem data-folder-op='new-child' onClick={() => {
                        const id = menuId; setMenuId(null);
                        if (id !== null) onCreateChild(id);
                    }}>新建子文件夹</MenuItem>
                )}
                {onAppearance && (
                    <MenuItem
                        data-folder-op='appearance'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) onAppearance(id);
                        }}
                    >
                        文件夹外观
                    </MenuItem>
                )}
                {onMove && (
                    <MenuItem
                        data-folder-op='move-to'
                        onClick={() => {
                            // 二级菜单：目标文件夹得另开一个 Menu 列出来
                            setMoveId(menuId);
                            setMoveAnchor(anchorEl);
                        }}
                    >
                        移动到…
                    </MenuItem>
                )}
                {onReorder && (
                    <MenuItem
                        data-folder-op='move-up'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) void onReorder(id, -1);
                        }}
                    >
                        向前移动
                    </MenuItem>
                )}
                {onReorder && (
                    <MenuItem
                        data-folder-op='move-down'
                        onClick={() => {
                            const id = menuId; setMenuId(null);
                            if (id !== null) void onReorder(id, 1);
                        }}
                    >
                        向后移动
                    </MenuItem>
                )}
                {onMove && (
                    <MenuItem data-folder-op='move-root' onClick={() => {
                        const id = menuId; setMenuId(null);
                        if (id !== null) onMove(id, null);
                    }}>移到根目录</MenuItem>
                )}
                {onAskRemove && (
                    <MenuItem
                        data-folder-op='remove'
                        onClick={() => {
                            const id = menuId;
                            setMenuId(null);
                            // 同理，删除的二次确认也走上层的 ConfirmDialog
                            if (id !== null) onAskRemove(id, items.find(i => i.id === id)?.name ?? "");
                        }}
                        // 删除是危险动作：跟 inkstone 一样用红色示警
                        sx={{ color: "error.main" }}
                    >
                        删除文件夹
                    </MenuItem>
                )}
            </Menu>
            {/* 「移动到…」的二级菜单：根目录 + 其余**合法的**目标文件夹。
                ⚠️ 不能把自己、以及自己的后代列进去 —— 那会把父子关系绕成环
                （后端 validateFolderParent 会拒，但界面先拦一道更省事）。 */}
            <Menu
                open={moveId !== null}
                anchorEl={moveAnchor}
                onClose={() => {
                    setMoveId(null);
                    setMoveAnchor(null);
                    setMenuId(null);
                    setAnchorEl(null);
                }}
                slotProps={{ paper: { sx: { minWidth: 160, maxHeight: 320 } } }}
            >
                <MenuItem
                    data-move-target='root'
                    onClick={() => {
                        const id = moveId;
                        setMoveId(null);
                        setMoveAnchor(null);
                        setMenuId(null);
                        setAnchorEl(null);
                        if (id !== null) onMove?.(id, null);
                    }}
                >
                    根目录
                </MenuItem>
                {moveId !== null &&
                    items
                        .filter(f => f.id !== moveId && !isDescendant(items, f.id, moveId))
                        .map(f => (
                            <MenuItem
                                key={f.id}
                                data-move-target={f.id}
                                onClick={() => {
                                    const id = moveId;
                                    setMoveId(null);
                                    setMoveAnchor(null);
                                    setMenuId(null);
                                    setAnchorEl(null);
                                    if (id !== null) onMove?.(id, f.id);
                                }}
                            >
                                {f.name}
                            </MenuItem>
                        ))}
            </Menu>
        </Box>
    );
}

/** 分栏比例的持久化键。按账号分桶：换账号后各用各的宽度习惯。 */
const SPLIT_KEY = "notes.splitRatio";
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

// ---------- 左两列的宽度（2026-10-06：用户报「太窄了，要能拖」） ----------
//
// 128 / 208 是当初照着「1360 宽窗口下编辑区还剩 1000 出头」定的死值，
// 但用户自己的窗口大小、想给文件夹名多少空间，各人不同 —— 固定值就必然有人嫌窄。
// 两个键都按账号分桶（与 UI 偏好同一套 scopedKey），换账号后各用各的习惯。
const NAV_W_KEY = "notes.navColW";
const LIST_W_KEY = "notes.listColW";
const NAV_W_MIN = 104;
const NAV_W_MAX = 260;
const LIST_W_MIN = 150;
const LIST_W_MAX = 460;

/** 读一个宽度；越界或读不到就用默认值（手改过 localStorage / 老版本的值都在这儿兜住） */
function readColW(key: string, fallback: number, min: number, max: number): number {
    try {
        const n = Number(globalThis.localStorage?.getItem(key));
        return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
    } catch {
        return fallback;
    }
}

function writeColW(key: string, value: number): void {
    try {
        globalThis.localStorage?.setItem(key, String(value));
    } catch {
        /* 隐私模式下写不了，忽略 */
    }
}

/**
 * 拖动两列之间的那条缝。
 *
 * ⚠️ 两个必须这么写的理由（都是这仓库踩过的）：
 *   1. 事件处理函数是 mousedown 那一刻挂上 window 的闭包，拖动中的 setState
 *      **改不到它读到的 state**。最新宽度只能靠 ref 跟住（分隔条那次同类问题）。
 *   2. 松手时别调「从 localStorage 读」的那个函数 —— 读回来必然是拖动前的旧值。
 */
function useColumnResize() {
    const [navW, setNavW] = useState(() => readColW(NAV_W_KEY, NAV_COL_W, NAV_W_MIN, NAV_W_MAX));
    const [listW, setListW] = useState(() =>
        readColW(LIST_W_KEY, LIST_COL_W, LIST_W_MIN, LIST_W_MAX)
    );
    const navRef = useRef(navW);
    const listRef = useRef(listW);

    /** 拖动哪一列。nav 的起点是它的左边缘，list 的起点是「导航列右边缘」。 */
    const startDrag = useCallback((which: "nav" | "list") => (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startNav = navRef.current;
        const startList = listRef.current;

        const onMove = (ev: MouseEvent) => {
            const d = ev.clientX - startX;
            if (which === "nav") {
                // 导航列不能吃掉整个左栏：给列表列留至少 LIST_W_MIN
                const next = Math.round(
                    Math.min(NAV_W_MAX, Math.max(NAV_W_MIN, startNav + d))
                );
                navRef.current = next;
                setNavW(next);
            } else {
                // 列表列拖太宽会把编辑区挤没，这里再卡一道「左栏最多占窗口 45%」
                const room = Math.max(LIST_W_MIN, Math.floor(window.innerWidth * 0.45) - startNav);
                const next = Math.round(
                    Math.min(Math.min(LIST_W_MAX, room), Math.max(LIST_W_MIN, startList + d))
                );
                listRef.current = next;
                setListW(next);
            }
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.userSelect = "";
            if (which === "nav") writeColW(NAV_W_KEY, navRef.current);
            else writeColW(LIST_W_KEY, listRef.current);
        };
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, []);

    /** 双击那条缝 = 回默认宽度（与分隔条双击回对半同一套手势） */
    const reset = useCallback((which: "nav" | "list") => () => {
        if (which === "nav") {
            navRef.current = NAV_COL_W;
            setNavW(NAV_COL_W);
            writeColW(NAV_W_KEY, NAV_COL_W);
        } else {
            listRef.current = LIST_COL_W;
            setListW(LIST_COL_W);
            writeColW(LIST_W_KEY, LIST_COL_W);
        }
    }, []);

    return { navW, listW, startDrag, reset };
}

/**
 * 两条列之间的可拖分隔条。
 *
 * 做法照抄 inkstone 的 `src/client/features/shell/Resizer.tsx`：
 * **命中区 9px + 负外边距 −4px**（实际可点 ≈17px）、静止 1px 发丝线、
 * hover/拖动时 2px 并变强调色，过渡 220ms `cubic-bezier(.22,1,.36,1)`。
 * 没有发光也没有阴影 —— inkstone 那种「只有一根细线」反而比描一圈更好看，
 * 之前我们给两栏都加了完整 border + 圆角 + 淡底色，看着像两张卡片拼起来，很脏。
 *
 * ⚠️ 键盘可达（Tab 聚焦后 ←/→ 调、Home/End 到头、双击复位）：
 * 这是 a11y 基线要求，不是装饰。
 */
function ColResizeHandle({
    label,
    onDrag,
    onReset,
    onNudge,
    ratio,
}: {
    label: string;
    onDrag: (e: React.MouseEvent) => void;
    onReset: () => void;
    /** 键盘左右微调（比例）。不传就没有方向键支持。 */
    onNudge?: (delta: number) => void;
    /** 当前比例，仅用于 aria-valuenow。 */
    ratio?: number;
}) {
    return (
        <Box
            role='separator'
            aria-orientation='vertical'
            aria-label={label}
            aria-valuenow={ratio === undefined ? undefined : Math.round(ratio * 100)}
            aria-valuemin={20}
            aria-valuemax={80}
            tabIndex={0}
            title={`${label}（双击回到默认宽度）`}
            onMouseDown={onDrag}
            onDoubleClick={onReset}
            onKeyDown={e => {
                if (!onNudge) return;
                // ←/→ 各 2%，Home/End 到两端。跟 inkstone 的 keyboardStep 一致。
                if (e.key === "ArrowLeft") onNudge(-0.02);
                else if (e.key === "ArrowRight") onNudge(0.02);
                else if (e.key === "Home") onNudge(-1);
                else if (e.key === "End") onNudge(1);
                else return;
                e.preventDefault();
            }}
            sx={{
                // 命中区 9px，向两侧各溢出 4px（inkstone 的 -mx-[4px]）
                width: 9,
                mx: "-4px",
                flexShrink: 0,
                cursor: "col-resize",
                bgcolor: "transparent",
                position: "relative",
                zIndex: 1,
                // 下面两条是「拖得动」的关键，不是装饰：
                //   - `alignSelf: stretch` + `minHeight`：父容器是 flex，
                //     不显式拉伸的话这条会**塌成 0 高度**（2026-10-06 的真机 bug：
                //     真机量到 h=0，鼠标点不中；而合成事件绕过命中测试，单测全绿）。
                //   - `touchAction: none`：触屏上浏览器会把手势当成滚动，
                //     拖动直接被滚动手势吃掉。
                alignSelf: "stretch",
                minHeight: 120,
                touchAction: "none",
                userSelect: "none",
                outline: "none",
                "&:focus-visible": { outline: "none" },
                // 常驻一条发丝线：用 span 而不是 ::after —— ::after 是伪元素，
                // 自动化测试量不到它的宽度（Chrome 会把 width 回退成宿主宽度）。
                "& > span": {
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: "50%",
                    // ⚠️ 必须写 '1px'，**不能**写 1 ——
                    // MUI 的 sizing transform 把 `width: 1` 当成 `100%`，
                    // 于是这条「发丝线」被拉满整个 9px 命中区，看着就是一条粗带子
                    // （真机量到 width=9px；单测/jsdom 量不到，一直是绿的）。
                    width: "1px",
                    transform: "translateX(-50%)",
                    bgcolor: "var(--card-border)",
                    transition:
                        "background-color var(--dur-base, 220ms) var(--ease-out, ease), width var(--dur-base, 220ms) var(--ease-out, ease)",
                    pointerEvents: "none",
                },
                // hover / 键盘聚焦 / 拖动中：线加粗并变强调色（inkstone 同款）
                "&:hover > span, &:focus-visible > span, &[data-dragging='1'] > span": {
                    width: "2px",
                    bgcolor: "var(--accent)",
                },
            }}
        >
            <span aria-hidden="true" />
        </Box>
    );
}

/**
 * 保存状态指示（inkstone 的 `SaveIndicator`，只是从它的 SVG 圆环简化来的）。
 *
 * ⚠️ 为什么搬到这里：inkstone 的 footer（状态栏）只放「这篇多长、它是谁」，
 * 保存状态挂在**头部**。我们之前把「已保存 · 3分钟前」写在状态栏右端，
 * 于是那一行既想报长度又想报状态，26px 根本塞不下 —— 搬上来之后状态栏才干净。
 *
 * 三态与 inkstone 一一对应：
 *   saving → 强调色圆环转圈 / pending（有改动）→ 灰点 / saved → 绿勾
 */
function SaveDot({
    state,
    dirty,
    savedAt,
    now,
}: {
    state: "idle" | "pending" | "saving" | "saved";
    dirty: boolean;
    savedAt: number | null;
    now: number;
}) {
    const label =
        state === "saving"
            ? "正在保存…"
            : dirty || state === "pending"
              ? "有改动，即将保存…"
              : savedAt
                ? `已保存 · ${formatRelative(savedAt, new Date(now))}`
                : "已保存";
    const tone =
        state === "saving"
            ? "var(--accent)"
            : dirty || state === "pending"
              ? "text.disabled"
              : "#2e9e6b";
    return (
        <Tooltip title={label}>
            <Box
                role='img'
                aria-label={label}
                data-save-dot={state}
                data-dirty={dirty ? "1" : "0"}
                sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    color: tone,
                }}
            >
                <Box
                    aria-hidden="true"
                    sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        border: "1.6px solid currentColor",
                        opacity: state === "saving" ? 0.35 : 1,
                        ...(state === "saving"
                            ? {
                                  borderTopColor: "transparent",
                                  animation: "note-save-spin .72s linear infinite",
                              }
                            : dirty || state === "pending"
                              ? { bgcolor: "currentColor", border: "none", opacity: 0.45 }
                              : { bgcolor: "currentColor", border: "none" }),
                    }}
                />
            </Box>
        </Tooltip>
    );
}

/**
 * 自动保存的防抖间隔**默认值**（阶段四第 14 条）。
 *
 * 3 秒是「打字不被打断」和「关掉不至于丢太多」之间的折中：1 秒太勤（每个停顿都发一次
 * 请求，离线队列里会攒一堆无用 PATCH），10 秒太长（关窗口就丢几秒的字）。
 * 真关窗口还有卸载前那次 flush 兜底，所以 3 秒不会真丢东西。
 *
 * ⚠️ 2026-10-07：真正生效的值是设置面板里的「自动保存延迟」
 * （notes.uiSettings.autosaveMs），这里只作为它的默认/兜底值。
 */
const AUTO_SAVE_MS = 3000;

/** 主栏↔侧栏比例的持久化（与列宽同一套思路：越界回落默认值） */
const PANE_RATIO_KEY = "notes.paneRatio";
function readPaneRatio(): number {
    try {
        const n = Number(globalThis.localStorage?.getItem(PANE_RATIO_KEY));
        return Number.isFinite(n) && n >= 0.2 && n <= 0.8 ? n : 0.5;
    } catch {
        return 0.5;
    }
}
function writePaneRatio(value: number): void {
    try {
        globalThis.localStorage?.setItem(PANE_RATIO_KEY, String(value));
    } catch {
        /* 隐私模式写不了，忽略 */
    }
}

function readSplitRatio(): number {
    try {
        const raw = globalThis.localStorage?.getItem(SPLIT_KEY);
        const n = Number(raw);
        return Number.isFinite(n) && n >= MIN_RATIO && n <= MAX_RATIO ? n : 0.5;
    } catch {
        return 0.5;
    }
}

export default function NotesPage({
    shareApi,
    uploadApi,
    backupApi,
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
    onNotify,
    folderTags,
}: NotesPageProps) {
    const [keyword, setKeyword] = useState("");
    /** 左栏视图：全部 / 最近 / 收藏（回收站要软删字段，留到阶段三） */
    const [view, setView] = useState<NoteView>("all");
    /** 中间栏排序（中栏右上角「排序」菜单）。
     *  default = 置顶优先 + 原始顺序；title/created 按字面排序。 */
    const [sortKey, setSortKey] = useState<"default" | "title" | "created">("default");
    const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
    /** 「收起」：中栏右上角把列表收起；切视图 / 选文件夹 / 点搜索框时自动展开 */
    const [middleHidden, setMiddleHidden] = useState(false);
    /**
     * tablet（768~1180）的导航抽屉（2026-10-08 照 inkstone 的 AppShell）：
     * 顶部一条 44px 栏放「导航栏」按钮 + 搜索框，导航列以 272px 左侧抽屉展开；
     * 导航列在窄屏不再内联渲染（desktop 才有），列表列收起后整个左区让给编辑区。
     */
    const [navDrawerOpen, setNavDrawerOpen] = useState(false);
    /** 编辑区头部「导出」下拉（2026-10-08 照 inkstone：Download 按钮 + 三格式菜单） */
    const [exportAnchor, setExportAnchor] = useState<HTMLElement | null>(null);
    /** 阶段三收尾：导航列里选中的文件夹 / 标签（选中任一个就只看那一份） */
    const [activeFolder, setActiveFolder] = useState<number | null>(null);
    const [activeTag, setActiveTag] = useState<number | null>(null);
    /**
     * 新建文件夹/标签 —— 走站内的 NamePromptDialog，不再用 window.prompt。
     * `parentId` 有值就是「新建子文件夹」，两个入口共用同一个弹窗，行为一致。
     */
    const [namePrompt, setNamePrompt] = useState<
        | {
              kind: "folder" | "tag";
              title: string;
              description?: string;
              defaultValue?: string;
              confirmText: string;
              /** 只有文件夹有：新建子文件夹时要挂到谁下面 */
              parentId: number | null;
              /** 重命名时：要改的是哪一个 */
              renameId?: number;
          }
        | null
    >(null);
    const askName = useCallback(
        (
            kind: "folder" | "tag",
            options: {
                parentId?: number | null;
                defaultValue?: string;
                title?: string;
                description?: string;
                renameId?: number;
            } = {}
        ) => {
            const parentId = options.parentId ?? null;
            setNamePrompt({
                kind,
                parentId,
                renameId: options.renameId,
                title:
                    options.title ??
                    (kind === "folder"
                        ? parentId
                            ? "新建子文件夹"
                            : "新建文件夹"
                        : "新建标签"),
                description: options.description,
                defaultValue: options.defaultValue,
                confirmText: options.renameId !== undefined ? "保存" : kind === "folder" ? "新建文件夹" : "新建标签",
            });
        },
        []
    );
    const closeNamePrompt = useCallback(() => setNamePrompt(null), []);

    /**
     * 删除分类的二次确认（替代 window.confirm）。
     * 说清影响面：文件夹里的笔记**不会**被删，只是回到「未归类」——
     * 这点必须写出来，否则用户会以为连带笔记一起没了而不敢点。
     */
    const [removeTarget, setRemoveTarget] = useState<{
        kind: "folder" | "tag";
        id: number;
        name: string;
    } | null>(null);
    const closeRemove = useCallback(() => setRemoveTarget(null), []);
    /** 阶段二：左栏可折叠（照 inkstone 的 196↔9，我们这边是 300↔44 的图标轨） */
    const [listCollapsed, setListCollapsed] = useState(false);
    /** 左两列的宽度（可拖动，持久化到 localStorage） */
    const { navW, listW, startDrag, reset } = useColumnResize();
    /**
     * 列表行的操作菜单：记住是哪条笔记（noteId）+ 锚在哪（el）。
     *
     * ⚠️ 存 noteId 而不是 note 本身：菜单开着的时候那条笔记可能被自动保存刷新成
     * 新对象，存旧引用会拿过期数据去渲染菜单项。
     */
    const [rowMenu, setRowMenu] = useState<{
        noteId: number;
        /** ⋯按钮打开=元素本身；右键打开=鼠标坐标虚拟元素（见 anchorAtMouse） */
        el: MenuAnchor;
        /** 菜单从哪里打开：列表行菜单全量；左栏内联笔记给精简菜单（inkstone 同款） */
        source: "list" | "rail";
    } | null>(null);
    /** 正在拖的笔记行（半透明反馈，与文件夹那边同一套观感） */
    const [draggingNoteId, setDraggingNoteId] = useState<number | null>(null);
    /** 「编辑标签」二级弹窗的锚点 */
    const [tagPick, setTagPick] = useState<{ el: MenuAnchor; noteId: number } | null>(null);
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    /** 用户主动清空过选择（把当前这条移到回收站）—— 见下面那条自动选中的 effect */
    const userClearedRef = useRef(false);
    const [pane, setPane] = useState<Pane>("split");
    /** 分栏比例（源码 : 预览）。可拖拽，记住上一次。 */
    const [splitRatio, setSplitRatio] = useState(readSplitRatio);
    /**
     * 拖分隔条时的**实时**比例。为什么要单独一个 ref：
     * `onMove` / `onUp` 是在 mousedown 那一刻挂上 window 的闭包，拖动过程中的
     * `setSplitRatio` 不会回头改写它们读到的 `splitRatio` —— 那个值会一直停在按下鼠标那一刻。
     * 松手时要持久化的是**松开那一刻**的比例，只能靠这个 ref 跟住。
     */
    const splitRatioRef = useRef(splitRatio);
    const splitBoxRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<NoteEditorHandle | null>(null);
    /** 草稿：编辑期间不立刻写库（点「保存」或切走才提交） */
    const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
    const [mobileDetail, setMobileDetail] = useState(false);
    /**
     * 三栏断点（2026-10-07）：desktop 三栏 / tablet 收导航 / mobile 两屏。
     *
     * ⚠️ 之前**完全没有断点**，三栏宽度全是写死的像素（导航 128 + 列表 208），
     * 唯一一处 `md:`（MUI 默认 900px）只用来切「列表/编辑」两屏。
     * 后果：浏览器缩放 125% 时 1080px 窗口在 CSS 里只剩 864px，跨过 900px 那条线，
     * 编辑区被压成 **0 宽**（真机量到 edW=0）—— 工具栏、正文、状态栏全都看不见，
     * 用户报「右边内容超出不可见」。缩放 150% 以上更糟。
     *
     * 现在跟着 inkstone 的两��线走（见 usePanelBreakpoint.ts）：
     *   ≥1180 三栏 ≥768 两栏（收导航） <768 两屏切换
     */
    const bp = usePanelBreakpoint();
    /** 窄屏（tablet/mobile）下左两列要收起来，只留列表 + 编辑区 */
    const narrowLayout = bp !== "desktop";
    // ⚠️ 不要自动弹导航抽屉（2026-10-09 用户明确）：桌面关着中栏拖窄、tablet 里点
    // 「收起列表」，两条路径都**不该**自动弹抽屉 —— 左区让位给编辑区就好，
    // 要导航时用户自己点顶部栏的「导航栏」按钮。此前这里有个
    // `bp==="tablet" && middleHidden → setNavDrawerOpen(true)` 的 effect，已删。
    // ⚠️ 2026-10-08 用户报「调整窗口后最左侧栏显示不出」→ 当天先修成「跨进窄布局
    // 复位桌面态」，用户复访后改为：**窄屏里关掉列表列（middleHidden）后左侧要显示
    // 导航栏**（与桌面「关中栏剩导航列」同一语义），不要收成图标轨。于是规则改成
    // 「二选一常驻」：窄布局里 listHidden → 导航列显示、列表列不渲染；否则相反。
    // 这样任何状态都自带出口（导航列里的视图按钮都会 setMiddleHidden(false)），
    // 也不需要复位 effect 了 —— 桌面关着中栏拖窄，导航列直接顶上，语义连续。

    // ---------- 编辑器工具集（2026-10-06 抽进 useEditorTools） ----------
    //
    // 主编辑器与「侧边打开」的第二台编辑器各拿一份：插入/撤销状态（lastInsertRef 等）
    // 随实例隔离，主编辑器撤销不会误伤侧编辑器刚插入的片段。
    // ⚠️ hooks 不能条件调用：侧编辑器没开时 sideRef.current 是 null，
    // 回调内部判空兜住，不会有副作用。
    const sideRef = useRef<NoteEditorHandle | null>(null);
    const [sideId, setSideId] = useState<number | null>(null);
    const [sideDraft, setSideDraft] = useState<EditorDraft | null>(null);
    /**
     * 侧边栏自己的查看模式：与主编辑区的 pane **互不相干**（2026-10-07）。
     * 三档与主栏一致（编辑 / 分栏 / 预览），只是窄栏里的「分栏」是上下排 —— 用户要
     * 「两边都能切」，不是只有主栏能。
     */
    const [sideMode, setSideMode] = useState<"edit" | "split" | "preview">("edit");
    /**
     * 侧栏「分栏」模式里源码 / 预览的比例（2026-10-08 新增可拖）：
     * 之前这条缝只是装饰（没有 onMouseDown），两栏写死 flex:1 固定 50/50，拖不动。
     * 沿用主栏 startSplitDrag 的那套 —— 比例按内容盒算、用 ref 跟住最新值、松手存 localStorage。
     */
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
    /** 侧栏的保存状态（与主栏 saveState 同一套语义，状态栏要显示） */
    const [sideSaveState, setSideSaveState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
    const [sideSavedAt, setSideSavedAt] = useState<number | null>(null);
    const [sideTick, setSideTick] = useState(() => Date.now());
    /**
     * 即时渲染（inkstone 顶栏那个同名开关）：开着=打字时预览跟着刷新；关掉=预览
     * 停在「上一次存库的内容」，长文里打字会流畅很多（每敲一下都要重解析整篇）。
     * 每栏各一份，跟着那一栏走。
     */
    /**
     * 「即时渲染」的渲染函数：编辑器用它把**非当前段落**整块替换成渲染后的样子
     * （inkstone 同款做法，见 NoteEditorLivePreview.ts）。
     * 关掉时传 null，编辑器就是纯源码。
     */
    const liveRenderer = useCallback(
        (source: string): Promise<ReactNode> => renderMarkdownToReact(source, {}),
        []
    );
    const tools = useEditorTools(textareaRef, setDraft);
    /** 大纲跳转 = 主编辑器的光标跳转（原局部实现已抽进 hook） */
    const jumpToOffset = tools.jumpToOffset;
    const sideTools = useEditorTools(sideRef, setSideDraft);

    /**
     * 快捷键动作表（inkstone 的 `EDITOR_SHORTCUTS.run`）。
     *
     * ⚠️ 为什么要过一层而不是直接给编辑器：这些动作要作用于**编辑器里真实的选区**，
     * 而 useEditorTools 走的是 textareaRef（宿主 handle），本身就能改 CM 的选区。
     * 统一由这里注入，快捷键和工具栏按钮因此共用同一套实现 ——
     * 不会出现「按钮能用、快捷键行为不一样」这种分裂。
     */
    const mainShortcutActions = useMemo<Record<string, () => void>>(
        () => ({
            bold: () => tools.insertAtCursor("**", "**", "粗体"),
            italic: () => tools.insertAtCursor("*", "*", "斜体"),
            strikethrough: () => tools.insertAtCursor("~~", "~~", "删除"),
            highlight: () => tools.insertAtCursor("==", "==", "高亮"),
            "inline-code": () => tools.insertAtCursor("`", "`", "code"),
            link: () => tools.insertAtCursor("[", "](https://)", "链接文字"),
            comment: () => tools.onInsertHiddenComment(),
            paragraph: () => tools.setHeadingLevel(0),
            h1: () => tools.setHeadingLevel(1),
            h2: () => tools.setHeadingLevel(2),
            h3: () => tools.setHeadingLevel(3),
            h4: () => tools.setHeadingLevel(4),
            h5: () => tools.setHeadingLevel(5),
            h6: () => tools.setHeadingLevel(6),
            "bullet-list": () => tools.toggleLinePrefix("- "),
            "ordered-list": () => tools.toggleLinePrefix("1. "),
            "task-list": () => tools.toggleLinePrefix("- [ ] "),
            quote: () => tools.toggleLinePrefix("> "),
        }),
        [tools]
    );
    /** 侧栏那台编辑器用自己的动作表（undo 栈互相隔离，不能共用主栏的 ref） */
    const sideShortcutActions = useMemo<Record<string, () => void>>(
        () => ({
            bold: () => sideTools.insertAtCursor("**", "**", "粗体"),
            italic: () => sideTools.insertAtCursor("*", "*", "斜体"),
            strikethrough: () => sideTools.insertAtCursor("~~", "~~", "删除"),
            highlight: () => sideTools.insertAtCursor("==", "==", "高亮"),
            "inline-code": () => sideTools.insertAtCursor("`", "`", "code"),
            link: () => sideTools.insertAtCursor("[", "](https://)", "链接文字"),
            comment: () => sideTools.onInsertHiddenComment(),
            paragraph: () => sideTools.setHeadingLevel(0),
            h1: () => sideTools.setHeadingLevel(1),
            h2: () => sideTools.setHeadingLevel(2),
            h3: () => sideTools.setHeadingLevel(3),
            h4: () => sideTools.setHeadingLevel(4),
            h5: () => sideTools.setHeadingLevel(5),
            h6: () => sideTools.setHeadingLevel(6),
            "bullet-list": () => sideTools.toggleLinePrefix("- "),
            "ordered-list": () => sideTools.toggleLinePrefix("1. "),
            "task-list": () => sideTools.toggleLinePrefix("- [ ] "),
            quote: () => sideTools.toggleLinePrefix("> "),
        }),
        [sideTools]
    );

    // ---------- 设置（外观 / 编辑器） ----------
    const [uiSettings, setUiSettings] = useState<NotesUiSettings>(loadNotesSettings);
    // 「即时渲染」存进设置（跨会话保留，两栏共用同一个值）；标题行那颗开关只改设置。
    // ⚠️ 必须声明在 uiSettings 之后 —— 它是从设置派生出来的。
    const liveRender = uiSettings.liveRender;
    const setLiveRender = (updater: boolean | ((v: boolean) => boolean)) =>
        setUiSettings(cur => ({
            ...cur,
            liveRender: typeof updater === "function" ? updater(cur.liveRender) : updater,
        }));
    const sideLiveRender = uiSettings.liveRender;
    const setSideLiveRender = setLiveRender;
    const [settingsOpen, setSettingsOpen] = useState(false);
    useEffect(() => {
        saveNotesSettings(uiSettings);
    }, [uiSettings]);
    /** 自动保存间隔（设置面板可调；兜底回落到默认值） */
    const autosaveMs = uiSettings.autosaveMs || AUTO_SAVE_MS;
    /**
     * 预览功能开关（公式 / 图表 / 折叠代码块）。
     * ⚠️ 必须 useMemo 稳定引用：MarkdownPreview 的解析 effect 依赖它，
     * 每次渲染都造新对象会让预览无限重新解析（输入一个字重渲一次）。
     */
    const previewFeatures = useMemo<RenderFeatures>(
        () => ({
            math: uiSettings.mathRender,
            mermaid: uiSettings.mermaidRender,
            foldCode: uiSettings.foldCode,
            foldCodeLines: uiSettings.foldCodeLines,
        }),
        [uiSettings.mathRender, uiSettings.mermaidRender, uiSettings.foldCode, uiSettings.foldCodeLines]
    );
    /**
     * 主栏 ↔ 侧栏的分栏比例（0.2~0.8，记住上一次）。
     * ⚠️ 2026-10-07 先按「固定 50/50 不可拖」做，当天用户又要求「能拖动改大小」——
     * 两条需求各成立一半，最后按后者做：默认 50/50，但可以拖，拖完记住。
     */
    const [paneRatio, setPaneRatio] = useState(() => readPaneRatio());
    const paneRatioRef = useRef(paneRatio);
    const [sideResizing, setSideResizing] = useState(false);
    const startPaneDrag = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const row = paneRowRef.current;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        const total = rect.width;
        if (total <= 0) return;
        setSideResizing(true);
        const onMove = (ev: MouseEvent) => {
            const ratio = (ev.clientX - rect.left) / total;
            const next = Math.min(0.8, Math.max(0.2, ratio));
            paneRatioRef.current = next;
            setPaneRatio(next);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            setSideResizing(false);
            writePaneRatio(paneRatioRef.current);
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }, []);
    const resetPaneRatio = useCallback(() => {
        paneRatioRef.current = 0.5;
        setPaneRatio(0.5);
        writePaneRatio(0.5);
    }, []);
    /** 键盘微调比例（←/→ 各 2%，Home/End 到两端）—— 分隔条 a11y 的一部分 */
    const nudgePaneRatio = useCallback((delta: number) => {
        const next = Math.min(0.8, Math.max(0.2, paneRatioRef.current + delta));
        paneRatioRef.current = next;
        setPaneRatio(next);
        writePaneRatio(next);
    }, []);
    /** 预览窗的滚动容器（滚动同步要拿它算位置） */
    const previewScrollRef = useRef<HTMLDivElement | null>(null);
    /** 两栏（主栏 | 侧栏）那一行，拖动时用它量总宽 */
    const paneRowRef = useRef<HTMLDivElement | null>(null);
    /**
     * 滚动同步（设置面板「滚动同步」）：源码滚到哪，预览跟到哪。
     *
     * ⚠️ 2026-10-17 换成**按源码行锚点**定位（对齐 inkstone 的
     * features/workspace/sync-scroll.ts）。之前是「按比例」：
     * `previewTop = ratio * (previewScrollHeight - clientHeight)`。
     * 比例对齐在两栏**总高度不同**时必然漂移 —— 真机量过一篇
     * 「8 个二级标题 + 12 行代码块 + 8 个附录」的笔记：源码内容高 2722px、
     * 预览内容高 2174px（差 20%，因为标题在预览里是大号字、代码块有横向内边距）。
     * 滚到一半时两边其实停在不同的段落，用户看到的就是「一起滚但对不上」。
     *
     * 现在的做法：渲染时每个块带 `data-line`（源码行号，见 markdownToReact
     * 的 anchorProps），滚动时取「视口顶部那一行」在锚点曲线里插值。
     *
     * 注意 `syncPreviewScroll` 这个名字保留：它现在是「驱动方」的入口，
     * 真正的绑定在下面的 useEffect（要同时监听 wheel/pointerdown 才能防反馈环）。
     */
    const syncPreviewScroll = useCallback((_ratio: number) => {
        // 真正的同步在 syncScrollRef 那条链路里；这里保留是为了兼容
        // NoteEditor 的 onScrollRatio 回调（它报的「比例」已不再用于定位）。
    }, []);

    /**
     * 把「上传一张图」转交给 uploadApi（2026-07）。
     *
     * ⚠️ uploadApi 是**可选**的：后端没配存储（R2 / KV 都没绑）时它不存在。
     * 这里不抛错、而是返回一个被拒的 Promise —— 让工具栏的调用点自己走 catch
     * 去提示用户；工具栏那边还会因为拿不到这个能力而把菜单项置灰。
     */
    const handleUpload = useCallback(
        async (file: File, noteId: number | null) => {
            if (!uploadApi) {
                throw new Error("服务器未配置图片存储，上传暂不可用");
            }
            const result = await uploadApi.uploadAttachment(file, noteId);
            // ⚠️ 别无条件把返回值往下传（2026-10-07 真机实测的坑）：
            // 只要后端/中间层回了个「200 但不是我们预期的 JSON」（错误页、代理拦截、
            // SPA 兜底把 /api/ 开头的路径回落成 index.html），拿到的就是 `{success:true}`
            // 之类的东西 —— url 与 filename 全是 undefined，而 fetch(undefined) 会
            // 去请求**当前页面**、拿到 HTML 还当成图片内嵌，正文里就出现
            // `![undefined](data:text/html;base64,...)`，用户根本看不懂哪里错了。
            // 宁可在这里拦下来报一句人话。
            if (!result?.url || !result?.filename) {
                throw new Error("上传返回的数据不完整（缺少图片地址），请重试");
            }
            return { url: result.url, filename: result.filename, size: result.size };
        },
        [uploadApi]
    );

    // 滚动同步控制器：只在「分栏 + 设置里开着」时启用（inkstone 同条件，
    // Workspace.tsx:241 的 `settings.preview.syncScroll && showSplit`）。
    const syncScrollRef = useRef<ReturnType<typeof createScrollSync> | null>(null);
    useEffect(() => {
        if (pane !== "split" || !uiSettings.scrollSync) return;
        // ⚠️ 不能一上来就 document.querySelector 再 return —— 切到分栏的**那一刻**
        // 预览层还没挂上，previewScrollRef.current 是 null，于是这个 effect
        // 直接退出、之后也不再重跑（依赖没变），滚动同步就永远不生效。
        // 真机症状：拖源码，预览纹丝不动。
        //
        // 解法：轮询等 ref 到位再绑定。
        // ⚠️⚠️ 这里**绝不能**用 useState 做「重新渲染」的触发器 —— 它在 useEffect
        // 内部调用，违反 Hooks 规则，真机直接白屏（React error #321:
        // "Invalid hook call"，因为 effect 里的 hook 顺序和渲染顺序对不上）。
        // 需要重跑时用 `activeId` / `pane` 这些**已经在依赖数组里**的量。
        let cancelled = false;
        let unbind: (() => void) | null = null;
        let tries = 0;
        const tryBind = () => {
            if (cancelled) return;
            const edScroll = document.querySelector<HTMLElement>(
                "[data-editor-pane='1'] .cm-scroller"
            );
            const pvScroll = previewScrollRef.current;
            if (!edScroll || !pvScroll) {
                // 最多等 ~1.2s（30 × 40ms）；超了就认为环境不对，放弃而不是无限轮询
                if (++tries < 30) window.setTimeout(tryBind, 40);
                return;
            }
            const ctrl = createScrollSync({
                editorScroller: edScroll,
                previewScroller: pvScroll,
                lineCount: () => textareaRef.current?.lineCount() ?? 1,
                editorLineAtScroll: () => {
                    // 渲染的 data-line 是 0 基，CM 的行号是 1 基 —— 这里减 1 对齐
                    return Math.max(0, (textareaRef.current?.topLineNumber() ?? 1) - 1);
                },
                enabled: () => pane === "split" && uiSettings.scrollSync,
            });
            syncScrollRef.current = ctrl;
            unbind = ctrl.bind();
        };
        tryBind();
        return () => {
            cancelled = true;
            unbind?.();
            unbind = null;
            syncScrollRef.current = null;
        };
    }, [pane, uiSettings.scrollSync, activeId]);

    // ---------- 文件夹外观弹窗（icon / color） ----------
    const [appearanceFolderId, setAppearanceFolderId] = useState<number | null>(null);

    // ---------- 「移动到文件夹」右侧抽屉 ----------
    const [moveDrawerNoteId, setMoveDrawerNoteId] = useState<number | null>(null);

    // ---------- 在侧边打开（两个文档同时编辑） ----------
    // sideId / sideDraft / sideRef 已随工具集声明（hooks 顺序要求），这里只有派生状态

    // ---------- 大纲面板（预览窗右侧，inkstone 的「大纲」） ----------
    const [outlineOpen, setOutlineOpen] = useState(loadNotesSettings().defaultOutline);

    /** 顶栏「⋯」：对**当前打开的笔记**弹出与右键同一套操作菜单（右下角按键已并入） */
    const [activeMenuAnchor, setActiveMenuAnchor] = useState<HTMLElement | null>(null);

    // ⚠️ 这一行不能省。记事本自己是 `position: fixed` 的全屏层，压根不占文档流，
    // 但**底下的导航站主界面还挂载着**（卡片网格一两千像素高），document照样能滚。
    // 于是「记事本页面里」右侧有一条整页滚动条，拖它页面会动，看着像坏了。
    // 关掉记事本（组件卸载）时 hook 会自动把样式还原回去。
    useScrollLock(true);

    /**
     * 全屏 overlay 的键盘可达性（2026-10-06 补，之前完全没有）：
     *   - **Escape 关闭**：这是全屏页，用户被关在里面出不去（只能去点左上角那个箭头）
     *   - **Tab 焦点循环**：整页盖住主界面，Tab 走出去会落到**看不见的地方**，
     *     焦点跑到背景里之后用户完全不知道自己在哪，键盘路径直接断掉
     *
     * ⚠️ 依赖里那几项（dirty / save / outlineAnchor…）都声明在后面，直接进依赖数组会拿到
     * 「还没初始化的引用」。所以这里用 ref 跟着最新值 —— 事件回调里读 ref 永远拿到当次值，
     * 而 effect 的依赖可以保持空数组（顺带避免每改一次草稿就重挂一次监听）。
     */
    const pageRef = useRef<HTMLDivElement | null>(null);
    const overlayKeyState = useRef({
        dirty: false,
        save: null as null | (() => Promise<void>),
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

    /**
     * 搜索框的 DOM 节点。**必须一个位置一个 ref**（2026-10-07 踩过）：
     * 之前两处 `searchField` 共用同一个 `inputRef`，jsdom 下直接把整个
     * notes.dom 测试文件**堆爆内存**（FATAL: heap out of memory，1992 条断言全过但进程死掉）。
     * 原因：同一个 ref 被两个 <input> 争抢，React 每次 commit 都要「解绑旧的、绑上新的」，
     * 而条件渲染（`narrowLayout &&`）会让这两个 input 反复互换角色，
     * 于是 attach/detach 永远收敛不了。
     *
     * 现在是两个独立 ref，⌘K 聚焦**当前可见的那一个**（隐藏的 display:none 聚焦不到）。
     */
    const searchRef = useRef<HTMLInputElement | null>(null);
    const searchRefNarrow = useRef<HTMLInputElement | null>(null);
    /** 聚焦当前看得见的那个搜索框 */
    const focusSearch = useCallback(() => {
        const narrow = searchRefNarrow.current;
        const wide = searchRef.current;
        if (narrow && narrow.offsetParent !== null) narrow.focus();
        else wide?.focus();
    }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                // ⚠️ 必须同时切到「搜索」视图：光聚焦输入框的话，
                // 用户看到的还是当前视图（比如「归档」）筛出来的列表，
                // 打完字发现列表纹丝不动 —— 那是「快捷键没生效」的第一印象。
                setView("search");
                setActiveFolder(null);
                setActiveTag(null);
                focusSearch();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [focusSearch]);

    const active = useMemo(
        () => notes.find(n => n.id === activeId) || null,
        [notes, activeId]
    );

    // 回收站是懒加载：只有真的切到那个视图才去拉（首屏不该为没人看的列表发请求）
    useEffect(() => {
        if (view === "trash") void onLoadTrash();
    }, [view, onLoadTrash]);

    // 选中的笔记变了就把草稿换成它的内容（没在编辑时才换，避免打字被冲掉）
    useEffect(() => {
        if (active) setDraft({ title: active.title || "", content: active.content || "" });
    }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    /**
     * 阅读位置记忆（inkstone 的 reading-position.ts）。
     *
     * 切走时记下当前滚动比例，切回来时恢复。记比例而不是像素：
     * 窗口大小 / 面板宽度 / 是否分屏都会变，像素在不同环境下不是同一段内容。
     *
     * ⚠️ 恢复要等编辑器量高之后：切笔记时 CM 已经建好，但长文要几帧才撑开高度，
     * 此刻 scrollHeight 还是 0，直接写 scrollTop 会被浏览器夹成 0 ——
     * 表现就是「功能好像没生效」。handle.restoreScrollRatio 内部处理了重试。
     */
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

    /**
     * 首次进记事本要**自动选中第一条**（inkstone 打开就是「上次的笔记」）。
     *
     * ⚠️ 为什么必须补这一步（2026-10-06 真机量到）：`activeId` 只在**首次渲染**
     * 用 `notes[0]` 初始化，而真实环境里笔记是**异步**拉回来的 —— 挂载那一刻
     * notes 还是空数组，等数据到位 activeId 已经定型为 null，不会再变。
     * 症状是：列表里明明有两条笔记，右边编辑器却整块空着、大纲按钮灰着，
     * 得手动点一行才出内容（jsdom 单测里 notes 是同步传入的，所以测不出来）。
     *
     * ⚠️ 用户**主动**清空过选择时不要抢：把当前这条移到回收站之后，
     * 应该停在空状态让他自己挑下一条，而不是立刻弹一篇上来。
     */
    useEffect(() => {
        if (activeId !== null || userClearedRef.current) return;
        const first = notes.find(n => n.id !== undefined && !n.archived) ?? notes.find(n => n.id !== undefined);
        if (first?.id !== undefined) setActiveId(first.id);
    }, [activeId, notes]);

    // ---------- 阶段三收尾：文件夹 / 标签 ----------
    // ⚠️ 这三个必须在 `filtered` **之前**声明：过滤链要用 noteTags 判断「这条笔记挂了哪个标签」，
    // 放在下面就是 TDZ（used before its declaration）。
    // ⚠️ 三处 `?? []` 都必须包 useMemo：直接写 `?? []` 得到的是**每次渲染一个全新数组**，
    // 下游 folderCounts / tagCounts 两个 useMemo 会跟着每次渲染重算（lint 也会盯这条）。
    const folders = useMemo(() => folderTags?.folders ?? [], [folderTags]);
    const tags = useMemo(() => folderTags?.tags ?? [], [folderTags]);
    const noteTags = useMemo(() => folderTags?.noteTags ?? EMPTY_TAG_LINKS, [folderTags]);

    /**
     * 搜索命中的笔记（2026-10-06）。
     *
     * 比原来那个「标题 + 正文 includes」多搜了**标签名** —— 用户记不清笔记正文里
     * 有没有那个词，但记得「我给标了『合同』的那几条」，标签是唯一能想起来的线索。
     * 归档的笔记也一并搜：找东西的时候不会先想「这条是不是被我收起来了」。
     */
    const searchHits = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return [];
        return notes.filter(n => {
            if ((n.title || "").toLowerCase().includes(kw)) return true;
            if ((n.content || "").toLowerCase().includes(kw)) return true;
            const names = tagNamesOf(n, noteTags, tags).map(t => t.toLowerCase());
            return names.some(t => t.includes(kw));
        });
    }, [notes, keyword, noteTags, tags]);

    const filtered = useMemo(() => {
        // 搜索视图：只给命中列表，不受「文件夹 / 标签选中」叠加影响 ——
        // 用户搜东西时想看的是「所有命中」，再被一个残留的文件夹选中态筛一遍
        // 只会让人以为「搜不到」。没关键词时回落到全部。
        if (view === "search") {
            return keyword.trim() ? searchHits : notes.filter(n => !n.archived);
        }
        // 归档的笔记默认从「全部 / 最近 / 收藏 / 未归类」里隐去，只在「归档」视图露面
        const live = notes.filter(n => !n.archived);
        const byView = live.filter(n => {
            if (view === "starred") return Boolean(n.pinned);
            // 阶段三收尾：选中了某个文件夹（或标签）就只看那一份，
            // 和「全部 / 最近」这些视图是**叠加**关系，不是互斥的。
            // ⚠️ 但文件夹/标签只在 live 里筛 —— 归档的笔记不该出现在任何文件夹视图里，
            // 那个视图要看归档笔记得先切到「归档」。
            if (activeFolder !== null) return n.folder_id === activeFolder;
            if (activeTag !== null) return tagOf(n, noteTags).has(activeTag);
            return true;
        });
        const bySort =
            view === "recent"
                ? [...byView].sort(
                      (a, b) =>
                          (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                          String(b.updated_at || b.created_at || "").localeCompare(
                              String(a.updated_at || a.created_at || "")
                          )
                  )
                : byView;
        const kw = keyword.trim().toLowerCase();
        const matched = kw
            ? bySort.filter(
                  n =>
                      (n.title || "").toLowerCase().includes(kw) ||
                      (n.content || "").toLowerCase().includes(kw)
              )
            : bySort;
        if (view === "archived") {
            // 归档视图看的是**全部**归档笔记（不管收藏不收藏）
            const kw2 = keyword.trim().toLowerCase();
            const all = notes.filter(n => n.archived);
            return kw2
                ? all.filter(
                      n =>
                          (n.title || "").toLowerCase().includes(kw2) ||
                          (n.content || "").toLowerCase().includes(kw2)
                  )
                : all;
        }
        if (view === "uncategorized") {
            // 「未归类」= **没有归到任何文件夹**的笔记（folder_id 为空）。
            // ⚠️ 这里原来筛的是 `site_id` —— 那是「没挂在站点上」，可记事本里
            // 根本没有「把笔记挂到某个站点」的入口，site_id 永远是 null，
            // 于是这个视图跟「全部」**完全等价**（左栏两个计数一模一样），
            // 而用户看到「未归类」时想的是文件夹，不是站点。阶段三加了文件夹，
            // 这个判据没跟着换过来。
            return matched.filter(n => n.folder_id === null || n.folder_id === undefined);
        }
        return matched;
    }, [notes, keyword, view, activeFolder, activeTag, noteTags, searchHits]);

    /** 阶段二：列表按月份分组（「十月」「九月…」），和 inkstone 一样 */
    /** 中栏「排序」的排序键。default = 置顶优先 + 原始顺序（服务端排序） */
    const sorted = useMemo(() => {
        const list = [...filtered];
        if (sortKey === "title") {
            list.sort((a, b) => (a.title || "无标题").localeCompare(b.title || "无标题"));
        } else if (sortKey === "created") {
            list.sort((a, b) =>
                String(b.created_at || "").localeCompare(String(a.created_at || ""))
            );
        }
        return list;
    }, [filtered, sortKey]);

    /**
     * 列表分组（照 inkstone 的 `buildGroups`）：**置顶单独一组**，
     * 其余按 `groupLabel` 的相对时间（今天 / 昨天 / 本周 / 本月 / 9 月 / 2026 年 8 月）。
     * ⚠️ 之前是纯按 `YYYY-MM` 分组，列表顶上永远是「2026 年 10 月」这种
     * 又长又没信息量的标题，而「今天动过的几条」被埋在里面看不出来。
     */
    const listGroups = useMemo(() => {
        const groups: { key: string; label: string; items: Note[] }[] = [];
        const pinned = sorted.filter(n => Boolean(n.pinned));
        if (pinned.length) groups.push({ key: "pinned", label: "置顶", items: pinned });
        const rest = sorted.filter(n => !n.pinned);
        if (!rest.length) return groups;
        // 按排序键决定用哪个时间戳分组：按创建时间排就用创建时间，
        // 否则用最后编辑时间（inkstone 的 buildGroups 同一条规则）。
        const stampOf = (n: Note) =>
            sortKey === "created" ? n.created_at : n.updated_at || n.created_at;
        // ⚠️ 按标题排的时候**不分组**（inkstone 也是这样：一组「其他」，不挂标题）。
        // 分了组反而会骗人 —— 标题顺序和「今天/昨天」毫无关系。
        if (sortKey === "title") {
            groups.push({ key: "rest", label: "", items: rest });
            return groups;
        }
        // ⚠️ 必须先按时间**从新到旧**排一遍再分桶。
        // inkstone 的 buildGroups 假设传进来的 items 已经是这个顺序（它由 store 保证），
        // 我们这边 `sorted` 只是保留了服务端顺序 —— 不先排一次的话，
        // 分组会跟着「接口返回的顺序」走，出现「9 月」排在「本周」前面。
        const ordered = [...rest].sort(
            (a, b) => String(stampOf(b) || "").localeCompare(String(stampOf(a) || ""))
        );
        let currentKey = "";
        let bucket: { key: string; label: string; items: Note[] } | null = null;
        for (const n of ordered) {
            const label = groupLabel(stampOf(n));
            // 分组键带上序号：同一个标签可能在列表里出现多段
            // （比如中间夹了置顶），光靠 label 会并到不该并的一组里。
            if (label !== currentKey) {
                currentKey = label;
                bucket = { key: `${label}-${groups.length}`, label, items: [] };
                groups.push(bucket);
            }
            bucket?.items.push(n);
        }
        return groups;
    }, [sorted, sortKey]);

    /** 阶段三：回收站列表。还原是主操作，彻底删除放右边且要二次确认。 */
    const trashPane = (
        <Box sx={{ px: 0.75, pb: 1 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 0.75 }}>
                <Typography variant='caption' color='text.secondary' sx={{ flex: 1 }}>
                    删除的笔记会先放到这里，保留 30 天
                </Typography>
                {trashedNotes.length > 0 && (
                    <Button
                        size='small'
                        color='error'
                        data-action='empty-trash'
                        onClick={() => {
                            if (window.confirm(`彻底删除这 ${trashedNotes.length} 条笔记？删了就找不回来了。`)) {
                                void onEmptyTrash();
                            }
                        }}
                        sx={{ fontSize: 12, py: 0.25 }}
                    >
                        清空
                    </Button>
                )}
            </Box>
            {trashedNotes.length === 0 ? (
                <Typography variant='body2' color='text.secondary' sx={{ p: 2 }}>
                    回收站是空的。
                </Typography>
            ) : (
                trashedNotes.map(item => (
                    <Box
                        key={item.recycleId}
                        data-trash-id={item.recycleId}
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            px: 1.25,
                            py: 0.9,
                            borderRadius: 1.5,
                            "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
                        }}
                    >
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Typography
                                variant='body2'
                                sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {item.title}
                            </Typography>
                            <Typography
                                variant='caption'
                                color='text.disabled'
                                sx={{ fontSize: 11 }}
                                title={formatWhen(item.deletedAt)}
                            >
                                {/* deletedAt 是毫秒时间戳，同样要走统一的解析入口 */}
                                {formatRelative(item.deletedAt)}
                            </Typography>
                        </Box>
                        <Tooltip title='还原到全部笔记'>
                            <IconButton
                                size='small'
                                aria-label={`还原 ${item.title}`}
                                data-action='restore'
                                onClick={() => void onRestoreTrashed(item.recycleId)}
                            >
                                <UndoIcon fontSize='small' />
                            </IconButton>
                    </Tooltip>
                        <Tooltip title='彻底删除（找不回来）'>
                            <IconButton
                                size='small'
                                color='error'
                                aria-label={`彻底删除 ${item.title}`}
                                data-action='purge'
                                onClick={() => {
                                    if (window.confirm(`彻底删除「${item.title}」？删了就找不回来了。`)) {
                                        void onPurgeTrashed(item.recycleId);
                                    }
                                }}
                            >
                                <DeleteForeverIcon fontSize='small' />
                            </IconButton>
                    </Tooltip>
                    </Box>
                ))
            )}
        </Box>
    );

    /** 左栏导航上挂的三个数 */
    const viewCounts = useMemo(
        () => ({
            all: notes.filter(n => !n.archived).length,
            recent: notes.filter(n => !n.archived).length,
            starred: notes.filter(n => !n.archived && Boolean(n.pinned)).length,
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

    // ---------- 阶段三收尾：文件夹 / 标签 ----------
    /** 没传 folderTags（老部署）时用两个空常量，而不是每次渲染都新建 [] ——
        后者会让下面的 useMemo 每次都重算，白费。 */

    /** 每条笔记的计数：服务端 listFolders/listTags 也带了 count，但那要等接口回来，
        本地 notes 一变就应该立刻反映到左栏，所以这里按本地数据算（同号重算）。 */
    const folderCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const f of folders) {
            map.set(f.id!, notes.filter(n => !n.archived && n.folder_id === f.id).length);
        }
        return map;
    }, [folders, notes]);

    const tagCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const t of tags) {
            map.set(
                t.id!,
                notes.filter(n => !n.archived && tagOf(n, noteTags).has(t.id!)).length
            );
        }
        return map;
    }, [tags, notes, noteTags]);
    // ⚠️ 下面这些 callback 的引用都取 `folderTags?.xxx`，**不直接写 folderTags 本身进依赖**：
    // folderTags 是调用方每次渲染新造的对象字面量，把它放进行依赖会让每一次渲染都
    // 重跑一遍这些回调、连带下面的 useMemo 全部失效（这是「effect 无限循环 → 内存打满」
    // 那类问题的入口）。只认里面那几个函数，它们由 useCallback 缓存住了。
    const createFolder = useCallback(
        async (name: string, parentId: number | null = null) => {
            const created = await folderTags?.onCreateFolder(name, parentId);
            // 只在建的是**根目录**文件夹时才自动切过去：新建子文件夹就把左栏
            // 跳到那个子文件夹，会让「我只是想加一个子项」变成视图被抢走。
            if (created?.id !== undefined && parentId === null) setActiveFolder(created.id);
        },
        [folderTags]
    );
    const renameFolder = useCallback(
        async (id: number, name: string) => {
            await folderTags?.onRenameFolder(id, name);
        },
        [folderTags]
    );
    const removeFolder = useCallback(
        async (id: number) => {
            await folderTags?.onRemoveFolder(id);
            // 删掉的是当前选中的那个，就得跟着回到「全部」，否则左栏停在一个空视图上
            setActiveFolder(cur => (cur === id ? null : cur));
        },
        [folderTags]
    );
    const createTag = useCallback(
        async (name: string) => {
            const created = await folderTags?.onCreateTag(name);
            if (created?.id !== undefined) setActiveTag(created.id);
        },
        [folderTags]
    );
    const renameTag = useCallback(
        async (id: number, name: string) => {
            await folderTags?.onRenameTag(id, name);
        },
        [folderTags]
    );
    const removeTag = useCallback(
        async (id: number) => {
            await folderTags?.onRemoveTag(id);
            setActiveTag(cur => (cur === id ? null : cur));
        },
        [folderTags]
    );

    // 弹窗的提交回调放在这里：上面那些 createFolder / renameTag / removeTag
    // 声明在后面，useCallback 的依赖表里引用它们会拿到「还没初始化的引用」。
    const submitNamePrompt = useCallback(
        async (name: string) => {
            const ask = namePrompt;
            if (!ask) return;
            if (ask.renameId !== undefined) {
                if (ask.kind === "folder") await renameFolder(ask.renameId, name);
                else await renameTag(ask.renameId, name);
            } else if (ask.kind === "folder") {
                await createFolder(name, ask.parentId);
            } else {
                await createTag(name);
            }
            setNamePrompt(null);
        },
        [namePrompt, createFolder, createTag, renameFolder, renameTag]
    );

    const submitRemove = useCallback(async () => {
        const target = removeTarget;
        if (!target) return;
        if (target.kind === "folder") await removeFolder(target.id);
        else await removeTag(target.id);
        setRemoveTarget(null);
    }, [removeTarget, removeFolder, removeTag]);

    /**
     * 导出一条笔记成 .md（inkstone 的「导出」，我们放在列表行菜单里）。
     *
     * ⚠️ 导的是 `active.content` 而不是本地草稿 `draft`：草稿可能还有没到 3 秒
     * 自动保存窗口的改动，而导出的是**已经存进库**的内容 —— 标题和正文必须同源，
     * 否则用户会拿到「旧正文 + 新标题」这种拼接产物。
     */
    const exportOne = useCallback(
        (note: Note) => {
            try {
                const name = exportNoteAsMarkdown(note.title, note.content);
                onNotify?.(`已导出「${name}」`, "success");
            } catch (error) {
                reportError(error, { source: "note-export" });
                onNotify?.("导出失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            }
        },
        [onNotify]
    );

    // ---------- 笔记右键菜单的各个动作（inkstone 的完整菜单） ----------

    /** 复制到剪贴板并给出回执 —— 静默成功会让人怀疑「复制了没」 */
    const copyText = useCallback(
        async (text: string, okMsg: string) => {
            try {
                await navigator.clipboard.writeText(text);
                onNotify?.(okMsg, "success");
            } catch {
                onNotify?.("复制失败（浏览器拒绝了剪贴板访问）", "error");
            }
        },
        [onNotify]
    );

    /** 笔记的直达链接：打开记事本时带 #note=<id> 就直接定位到这条 */
    const noteLink = useCallback((note: Note): string => {
        if (note.id === undefined) return "";
        return `${globalThis.location.origin}${globalThis.location.pathname}${globalThis.location.search}#note=${note.id}`;
    }, []);

    /** 深链接：打开记事本时 #note=<id> 存在就直接定位（配合「复制直链」） */
    useEffect(() => {
        const m = /^#note=(\d+)$/.exec(globalThis.location.hash || "");
        if (!m) return;
        const id = Number(m[1]);
        if (notes.some(n => n.id === id)) {
            setActiveId(id);
            setMobileDetail(true);
        }
        // 只在笔记列表首次到位时读一次 hash
    }, [notes.length]); // eslint-disable-line react-hooks/exhaustive-deps

    /** 在侧边打开：第二台编辑器同时编辑另一篇 */
    const openInSide = useCallback(
        (note: Note) => {
            if (note.id === undefined) return;
            if (note.id === activeId) {
                onNotify?.("这条笔记已经在主编辑区打开了", "info");
                return;
            }
            setSideId(note.id);
            setSideMode("edit"); // 每次新开一篇都回到编辑态，别把上一次的预览态带过来
            setSideDraft({ title: note.title || "", content: note.content || "" });
            onNotify?.(`已在侧边打开「${note.title || "无标题"}」`, "success");
        },
        [activeId, onNotify]
    );

    /** 关闭侧边编辑器：先把还没落库的草稿刷掉（自动保存是 3 秒防抖，关了就丢） */
    const closeSide = useCallback(() => {
        const note = sideId !== null ? notes.find(n => n.id === sideId) : null;
        if (note && sideDraft) {
            const dirtySide =
                sideDraft.title !== (note.title || "") ||
                sideDraft.content !== (note.content || "");
            if (dirtySide) {
                void onUpdate(note.id!, {
                    title: sideDraft.title,
                    content: sideDraft.content,
                });
            }
        }
        setSideId(null);
        setSideDraft(null);
    }, [sideId, sideDraft, notes, onUpdate]);

    /** 侧边那条笔记没了（被移到回收站 / 彻底删除）就收起侧边栏，
        否则会留下一个「标题栏空白、编辑器空转」的半屏。 */
    useEffect(() => {
        if (sideId === null) return;
        if (!notes.some(n => n.id === sideId)) {
            setSideId(null);
            setSideDraft(null);
        }
    }, [sideId, notes]);

    /**
     * 侧边编辑器的自动保存（与主编辑器同一套防抖）。
     * ⚠️ 状态（待存/正在存/已存 + 时刻）也跟主栏一样摊出来 —— 否则侧栏状态栏
     * 只能写「侧边」两个字，用户看不到这篇到底存没存（2026-10-07 要求对齐左侧）。
     */
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
        return () => clearTimeout(timer);
    }, [sideDraft, sideId, notes, onUpdate, autosaveMs]);

    /** 创建副本：标题加「副本」，归到同一文件夹 */
    const duplicateNote = useCallback(
        async (note: Note) => {
            const created = await onCreate({
                title: `${note.title || "无标题"} 副本`,
                content: note.content || "",
                folder_id: note.folder_id ?? null,
            });
            if (created?.id) {
                setActiveId(created.id);
                setDraft({ title: created.title || "", content: created.content || "" });
            }
            onNotify?.("已创建副本", "success");
        },
        [onCreate, onNotify]
    );

    /** 导出 HTML（markdown-it 渲染成离线可看的单文件） */
    const exportHtmlOne = useCallback(
        (note: Note) => {
            void exportNoteAsHtml(note.title, note.content)
                .then(name => onNotify?.(`已导出「${name}」`, "success"))
                .catch(error => {
                    reportError(error, { source: "note-export-html" });
                    onNotify?.("导出失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
                });
        },
        [onNotify]
    );

    /** 导出 PDF：调起系统打印（目的地选「另存为 PDF」） */

    /**
     * 附件引用计数（附件管理器里「引用 N 次 / 未引用」）：扫一遍已加载的正文，
     * 数每条附件 id 出现在几条笔记里（按笔记去重，一条笔记里写两次也算 1 个引用）。
     * 与后端 prune 的判据同源（正文里没出现过的才算未引用），两边口径不能各算各的。
     */
    const attachmentRefCounts = useMemo(() => {
        const map = new Map<string, number>();
        for (const n of notes) {
            const content = n.content || "";
            const seen = new Set<string>();
            for (const m of content.matchAll(/\/api\/notes\/attachments\/([0-9a-zA-Z-]+)/g)) {
                if (seen.has(m[1])) continue;
                seen.add(m[1]);
                map.set(m[1], (map.get(m[1]) ?? 0) + 1);
            }
        }
        return map;
    }, [notes]);

    /** 导出全部笔记（2026-10-08 设置→数据，照 inkstone 的导出）：JSON 一份
     *  （笔记 + 文件夹 + 标签 + 关联），不含附件二进制。前端直接从内存生成，
     *  不需要新端点；导入等后续批次再做。 */
    const exportAllData = () => {
        try {
            const payload = {
                kind: "navihive-notes-export",
                exported_at: new Date().toISOString(),
                notes,
                folders: folderTags?.folders ?? [],
                tags: folderTags?.tags ?? [],
                noteTags: folderTags?.noteTags ?? {},
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], {
                type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `notes-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // 下载已触发后再回收；立刻 revoke 在部分浏览器会打断下载
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            onNotify?.(`已导出 ${notes.length} 条笔记（JSON，不含附件）`, "success");
        } catch (error) {
            onNotify?.(
                "导出失败：" + (error instanceof Error ? error.message : "未知错误"),
                "error"
            );
        }
    };
    const exportPdfOne = useCallback(
        (note: Note) => {
            void printNoteAsPdf(note.title, note.content).catch(error => {
                reportError(error, { source: "note-export-pdf" });
                onNotify?.("打印失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
            });
        },
        [onNotify]
    );

    // ---------- 反向链接（inkstone 顶栏那个「反向链接」）----------
    //
    // 纯前端算：客户端本来就持有全部笔记，一次遍历即可，**不新增任何表**。
    // 判据与渲染层的 `[[双链]]` 规则共用 utils/noteWikiLink，两处不会跑偏。
    const [backlinkAnchor, setBacklinkAnchor] = useState<HTMLElement | null>(null);
    /** 有草稿时按草稿算：正在写的内容不该被「库里那份」盖住 */
    const backlinks = useMemo(() => {
        if (!active || active.id === undefined) return [];
        return buildBacklinks(notes, {
            id: active.id,
            title: active.title,
            content: draft?.content ?? active.content ?? "",
        });
    }, [active, draft?.content, notes]);
    /** 这条笔记链出去、且目标真实存在的那些（死链不给入口） */
    const outgoingLinks = useMemo(() => {
        if (!active || active.id === undefined) return [];
        return resolveWikiLinks(notes, {
            id: active.id,
            title: active.title,
            content: draft?.content ?? active.content ?? "",
        });
    }, [active, draft?.content, notes]);

    // ---------- 版本历史（inkstone 顶栏「版本历史」）----------
    const [revisionAnchor, setRevisionAnchor] = useState<HTMLElement | null>(null);
    const [shareId, setShareId] = useState<number | null>(null);
    const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
    /** 正在恢复的版本 id：期间禁用所有按钮，避免连点重复提交 */
    const [restoringId, setRestoringId] = useState<number | null>(null);

    /** 打开面板时才拉列表：不为一条没打开过的笔记请求历史 */
    const openRevisions = useCallback(
        async (anchor: HTMLElement) => {
            setRevisionAnchor(anchor);
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onListRevisions) {
                setRevisions([]);
                return;
            }
            setRevisions(null);
            setRevisions(await folderTags.onListRevisions(noteId));
        },
        [active?.id, folderTags]
    );

    const doRestoreRevision = useCallback(
        async (revisionId: number) => {
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onRestoreRevision) return;
            setRestoringId(revisionId);
            const restored = await folderTags.onRestoreRevision(noteId, revisionId);
            setRestoringId(null);
            if (!restored) return;
            setRevisionAnchor(null);
            setRevisions(null);
            // ⚠️ 必须显式写回草稿：草稿只在「换了笔记」（active.id 变化）时重置，
            // 而版本恢复 id 是一样的 —— 不塞回去的话界面还停在恢复前的内容，
            // 看着像「点了没反应」。
            setDraft({ title: restored.title || "", content: restored.content || "" });
            onNotify?.("已恢复到该版本（恢复前的内容也存了一份快照）", "success");
        },
        [active?.id, folderTags, onNotify]
    );
    /** 当前这条笔记的标题层级（草稿内容变就重算） */
    const outline = useMemo(
        () => extractOutline(draft?.content ?? ""),
        [draft?.content]
    );

    const dirty =
        !!active &&
        !!draft &&
        (draft.title !== (active.title || "") || draft.content !== (active.content || ""));

    const save = useCallback(async () => {
        if (!active?.id || !draft) return;
        await onUpdate(active.id, { title: draft.title, content: draft.content });
    }, [active, draft, onUpdate]);

    // ---------- 阶段四第 14 条：自动保存 ----------
    //
    // 之前**既没有保存按钮也没有自动保存**，草稿只在「切到另一条笔记」时才写库 ——
    // 改完直接关掉记事本，内容就没了。这里补 debounce 3s 自动存 + 状态指示。
    //
    // ⚠️ 为什么 save 要走 ref 塞进定时器：save 依赖 onUpdate，而 onUpdate（= updateNote）
    // 依赖 notes —— notes 每保存一次就换一个引用，save 的身份也跟着换。
    // 直接把 save 写进下面那个 effect 的依赖，debounce 定时器会被反复重置，
    // 打字正好赶上保存完成的那一下就会被清掉、拖到下一次按键才重新计时。
    // 用 ref 存最新的 save，effect 只认 dirty / draft / active.id 这三样。
    const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
    const [savedAt, setSavedAt] = useState<number | null>(null);
    // 「已保存 · 刚刚」这句得自己走：formatRelative 只在渲染时算一次，
    // 不刷新它会永远停在「刚刚」（放那儿二十分钟也一样）。只在显示已保存时起这个定时器。
    const [tick, setTick] = useState(() => Date.now());
    useEffect(() => {
        if (saveState !== "saved") return;
        const timer = setInterval(() => setTick(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, [saveState]);
    const saveRef = useRef(save);
    useEffect(() => {
        saveRef.current = save;
    }, [save]);

    useEffect(() => {
        // 还没拿到 id 的新笔记不能存（onCreate 是异步的，那一瞬间 id 还是空的）
        if (!dirty || !active?.id) {
            setSaveState(cur => (cur === "pending" ? "idle" : cur));
            return;
        }
        setSaveState("pending");
        const timer = setTimeout(async () => {
            setSaveState("saving");
            await saveRef.current();
            setSaveState("saved");
            setSavedAt(Date.now());
            setTick(Date.now());
        }, autosaveMs);
        return () => clearTimeout(timer);
    }, [dirty, draft, active?.id, autosaveMs]);

    // 关掉记事本时把还没落库的草稿刷一次：debounce 是 3 秒，
    // 打完字立刻关闭的话那 3 秒还没走完。卸载是同步的，await 不上，
    // 只能 fire-and-forget（api 是模块级的实例，组件没了请求照样发得出去）。
    const flushRef = useRef({ dirty: false, save: async () => {} });
    useEffect(() => {
        flushRef.current = { dirty, save };
    });
    useEffect(
        () => () => {
            if (flushRef.current.dirty) void flushRef.current.save();
        },
        []
    );

    /** ⌘/Ctrl+S 手动存一下：自动保存已经兜底，但有人就是想立刻存 */
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void saveRef.current();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const openNote = useCallback((note: Note) => {
        setActiveId(note.id ?? null);
        setMobileDetail(true);
    }, []);

    /**
     * 在**当前选中的文件夹**里直接新建（inkstone：文件夹那一栏就是笔记的落点）。
     * 没选中文件夹时 folder_id 留空 —— 落在「未归类」，和之前的行为一致。
     */
    const startCreateInFolder = useCallback(
        async (folderId: number | null) => {
            const created = await onCreate(
                folderId === null
                    ? { title: "", content: "" }
                    : { title: "", content: "", folder_id: folderId }
            );
            if (created?.id) {
                setActiveId(created.id);
                // folder_id 已经在 onCreate 里落库了，草稿只带正文两字段
                // （自动保存也只提交这两个，见 save）
                setDraft({ title: "", content: "" });
                setMobileDetail(true);
            }
        },
        [onCreate]
    );

    /**
     * 某个文件夹下的笔记（左栏内联显示用）。
     * 归档的笔记不算 —— 它们只该出现在「归档」视图里。
     */
    const notesInFolder = useCallback(
        (folderId: number) =>
            notes
                .filter(n => !n.archived && n.folder_id === folderId)
                .sort((a, b) =>
                    String(b.updated_at || b.created_at || "").localeCompare(
                        String(a.updated_at || a.created_at || "")
                    )
                )
                .map(n => ({ id: n.id!, title: n.title || "" })),
        [notes]
    );

    /** 切换笔记前先把当前这条存掉 —— 草稿只存在内存里，不存就丢了 */
    const switchTo = useCallback(
        async (id: number | null) => {
            if (dirty) await save();
            setActiveId(id);
        },
        [dirty, save]
    );

    /**
     * 双链跳转 / 反向链接跳转统一走这里。
     * 走 switchTo 而不是 openNote：**有未保存改动时先存** ——
     * 点个链接就把当前编辑的正文丢掉是不能接受的（openNote 是列表行的裸切换）。
     */
    const jumpToNote = useCallback(
        async (id: number) => {
            await switchTo(id);
            setMobileDetail(true);
        },
        [switchTo]
    );

    /**
     * 笔记嵌入 `![[标题]]` / 块引用 `![[标题#^块ID]]` 在预览里按标题找目标笔记。
     * 大小写不敏感、去首尾空白 —— 用户写 `[[API]]` 能命中「api」。
     */
    const resolveNote = useCallback(
        (title: string): NoteEmbedTarget | null => {
            const key = title.trim().toLowerCase();
            if (!key) return null;
            const hit = notes.find(n => (n.title ?? "").trim().toLowerCase() === key);
            return hit ? { title: hit.title ?? "", content: hit.content ?? "" } : null;
        },
        [notes]
    );

    /** 点嵌入标题跳到那篇笔记（有未保存改动先存） */
    const handleOpenEmbedNote = useCallback(
        (title: string) => {
            const key = title.trim().toLowerCase();
            const hit = notes.find(n => (n.title ?? "").trim().toLowerCase() === key);
            if (hit?.id != null) void jumpToNote(hit.id);
        },
        [notes, jumpToNote]
    );

    /**
     * 拖分隔条。监听挂在 **window** 上而不是分隔条自己身上：指针在拖动中移出
     * 那 4px 宽的条就会丢失 mousemove，光靠元素上的事件会「拖到一半卡住」。
     */
    const startSplitDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const box = splitBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return;
        // ⚠️ 比例要按**内容盒**算，不能按 border-box：内容区加了 px:2 的内边距后，
        // 两栏的宽度是相对「扣掉左右内边距后的宽度」分的（textarea 的 width:% 同理）。
        // 不扣的话分隔条会跟手差 16px，看起来就是「拖不到头」。
        const cs = getComputedStyle(box);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const contentLeft = rect.left + padL;
        const contentWidth = rect.width - padL - padR;
        if (contentWidth <= 0) return;
        const onMove = (ev: MouseEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            // 拖动中 setState 不会回头改 onUp 那个闭包里的 splitRatio
            //（事件处理函数是 mousedown 那一刻挂上去的），所以最新值走 ref。
            splitRatioRef.current = clamped;
            setSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.userSelect = "";
            try {
                // ⚠️⚠️ 这里原来写的是 `String(readSplitRatio())` —— 那是**从 localStorage 读**，
                // 读回来的必然是拖动开始之前的旧值：拖了半天松手，存回去的还是原来那个比例，
                // 刷新页面宽度就弹回去了（用户视角就是「拖不动」/「拖了没反应」）。
                // 而且这里也不能直接读 splitRatio：onUp 是 mousedown 那一刻挂上去的闭包，
                // 拖动中的 setState 改不到它 —— 只有 splitRatioRef 跟得住最新值。
                localStorage.setItem(SPLIT_KEY, String(splitRatioRef.current));
            } catch {
                /* 隐私模式下写不了，忽略 */
            }
        };
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    /** 侧栏「分栏」那条缝的拖动：与主栏 startSplitDrag 同款，只是量的是 sideSplitBoxRef。 */
    const startSideSplitDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const box = sideSplitBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        if (rect.width <= 0) return;
        const cs = getComputedStyle(box);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const contentLeft = rect.left + padL;
        const contentWidth = rect.width - padL - padR;
        if (contentWidth <= 0) return;
        const onMove = (ev: MouseEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            sideSplitRatioRef.current = clamped;
            setSideSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            try {
                localStorage.setItem(SIDE_SPLIT_KEY, String(sideSplitRatioRef.current));
            } catch {
                /* 隐私模式下写不了，忽略 */
            }
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    };

    /**
     * Ctrl/Cmd + / 插入隐藏注释 —— inkstone 的「笔记工具」菜单里给这项标了这个快捷键，
     * 属于「不用记也知道在哪、记住了就很快」的那种。
     *
     * ⚠️ 只在**编辑器里有焦点**时抢这个键：全局拦截会把浏览器/页面的其它
     * Ctrl+/ 语义一起吃掉（比如输入法切换），那属于抢用户的东西。
     */
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
    /**
     * 字数（**不含**空白）与字符数（含空白）必须是两个不同的量。
     *
     * ⚠️ 之前状态栏写的是「{charCount} 字」「{charCount} 字符」——同一个数字摆两遍。
     * 真机实测状态栏原文就是「297 字 297 字符」，看着像给了两个指标，其实只有一个，
     * 用户只会以为「字」和「字符」在这儿是同义词（inkstone 那边是「1字 67字符」，两个数确实不同）。
     */
    const wordCount = useMemo(() => {
        const s = draft?.content ?? "";
        return s.replace(/\s+/g, "").length;
    }, [draft?.content]);
    /**
     * 全站正文总字数（设置→数据→概览的「总字数」，inkstone 的 stats.words 同格）。
     * 与状态栏那套算法一致（去空白后数字符），两处不许各算各的。
     */
    const noteWordTotal = useMemo(
        () => notes.reduce((sum, n) => sum + (n.content ?? "").replace(/\s+/g, "").length, 0),
        [notes]
    );
    /** 当前笔记所在文件夹名（状态栏的位置指示，inkstone 也有这一项） */
    const activeFolderName = useMemo(() => {
        const fid = active?.folder_id;
        if (fid === null || fid === undefined) return "";
        return folders.find(f => f.id === fid)?.name ?? "";
    }, [active?.folder_id, folders]);
    /** 当前笔记的标签名（状态栏第六项，inkstone 最多摆 4 个） */
    const activeTagNames = useMemo(
        () => (active ? tagNamesOf(active, noteTags, tags) : []),
        [active, noteTags, tags]
    );
    const pinnedCount = notes.filter(n => Boolean(n.pinned)).length;
    /**
     * 选中了某个文件夹 → 中间那栏笔记列表**不出现**（inkstone 的文件夹树）：
     * 笔记已经直接列在左栏那个文件夹下面了，再来一栏是重复的同一批东西，
     * 白占 200 多 px，还让用户以为是两份不同的笔记。
     *
     * 只对文件夹生效：标签是交叉维度（一条笔记可以同时属于多个标签），
     * 「标签→笔记」那种树状归属不成立，所以标签视图仍走中间栏。
     */
    const folderFocus = activeFolder !== null;
    /**
     * 中栏隐藏 = 选中了文件夹（笔记内联在左栏）或用户点了「收起」。
     * 两者共用同一套隐藏逻辑：导航列后面的那条拖拽缝、中间的列表列都不渲染。
     */
    const listHidden = folderFocus || middleHidden;

    /**
     * 列表空状态：插画 + 一句话（照 inkstone 的 9 种场景配置）。
     * ⚠️ 之前只有「还没有笔记 / 没有匹配的笔记」两句，六种情况共用，
     * 用户看到空白不知道是「没写」还是「筛掉了」—— 这两件事的下一步完全相反。
     */
    const { art: emptyArt, ...emptyCopy } = useMemo((): {
        art: "notes" | "search" | "starred" | "archive" | "folder" | "tag" | "trash";
        title: string;
        desc: string;
    } => {
        if (view === "search") {
            return { art: "search", title: "没有匹配的笔记", desc: "换个词再搜一次，或者清掉筛选条件。" };
        }
        if (view === "starred") {
            return { art: "starred", title: "还没有收藏", desc: "在笔记上右键就能收藏，收藏过的会出现在这里。" };
        }
        if (view === "archived") {
            return { art: "archive", title: "归档里是空的", desc: "把暂时不看的笔记归档，它就不会出现在列表里了。" };
        }
        if (view === "trash") {
            return { art: "trash", title: "回收站是空的", desc: "删掉的笔记会先放到这里，随时能还原。" };
        }
        if (activeFolder !== null) {
            return { art: "folder", title: "这个文件夹还是空的", desc: "把笔记拖进来，或者直接在这个文件夹里新建一条。" };
        }
        if (activeTag !== null) {
            return { art: "tag", title: "没有带这个标签的笔记", desc: "在笔记里写 #这个标签，它就会自动归到这里。" };
        }
        if (notes.length === 0) {
            return { art: "notes", title: "还没有笔记", desc: "点「新建笔记」写第一条。" };
        }
        return { art: "notes", title: "这里没有要显示的笔记", desc: "换个筛选条件看看。" };
    }, [view, activeFolder, activeTag, notes.length]);
    /**
     * 搜索框。做成**函数**而不是变量，因为它要挂两个地方（2026-10-07）：
     * 宽屏在导航列顶部；tablet/mobile 导航列整列 display:none，搜索框会跟着消失 ——
     * 而搜索是最高频入口，不能没有。窄屏时列表列头部再挂一份（inkstone 的
     * tablet 头部就是这个思路：一条 44px 顶栏 + 搜索）。
     *
     * ⚠️⚠️ 每个位置必须传**自己的 ref**。曾经写成「一个变量渲染两处、共用一个
     * inputRef」，结果把整个 notes.dom 测试文件堆爆内存
     * （FATAL: heap out of memory；1992 条断言全过但进程直接死掉，
     *  表现成「只跑了 10 条就 not ok」，极难定位）。
     * 原因：同一个 ref 被两个 <input> 争抢 + 条件渲染让两者互换角色，
     * React 每次 commit 都在「解绑 A / 绑上 B」之间来回，永远收敛不了。
     */
    const renderSearchField = (inputRef: React.RefObject<HTMLInputElement | null>) => (
        // 用 TextField + InputAdornment：之前是自己画的绝对定位图标，
        // 那个放大镜飘在框外面右下方，对不齐也很难看。
        <TextField
            fullWidth
            size='small'
            inputRef={inputRef}
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
            placeholder='搜索标题与内容'
            slotProps={{
                input: {
                    "aria-label": "搜索笔记",
                    startAdornment: (
                        <InputAdornment position='start'>
                            <SearchIcon fontSize='small' />
                        </InputAdornment>
                    ),
                    // 阶段二：搜索框右侧挂个 ⌘K 提示（⌘/Ctrl+K 会聚焦它）
                    endAdornment: (
                        <InputAdornment position='end'>
                            <Box
                                component='kbd'
                                aria-hidden='true'
                                sx={{
                                    fontSize: 10,
                                    lineHeight: 1.4,
                                    px: 0.5,
                                    py: 0.1,
                                    borderRadius: 0.75,
                                    border: "1px solid rgba(128,128,128,0.35)",
                                    color: "text.disabled",
                                }}
                            >
                                ⌘K
                            </Box>
                        </InputAdornment>
                    ),
                },
            }}
        />
    );

    /** 导航列内容（2026-10-08 抽出）：桌面导航列与 tablet 导航抽屉共用同一份 JSX。
     *  两者互斥挂载（桌面列 !narrowLayout 才挂、抽屉仅 tablet 开），
     *  所以 data-view / searchRef / data-nav-col 都不会出现两份。 */
    const navInner = (
            <>
            {/* 迷你顶栏（2026-10-07）：顶栏只压这一列（inkstone 布局），中栏 / 编辑区
                直达页面顶部、各带头部。返回 + 应用名留在这里；「收起列表」进左下角
                （设置左边）；分享 / 版本 / 大纲 / 反链收进编辑区右上角的「更多操作」。 */}
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
                <Typography
                    variant='subtitle2'
                    component='div'
                    sx={{ fontWeight: 600, flex: 1, fontSize: 14, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                    记事本
                </Typography>
                {/* 返回箭头（2026-10-09 用户明确）：只在**桌面**导航列里显示；
                    窄屏（tablet/mobile）的返回箭头要贴着**整页右上角**（顶部 44px 栏
                    最右端 / 列表屏头部行最右），不能落在抽屉（最左栏）的右上角。 */}
                {!narrowLayout && (
                    <IconButton aria-label='返回导航站' onClick={onClose} size='small'>
                        <ArrowBackIcon fontSize='small' sx={{ transform: "scaleX(-1)" }} />
                    </IconButton>
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
                }))}
                selectedId={activeFolder}
                onSelect={id => {
                    setActiveFolder(id);
                    setActiveTag(null);
                    setMiddleHidden(false);
                    setNavDrawerOpen(false);
                    if (id === null) setView("all");
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
            <FolderTagSection
                title='标签'
                items={tags.map(t => ({
                    id: t.id!,
                    name: t.name || "未命名",
                    count: tagCounts.get(t.id!) ?? 0,
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
                    {(
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
                    {/* 收起 / 展开整个左栏（2026-10-07 从顶栏挪到这里，设置左边）：
                        低频操作和设置是同一类，跟账号挤一行正合适 */}
                    <Tooltip title={listCollapsed ? "展开笔记列表" : "收起笔记列表"}>
                        <IconButton
                            size='small'
                            aria-label={listCollapsed ? "展开笔记列表" : "收起笔记列表"}
                            data-tool='collapse-pane'
                            onClick={() => setListCollapsed(c => !c)}
                            sx={{ p: 0.25 }}
                        >
                            {listCollapsed ? (
                                <LastPageIcon fontSize='inherit' />
                            ) : (
                                <FirstPageIcon fontSize='inherit' />
                            )}
                        </IconButton>
                    </Tooltip>
                    {/* 设置：打开记事本自己的设置（外观 / 编辑器），不再复用导航站配置 */}
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

    const listPane = (        <Box
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
                // 折叠态：顶部只留「返回」，**展开箭头放左下角**（2026-10-07 用户要求，
                // 与 inkstone 一致 —— 收起是低频动作，该待在不碍事、但伸手就能点到的角落）。
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
                    <Tooltip title='返回导航站'>
                        <IconButton aria-label='返回导航站' onClick={onClose} size='small'>
                            <ArrowBackIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
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
                    </Typography>                    <Tooltip title='排序'>
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
                            onClick={() => void startCreateInFolder(activeFolder)}
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
                    trashPane
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
                                <Button
                                    size='small'
                                    variant='outlined'
                                    startIcon={<NoteAddIcon fontSize='inherit' />}
                                    onClick={() => void startCreateInFolder(activeFolder)}
                                >
                                    新建笔记
                                </Button>
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
                                            "&:hover": { bgcolor: "rgba(128,128,128,0.06)" },
                                        },
                                    }}
                                >
                                    {group.label}
                                </Typography>
                            )}
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
                                onClick={() => (dirty ? void switchTo(note.id ?? null) : openNote(note))}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        openNote(note);
                                    }
                                }}
                                onContextMenu={e => {
                                    // 右键行 = 打开完整操作菜单（inkstone 同款交互）
                                    e.preventDefault();
                                    // ⚠️ 必须先把焦点从行上拿走（2026-10-07 用户报「右键后
                                    // 留下一颗白色圆点」）：行是 tabIndex=0 的 role=button，
                                    // 右键会让它拿到焦点，行内的「⋯」按钮靠
                                    // `:focus-within` 常显 —— 菜单关掉后焦点还在，
                                    // 那颗按钮就一直挂在行右侧（22×22 的圆形 IconButton）。
                                    (e.currentTarget as HTMLElement).blur();
                                    if (note.id === undefined) return;
                                    // ⚠️ 锚在鼠标处：锚整行左上角的话菜单跟指针没关系（用户报「固定位置」）
                                    setRowMenu({
                                        noteId: note.id,
                                        el: anchorAtMouse(e.clientX, e.clientY),
                                        source: "list",
                                    });
                                }}
                                sx={{
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
                                    // 菜单按钮平时藏起来，hover / 聚焦才出 —— 和 inkstone 一致，
                                    // 128px 的窄列里常驻一个按钮会把标题挤没。
                                    "&:hover .note-row-actions, &:focus-within .note-row-actions": {
                                        opacity: 1,
                                    },
                                    "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
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
                                    {/* ⚠️ 必须先转布尔：pinned 存的是 0/1，
                                        `0 && <Icon/>` 在 JS 里返回 0，React 会把它
                                        当文本渲染出来 —— 列表里就冒出一个孤零零的 "0" */}
                                    {Boolean(note.pinned) && (
                                        <PushPinIcon fontSize='inherit' sx={{ color: "var(--accent)" }} />
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
                                        {note.title || "无标题"}
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
                                        className='note-row-actions'
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
                                            transition: "opacity 120ms ease",
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
                                    {summarize(note.content) || "空白笔记"}
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
                                        {tagNamesOf(note, noteTags, tags).map(name => (
                                            <Box
                                                key={name}
                                                data-note-tag={name}
                                                sx={{
                                                    px: 0.75,
                                                    py: 0.1,
                                                    fontSize: 10.5,
                                                    lineHeight: 1.6,
                                                    borderRadius: 999,
                                                    border: "1px solid var(--card-border)",
                                                    color: "text.secondary",
                                                    bgcolor: "rgba(128,128,128,0.08)",
                                                }}
                                            >
                                                {name}
                                            </Box>
                                        ))}
                                    </Box>
                                )}
                            </Box>
                        );
                    })}
                        </Box>
                    ))
                )}
            </Box>


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

    const editorPane = (
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
                            ⚠️ 窄屏（<900px）藏起来：标题行已经装了「即时渲染 + 三档 + 更多 +
                            关闭」，窄窗口塞不下。同一个开关在「更多操作」菜单里有一份，
                            窄屏走那条路（见下面 data-active-op='live-render'）。 */}
                        <Box sx={{ display: narrowLayout ? "none" : "flex", alignItems: "center", gap: 0.25, flexShrink: 0, mr: 0.5 }}>
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
                        {/* 模式切换：**框起来的一组图标**（inkstone 同款）。
                            ⚠️ 之前是「宽屏文字按钮 + 小屏图标」两套，宽屏下三个
                            「编辑/分栏/预览」文字把标题行撑得很宽，两栏并排时
                            标题与工具栏都对不齐（用户报）。现在统一成图标 +
                            外框，选中项填底色。aria-label 保持中文，测试与读屏不受影响。 */}
                        <Box
                            data-pane-modes='1'
                            sx={{
                                display: "flex",
                                flexShrink: 0,
                                border: "1px solid var(--card-border)",
                                borderRadius: 1.5,
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
                                            "&:hover": { bgcolor: "rgba(128,128,128,0.12)" },
                                            "& + &": { borderLeft: "1px solid var(--card-border)" },
                                        }}
                                    >
                                        {icon}
                                    </IconButton>
                            </Tooltip>
                            ))}
                        </Box>
                        {/* 保存状态（inkstone 的 SaveIndicator 就挂在头部这一排）。
                            之前它写在状态栏右端，于是那一行既报长度又报状态，26px 塞不下。 */}
                        <SaveDot state={saveState} dirty={dirty} savedAt={savedAt} now={tick} />
                        {/* ⚠️ P0-3（2026-10-07）：把两个高频动作从「⋯」里提到头部常驻。
                            inkstone 的头部右侧是平铺的一排图标（Workspace.tsx:425-472）：
                            更多 / 收藏 / 反向链接 / 版本历史 / 导出 / 大纲 / 分享。
                            我们把分享/版本/大纲/反链都收进了「⋯」—— 收着不算错（窄栏更合理），
                            但「收藏」和「大纲」是随手要用的，让用户先点开菜单再点一项太绕。
                            所以只把这两个提成常驻按钮，其余仍留在「⋯」里。 */}
                        <Box sx={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 0.25, mr: 0.5 }}>
                            <Tooltip title={active?.pinned ? "取消收藏" : "收藏"}>
                                <span>
                                    <IconButton
                                        size='small'
                                        aria-label={active?.pinned ? "取消收藏" : "收藏"}
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
                        {/* 桌面端把高频操作直接平铺（2026-10-08 照 inkstone Workspace 头部：
                            收藏 / 反链 / 版本历史 / 导出 / 大纲 / 分享直接显示，
                            「⋯」桌面端不再收纳它们；窄屏标题行窄，不渲染这组，仍走「⋯」）。 */}
                        {!narrowLayout && (
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
                                        disabled={!active || backlinks.length === 0}
                                        onClick={e => setBacklinkAnchor(e.currentTarget)}
                                        sx={{ width: 28, height: 28, color: "text.secondary" }}
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
                                        onClick={e => active && void openRevisions(e.currentTarget)}
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
                            反向链接也收进了这个菜单（见下面 data-active-op 那几项）。 */}
                        {/* 「更多操作」独立成组，紧贴模式控件右侧 */}
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
                    </Box>

                    {/* 格式工具栏：照 inkstone 那一排。放在标题与内容区之间，
                        点一下在光标处插入语法 —— 省得手打 `**` 和 `- [ ]`。
                        设置里可以整个关掉（uiSettings.showToolbar）。 */}
                    {uiSettings.showToolbar && (
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
                                    focusMode={uiSettings.focusMode}
                                    typewriterMode={uiSettings.typewriterMode}
                                    shortcutActions={mainShortcutActions}
                                />
                            </Box>
                        )}
                        {pane === "split" && (
                            <Box
                                role='separator'
                                aria-orientation='vertical'
                                aria-label='拖动调整源码与预览的比例'
                                title='拖动调整比例（双击回到对半）'
                                onMouseDown={startSplitDrag}
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
                                sx={{
                                    // 与源码区同一个 basis（0），两栏才严格对半
                                    flex: 1,
                                    minWidth: 0,
                                    // ⚠️ minHeight:0 不能少：flex 子项默认 min-height:auto，
                                    // Markdown 一长就把这一层撑高、连带整页出现滚动条。
                                    minHeight: 0,
                                    overflowY: "auto",
                                    p: 2.5,
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
                                /></Box>
                            </Box>
                        )}
                    </Box>
                    {/* 大纲面板：当前这条笔记的标题层级，常驻在预览右侧。
                        没标题时给一句说明，别给一块空白让人以为功能坏了。 */}
                    {outlineOpen && (
                        <Box
                            data-outline-panel='1'
                            sx={{
                                width: 190,
                                flexShrink: 0,
                                borderLeft: "1px solid rgba(128,128,128,0.18)",
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
                                        onClick={() => jumpToOffset(item.offset)}
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
                                                bgcolor: "rgba(128,128,128,0.1)",
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
                    </Box>

                    {/* 状态栏：照 inkstone 的 footer —— **26px 一条**，
                        内容就六项：字数 / 字符 / 读完要几分钟 / 所在文件夹 / 标签 / 创建于。
                        ⚠️ 两处刻意与之前不同：
                        ① 不再显示行号与光标位置（inkstone 也没有，行号是编辑器的东西，
                           摆在状态栏只会跟 CodeMirror 的行号槽重复）；
                        ② 保存状态搬去了标题行（inkstone 的 SaveIndicator 就在头部），
                           这里只管「这篇多长、它是谁」。 */}
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
                </>
            )}
        </Box>
    );

    /**
     * 侧边编辑器（「在侧边打开」）：第二台**完整可编辑**的编辑器 ——
     * 自己的标题框、自己的工具栏（sideTools，撤销状态与主编辑器互相隔离）、
     * 自己的 3 秒自动保存。关闭时先把没落库的草稿刷掉。
     */
    const sideNote = sideId !== null ? notes.find(n => n.id === sideId) ?? null : null;
    const sidePane = sideNote ? (
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
                        borderRadius: 1.5,
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
                                    "&:hover": { bgcolor: "rgba(128,128,128,0.12)" },
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
                                liveRender={liveRender ? liveRenderer : null}
                                focusMode={uiSettings.focusMode}
                                typewriterMode={uiSettings.typewriterMode}
                                shortcutActions={sideShortcutActions}
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
                            onMouseDown={startSideSplitDrag}
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
                        liveRender={liveRender ? liveRenderer : null}
                        focusMode={uiSettings.focusMode}
                        typewriterMode={uiSettings.typewriterMode}
                        shortcutActions={sideShortcutActions}
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
    ) : null;

    return (
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
            style={{ "--accent": uiSettings.accent } as React.CSSProperties}
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
                    // 导入「记事本导出」JSON：同一条链路（NotesPage 自己导出的文件）
                    onImportNotes: shareApi?.importNotes
                        ? (payload) => shareApi.importNotes!(payload)
                        : undefined,
                    // 备份页（2026-10-09 照 inkstone 的 BackupSettings）：能力由
                    // NotesOverlay 探测好传进来，老部署没有时整页不出现
                    onNotesBackupGetState: backupApi?.getState,
                    onNotesBackupSave: backupApi?.save,
                    onNotesBackupTest: backupApi?.test,
                    onNotesBackupRun: backupApi?.run,
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
                与 inkstone 对齐的两套菜单：
                  - list（中栏列表行，右键或 ⋯）：复制标题/ID/直链、在侧边打开、收藏、
                    创建副本、归档、移动到文件夹、导出三件套、移到回收站；
                  - rail（左栏内联笔记右键）：精简版 —— 在侧边打开/收藏/移动到文件夹/
                    归档/移到回收站。
                菜单带图标（inkstone 的菜单行是「图标 + 文字」）。 */}
            <Menu
                open={Boolean(rowMenu)}
                anchorEl={rowMenu?.el ?? null}
                onClose={() => setRowMenu(null)}
            >
                {(() => {
                    const note = rowMenu ? notes.find(n => n.id === rowMenu.noteId) : null;
                    if (!note) return null;
                    const source = rowMenu?.source ?? "list";
                    const done = async (fn: () => Promise<unknown> | void) => {
                        setRowMenu(null);
                        await fn();
                    };
                    const moveToFolder = () => {
                        const id = note.id;
                        setRowMenu(null);
                        if (id !== undefined) setMoveDrawerNoteId(id);
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
                                    {note.pinned ? "取消收藏" : "收藏"}
                                </MenuItem>
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
                            <MenuItem
                                data-row-op='copy-title'
                                onClick={() => void done(() => copyText(note.title || "", "已复制标题"))}
                            >
                                <DriveFileRenameOutlineIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                复制标题
                            </MenuItem>
                            <MenuItem
                                data-row-op='copy-id'
                                onClick={() => void done(() => copyText(String(note.id ?? ""), "已复制 ID"))}
                            >
                                <ContentCopyIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                复制 ID
                            </MenuItem>
                            <MenuItem
                                data-row-op='copy-link'
                                onClick={() => void done(() => copyText(noteLink(note), "已复制直链"))}
                            >
                                <LinkIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                复制直链
                            </MenuItem>
                            <Divider />
                            <MenuItem data-row-op='open-side' onClick={() => void done(() => openInSide(note))}>
                                <OpenInNewIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                在侧边打开
                            </MenuItem>
                            <MenuItem data-row-op='pin' onClick={() => void done(() => onTogglePin(note))}>
                                <PushPinIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                {note.pinned ? "取消收藏" : "收藏"}
                            </MenuItem>
                            <MenuItem data-row-op='duplicate' onClick={() => void done(() => duplicateNote(note))}>
                                <NoteAltIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                创建副本
                            </MenuItem>
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
                                    setRowMenu(null);
                                    if (pick && id !== undefined) {
                                        setTagPick({ el: pick.el, noteId: id });
                                    }
                                }}
                            >
                                <PaletteIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                编辑标签…
                            </MenuItem>
                            <Divider />
                            <MenuItem data-row-op='export' onClick={() => void done(() => exportOne(note))}>
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 Markdown
                            </MenuItem>
                            <MenuItem data-row-op='export-html' onClick={() => void done(() => exportHtmlOne(note))}>
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 HTML
                            </MenuItem>
                            <MenuItem data-row-op='export-pdf' onClick={() => void done(() => exportPdfOne(note))}>
                                <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                                导出 PDF
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
                                exportOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 Markdown
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                setExportAnchor(null);
                                exportHtmlOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 HTML
                        </MenuItem>
                        <MenuItem
                            onClick={() => {
                                setExportAnchor(null);
                                exportPdfOne(active);
                            }}
                        >
                            <FileDownloadIcon fontSize='small' sx={{ mr: 1, fontSize: 16, opacity: 0.7 }} />
                            导出 PDF
                        </MenuItem>
                    </>
                )}
            </Menu>

            {/* 当前笔记的「⋯」菜单：与右键菜单同一套（全量版）。 */}
            <Menu
                open={Boolean(activeMenuAnchor)}
                anchorEl={activeMenuAnchor}
                onClose={() => setActiveMenuAnchor(null)}
            >
                {active && (
                    <>
                        {/* 分享 / 版本 / 大纲 / 反链：桌面端已平铺到头部（2026-10-08），
                            这几项只留给窄屏（标题行放不下）。 */}
                        {narrowLayout && (
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
                            onClick={e => {
                                setActiveMenuAnchor(null);
                                void openRevisions(e.currentTarget);
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
                        <Divider />
                        {/* 窄屏时标题行放不下「即时渲染」，这里补一个入口（同一个状态）；
                            桌面端头部已有开关，这项不再重复出现。 */}
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
                            {active.pinned ? "取消收藏" : "收藏"}
                        </MenuItem>
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
                            这里只留给窄屏。 */}
                        {narrowLayout && (
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

            <Menu
                open={Boolean(revisionAnchor)}
                anchorEl={revisionAnchor}
                onClose={() => setRevisionAnchor(null)}
                slotProps={{ paper: { sx: { maxHeight: 420, overflowY: "auto", minWidth: 260 } } }}
            >
                {revisions === null ? (
                    <MenuItem disabled data-revisions='loading'>
                        正在读取历史版本…
                    </MenuItem>
                ) : revisions.length === 0 ? (
                    <MenuItem disabled data-revisions='empty'>
                        还没有历史版本（改动正文后会自动留档）
                    </MenuItem>
                ) : (
                    revisions.map(r => (
                        <MenuItem
                            key={r.id}
                            data-revision-item={r.id}
                            disabled={restoringId !== null}
                            onClick={() => void doRestoreRevision(r.id)}
                            sx={{ display: "block" }}
                        >
                            <Typography component='span' sx={{ display: "block", fontSize: 13 }}>
                                {restoringId === r.id
                                    ? "正在恢复…"
                                    : formatWhenFull(r.created_at) || "某一版"}
                            </Typography>
                            <Typography
                                component='span'
                                variant='caption'
                                color='text.secondary'
                                sx={{ display: "block" }}
                            >
                                {r.title || "（无标题）"} · {r.size ?? 0} 字
                            </Typography>
                        </MenuItem>
                    ))
                )}
            </Menu>

            {/* 反向链接面板：谁引用了这条笔记。上半是「链出去的」，
                下半是「链进来的」—— 两者都是纯前端算的，不查库。 */}
            <Menu
                open={Boolean(backlinkAnchor)}
                anchorEl={backlinkAnchor}
                onClose={() => setBacklinkAnchor(null)}
                slotProps={{ paper: { sx: { maxHeight: 380, overflowY: "auto", minWidth: 240 } } }}
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
                右边搜索框（与 mobile 列表列头部那份互斥挂载，共用 searchRefNarrow）。 */}
            {bp === "tablet" && (
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
                        borderBottom: "1px solid rgba(128,128,128,0.18)",
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
                    剩下的就是「中间那块空白」。宽度只由内层决定：flex: 0 0 auto。 */}
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
                    {listPane}
                </Box>
                {/* 右栏占满剩余空间。minHeight:0 同样要加：缺了它，内部内容会把这层
                    撑高、进而把最外层的 fixed 容器顶出视口 —— 表现就是页面级滚动条。
                    ⚠️ 外层改成了**列**方向：编辑区本体在上，移动端的「回到列表」压在底下
                    （根容器 2026-10-07 起是 row，这条不能再挂在根上，否则会横着排到右边）。 */}
                <Box
                    sx={{
                        // mobile 且没打开笔记时，右边不占位（否则会把 0 宽的 flex 项
                        // 留在行里，列表被挤窄）。tablet/desktop 永远显示。
                        display: bp === "mobile" && !mobileDetail ? "none" : "flex",
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
                            ⚠️ 判据用 sidePane（= 侧边那条笔记真的还在），不能用 sideId：
                            侧边那条被删掉/回收后 sideId 还留着，按它分屏会让主编辑区
                            白白让出一半、右边空着一条（2026-10-06）
                            ⚠️ 比例可拖（2026-10-07 用户要求）：默认 50/50，中间那条缝能拖，
                            拖完记住（notes.paneRatio）；双击回 50/50。 */}
                        <Box
                            data-pane-divider={sidePane !== null ? "drag" : undefined}
                            sx={{
                                // ⚠️ 宽度必须写成 `0 0 auto` + 百分比，**不能**写 `1 1 X%`。
                                // `1 1 X%` 的两个 flex-basis 加起来正好 100%，再加上中间那条
                                // 9px 把手就超了 → 浏览器按 shrink 因子回缩两栏，
                                // 而侧栏里那台编辑器的 min-content 宽度会参与回缩计算，
                                // 于是「点一下侧边的分栏、内容重排、分割线就跳一下」。
                                // inkstone 的写法是左栏 `width: X%`、右栏 `flex: 1`：
                                // 左栏宽度**只由比例决定**，右栏吃剩下的，分割线位置恒定。
                                ...(sidePane !== null
                                    ? { flex: "0 0 auto", width: `${paneRatio * 100}%` }
                                    : { flex: 1 }),
                                minWidth: 0,
                                minHeight: 0,
                                display: "flex",
                            }}
                        >
                            {editorPane}
                        </Box>
                        {sidePane !== null && (
                            <ColResizeHandle
                                label='拖动调整两栏的比例（双击回到对半）'
                                onDrag={startPaneDrag}
                                onReset={resetPaneRatio}
                                onNudge={nudgePaneRatio}
                                ratio={paneRatio}
                            />
                        )}
                        {sidePane}
                    </Box>
                    {/* 移动端从编辑态回列表。
                        ⚠️ 同样不能用 `md:`（900px）：两屏切换现在由 bp === "mobile"（768）
                        决定，按钮要跟它**同一个判据**，否则会出现「按钮在、列表也在」的矛盾态。 */}
                    {mobileDetail && bp === "mobile" && (
                        <Box sx={{ display: "flex", p: 1, borderTop: "1px solid rgba(128,128,128,0.25)", flexShrink: 0 }}>
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
                            backgroundColor: "rgba(15, 23, 42, 0.45)",
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
                    {navInner}
                </Box>
            </Drawer>

            {/* 分类相关的弹窗：新建 / 重命名（NamePromptDialog）与删除二次确认
                （ConfirmDialog）。原来这些走的是 window.prompt / window.confirm ——
                样式突兀，且部分 WebView 直接拦掉，表现为「点了没反应」。 */}
            <NamePromptDialog
                open={namePrompt !== null}
                title={namePrompt?.title ?? ''}
                description={namePrompt?.description}
                defaultValue={namePrompt?.defaultValue ?? ''}
                confirmText={namePrompt?.confirmText ?? '确定'}
                placeholder={namePrompt?.kind === 'folder' ? '文件夹名字' : '标签名字'}
                onConfirm={submitNamePrompt}
                onClose={closeNamePrompt}
            />
            <ConfirmDialog
                open={removeTarget !== null}
                title={`删除${removeTarget?.kind === 'folder' ? '文件夹' : '标签'}`}
                description={
                    removeTarget?.kind === 'folder' ? (
                        <>
                            真的要删除「{removeTarget?.name}」吗？
                            <br />
                            里面的笔记**不会被删**，只是回到「未归类」；直接挂在它下面的子文件夹会升到根目录。
                        </>
                    ) : (
                        <>
                            真的要删除标签「{removeTarget?.name}」吗？笔记本身不会动，只是不再带这个标签。
                        </>
                    )
                }
                impact={{
                    object: removeTarget?.kind === 'folder' ? '文件夹' : '标签',
                    undoable: false,
                }}
                danger
                confirmText='删除'
                onConfirm={submitRemove}
                onClose={closeRemove}
            />
        </Box>
    );
}

/**
 * Markdown 预览。
 *
 * 渲染是**异步**的：markdown-it 走动态 import（必须 lazy，否则进首屏）。
 * 所以先渲染一个占位，解析完再替换 —— 免得每次输入都闪一下。
 */
function MarkdownPreview({
    source,
    resolveNote,
    onOpenNote,
    features,
}: {
    source: string;
    /** 笔记嵌入 `![[标题]]` 按标题找目标 */
    resolveNote?: (title: string) => NoteEmbedTarget | null;
    /** 点嵌入标题跳到那篇笔记 */
    onOpenNote?: (title: string) => void;
    /** 预览功能开关（公式 / 图表 / 折叠代码块），来自设置面板 */
    features?: RenderFeatures;
}) {
    const [node, setNode] = useState<ReactNode>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!source) {
            setNode(null);
            return;
        }
        void renderMarkdownToReact(source, { resolveNote, onOpenNote, features }).then(result => {
            if (cancelled) return;
            setNode(result);
            setReady(true);
        });
        return () => {
            // 输入很快时，旧的解析结果要丢掉，否则会闪回上一版内容
            cancelled = true;
        };
    }, [source, resolveNote, onOpenNote, features]);

    if (!source) {
        return (
            <Typography variant='body2' color='text.disabled'>
                （空）
            </Typography>
        );
    }
    if (!ready) {
        return (
            <Typography variant='body2' color='text.disabled'>
                解析中…
            </Typography>
        );
    }
    // ⚠️ `overflowWrap: "anywhere"` 不是 `wordBreak: "break-word"`（2026-10-07 用户报
    // 「分栏时右侧内容超出屏幕」）。两者差别就在中文长句上：
    //   break-word  只在**词边界**断行 —— 而中文没有空格，
    //                 于是「## 引用内容引用内容…」这种一整串 CJK 被当成一个超长单词，
    //                 撑到 1000px 宽也不断，直接把预览层顶出屏幕且**没有滚动条**
    //                 （真机 1080 宽复现：预览层 377px，标题被切掉半个字）。
    //   anywhere     必要时在任意字符间断行 —— 正是 inkstone 用的
    //                 （prose.css:429/435/897/960 全是 `overflow-wrap: anywhere`）。
    // 源码区（CodeMirror）早就配了 `overflowWrap: "anywhere"`，只有预览层漏了。
    return (
        <Box sx={{ overflowWrap: "anywhere", wordBreak: "break-word", lineHeight: 1.7 }}>
            {node}
        </Box>
    );
}

/** 一个工具按钮：icon / label 二选一，before/after 是包在选区两侧的语法 */
/** 表格菜单里的常用尺寸：给几个现成的，不逼用户先想行列数 */
const TABLE_PRESETS: { label: string; rows: number; cols: number }[] = [
    { label: "2 行 × 3 列", rows: 2, cols: 3 },
    { label: "3 行 × 4 列", rows: 3, cols: 4 },
    { label: "4 行 × 5 列", rows: 4, cols: 5 },
];

interface ToolSpec {
    key: string;
    icon?: ReactNode;
    label?: string;
    title: string;
    before: string;
    after?: string;
    placeholder?: string;
    /**
     * 对应 `EDITOR_SHORTCUTS` 的 id。有绑定 → tooltip 显示快捷键；
     * 没有（留空）→ 只显示名称，不显示一个按了没反应的键。
     */
    shortcutId?: string;
    /**
     * 这是**行首前缀**（引用 / 列表），不是「在光标处包一段」。
     * 必须走 toggleLinePrefix —— 否则光标停在行尾时前缀会掉在行中间。
     */
    linePrefix?: boolean;
}

/**
 * 工具栏分组：参照 inkstone 收成「强调 | 列表」两段独立图标。
 *
 * ⚠️ `shortcutId` 指向 `EDITOR_SHORTCUTS` 里的条目（不是快捷键字符串本身）。
 * 渲染时用 `comboFor(id)` 反查 —— 这样平台差异（mac ⌘ / 其它 Ctrl）只在一处处理，
 * 加新快捷键时也永远不会出现「菜单上写的和实际按的不一致」。
 */
const TOOL_GROUPS: { name: string; tools: ToolSpec[] }[] = [
    {
        name: "强调",
        tools: [
            {
                key: "bold",
                icon: <FormatBoldIcon fontSize='small' />,
                title: "加粗",
                before: "**",
                after: "**",
                placeholder: "粗体",
                shortcutId: "bold",
            },
            {
                key: "italic",
                icon: <FormatItalicIcon fontSize='small' />,
                title: "斜体",
                before: "*",
                after: "*",
                placeholder: "斜体",
                shortcutId: "italic",
            },
            {
                key: "strike",
                icon: <StrikethroughIcon fontSize='small' />,
                title: "删除线",
                before: "~~",
                after: "~~",
                placeholder: "删除",
                shortcutId: "strikethrough",
            },
            {
                key: "highlight",
                icon: <FormatColorTextIcon fontSize='small' />,
                title: "高亮",
                before: "==",
                after: "==",
                placeholder: "高亮",
            },
            {
                key: "code",
                icon: <CodeIcon fontSize='small' />,
                title: "行内代码",
                before: "`",
                after: "`",
                placeholder: "code",
                shortcutId: "inline-code",
            },
        ],
    },
    {
        name: "列表",
        tools: [
            {
                key: "ul",
                icon: <FormatListBulletedIcon fontSize='small' />,
                title: "无序列表",
                before: "- ",
                placeholder: "列表项",
                shortcutId: "bullet-list",
                linePrefix: true,
            },
            {
                key: "ol",
                icon: <FormatListNumberedIcon fontSize='small' />,
                title: "有序列表",
                before: "1. ",
                placeholder: "列表项",
                shortcutId: "ordered-list",
                linePrefix: true,
            },
            {
                key: "task",
                icon: <ChecklistIcon fontSize='small' />,
                title: "任务列表",
                before: "- [ ] ",
                placeholder: "要做的事",
                shortcutId: "task-list",
                linePrefix: true,
            },
            {
                key: "quote",
                icon: <FormatQuoteIcon fontSize='small' />,
                title: "引用",
                before: "> ",
                placeholder: "引用",
                shortcutId: "quote",
                linePrefix: true,
            },
        ],
    },
];

/**
 * 代码块语言下拉（阶段四第 12 条）。
 *
 * 预览层（markdown-it）本来就会把 ```js 渲染成 `<code class="language-js">`
 * —— 差的一直只是「怎么把语言标上去」这个入口，所以这里只做选择，不碰渲染。
 * 第一项留空 = 纯文本：不标语言时预览就是普通 <pre>，别逼用户非选一个。
 */
const CODE_LANGUAGES: { label: string; value: string }[] = [
    { label: "纯文本", value: "" },
    { label: "JavaScript", value: "js" },
    { label: "TypeScript", value: "ts" },
    { label: "Python", value: "python" },
    { label: "Bash / Shell", value: "bash" },
    { label: "JSON", value: "json" },
    { label: "HTML", value: "html" },
    { label: "CSS", value: "css" },
    { label: "SQL", value: "sql" },
    { label: "Java", value: "java" },
    { label: "Go", value: "go" },
    { label: "Rust", value: "rust" },
    { label: "C / C++", value: "cpp" },
    { label: "YAML", value: "yaml" },
    { label: "Markdown", value: "markdown" },
    { label: "Mermaid 图表", value: "mermaid" },
    { label: "Diff", value: "diff" },
];

/**
 * 下拉菜单项里「左边名字、右边快捷键」那套排版。
 *
 * ⚠️ 只能走 `sx`，**不能**写 `slotProps={{ root: { style: … } }}` ——
 * MUI v9 的 MenuItem 压根没有 slotProps 这个 prop（它不是 ButtonBase），
 * 写了 tsc -b 直接报 TS2769。之前 10 个菜单项各写一遍，也是同一个错。
 */
const menuRowSx = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
} as const;

/** 标题层级下拉（H1/H2/H3）—— 标题是「行首加前缀」，走另一条路径 */
/**
 * 标题下拉的 7 档（inkstone 的 `setHeading(0..6)`）。
 * `shortcutId` 用来查快捷键显示在菜单项右侧 —— 别在这里硬写 "Ctrl+Alt+2"，
 * 平台差异（mac 是 ⌘）由 editorShortcuts 统一处理。
 */
const HEADING_LEVELS: { level: string; label: string; prefix: string; value: number; shortcutId: string }[] = [
    // ⚠️ 2026-07 文案对齐 inkstone zh-CN：
    //   workspace.paragraph      = "正文"
    //   workspace.heading_value0 = "{value0} 级标题"
    // 之前写的是「正文（去掉标题）」「H1 一级标题」—— 那个 H1 冗余（菜单项在标题组里，
    // 「1 级标题」已经够了），而解释性文案该放 Tooltip 不该占菜单项文字。
    { level: "0", label: "正文", prefix: "", value: 0, shortcutId: "paragraph" },
    { level: "1", label: "1 级标题", prefix: "# ", value: 1, shortcutId: "h1" },
    { level: "2", label: "2 级标题", prefix: "## ", value: 2, shortcutId: "h2" },
    { level: "3", label: "3 级标题", prefix: "### ", value: 3, shortcutId: "h3" },
    { level: "4", label: "4 级标题", prefix: "#### ", value: 4, shortcutId: "h4" },
    { level: "5", label: "5 级标题", prefix: "##### ", value: 5, shortcutId: "h5" },
    { level: "6", label: "6 级标题", prefix: "###### ", value: 6, shortcutId: "h6" },
];

/**
 * Markdown 格式工具栏。
 *
 * 只在「源码」可见时出现 —— 预览模式下没有可编辑的文本，工具栏会让人以为能改。
 * 按钮用 `onMouseDown` 的 preventDefault 保住 textarea 的选区：
 * 默认的 mousedown 会让输入框失焦，selectionStart 就变成了 0，
 * 插入的位置会全跑到开头去。
 */
/**
 * Blob → data URI。
 *
 * 为什么需要：上传接口返回的 URL 走 cookie 鉴权，浏览器 `<img src>` 不会带
 * 我们自己的鉴权流程（它只带同源 cookie，但接口要求的是登录态 cookie ——
 * 同源下其实会带，真正的问题是**图片加载失败时无法区分是 401 还是 404**）。
 * 内嵌成 data URI 后图片成为正文的一部分，离线可读、不需要再发请求。
 * 代价见 pickImage 注释（25MB 上限、只内嵌小图）。
 */
function blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
        reader.readAsDataURL(blob);
    });
}

function MarkdownToolbar({
    onInsert,
    onLinePrefix,
    onSetHeading,
    onCodeLanguage,
    onTable,
    onFormula,
    onFootnoteRef,
    onCallout,
    onInsertEmbed,
    onInsertBlockRef,
    onInsertBlockId,
    onInsertFrontMatter,
    onInsertTag,
    onInsertWikiLink,
    onInsertHiddenComment,
    onNotify,
    activeId,
    onUploadImage,
    canInsert,
    onInsertFold,
    onInsertTabs,
    onInsertDivider,
}: {
    onInsert: (before: string, after: string, placeholder: string) => void;
    /** 行首前缀的开关：引用 `> `、列表 `- `（再点一次摘掉） */
    onLinePrefix: (prefix: string) => void;
    /**
     * 设标题层级 0–6（inkstone 的 `setHeading`）。
     * 与 onLinePrefix 的区别：这个会**先剥掉已有前缀**再设，
     * 所以「二级标题上点一级标题」得到的是一级，不是三级。
     */
    onSetHeading: (level: number) => void;
    /** 阶段四第 12 条：给光标所在的（或新插入的）代码块定语言 */
    onCodeLanguage: (lang: string) => void;
    /** 阶段四第 12 条：表格的插入 / 增删行列 */
    onTable: (op: TableOp) => void;
    /** 阶段四第 12c 条：插入公式（行内 $…$ / 块级 $$…$$） */
    onFormula: (kind: "inline" | "block" | "inlineTex" | "blockTex") => void;
    /**
     * 「链接与引用」：把选中的文字变成脚注引用。
     * 它没法用 onInsert 那套 before/after 表达 —— 脚注要**两处**改动
     * （文末一条定义 + 正文一个引用），所以单开一个回调。
     */
    onFootnoteRef: () => void;
    /** 内容块：插 `> [!类型]` 骨架（inkstone 的「内容块」） */
    onCallout: (type: string) => void;
    /** 笔记嵌入 `![[标题]]`（块级，单独成行） */
    onInsertEmbed: () => void;
    /** 块引用 `![[标题#^块ID]]`（块级，单独成行） */
    onInsertBlockRef: () => void;
    /** 给当前行追加块 ID（` ^abc12`） */
    onInsertBlockId: () => void;
    /** 在笔记最前面插入 YAML 属性块 */
    onInsertFrontMatter: () => void;
    /** 插入标签 `#标签`（行内） */
    onInsertTag: () => void;
    /** 插入双链 `[[标题]]`（行内，可点跳转） */
    onInsertWikiLink: () => void;
    /** 插入隐藏注释 `%%…%%`（预览不显示） */
    onInsertHiddenComment: () => void;
    /** 插入折叠块 `> [!FOLD] 标题` */
    onInsertFold: () => void;
    /** 插入标签页容器 `:::tabs … :::` */
    onInsertTabs: () => void;
    /** 插入分隔线 `---` */
    onInsertDivider: () => void;
    /** 上传进度 / 失败时提示（与页面同一套通知） */
    onNotify?: (message: string, level: "error" | "success" | "info") => void;
    /** 当前笔记 id（图片挂到这条笔记名下） */
    activeId?: number | null;
    /**
     * 上传一张图，返回可直接取图的 URL。
     *
     * ⚠️ 走**回调**而不是在工具栏里直接 import api：NotesPage 并不持有 api 实例
     * （数据读写都在父组件那一层）。做成回调后单测也能塞一个假的进去，
     * 不用起真实后端。
     */
    onUploadImage: (file: File, noteId: number | null) => Promise<{ url: string; filename: string; size: number }>;
    /**
     * 编辑器是否真的能接住插入（默认 true）。
     *
     * ⚠️ 「预览」模式下编辑器不挂载，insertAtCursor 会**静默 return** ——
     * 图传上去了正文却没变，用户看到的就是「预览窗里没有这张图」
     * （2026-10-08 用户连报两轮「上传后看不见图片」的一条真因）。
     * 主工具栏在预览模式下要传 false：先挡住并说明，别让人白传一次。
     */
    canInsert?: boolean;
}) {
    const canInsertOk = canInsert !== false;
    const [headingAnchor, setHeadingAnchor] = useState<HTMLElement | null>(null);
    const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
    const [imageAnchor, setImageAnchor] = useState<HTMLElement | null>(null);
    const [insertAnchor, setInsertAnchor] = useState<HTMLElement | null>(null);
    const [blockAnchor, setBlockAnchor] = useState<HTMLElement | null>(null);
    const [langAnchor, setLangAnchor] = useState<HTMLElement | null>(null);
    /**
     * 「代码语言」菜单的锚点（2026-07 新增）。
     * 为什么与 `langAnchor` 分开：inkstone 的 code 菜单只有 3 项
     * （代码块 / 增强代码块 / Mermaid），而我们有 17 种语言要选 ——
     * 塞进同一个菜单会变成 19 项，和 inkstone 完全不像。
     * 两个独立按钮 + 两个独立菜单：主按钮管「插什么」，语言按钮管「标什么」。
     */
    const [codeLangAnchor, setCodeLangAnchor] = useState<HTMLElement | null>(null);
    /** 「提示块」二级菜单的锚点（2026-07）：主菜单只 1 项「提示块」，5 种类型在二级里。 */
    const [calloutAnchor, setCalloutAnchor] = useState<HTMLElement | null>(null);
    const [tableAnchor, setTableAnchor] = useState<HTMLElement | null>(null);
    const [formulaAnchor, setFormulaAnchor] = useState<HTMLElement | null>(null);
    /** 隐藏的 `<input type=file>`：点「上传图片」时用它弹系统选择框 */
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    /** 上传中：禁掉菜单项，避免连点把同一张图传两遍 */
    const [uploading, setUploading] = useState(false);

    /**
     * 选一张图 → 上传 → 把 Markdown 插进正文。
     *
     * 三步链路上有两个容易踩的点：
     *
     *  1. **上传的是原始 File，不是 base64 / multipart**（见 worker/routes/data.ts
     *     的 handleUploadAttachment）：base64 撑大 33%，而单文件上限就是存储
     *     单条的 25MB，base64 之后必然超。
     *
     *  2. **返回的 url 走鉴权，`<img src>` 不能直接用它**（会 401）。
     *     所以这里把图片 fetch 成 blob、转成 data URI 再插进正文 ——
     *     代价是正文体积变大（图片内嵌），但这是「离线可读」与
     *     「不重复鉴权」换来的；真实部署更该用受保护的 URL + 一次性 token。
     *     ⚠️ 25MB 的图内嵌会让笔记正文膨胀到几十 MB（D1 单行上限 2MB），
     *     所以这里**只内嵌小于 1MB 的图**，更大的只插 URL 链接。
     */
    const pickImage = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const handleImagePicked = useCallback(
        async (file: File) => {
            // ⚠️ 没有编辑器（预览模式）时 insertAtCursor 会**静默 return**：
            // 图传上去了、正文没变，用户看到的就是「预览窗里没有这张图」。
            // 所以这里先把话说清楚，而不是让它悄悄过去。
            if (!canInsertOk) {
                onNotify?.("预览模式插不进正文：先切回「编辑」或「分栏」再传图", "error");
                return;
            }
            // 先本地挡一道：与后端 ATTACHMENT_MAX_BYTES 一致（25MB）。
            // 不挡的话要等传完 25MB 才收到 413，用户干等半天还以为卡住了。
            if (file.size > 25 * 1024 * 1024) {
                onNotify?.("这张图超过 25MB，换一张小一点的再传", "error");
                return;
            }
            setUploading(true);
            try {
                const uploaded = await onUploadImage(file, activeId ?? null);
                // 小图内嵌成 data URI（离线可读），大图只插链接
                const INLINE_MAX = 1024 * 1024;
                if (file.size <= INLINE_MAX) {
                    const response = await fetch(uploaded.url, { credentials: "same-origin" });
                    if (response.ok) {
                        const blob = await response.blob();
                        // ⚠️ 光看 response.ok 不够（2026-10-07 实测）：200 也可能是
                        // 错误页 / SPA 兜底的 index.html。内嵌了它，正文里就是一坨
                        // `data:text/html;base64,...`，比裂图还难排查。
                        // 不是图片就退回插 URL，让浏览器自己去裂、至少是个正常链接。
                        if (blob.type.startsWith("image/")) {
                            const dataUri = await blobToDataUri(blob);
                            onInsert(`![${uploaded.filename}](`, ")", dataUri);
                            onNotify?.(`已插入图片「${uploaded.filename}」`, "success");
                            return;
                        }
                        console.warn("附件地址返回的不是图片，改为插入链接", blob.type);
                    }
                }
                onInsert(`![${uploaded.filename}](`, ")", uploaded.url);
                // ⚠️ 必须给一句反馈：之前插入完一点动静都没有，用户在预览里
                // 没立刻找到图，就以为「上传没生效」（2026-10-08 用户连报两轮）。
                onNotify?.(`已插入图片「${uploaded.filename}」`, "success");
            } catch (error) {
                onNotify?.(
                    error instanceof Error ? error.message : "图片上传失败",
                    "error"
                );
            } finally {
                setUploading(false);
            }
        },
        [activeId, canInsertOk, onInsert, onNotify, onUploadImage]
    );

    /**
     * inkstone 的「菜单 + 主按钮」双态：一半的图标既能直接点（执行主功能），
     * 又带一个小箭头开下拉。之前我们只做了下拉，想插普通链接得点两下；
     * 现在点图标直接插链接、点小箭头才是完整列表。
     */
    const toolBtnSx = {
        width: 28,
        height: 28,
        color: "text.secondary",
        flexShrink: 0,
        "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
    } as const;
    /** 带下拉箭头的按钮：图标 + ChevronDown，整体一个圆角 hover 底 */
    const menuBtnSx = (open: boolean) => ({
        width: 30,
        height: 28,
        minWidth: 0,
        p: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 0.25,
        borderRadius: "8px",
        color: "text.secondary",
        ...(open ? { bgcolor: "rgba(128,128,128,0.16)", color: "text.primary" } : {}),
        "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
    }) as const;
    /** 分组之间的竖线（inkstone 的 Divider：mx-1、16px 高、1px 宽） */
    const divider = <Divider orientation='vertical' flexItem sx={{ mx: 0.5, my: 0.5 }} />;

    return (
        <>
        {/* 隐藏的文件选择框。
            ⚠️ 为什么不用 `display:none` 的 `<input>` 直接放工具栏里：
            它会被 flexWrap 的布局当成第 28 个「按钮」占位（虽然 0 宽，
            但在换行计算里仍占一个 flex item），极端窄栏下会多折一行。
            放在 fragment 里、工具栏外面，布局就不算它。 */}
        <input
            ref={fileInputRef}
            type='file'
            accept='image/png,image/jpeg,image/gif,image/webp,image/avif'
            style={{ display: "none" }}
            data-file-input='1'
            onChange={e => {
                const file = e.target.files?.[0];
                // ⚠️ 读完立刻清空 value：否则选同一张图第二次不会触发 change
                e.target.value = "";
                if (file) void handleImagePicked(file);
            }}
        />
        <Box
            role='toolbar'
            aria-label='Markdown 格式'
            sx={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 0.25,
                px: 1,
                py: 0.25,
                // ⚠️ 不能定高 + overflowX:auto（2026-10-07 用户报）：分屏时一栏只有
                // 半个屏宽，二十几个按钮塞一行必然溢出 —— overflowX:auto 会连带把
                // overflowY 也变成 auto，横滚动条一出现就把 40px 撑出**竖向滚动**，
                // 工具栏还会盖住标题。改成**换行铺开**：窄栏下自动折成两三行，
                // 高度自适应（编辑器是 flex:1 会自己让空间），永远不出现滚动条。
                minHeight: 36,
                flexShrink: 0,
                borderBottom: "1px solid var(--card-border)",
            }}
        >
            {/* ① 标题层级（inkstone 的 heading 菜单）。
                ⚠️ tooltip 一律写「会发生什么」，不写「这是什么」——
                用户看不懂的是**作用**，不是名词（2026-10-07 反馈）。 */}
            <Tooltip title='把这一行变成标题：一级 / 二级 / 三级 / 正文'>
            <Button
                size='small'
                aria-label='标题层级'
                aria-haspopup='menu'
                aria-expanded={headingAnchor ? true : undefined}
                onClick={e => setHeadingAnchor(e.currentTarget)}
                sx={{
                    width: 28,
                    height: 28,
                    minWidth: 0,
                    p: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 0.25,
                    borderRadius: "8px",
                    color: "text.secondary",
                    "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                }}
            >
                <ViewHeadlineIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            <Menu
                open={Boolean(headingAnchor)}
                anchorEl={headingAnchor}
                onClose={() => setHeadingAnchor(null)}
            >
                {HEADING_LEVELS.map(h => (
                    <Fragment key={h.level}>
                        {/* ⚠️ inkstone 的 headingItems 在「正文」之后有一条分隔线
                            （EditorToolbar.tsx:46 `separatorBefore: level === 1`）——
                            「正文」是「去掉标题」，语义上跟 H1~H6 是两类，分开更清楚。 */}
                        {h.level === "1" && <Divider />}
                        <MenuItem
                            data-heading={h.level}
                            sx={menuRowSx}
                            onClick={() => {
                                onSetHeading(h.value);
                                setHeadingAnchor(null);
                            }}
                        >
                            <span>{h.label}</span>
                            <Kbd combo={comboFor(h.shortcutId)} />
                        </MenuItem>
                    </Fragment>
                ))}
            </Menu>

            {divider}

            {/* ⑦ 独立图标组（inkstone 的 ToolButton 群）：强调 → 行内代码 → 列表。
                ⚠️ 2026-10-07 把它从工具栏**末尾**挪到了这里（紧跟标题层级之后），
                对齐 inkstone EditorToolbar.tsx:101-112 的顺序：
                  标题 │ 加粗 斜体 删除线 高亮 行内代码 │ 无序 有序 任务 引用
                之前它在最后面，于是「加粗」这种最高频的按钮排在倒数第二，跟 inkstone 差得最远。
                ⚠️ tooltip 里带上快捷键（inkstone 的 Tooltip 支持 combo），
                这样「这个键是干什么的」不用去记 —— 但**只在真的有绑定时**才显示，
                高亮这类没绑定的就只写名称，不显示一个按了没反应的键。 */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
                {TOOL_GROUPS.map((group, gi) => (
                    <Fragment key={group.name}>
                        {gi > 0 && <Divider orientation='vertical' flexItem sx={{ mx: 0.5, my: 0.5 }} />}
                        {group.tools.map(tool => {
                            const combo = comboFor(tool.shortcutId ?? "");
                            return (
                                <Tooltip
                                    key={tool.key}
                                    title={
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                            <span>{tool.title}</span>
                                            {combo && <Kbd combo={combo} />}
                                        </span>
                                    }
                                >
                                    <IconButton
                                        size='small'
                                        onMouseDown={e => e.preventDefault()}
                                        onClick={() =>
                                            tool.linePrefix
                                                ? onLinePrefix(tool.before)
                                                : onInsert(tool.before, tool.after ?? "", tool.placeholder ?? "")
                                        }
                                        data-tool={tool.key}
                                        aria-label={tool.title}
                                        sx={toolBtnSx}
                                    >
                                        {tool.icon ?? tool.label}
                                    </IconButton>
                            </Tooltip>
                            );
                        })}
                    </Fragment>
                ))}
            </Box>

            {divider}

            {/* ② 链接与引用（inkstone 的 reference 菜单）：**图标直接插链接**，
                小箭头才开下拉 —— 想插最常见的普通链接不用点两次。
                data-tool='link' 挂在主按钮上，老的用例按它找按钮不丢。 */}
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入网址'>
                <IconButton
                    size='small'
                    aria-label='链接'
                    data-tool='link'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("[", "](https://)", "链接文字")}
                    sx={{ ...toolBtnSx, borderRadius: "8px 0 0 8px" }}
                >
                    <LinkIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='插入网址，或引用另一篇笔记（双链 / 嵌入 / 脚注）'>
                <IconButton
                    size='small'
                    aria-label='链接与引用'
                    data-tool='link-menu'
                    aria-haspopup='menu'
                    aria-expanded={linkAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setLinkAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 16, borderRadius: "0 8px 8px 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            <Menu
                open={Boolean(linkAnchor)}
                anchorEl={linkAnchor}
                onClose={() => setLinkAnchor(null)}
            >
                <MenuItem
                    data-link-op='external'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsert("[", "](https://)", "链接文字");
                        setLinkAnchor(null);
                    }}
                >
                    <span>链接</span>
                    <Kbd combo={comboFor("link")} />
                </MenuItem>
                {/* ⚠️ inkstone 的 referenceItems 有两条分隔线（EditorToolbar.tsx:51/54）：
                    `链接` 是「插一个普通链接」，下面三项是「引用到别处的东西」，
                    `脚注` 又是另一类（要同时改文末定义）。分组比说明文字清楚。 */}
                <Divider />
                <MenuItem
                    data-link-op='wikilink'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertWikiLink();
                        setLinkAnchor(null);
                    }}
                >
                    <span>双链</span>
                </MenuItem>
                <MenuItem
                    data-link-op='embed'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertEmbed();
                        setLinkAnchor(null);
                    }}
                >
                    <span>笔记嵌入</span>
                </MenuItem>
                <MenuItem
                    data-link-op='blockref'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertBlockRef();
                        setLinkAnchor(null);
                    }}
                >
                    <span>块引用</span>
                </MenuItem>
                <Divider />
                {/* 脚注要同时改两处（文末定义 + 正文引用），和上面「包一层」不是一回事，
                    所以逻辑上归「引用」而不是「链接」。data-tool 保持不变，老用例能点到。 */}
                {/* 菜单项文字照 inkstone 的短名词（脚注 / 块 ID / 折叠内容…），
                    解释性文案搬进 tooltip —— 既对齐了 inkstone，又不丢可理解性。 */}
                <Tooltip title='把选中的文字变成脚注引用，定义自动放到文末'>
                <MenuItem
                    data-link-op='footnote'
                    data-tool='footnote-ref'
                    sx={menuRowSx}
                    onClick={() => {
                        onFootnoteRef();
                        setLinkAnchor(null);
                    }}
                >
                    <span>脚注</span>
                </MenuItem>
                </Tooltip>
            </Menu>

            {/* ③ 图片（inkstone 的 image 菜单）：同样是「主按钮 + 箭头」。
                2026-10-08 起本地上传已接上（KV 落地），下面的 Tooltip 别再写
                「还没开放」—— 用户会照着提示以为是坏的（真发生过）。 */}
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入图片：点图标直接传本地图，点箭头选网络图片'>
                <IconButton
                    size='small'
                    aria-label='图片'
                    data-tool='image'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("![", "](https://)", "图片说明")}
                    sx={{ ...toolBtnSx, borderRadius: "8px 0 0 8px" }}
                >
                    <ImageIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='插入图片菜单：上传图片 / 网络图片'>
                <IconButton
                    size='small'
                    aria-label='插入图片'
                    data-tool='image-menu'
                    aria-haspopup='menu'
                    aria-expanded={imageAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setImageAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 16, borderRadius: "0 8px 8px 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            <Menu
                open={Boolean(imageAnchor)}
                anchorEl={imageAnchor}
                onClose={() => setImageAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:56-59 `imageItems`）：
                    上传图片在前、网络图片在后，且**没有分隔线**。
                    之前我们是「网络图片 → 分隔线 → 上传图片（置灰）」，顺序反了。
                    文案也照 inkstone 的 zh-CN 原文：`上传图片` / `网络图片`。
                    「暂未开放」这类说明搬进 Tooltip，不占菜单项文字。

                    ⚠️ 2026-10-07 后端就绪后**解除置灰**：存储走 KV（R2 未开通，
                    但接口留着 —— 开了只加一条 wrangler 绑定，前端不用动）。 */}
                <Tooltip
                    title={
                        uploading
                            ? '正在上传…'
                            : !canInsertOk
                              ? '预览模式插不进正文：先切回「编辑」或「分栏」再传图'
                              : '从本机选一张图片插进来（≤25MB，PNG / JPEG / GIF / WebP / AVIF）'
                    }
                >
                <MenuItem
                    data-image-op='upload'
                    disabled={uploading || !canInsertOk}
                    onClick={() => {
                        setImageAnchor(null);
                        pickImage();
                    }}
                >
                    上传图片
                </MenuItem>
                </Tooltip>
                <MenuItem
                    data-image-op='url'
                    onClick={() => {
                        onInsert("![", "](https://)", "图片说明");
                        setImageAnchor(null);
                    }}
                >
                    网络图片
                </MenuItem>
            </Menu>

            <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />

            {/* ④ 笔记工具（inkstone 的 note 菜单）：标签 / 块 ID / 笔记属性 / 隐藏注释。
                从文字按钮「插入」改成图标 + 箭头，和左右两组的视觉重量对齐。 */}
            <Tooltip title='不太常用但有用的语法：标签、块 ID、笔记属性、隐藏注释'>
            <Button
                size='small'
                aria-label='笔记工具'
                data-tool='note'
                aria-haspopup='menu'
                aria-expanded={insertAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setInsertAnchor(e.currentTarget)}
                sx={menuBtnSx(Boolean(insertAnchor))}
            >
                <SubjectIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            <Menu
                open={Boolean(insertAnchor)}
                anchorEl={insertAnchor}
                onClose={() => setInsertAnchor(null)}
            >
                <Tooltip title='给这篇笔记加一个 #标签，便于检索'>
                <MenuItem
                    data-insert-op='tag'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertTag();
                        setInsertAnchor(null);
                    }}
                >
                    <span>插入标签</span>
                </MenuItem>
                </Tooltip>
                <Tooltip title='给这一段加个锚点（^标识），别处能引用它'>
                <MenuItem
                    data-insert-op='blockid'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertBlockId();
                        setInsertAnchor(null);
                    }}
                >
                    <span>块 ID</span>
                </MenuItem>
                </Tooltip>
                {/* ⚠️ inkstone 的 noteItems 也有两条分隔线（EditorToolbar.tsx:63/64）：
                    标签/块 ID 是「往正文里插东西」，属性是「改整篇笔记的元信息」，
                    隐藏注释又是另一类。 */}
                <Divider />
                <Tooltip title='给整篇笔记加标题、标签等信息（YAML 头部）'>
                <MenuItem
                    data-insert-op='frontmatter'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertFrontMatter();
                        setInsertAnchor(null);
                    }}
                >
                    <span>笔记属性（YAML）</span>
                </MenuItem>
                </Tooltip>
                <Divider />
                <Tooltip title='写给自己看的备注，预览里不显示'>
                <MenuItem
                    data-insert-op='hidden'
                    sx={menuRowSx}
                    onClick={() => {
                        onInsertHiddenComment();
                        setInsertAnchor(null);
                    }}
                >
                    <span>隐藏注释</span>
                    <Kbd combo={comboFor("comment")} />
                </MenuItem>
                </Tooltip>
            </Menu>

            {/* ⑤ 内容块（inkstone 的 block 菜单）：提示框 / 折叠 / 标签页 / 分隔线。
                ⚠️ 2026-10-07 删掉了前面那个**文字「块」按钮**：
                它和下面这个图标版都叫 aria-label='块'、都开同一个 blockAnchor 菜单，
                真机上就是两个按钮干同一件事（读屏也会念两遍「块」）。
                inkstone 那边只有图标 + ChevronDown 一个（EditorToolbar.tsx:121）。 */}
            <Tooltip title='成块的语法：提示框、折叠内容、标签页、分隔线'>
            <Button
                size='small'
                aria-label='内容块'
                data-tool='callout'
                aria-haspopup='menu'
                aria-expanded={blockAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setBlockAnchor(e.currentTarget)}
                sx={menuBtnSx(Boolean(blockAnchor))}
            >
                <ViewStreamIcon sx={{ fontSize: 15 }} />
                <ExpandMoreIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            </Button>
            </Tooltip>
            <Menu
                open={Boolean(blockAnchor)}
                anchorEl={blockAnchor}
                onClose={() => setBlockAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:75-80 `blockItems`）：
                    4 项 —— `提示块` / `折叠内容` / `标签页` /（分隔线）`分隔线`。
                    之前我们有 8 项：5 种提示框（提示/技巧/重要/警告/引用）+ 折叠 + 标签页 + 分隔线。
                    合并成 1 项「提示块」，5 种类型挪到**二级菜单** ——
                    菜单与 inkstone 一致，功能一个不丢。
                    文案也照 zh-CN 原文，说明搬进 Tooltip。 */}
                <MenuItem
                    data-block-op='callout-menu'
                    aria-label='提示块类型'
                    aria-haspopup='menu'
                    onClick={e => {
                        // 停住不让菜单关闭，然后在这项右侧开二级菜单
                        e.stopPropagation();
                        setCalloutAnchor(e.currentTarget);
                    }}
                    sx={{ position: "relative" }}
                >
                    提示块
                </MenuItem>
                {calloutAnchor && (
                    <Menu
                        open
                        anchorEl={calloutAnchor}
                        onClose={() => setCalloutAnchor(null)}
                        anchorOrigin={{ vertical: "center", horizontal: "right" }}
                        transformOrigin={{ vertical: "center", horizontal: "left" }}
                    >
                        {(
                            [
                                ["NOTE", "提示"],
                                ["TIP", "技巧"],
                                ["IMPORTANT", "重要"],
                                ["WARNING", "警告"],
                                ["QUOTE", "引用"],
                            ] as const
                        ).map(([type, label]) => (
                            <MenuItem
                                key={type}
                                data-block-op='callout'
                                data-callout-type={type}
                                onClick={() => {
                                    setCalloutAnchor(null);
                                    setBlockAnchor(null);
                                    onCallout(type);
                                }}
                            >
                                提示框 · {label}
                            </MenuItem>
                        ))}
                    </Menu>
                )}
                <Tooltip title='可点开 / 收起的一段'>
                <MenuItem
                    data-block-op='fold'
                    onClick={() => {
                        onInsertFold();
                        setBlockAnchor(null);
                    }}
                >
                    折叠内容
                </MenuItem>
                </Tooltip>
                <Tooltip title='把几段内容并排放，一页只显示一页'>
                <MenuItem
                    data-block-op='tabs'
                    onClick={() => {
                        onInsertTabs();
                        setBlockAnchor(null);
                    }}
                >
                    标签页
                </MenuItem>
                </Tooltip>
                <Divider />
                <Tooltip title='一条横线，把内容分段'>
                <MenuItem
                    data-block-op='divider'
                    onClick={() => {
                        onInsertDivider();
                        setBlockAnchor(null);
                    }}
                >
                    分隔线
                </MenuItem>
                </Tooltip>
            </Menu>

            {divider}

            {/* ⚠️ 引用按钮不在这里 —— 它已经并进下面的 TOOL_GROUPS「列表」组
                （inkstone 也是把引用和无序/有序/任务列表放一组的）。
                之前这里单独放一个，工具栏因此比 inkstone 宽出一截。 */}

            {/* ⑥ 代码与图表（inkstone 的 code 菜单）：**图标直接插代码块**，
                箭头里是 inkstone 那 3 项（代码块 / 增强代码块 / Mermaid 图表）。
                ⚠️ 2026-10-07 菜单名从「代码块语言」改成 inkstone 的 zh-CN 原文
                「代码与图表」—— 原来那个名字是按「这菜单里能选语言」起的，
                拆出独立的语言按钮后它就不贴切了。 */}
            <Box sx={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
                <Tooltip title='插入代码块'>
                <IconButton
                    size='small'
                    aria-label='代码块'
                    data-tool='pre'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsert("```\n", "\n```", "代码")}
                    sx={{ ...toolBtnSx, borderRadius: "8px 0 0 8px" }}
                >
                    <DataObjectIcon fontSize='small' />
                </IconButton>
                    </Tooltip>
                <Tooltip title='代码与图表：插代码块、画 Mermaid 图'>
                <IconButton
                    size='small'
                    aria-label='代码与图表'
                    data-tool='code-menu'
                    aria-haspopup='menu'
                    aria-expanded={langAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setLangAnchor(e.currentTarget)}
                    sx={{ ...toolBtnSx, width: 16, borderRadius: "0 8px 8px 0", ml: "2px" }}
                >
                    <ExpandMoreIcon sx={{ fontSize: 14, opacity: 0.7 }} />
                </IconButton>
                    </Tooltip>
            </Box>
            <Menu
                open={Boolean(langAnchor)}
                anchorEl={langAnchor}
                onClose={() => setLangAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:66-70 `codeItems`）：菜单只有 3 项
                    —— `代码块` / `增强代码块` / `Mermaid 图表`，且 Mermaid 前有分隔线。
                    之前这里是「代码块 / Mermaid + 17 种语言列表」，语言选择器
                    把这个菜单撑到 19 项，跟 inkstone 差得很远。
                    语言选择器是真实功能（inkstone 没有 —— 它在「增强代码块」里处理），
                    所以**保留但拆成独立的「代码语言」按钮**，不塞进这个菜单。 */}
                <MenuItem
                    data-code-lang='block'
                    onClick={() => {
                        onInsert("```\n", "\n```", "代码");
                        setLangAnchor(null);
                    }}
                >
                    代码块
                </MenuItem>
                <MenuItem
                    data-code-lang='enhanced'
                    onClick={() => {
                        onInsert("```js title=example.js showLineNumbers\n", "\n```", "// 代码");
                        setLangAnchor(null);
                    }}
                >
                    增强代码块
                </MenuItem>
                <Divider />
                <MenuItem
                    data-code-lang='mermaid'
                    onClick={() => {
                        onInsert("```mermaid\n", "\n```", "flowchart LR\n  A --> B");
                        setLangAnchor(null);
                    }}
                >
                    Mermaid 图表
                </MenuItem>
            </Menu>

            {/* 代码语言（inkstone 没有这个入口，我们保留 —— 标语言是真需求）。
                独立成一个按钮，避免把上面那个菜单撑成 19 项。 */}
            <Tooltip title='给已有的代码块标语言（js / python / sql…）'>
            <IconButton
                size='small'
                aria-label='代码语言'
                data-tool='code-lang-menu'
                aria-haspopup='menu'
                aria-expanded={codeLangAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setCodeLangAnchor(e.currentTarget)}
                sx={{ ...toolBtnSx }}
            >
                <CodeIcon fontSize='small' />
            </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(codeLangAnchor)}
                anchorEl={codeLangAnchor}
                onClose={() => setCodeLangAnchor(null)}
            >
                {CODE_LANGUAGES.map(item => (
                    <MenuItem
                        key={item.label}
                        data-code-lang={item.value || "plain"}
                        onClick={() => {
                            onCodeLanguage(item.value);
                            setCodeLangAnchor(null);
                        }}
                    >
                        {item.label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 公式下拉 */}
            <Tooltip title='插入公式：行内 $…$ 或单独一段的 $$…$$'>
                <IconButton
                    size='small'
                    aria-label='公式'
                    data-tool='formula'
                    aria-haspopup='menu'
                    aria-expanded={formulaAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setFormulaAnchor(e.currentTarget)}
                    sx={{
                        width: 28,
                        height: 28,
                        color: "text.secondary",
                        "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                    }}
                >
                    <CalculateIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(formulaAnchor)}
                anchorEl={formulaAnchor}
                onClose={() => setFormulaAnchor(null)}
            >
                {/* ⚠️ 2026-10-07 对齐 inkstone（EditorToolbar.tsx:71-74 `mathItems`）：只有两项
                    —— `行内公式` / `块级公式`。之前我们有 4 项，多出来的
                    `行内公式 \( … \)` / `独立公式 \[ … \]` 是 KaTeX 的第二套分隔符，
                    inkstone 不用（它只用 $…$ / $$…$$）。删掉以保持菜单一致。 */}
                <MenuItem
                    data-formula-op='inline'
                    onClick={() => {
                        onFormula("inline");
                        setFormulaAnchor(null);
                    }}
                >
                    行内公式
                </MenuItem>
                <MenuItem
                    data-formula-op='block'
                    onClick={() => {
                        onFormula("block");
                        setFormulaAnchor(null);
                    }}
                >
                    块级公式
                </MenuItem>
            </Menu>

            {/* 表格下拉 */}
            <Tooltip title='插入表格，或给已有表格增删行列'>
                <IconButton
                    size='small'
                    aria-label='表格'
                    data-tool='table'
                    aria-haspopup='menu'
                    aria-expanded={tableAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setTableAnchor(e.currentTarget)}
                    sx={{
                        width: 28,
                        height: 28,
                        color: "text.secondary",
                        "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                    }}
                >
                    <TableRowsIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(tableAnchor)}
                anchorEl={tableAnchor}
                onClose={() => setTableAnchor(null)}
            >
                {TABLE_PRESETS.map(p => (
                    <MenuItem
                        key={p.label}
                        data-table-preset={p.rows + "x" + p.cols}
                        onClick={() => {
                            onTable({ kind: "insert", rows: p.rows, cols: p.cols });
                            setTableAnchor(null);
                        }}
                    >
                        插入 {p.label}
                    </MenuItem>
                ))}
                <Divider />
                <MenuItem
                    data-table-op='addRow'
                    onClick={() => {
                        onTable({ kind: "addRow" });
                        setTableAnchor(null);
                    }}
                >
                    在下方插入一行
                </MenuItem>
                <MenuItem
                    data-table-op='delRow'
                    onClick={() => {
                        onTable({ kind: "delRow" });
                        setTableAnchor(null);
                    }}
                >
                    删除当前行
                </MenuItem>
                <MenuItem
                    data-table-op='addCol'
                    onClick={() => {
                        onTable({ kind: "addCol" });
                        setTableAnchor(null);
                    }}
                >
                    在右侧插入一列
                </MenuItem>
                <MenuItem
                    data-table-op='delCol'
                    onClick={() => {
                        onTable({ kind: "delCol" });
                        setTableAnchor(null);
                    }}
                >
                    删除当前列
                </MenuItem>
            </Menu>

        </Box>
        </>
    );
}
