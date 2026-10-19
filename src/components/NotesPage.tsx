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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import FolderIcon from "@mui/icons-material/Folder";
import ArchiveIcon from "@mui/icons-material/Archive";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import EditIcon from "@mui/icons-material/Edit";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import VisibilityIcon from "@mui/icons-material/VisibilityOutlined";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import MenuIcon from "@mui/icons-material/Menu";
import LastPageIcon from "@mui/icons-material/LastPage";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import HistoryIcon from "@mui/icons-material/History";
import ShareIcon from "@mui/icons-material/Share";
import BoltIcon from "@mui/icons-material/Bolt";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import SearchIcon from "@mui/icons-material/Search";
import SettingsIcon from "@mui/icons-material/Settings";
import SortIcon from "@mui/icons-material/Sort";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import Checkbox from "@mui/material/Checkbox";
import HubIcon from "@mui/icons-material/Hub";
import NoteGraphDialog from "./NoteGraphDialog";
import NotesTodoDialog from "./NotesTodoDialog";
import { todoCounts } from "../utils/noteTodoAgenda";
import BacklinksPanel from "./BacklinksPanel";
import UndoIcon from "@mui/icons-material/Undo";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaletteIcon from "@mui/icons-material/Palette";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
// —— 格式工具栏（对齐 inkstone 的 EditorToolbar：7 个下拉 + 独立图标组）——
import { Kbd } from "./Kbd";
import { EDITOR_SHORTCUTS } from "../utils/editorShortcuts";
import { extractNoteTags } from "../utils/markdownNoteTags";
import { readReadingPosition, writeReadingPosition } from "../utils/readingPosition";
import type {
    Note,
    NoteFolder,
    NoteImportStats,
    NoteRevision,
    NoteTag,
    NotesBackupSavePatch,
    NotesBackupState,
    NoteSearchResult,
    NotesImportPayload,
    WebDavErrorCode,
} from "../API/http";
import type { NoteImportProgress } from "../API/types";
import type { TrashedNote } from "../hooks/useNotes";
import {
    renderMarkdownToReact,
    seedAttachmentDimensions,
    type RenderFeatures,
} from "../utils/markdownToReact";
import { toggleTaskLine } from "../utils/noteTasks";
import type { CompletionSources } from "../utils/noteCompletion";
import { fuzzyFilter, fuzzyMatch } from "../utils/fuzzy";
import { createZip, readZip, type ZipEntry } from "../utils/zip";
import Highlighted from "./Highlighted";
import type { NoteEmbedTarget } from "./NoteEmbedNode";
import { useScrollLock } from "../hooks/useScrollLock";
import { usePanelBreakpoint } from "../hooks/usePanelBreakpoint";
// 笔记时间统一走这里：SQLite 的 UTC 无时区串必须按 UTC 解释，
// 直接 `new Date(iso)` 在东八区会差 8 小时（「笔记时间不对」的根因）。
import { formatRelative, formatWhen, formatWhenFull, groupLabel } from "../utils/noteTime";
import { extractOutline, outlineIndent } from "../utils/noteOutline";
import { Dialog, DialogTitle, DialogContent, DialogActions } from "@mui/material";
import { buildBacklinks, resolveWikiLinks } from "../utils/noteWikiLink";
import { exportNoteAsMarkdown } from "../utils/noteExport";
import { exportNoteAsHtml, printNoteAsPdf } from "../utils/noteHtmlExport";
import { isFolderColor } from "../utils/folderAppearance";
import { createScrollSync } from "../utils/syncScroll";
import {
    loadNotesSettings,
    saveNotesSettings,
    type NotesUiSettings,
} from "../utils/notesSettings";
import { reportError } from "../utils/errorReporter";
import NoteEditor from "./NoteEditor";
import NotesCommandPalette from "./NotesCommandPalette";
import type { CommandItem } from "./CommandPalette";
// 空状态：插画 + 标题 + 说明 + 可选动作，对齐 inkstone 的 <Empty>
import { EmptyState } from "./EmptyArt";
import ConfirmDialog from "./ConfirmDialog";
import NamePromptDialog from "./NamePromptDialog";
import FolderAppearanceDialog from "./FolderAppearanceDialog";
import TagColorDialog from "./TagColorDialog";
import MoveFolderDrawer from "./MoveFolderDrawer";
import NotesSettingsDialog from "./NotesSettingsDialog";
import NoteVersionHistoryDialog from "./NoteVersionHistoryDialog";
import type { NoteEditorHandle } from "../utils/noteEditorHandle";
import { useEditorTools, type EditorDraft } from "../hooks/useEditorTools";

import NoteShareDialog, { type NoteShareApi } from "./NoteShareDialog";
import {
    MarkdownPreview,
    MarkdownToolbar,
    noteExcerpt,
    resolveImageUpload,
} from "./notes/markdownToolbar";
import { LazyGroup } from "./notes/lazyGroup";
import { shouldVirtualize } from "../utils/virtualWindow";

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
    // 「选中某个文件夹」的视图键（2026-10-18）：点文件夹时切到这里，
    // 左栏「全部 / 最近」等行不再保持高亮 —— 否则计数还显示「全部 3」
    // 而中栏只有该文件夹的 1 条，用户以为没切过去（报「笔记不在文件夹下方」）。
    | "folder"
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


// —— 第二批拆分（2026-10-12）：左栏导航与分栏 chrome 搬到独立文件 ——
// FolderTagSection / NavRow / ColResizeHandle 这些本来就是纯 props 驱动的组件，
// 留在主文件只会撑行数；拆出后主文件只留页面装配逻辑。
import {
    EMPTY_TAG_LINKS,
    tagOf,
    tagNamesOf,
    NavRow,
    anchorAtMouse,
    FolderTagSection,
    type MenuAnchor,
} from "./notes/sidebarSection";

/**
 * 「引用次数」的空表：模块级常量，别在渲染里 new Map()
 * —— 那会让下游 props 每次都是新引用（2026-10-18 性能批次）。
 */
const EMPTY_REF_COUNTS: ReadonlyMap<string, number> = new Map();
/** 空的内联笔记列表：同上，保证 notesInFolder 返回的引用稳定 */
const EMPTY_NOTE_LINKS: { id: number; title: string }[] = [];
import {
    AUTO_SAVE_MS,
    MAX_RATIO,
    MIN_RATIO,
    PANE_HEADER_H,
    SPLIT_KEY,
    STATUSBAR_H,
    ColResizeHandle,
    SaveDot,
    readPaneRatio,
    readSplitRatio,
    useColumnResize,
    writePaneRatio,
} from "./notes/paneChrome";


export default function NotesPage({
    shareApi,
    uploadApi,
    backupApi,
    onDatasetChanged,
    syncChangedNoteIds,
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
    onToggleStar,
    onNotify,
    folderTags,
    onEnsureFullNote,
}: NotesPageProps) {
    const [keyword, setKeyword] = useState("");
    /** 关系图谱（2026-10-09）：双链关系的全貌，从「更多」里开 */
    const [graphOpen, setGraphOpen] = useState(false);
    /** 全库待办面板（2026-10-11 阶段②）：散在各篇里的 `- [ ]` 任务收进一个清单 */
    const [todoOpen, setTodoOpen] = useState(false);
    /** 反链右侧常驻面板（N4）：与大纲面板同一位置，桌面头部按钮 / 菜单项共同开关 */
    const [backlinksOpen, setBacklinksOpen] = useState(false);
    /** 多选批量条（2026-10-09）：只在用户主动开了「多选」时才勾人，退出即清空 */
    const [multiSelect, setMultiSelect] = useState(false);
    const [checked, setChecked] = useState<Set<number>>(() => new Set());
    /**
     * ⌘/Ctrl+点（切换单选）与 Shift+点（范围选）共用的锚点。
     *
     * 平时随便点一行就刷新它 —— 这样「点一条 → Shift 点另一条」天然是从刚看的那条
     * 开始选；不用先勾选再 Shift，符合多数选择器的肌肉记忆。
     */
    const selectAnchorRef = useRef<number | null>(null);
    /** 勾选 / 取消勾选一条（多行共用的同一个译(setState updater)） */
    const toggleChecked = useCallback((id: number) => {
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
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
    /**
     * 行菜单正在关闭（退出动画那 ~200ms + 焦点还原窗口，共 300ms）：
     *  - 给行内「⋯」按钮打 --closing 硬压 opacity（否则 rowMenu 还挂着、
     *    menuOpen 显式 opacity:1，「弹窗消失的瞬间冒出白圈」——第四报）；
     *  - **focusin 捕获**：MUI Modal 关闭时会把焦点还原给打开前的元素，
     *    而 Chromium 里被还原的焦点会匹配 :focus-visible（pointer 交互也算），
     *    行级 :has(:focus-visible) 随即把「⋯」顶出来。
     *    指针菜单另禁焦点还原；这里保留关闭窗口内的 focusin 防护。
     * onClose 置位、300ms 后自清。
     */
    const [menuClosing, setMenuClosing] = useState(false);
    useEffect(() => {
        if (!menuClosing) return;
        const onFocusIn = (e: Event) => {
            const el = e.target as HTMLElement | null;
            if (el && el.classList.contains("note-row-actions")) el.blur();
        };
        document.addEventListener("focusin", onFocusIn, true);
        const timer = setTimeout(() => setMenuClosing(false), 300);
        return () => {
            document.removeEventListener("focusin", onFocusIn, true);
            clearTimeout(timer);
        };
    }, [menuClosing]);
    /**
     * 菜单关闭后**悬停显隐抑制**的行（第五报「右键弹窗消失的瞬间起初右键的
     * 点位还是会闪过白圈」）：菜单关闭时指针通常还停在那行上（右键点多在
     * 行右侧、正是「⋯」的位置），300ms 抑制一过 `&:hover` 规则就把「⋯」
     * 弹出来 —— 用户看到的就是「关闭瞬间冒白圈」。这里在关闭时记下该行，
     * 悬停显隐对它失效，直到指针**离开这一行**（onMouseLeave 清除）才恢复。
     * 离开再进来是新的悬停意图，正常显示。
     */
    const [rowActionsSuppressed, setRowActionsSuppressed] = useState<number | null>(null);
    /** 统一的行菜单关闭：置抑制行 + menuClosing（各关闭路径共用，防漏） */
    const closeRowMenu = useCallback(() => {
        setRowActionsSuppressed(rowMenu?.noteId ?? null);
        setRowMenu(null);
        setMenuClosing(true);
    }, [rowMenu]);
    /** 正在拖的笔记行（半透明反馈，与文件夹那边同一套观感） */
    const [draggingNoteId, setDraggingNoteId] = useState<number | null>(null);
    /** 「编辑标签」二级弹窗的锚点 */
    const [tagPick, setTagPick] = useState<{ el: MenuAnchor; noteId: number } | null>(null);
    /** 「导出」二级菜单的锚点（2026-10-17 精简右键菜单：三个导出格式收进一个入口） */
    const [exportPick, setExportPick] = useState<{ el: MenuAnchor; noteId: number } | null>(null);
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    /** 记事本命令面板（N1）开关 */
    const [notesCmdOpen, setNotesCmdOpen] = useState(false);
    /** 最近打开的笔记 id（命令面板空查询时优先展示） */
    const [recentNoteIds, setRecentNoteIds] = useState<number[]>([]);
    useEffect(() => {
        if (activeId == null) return;
        setRecentNoteIds(prev =>
            [activeId, ...prev.filter(id => id !== activeId)].slice(0, 8)
        );
    }, [activeId]);
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
     * 快捷键动作表（`EDITOR_SHORTCUTS` 的 id → 执行）。
     * inkstone 把这套动作挂在 `EDITOR_SHORTCUTS[].run` 上；我们这张表只放
     * 「键 + 名字」（见 utils/editorShortcuts.ts），动作由宿主注入 ——
     * 编辑器不认识此处任何一个工具函数，也不该认识。
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
    // 侧边栏的「即时渲染」独立于主栏（2026-10-18 用户报「在侧边打开时两个
    // 笔记的即时渲染不要同步打开和关闭」）：初值跟主设置，之后各管各 ——
    // 主栏那颗开关仍写全局设置（设置面板可改、跨会话保留），侧边这颗只动
    // 自己的 state，不再写回 uiSettings。
    const [sideLiveRender, setSideLiveRender] = useState(uiSettings.liveRender);
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
    const startPaneDrag = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        const row = paneRowRef.current;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        const total = rect.width;
        if (total <= 0) return;
        setSideResizing(true);
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - rect.left) / total;
            const next = Math.min(0.8, Math.max(0.2, ratio));
            paneRatioRef.current = next;
            setPaneRatio(next);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            setSideResizing(false);
            writePaneRatio(paneRatioRef.current);
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
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

    /**
     * 「添加附件」（2026-10-18 用户报「工具栏加上添加附件按键可以选择 txt/json」）：
     * 与 handleUpload 同一条上传链路（真附件、挂到当前笔记名下），成功后把下载链接
     * 插入对应编辑器正文，让附件在笔记里可见；成功/失败都给一句人话反馈。
     */
    const attachmentTargets = useRef({ activeId, sideId, notes, onUpdate });
    attachmentTargets.current = { activeId, sideId, notes, onUpdate };
    const handleAttach = useCallback(
        async (file: File, noteId: number | null, side: boolean) => {
            const ref = side ? sideRef : textareaRef;
            const editor = ref.current;
            try {
                if (noteId === null || !editor) throw new Error("请先打开笔记并切换到编辑模式");
                const uploaded = await handleUpload(file, noteId);
                const safeFilename = uploaded.filename.replace(/[\\[\]\n\r]/g, " ");
                const link = `\n[${safeFilename}](<${uploaded.url}>)\n`;
                const current = attachmentTargets.current;
                if ((side ? current.sideId : current.activeId) === noteId && ref.current === editor) {
                    // 上传不是格式开关：直接插入，避免再次添加同一附件时撤掉旧链接。
                    const at = editor.selectionEnd ?? editor.value.length;
                    const content = editor.value.slice(0, at) + link + editor.value.slice(at);
                    editor.value = content;
                    editor.setSelectionRange(at + link.length, at + link.length);
                    (side ? setSideDraft : setDraft)(d => d ? { ...d, content } : d);
                } else {
                    // 上传期间切换笔记，绝不把附件写到新打开的笔记。
                    const original = current.notes.find(note => note.id === noteId);
                    if (!original || await current.onUpdate(noteId, { content: original.content + link }) === false) {
                        throw new Error("附件已上传，但原笔记回写失败，请在附件管理器找回");
                    }
                }
                onNotify?.(`已添加附件「${uploaded.filename}」，并在笔记中插入下载链接`, "success");
            } catch (error) {
                onNotify?.(error instanceof Error ? error.message : "附件上传失败", "error");
            }
        },
        [handleUpload, onNotify]
    );

    /**
     * 编辑器粘贴 / 拖拽图片（N3）用的上传函数：与 MarkdownToolbar 的「上传图片」
     * 按钮共用同一个模块级 resolveImageUpload（上传 + 小图内嵌解析），行为不会跑偏。
     * noteId 用主栏 activeId（侧栏那条传的图也挂到当前笔记，url 才是关键）。
     */
    const detachedNotesRef = useRef(notes);
    detachedNotesRef.current = notes;
    const detachedUpdateRef = useRef(onUpdate);
    detachedUpdateRef.current = onUpdate;
    const replaceDetachedUpload = useCallback(async (noteId: number, placeholder: string, replacement: string) => {
        const note = detachedNotesRef.current.find(n => n.id === noteId);
        if (!note?.content.includes(placeholder)) return;
        try {
            const saved = await detachedUpdateRef.current(noteId, { content: note.content.replace(placeholder, replacement) });
            if (saved === false) onNotify?.("附件已上传，但原笔记回写失败，请在附件管理器找回", "error");
        } catch { onNotify?.("附件已上传，但原笔记回写失败，请在附件管理器找回", "error"); }
    }, [onNotify]);

    const uploadImageForEditor = useCallback(
        (file: File) => resolveImageUpload(file, handleUpload, activeId ?? null),
        [handleUpload, activeId]
    );

    const uploadFileForSideEditor = useCallback(
        (file: File) => resolveImageUpload(file, handleUpload, sideId),
        [handleUpload, sideId]
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
                editorScrollForLine: line => textareaRef.current?.scrollOffsetForLine(line) ?? 0,
                editorLineAtScroll: () => {
                    // 渲染出的 data-line 是 0 基，CM 的 topLineNumber() 是 1 基 —— 这里减 1 对齐。
                    // ⚠️ 减一次就够了：syncScroll 内部**不再**减（那边的注释也写明了口径），
                    // 两边各减一次就会整体滞后一行。
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

    // ---------- 标签颜色弹窗（note_tag.color） ----------
    const [tagColorId, setTagColorId] = useState<number | null>(null);

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
        save: null as null | (() => Promise<boolean>),
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
     * 现在是两个独立 ref（⌘K 改去开命令面板，见下面那个 handler）。
     */
    const searchRef = useRef<HTMLInputElement | null>(null);
    const searchRefNarrow = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!e.defaultPrevented && !e.isComposing && !e.repeat && !e.altKey && !e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                // N1：⌘K 在记事本上下文打开命令面板（搜笔记/文件夹/标签 + 执行命令），
                // 不再只是聚焦搜索框。面板里也能搜笔记（含远端全文命中），体验更一致。
                setNotesCmdOpen(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const active = useMemo(
        () => notes.find(n => n.id === activeId) || null,
        [notes, activeId]
    );

    /**
     * 编辑器内导出（头部菜单 / ⌘K）用的内容口径：**有未保存修改就导草稿**。
     *
     * 草稿的 title / content 都是编辑器当前值，天然同源，不会出现「旧正文 + 新标题」
     * 的拼接产物；所见即所得——用户刚打的字就在导出文件里。没有草稿或草稿与库里
     * 一致时导已存版本。列表行菜单 / 右键菜单导的是**没打开**的笔记（没有草稿概念），
     * 仍走 exportOne 的 note.content 口径（见下方注释）。
     */
    const exportTarget = useCallback(
        (): { title: string; content: string } => {
            if (
                active &&
                draft &&
                (draft.title !== (active.title || "") || draft.content !== (active.content || ""))
            ) {
                return { title: draft.title, content: draft.content };
            }
            return { title: active?.title || "", content: active?.content || "" };
        },
        [active, draft]
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
     * 一条笔记参与搜索的文本：标题 + 正文 + 标签名。
     * 标签名必须算进来 —— 用户记不清正文里有没有那个词，但记得「我给标了『合同』的
     * 那几条」，标签常常是唯一能想起来的线索。
     */
    const searchableText = useCallback(
        (n: Note) =>
            `${n.title || ""} ${n.content || ""} ${tagNamesOf(n, noteTags, tags).join(" ")}`,
        [noteTags, tags]
    );

    /**
     * 服务端全文检索的结果（2026-10-09）。
     *
     * 有 FTS5 时服务端能给 bm25 相关度与命中片段，比本地顺序扫描更准；
     * 但它只是**增强**：老部署没有 notes/search、或者索引没建起来时
     * `remoteSearch` 保持 null，下面照旧走本地模糊匹配。
     *
     * ⚠️ keyword 一起存进 state：请求是异步的，回来时输入框可能已经变了，
     * 拿「上一次关键词的结果」给当前关键词用会把列表排错。
     */
    const [remoteSearch, setRemoteSearch] = useState<{
        keyword: string;
        hits: { id: number; title: string; snippet: string; score: number }[];
        /** 服务端用的检索方式：fts = 全文索引，like = 降级成 LIKE 全表扫 */
        mode?: "fts" | "like";
    } | null>(null);
    const searchEpoch = useRef(0);
    const searchRemote = folderTags?.onSearchRemote;
    useEffect(() => {
        const kw = keyword.trim();
        if (!searchRemote || !kw) {
            setRemoteSearch(null);
            return;
        }
        const epoch = ++searchEpoch.current;
        // 打一个 250ms 的防抖：搜索框每敲一个字都打一次接口太浪费
        const timer = setTimeout(() => {
            void searchRemote(kw, 100).then(res => {
                if (epoch !== searchEpoch.current) return; // 过期结果直接丢
                setRemoteSearch(
                    res && Array.isArray(res.results)
                        ? { keyword: kw, hits: res.results, mode: res.mode }
                        : null
                );
            }).catch(() => {
                if (epoch !== searchEpoch.current) return;
                setRemoteSearch(null); // 失败就退回本地搜，不弹错误
            });
        }, 250);
        return () => clearTimeout(timer);
    }, [keyword, searchRemote]);

    /** 服务端给的命中片段（按笔记 id 查；只在搜索视图里显示） */
    const searchSnippets = useMemo(() => {
        const map = new Map<number, string>();
        if (remoteSearch && remoteSearch.keyword === keyword.trim()) {
            for (const hit of remoteSearch.hits) {
                if (hit.snippet) map.set(hit.id, hit.snippet);
            }
        }
        return map;
    }, [remoteSearch, keyword]);

    /**
     * 搜索命中的笔记（2026-10-06 加，2026-10-09 换成模糊匹配）。
     *
     * 原来是 `includes`：打错一个字（「数据哭」）就一条都搜不到，而且命中的字眼
     * 在列表里没有标记。现在照 inkstone 走「模糊匹配 + 命中区间高亮」（utils/fuzzy.ts），
     * 顺带按相关度排序 —— 标题里直接命中的排在正文里捎带命中的前面。
     */
    const searchHits = useMemo(() => {
        const kw = keyword.trim();
        if (!kw) return [];
        // 服务端有结果就按它的相关度排（bm25：标题命中权重更高）。
        // 高亮区间仍然本地算 —— fuzzyMatch 是纯函数，同一份标题两边结果一致。
        if (remoteSearch && remoteSearch.keyword === kw && remoteSearch.hits.length > 0) {
            const byId = new Map<number, Note>();
            for (const n of notes) if (n.id !== undefined) byId.set(n.id, n);
            const out: { note: Note; ranges: [number, number][] }[] = [];
            for (const hit of remoteSearch.hits) {
                const note = byId.get(hit.id);
                if (!note) continue; // 索引里可能残留已删的
                const match = fuzzyMatch(note.title || "", kw);
                out.push({ note, ranges: match?.ranges ?? [] });
            }
            if (out.length > 0) return out;
        }
        return fuzzyFilter(notes, kw, searchableText, 300).map(({ item, match }) => ({
            note: item,
            // ⚠️ 区间要裁到标题长度内：模糊匹配是在「标题 + 正文」上跑的，
            // 落在正文里的区间拿去标标题会标到别处去（inkstone 同样只标标题）。
            ranges: match.ranges.filter(([start]) => start < (item.title || "").length),
        }));
    }, [notes, keyword, searchableText, remoteSearch]);

    /** 标题高亮区间（按笔记 id 查；没搜东西时是空表） */
    const highlightRanges = useMemo(() => {
        const map = new Map<number, [number, number][]>();
        for (const hit of searchHits) {
            if (hit.note.id !== undefined && hit.ranges.length) map.set(hit.note.id, hit.ranges);
        }
        if (!keyword.trim()) return map;
        // 非搜索视图里也在列表顶部过滤（见 filtered），那里同样要能高亮
        for (const n of notes) {
            if (n.id === undefined || map.has(n.id)) continue;
            const match = fuzzyMatch(`${n.title || ""}`, keyword.trim());
            if (match && match.ranges.length) map.set(n.id, match.ranges);
        }
        return map;
    }, [searchHits, notes, keyword]);

    const filtered = useMemo(() => {
        // 搜索视图：只给命中列表，不受「文件夹 / 标签选中」叠加影响 ——
        // 用户搜东西时想看的是「所有命中」，再被一个残留的文件夹选中态筛一遍
        // 只会让人以为「搜不到」。没关键词时回落到全部。
        if (view === "search") {
            // ⚠️ searchHits 带命中区间（为了高亮），这里只要笔记本身
            return keyword.trim() ? searchHits.map(h => h.note) : notes.filter(n => !n.archived);
        }
        // 归档的笔记默认从「全部 / 最近 / 收藏 / 未归类」里隐去，只在「归档」视图露面
        const live = notes.filter(n => !n.archived);
        const byView = live.filter(n => {
            // ⚠️ 2026-10-09：收藏判的是 starred 而不是 pinned —— 之前两个是同一个开关，
            // 用户想标记常用就把排序也改了（详见 Note.starred 的注释）
            if (view === "starred") return Boolean(n.starred);
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
        const kw = keyword.trim();
        const matched = kw
            ? fuzzyFilter(bySort, kw, searchableText, 300).map(({ item }) => item)
            : bySort;
        if (view === "archived") {
            // 归档视图看的是**全部**归档笔记（不管收藏不收藏）
            const kw2 = keyword.trim();
            const all = notes.filter(n => n.archived);
            return kw2 ? fuzzyFilter(all, kw2, searchableText, 300).map(({ item }) => item) : all;
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
    }, [notes, keyword, view, activeFolder, activeTag, noteTags, searchHits, searchableText]);

    /**
     * 列表要不要走组级懒挂载（LazyGroup）。条数低于阈值时全量渲染 ——
     * 不改变 DOM 结构，守卫与真机探针在小数据量下的行为与从前完全一致。
     * 占位行高与 CSS content-visibility 的占位估计值同源（56/96 两档）。
     * ⚠️ 这条注释刻意不写行样式那两个驼峰属性名 —— 有守卫拿它们当锚点。
     */
    const lazyListGroups = shouldVirtualize(filtered.length);

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

    /**
     * 列表**当前渲染顺序**里的 id 序列。
     *
     * Shift 范围选必须按「屏幕上看到的先后」来选，而不是按 `notes` 的库内顺序 ——
     * 列表有分组（置顶 / 今天 / 昨天）和排序键，两者顺序并不一致，
     * 用错的那份会选出一段看起来毫无规律的笔记。
     */
    const visibleIds = useMemo(
        () =>
            listGroups
                .flatMap(g => g.items.map(n => n.id))
                .filter((id): id is number => id !== undefined),
        [listGroups]
    );

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
            starred: notes.filter(n => !n.archived && Boolean(n.starred)).length,
            archived: notes.filter(n => Boolean(n.archived)).length,
            uncategorized: notes.filter(
                // 与 filtered 里那个视图同一判据（folder_id 为空 = 没归到任何文件夹）。
                // 两处必须一致，否则左栏写着「未归类 3」点进去却空着。
                n => !n.archived && (n.folder_id === null || n.folder_id === undefined)
            ).length,
            trash: trashedNotes.length,
            // 待办面板角标：全库未完成任务数（纯文本扫描，围栏代码块不算）
            todo: todoCounts(notes).open,
        }),
        [notes, trashedNotes]
    );

    /** 待办面板勾选 → 回写原笔记：与预览勾选同一套判据（toggleTaskLine），
     *  走 onUpdate（updateNote）链路，rev 守卫 / 自动保存 / 广播自动生效。 */
    const handleTodoToggle = useCallback(
        (noteId: number, line: number, checked: boolean) => {
            const note = notes.find(n => n.id === noteId);
            if (!note || typeof note.content !== "string") return;
            const next = toggleTaskLine(note.content, line, checked);
            if (next === null) {
                onNotify?.("这条任务在原文里已变化，请打开笔记后重试", "error");
                return;
            }
            void onUpdate(noteId, { content: next });
        },
        [notes, onUpdate, onNotify]
    );

    // ---------- 阶段三收尾：文件夹 / 标签 ----------
    /** 没传 folderTags（老部署）时用两个空常量，而不是每次渲染都新建 [] ——
        后者会让下面的 useMemo 每次都重算，白费。 */

    /** 每条笔记的计数：服务端 listFolders/listTags 也带了 count，但那要等接口回来，
        本地 notes 一变就应该立刻反映到左栏，所以这里按本地数据算（同号重算）。 */
    /**
     * 每个文件夹下的笔记数（左栏那个灰色小数字）。
     *
     * ⚠️ 必须**一次遍历** notes：原来是「外层遍历 folders × 内层 filter 全量 notes」，
     * 置顶 / 移动 / 保存时这里要跑 `folders.length × notes.length` 次判断
     * （用户报「文件夹下方置顶笔记等操作卡顿」的组成部分之一，2026-10-18 修）。
     */
    const folderCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const n of notes) {
            if (n.archived || n.folder_id === null || n.folder_id === undefined) continue;
            map.set(n.folder_id, (map.get(n.folder_id) ?? 0) + 1);
        }
        // 没笔记的文件夹也要有 0，否则左栏读不到值（Map.get 返回 undefined）
        for (const f of folders) {
            if (f.id !== undefined && !map.has(f.id)) map.set(f.id, 0);
        }
        return map;
    }, [folders, notes]);

    /**
     * 每个标签下的笔记数。
     *
     * ⚠️ 同样必须一次遍历：原来外层 tags × 内层 notes，每次还调 `tagOf` 新建一个 Set
     * —— `tags.length × notes.length` 次 Set 分配，这是置顶卡顿里最贵的一块
     * （2026-10-18 修）。现在每条笔记只解析一次标签集，去累加它命中的那些标签。
     */
    const tagCounts = useMemo(() => {
        const map = new Map<number, number>();
        for (const t of tags) {
            if (typeof t.id === "number") map.set(t.id, 0);
        }
        for (const n of notes) {
            if (n.archived) continue;
            for (const id of tagOf(n, noteTags)) {
                map.set(id, (map.get(id) ?? 0) + 1);
            }
        }
        return map;
    }, [tags, notes, noteTags]);

    /**
     * 标签名 → 颜色。列表里的徽章按它着色。
     *
     * ⚠️ 按**名字**索引而不是 id：`tagNamesOf` 返回的是名字串（渲染用的是名字），
     * 再拿名字回查一次 id 会让列表每行多一次线性查表。
     * 名字重复时取「先出现且有颜色」的那一个 —— 两个同名标签本来就该合并。
     */
    const tagColorByName = useMemo(() => {
        const map = new Map<string, string>();
        for (const t of tags) {
            if (!t.name || !isFolderColor(t.color)) continue;
            const key = t.name.trim();
            if (!map.has(key)) map.set(key, t.color);
        }
        return map;
    }, [tags]);

    /**
     * 编辑器输入补全的数据源（`[[` / `#` / 围栏语言）。
     *
     * ⚠️ 必须是 **getter 形态**（由 NoteEditor 内部自己调用，而不是这里算好了传过去）：
     * 笔记与标签随时增删改，传快照的话「刚建的那条在补全里找不到」，
     * 而 getter 每次弹面板时读的都是最新的 `notes` / `tags`。
     * 只喂**未归档**的笔记 —— 归档里的东西默认不该再被引用（和列表口径一致）。
     */
    const completionSources = useCallback((): CompletionSources => {
        return {
            notes: () =>
                notes
                    .filter(n => !n.archived)
                    .map(n => ({
                        id: n.id,
                        title: n.title || "",
                        excerpt: noteExcerpt(n.content || ""),
                    })),
            tags: () => tags.map(t => ({ name: t.name, count: tagCounts.get(t.id!) ?? 0 })),
        };
    }, [notes, tags, tagCounts]);

    /**
     * 预览里点任务复选框 → 回写草稿正文（主栏）。
     *
     * 写 draft 而不是直接发 API：草稿是「编辑区当前那份」，写完由 3s 自动保存落库，
     * 和手打字符走的是同一条保存链路 —— 不会出现「预览勾上了、自动保存把正文覆盖回去」。
     * ⚠️ `toggleTaskLine` 判不出任务项时返回 null（比如行号已经过期），
     * 这时**什么都不做**，绝不把旧文本写回去（那会丢掉用户刚敲的字）。
     */
    const handleToggleTask = useCallback((line: number, checked: boolean) => {
        setDraft(d => {
            if (!d) return d;
            const next = toggleTaskLine(d.content, line, checked);
            return next === null ? d : { ...d, content: next };
        });
    }, []);

    /** 侧边预览的同一套回写（侧栏有自己的草稿，不能改主栏那份） */
    const handleSideToggleTask = useCallback((line: number, checked: boolean) => {
        setSideDraft(d => {
            if (!d) return d;
            const next = toggleTaskLine(d.content, line, checked);
            return next === null ? d : { ...d, content: next };
        });
    }, []);
    // ⚠️ 下面这些 callback 的引用都取 `folderTags?.xxx`，**不直接写 folderTags 本身进依赖**：
    // folderTags 是调用方每次渲染新造的对象字面量，把它放进行依赖会让每一次渲染都
    // 重跑一遍这些回调、连带下面的 useMemo 全部失效（这是「effect 无限循环 → 内存打满」
    // 那类问题的入口）。只认里面那几个函数，它们由 useCallback 缓存住了。
    const createFolder = useCallback(
        async (name: string, parentId: number | null = null) => {
            const created = await folderTags?.onCreateFolder(name, parentId);
            // 只在建的是**根目录**文件夹时才自动切过去：新建子文件夹就把左栏
            // 跳到那个子文件夹，会让「我只是想加一个子项」变成视图被抢走。
            if (created?.id !== undefined && parentId === null) {
                setActiveFolder(created.id);
                // 切过去就连视图一起切（同点文件夹：否则「全部 N」行还高亮着，
                // 中栏却只剩这一个空文件夹 —— 2026-10-18 用户报的同类困惑）
                setView("folder");
            }
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
            setView(cur => (cur === "folder" ? "all" : cur));
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
     * ⚠️ 导的是 `note.content`（已存进库的内容）：这里导的是**没在编辑器里打开**的
     * 笔记，没有草稿概念，标题和正文取同一条记录天然同源。
     * 编辑器内导出（头部菜单 / ⌘K）走 exportTarget()：有未保存修改时导草稿（所见即所得），
     * 见 active 定义处的注释。两入口口径不同是有意的。
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

    /**
     * 摘要模式：打开哪条就补哪条的全文。
     *
     * 挂在 activeId / sideId 上而不是逐个改写「点开」的回调 —— 打开笔记的入口有四五处
     * （列表点击、深链接、侧边栏、新建后定位、搜索结果…），逐个接一定漏。
     * 这里只认「当前被打开的那条是不是摘要」，是就补，全覆盖且不侵入各条链路。
     */
    useEffect(() => {
        if (!onEnsureFullNote) return;
        for (const id of [activeId, sideId]) {
            if (typeof id !== "number") continue;
            if (notes.find(n => n.id === id)?.content_truncated) {
                void onEnsureFullNote(id);
            }
        }
    }, [activeId, sideId, notes, onEnsureFullNote]);

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

        // 失焦立即落盘（与主栏那处同理，是防抖放宽到 5 秒的补偿）
        const flush = () => {
            clearTimeout(timer);
            void onUpdate(sideId, { title: sideDraft.title, content: sideDraft.content }).then(() => {
                setSideSaveState("saved");
                setSideSavedAt(Date.now());
                setSideTick(Date.now());
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("blur", flush);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            clearTimeout(timer);
            window.removeEventListener("blur", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [sideDraft, sideId, notes, onUpdate, autosaveMs]);

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
    // 定向提示（2026-10-11 阶段①）：当前打开的笔记被其他设备改过时，除了全局
    // 的列表刷新提示，再给一句「就是这篇」的说明。不弹冲突框——用户可能只是
    // 在看；真正保存时 rev 守卫会拦住静默覆盖，给覆盖/放弃的选择。
    useEffect(() => {
        if (!syncChangedNoteIds?.length) return;
        if (active?.id === undefined || !syncChangedNoteIds.includes(active.id)) return;
        onNotify?.("当前打开的笔记在其他设备被修改：保存时会提示冲突（覆盖或放弃）", "info");
    }, [syncChangedNoteIds, active?.id, onNotify]);

    // 服务端尺寸预注入（2026-10-11 阶段⑤）：挂载后拉一次附件元数据，把
    // width/height 种进渲染缓存 —— 换设备首开多图笔记时首帧就有尺寸，不再
    // 「塌缩→撑开」。只种缺失条目，运行时已建立的状态（blob: 兜底等）不覆盖。
    useEffect(() => {
        if (!uploadApi?.listAttachments) return;
        let cancelled = false;
        void uploadApi
            .listAttachments()
            .then(list => {
                if (!cancelled && Array.isArray(list)) seedAttachmentDimensions(list);
            })
            .catch(() => {
                // 元数据拉不到就退回纯客户端测量，不是错误
            });
        return () => {
            cancelled = true;
        };
    }, [uploadApi]);

    /**
     * 附件被多少条笔记引用（设置→数据→附件管理器那格「引用 N 次」）。
     *
     * ⚠️ 只在**数据面板真的打开**时才算（2026-10-18 修「置顶笔记卡顿」）：
     * 原来无条件扫全部正文，置顶/保存时这一段要跑好几毫秒的正则，而结果
     * 99% 的时间根本没人看。面板一开（settingsOpen 变 true）当帧就会算出来。
     * ⚠️ 每条笔记先用 `includes` 兜一道：没有附件链接的正文不进正则。
     */
    const attachmentRefCounts = useMemo(() => {
        if (!settingsOpen) return EMPTY_REF_COUNTS;
        const map = new Map<string, number>();
        for (const n of notes) {
            const content = n.content || "";
            if (!content.includes("/api/notes/attachments/")) continue;
            const seen = new Set<string>();
            for (const m of content.matchAll(/\/api\/notes\/attachments\/([0-9a-zA-Z-]+)/g)) {
                if (seen.has(m[1])) continue;
                seen.add(m[1]);
                map.set(m[1], (map.get(m[1]) ?? 0) + 1);
            }
        }
        return map;
    }, [notes, settingsOpen]);

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
    /**
     * 导出 zip（含图片附件，2026-10-09）。
     *
     * 之前只有 JSON：笔记正文里的图片是 `/api/notes/attachments/<id>` 这种引用，
     * JSON 里不带字节 —— 一旦删站或迁移，正文还在、图全没了。inkstone 的
     * 「导出 zip」把笔记 + 附件一起打包，UI 上直接写「用于完整恢复」。
     * zip 是我们自己实现的（utils/zip.ts，零依赖），打包不压缩（图片本来就是压过的）。
     */
    const exportAllZip = useCallback(async () => {
        try {
            const payload = {
                kind: "navihive-notes-export",
                exported_at: new Date().toISOString(),
                notes,
                folders: folderTags?.folders ?? [],
                tags: folderTags?.tags ?? [],
                noteTags: folderTags?.noteTags ?? {},
            };
            const entries: ZipEntry[] = [
                {
                    path: "notes.json",
                    data: new TextEncoder().encode(JSON.stringify(payload, null, 2)),
                },
            ];
            const list = uploadApi?.listAttachments ? await uploadApi.listAttachments() : [];
            let failed = 0;
            for (const att of list) {
                try {
                    const res = await fetch(
                        `/api/notes/attachments/${encodeURIComponent(att.id)}`,
                        { credentials: "same-origin" }
                    );
                    if (!res.ok) {
                        failed += 1;
                        continue;
                    }
                    entries.push({
                        // ⚠️ 文件名里带原始 id：导入时要靠它把正文里的旧引用换成新 id
                        path: `attachments/${att.id}__${att.filename || "file"}`,
                        data: new Uint8Array(await res.arrayBuffer()),
                    });
                } catch {
                    failed += 1;
                }
            }
            const packed = createZip(entries);
            // ⚠️ 直接把 Uint8Array 交给 Blob 在 TS 5.7+ 会挑 ArrayBufferLike/SharedArrayBuffer，
            // 显式拷一份 ArrayBuffer 绕开（浏览器端 Blob 本来就只接受这一支）。
            const out = new Uint8Array(packed.byteLength);
            out.set(packed);
            const blob = new Blob([out.buffer], { type: "application/zip" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `notes-backup-${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            onNotify?.(
                failed === 0
                    ? `已导出 ${notes.length} 条笔记 + ${list.length} 个附件（ZIP）`
                    : `已导出，但有 ${failed} 个附件没取到（ZIP）`,
                failed === 0 ? "success" : "warning" as never
            );
        } catch (error) {
            onNotify?.(
                "导出失败：" + (error instanceof Error ? error.message : "未知错误"),
                "error"
            );
        }
    }, [notes, folderTags, uploadApi, onNotify]);

    /**
     * 导入文件：JSON（老格式）或 zip（含附件）。
     *
     * zip 那条路上有个必须处理的坑：附件上传后服务端会给**新的 id**（uuid 是服务端
     * 生成的），而正文里写的是旧 id。不替换的话恢复出来的笔记每张图都是裂的。
     * 所以先把附件一个个传上去、记下「旧 id → 新 id」，再把正文里的引用换掉。
     */
    // ---------- 批量操作（2026-10-09，配合上面的多选条）----------
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
    const [bulkBusy, setBulkBusy] = useState(false);
    /**
     * 选中集合 → 笔记对象。
     *
     * ⚠️ 只在**当前列表（filtered）**里取，不是全量 notes：
     * 用户是在「看到的这几条」里勾的，切了视图或搜了东西之后再点批量归档，
     * 结果却动到列表外面的笔记 —— 那是最容易挨骂的一类「删错东西」。
     */
    const checkedNotes = useMemo(
        () => filtered.filter(n => n.id !== undefined && checked.has(n.id)),
        [filtered, checked]
    );
    const bulkArchive = useCallback(async () => {
        if (bulkBusy) return;
        setBulkBusy(true);
        try {
            // 逐条走现有的归档：混选（有归档有没归档）时按「多数」取向 ——
            // 只要还有没归档的就全部归档，否则全部取回，避免一次点完变成「反的」
            const target = checkedNotes.some(n => !n.archived);
            for (const n of checkedNotes) {
                // ⚠️ 判据是「当前状态 === 目标」就跳过（已经归档的不用再归档一次）。
                // 写成 !== 会把**所有**条目都跳过：批量归档变成「点了没反应」
                //（用例里 archived 一直是空数组才抓出来的）。
                if (Boolean(n.archived) === target) continue;
                await onToggleArchive(n);
            }
            onNotify?.(
                target ? `已归档 ${checkedNotes.length} 条` : `已取回 ${checkedNotes.length} 条`,
                "success"
            );
            setChecked(new Set());
        } catch (error) {
            onNotify?.("批量归档失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBulkBusy(false);
        }
    }, [bulkBusy, checkedNotes, onToggleArchive, onNotify]);

    const bulkDelete = useCallback(async () => {
        if (bulkBusy) return;
        setBulkBusy(true);
        try {
            for (const n of checkedNotes) await onDelete(n);
            onNotify?.(`已删除 ${checkedNotes.length} 条（可在回收站里还原）`, "success");
            setChecked(new Set());
            setBulkDeleteOpen(false);
        } catch (error) {
            onNotify?.("批量删除失败：" + (error instanceof Error ? error.message : "未知错误"), "error");
        } finally {
            setBulkBusy(false);
        }
    }, [bulkBusy, checkedNotes, onDelete, onNotify]);

    const importNotesFile = useCallback(
        async (
            file: File,
            onProgress?: (p: NoteImportProgress) => void,
        ): Promise<NoteImportStats> => {
            if (!shareApi?.importNotes) throw new Error("当前部署不支持导入笔记");

            const isZip =
                /\.zip$/i.test(file.name) ||
                file.type === "application/zip" ||
                file.type === "application/x-zip-compressed";

            if (!isZip) {
                const parsed = JSON.parse(await file.text()) as NotesImportPayload;
                onProgress?.({ phase: "写入笔记", current: 0, total: 0 });
                const stats = await shareApi.importNotes(parsed);
                // 当前标签页必须自己重拉（2026-10-17：此前只广播给其它标签页，
                // 本页要等跨设备轮询的下个周期才看见恢复结果 —— 用户报「提示弹了
                // 还要很久才恢复完」就是这个空窗）。等重拉完才让上层弹成功提示。
                onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
                await onDatasetChanged?.();
                return stats;
            }

            const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
            const notesEntry = entries.find(e => e.path === "notes.json");
            if (!notesEntry) {
                const visibleEntries = entries.filter(e => !e.path.split("/").some(part => part.startsWith(".") || part === "__MACOSX"));
                const markdownEntries = visibleEntries.filter(e => /\.md$/i.test(e.path));
                if (!markdownEntries.length) throw new Error("ZIP 中没有 notes.json 或 Markdown 笔记");
                const folders: NoteFolder[] = [];
                const folderIds = new Map<string, number>();
                const ensureFolder = (path: string): number | null => {
                    if (!path) return null;
                    if (folderIds.has(path)) return folderIds.get(path)!;
                    const parts = path.split("/");
                    const name = parts.pop()!;
                    const parent_id = ensureFolder(parts.join("/"));
                    const id = folders.length + 1;
                    folderIds.set(path, id);
                    folders.push({ id, name, parent_id });
                    return id;
                };
                const attachments = new Map<string, string>();
                const paths = new Set<string>();
                for (const entry of entries) {
                    if (entry.path.split("/").some(p => p === ".." || p === ".") || entry.path.startsWith("/") || entry.path.includes("\\")) throw new Error("不安全的文件路径");
                    if (paths.has(entry.path)) throw new Error("ZIP 中存在重复文件路径");
                    paths.add(entry.path);
                }
                const attachmentEntries = visibleEntries.filter(e => !/\.md$/i.test(e.path) && e.data.length);
                onProgress?.({ phase: "解包备份", current: 0, total: 0 });
                if (attachmentEntries.length && !uploadApi) throw new Error("ZIP 含附件，需先配置附件上传能力");
                // 附件之间互不依赖（路径→url 各写各的），并发回传比串行快数倍 ——
                // 附件一多时这正是「恢复太慢」的大头。并发 6：再多对单线用户带宽没增益。
                let uploadedCount = 0;
                let next = 0;
                const uploadWorker = async () => {
                    while (next < attachmentEntries.length) {
                        const entry = attachmentEntries[next++];
                        const uploaded = await uploadApi!.uploadAttachment(new File([entry.data.slice().buffer], entry.path.split("/").pop()!));
                        if (!uploaded?.url) throw new Error("附件上传失败：" + entry.path);
                        attachments.set(entry.path, uploaded.url);
                        uploadedCount += 1;
                        onProgress?.({ phase: "上传附件", current: uploadedCount, total: attachmentEntries.length });
                    }
                };
                await Promise.all(Array.from({ length: Math.min(6, attachmentEntries.length) }, uploadWorker));
                const tags: NoteTag[] = [];
                const tagIds = new Map<string, number>();
                const noteTags: Record<string, number[]> = {};
                const imported: Note[] = [];
                for (const entry of markdownEntries) {
                    if (entry.path.split("/").some(p => p === ".." || p === ".")) throw new Error("不安全的文件路径");
                    const parts = entry.path.split("/");
                    const title = parts.pop()!.replace(/\.md$/i, "");
                    let content = new TextDecoder().decode(entry.data);
                    const resolveAsset = (target: string): string | undefined => {
                        let decoded: string;
                        try { decoded = decodeURIComponent(target); } catch { return undefined; }
                        const stack = parts.slice();
                        for (const p of decoded.split("/")) {
                            if (p === "..") stack.pop();
                            else if (p !== "." && p) stack.push(p);
                        }
                        const direct = attachments.get(stack.join("/")) ?? attachments.get(decoded);
                        if (direct) return direct;
                        const basename = decoded.split("/").pop()?.toLowerCase();
                        const matches = [...attachments].filter(([path]) => path.split("/").pop()?.toLowerCase() === basename);
                        // 同名附件有歧义时不猜，保留原引用给用户修正。
                        return matches.length === 1 ? matches[0][1] : undefined;
                    };
                    content = content.replace(/!\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
                        const path = target.split("|")[0];
                        const url = resolveAsset(path);
                        return url ? `![${path.split("/").pop()}](${url})` : whole;
                    }).replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (whole, lead: string, target: string, end: string) => {
                        const url = resolveAsset(target);
                        return url ? lead + url + end : whole;
                    });
                    const id = imported.length + 1;
                    const names = extractNoteTags(content);
                    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
                    if (frontMatter) {
                        const tagField = /^tags:\s*(.*(?:\r?\n[ \t]+-[^\n]*)*)/m.exec(frontMatter)?.[1];
                        if (tagField) {
                            for (const name of tagField.replace(/[[\]"']/g, "").split(/[,\r\n]/).map(tag => tag.trim().replace(/^-\s*/, "").replace(/^#/, ""))) {
                                if (/^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,79}$/u.test(name)) names.push(name);
                            }
                        }
                    }
                    for (const name of new Set(names)) {
                        if (!tagIds.has(name)) { const tagId = tags.length + 1; tagIds.set(name, tagId); tags.push({ id: tagId, name }); }
                    }
                    noteTags[String(id)] = [...new Set(names)].map(name => tagIds.get(name)!);
                    imported.push({ id, title, content, folder_id: ensureFolder(parts.join("/")) });
                }
                onProgress?.({ phase: "写入笔记", current: attachmentEntries.length, total: attachmentEntries.length });
                const stats = await shareApi.importNotes({ notes: imported, folders, tags, noteTags });
                // 同上：等当前页重拉完再返回，成功提示弹出时列表已经是新的
                onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
                await onDatasetChanged?.();
                return stats;
            }
            const payload = JSON.parse(
                new TextDecoder().decode(notesEntry.data)
            ) as NotesImportPayload;

            // 1) 附件回传，记下 id 变化
            const idMap = new Map<string, string>();
            let skipped = 0;
            const attachmentEntries = entries.filter(e => {
                if (!e.path.startsWith("attachments/")) return false;
                const name = e.path.slice("attachments/".length);
                return name.indexOf("__") > 0;
            });
            let done = 0;
            let next = 0;
            onProgress?.({ phase: "解包备份", current: 0, total: 0 });
            // 同上：附件回传并发 6（idMap 各写各的键，无顺序依赖）
            const uploadWorker = async () => {
                while (next < attachmentEntries.length) {
                    const entry = attachmentEntries[next++];
                    const name = entry.path.slice("attachments/".length);
                    const sep = name.indexOf("__");
                    if (sep <= 0) { done += 1; continue; }
                    const oldId = name.slice(0, sep);
                    const filename = name.slice(sep + 2);
                    if (!uploadApi) {
                        skipped += 1;
                    } else {
                        try {
                            const uploaded = await uploadApi.uploadAttachment(
                                new File([entry.data.slice().buffer], filename || "file")
                            );
                            if (uploaded?.id && uploaded.id !== oldId) idMap.set(oldId, uploaded.id);
                        } catch {
                            skipped += 1;
                        }
                    }
                    done += 1;
                    onProgress?.({ phase: "上传附件", current: done, total: attachmentEntries.length });
                }
            };
            await Promise.all(Array.from({ length: Math.min(6, attachmentEntries.length) }, uploadWorker));

            // 2) 正文里的旧 id 换成新 id（只换真发生变化的那些）
            if (idMap.size > 0 && Array.isArray(payload.notes)) {
                payload.notes = payload.notes.map((n: Note) =>
                    n && typeof n.content === "string"
                        ? {
                              ...n,
                              content: n.content.replace(
                                  /\/api\/notes\/attachments\/([A-Za-z0-9_-]+)/g,
                                  (whole: string, id: string) =>
                                      idMap.has(id)
                                          ? `/api/notes/attachments/${idMap.get(id)}`
                                          : whole
                              ),
                          }
                        : n
                );
            }

            onProgress?.({ phase: "写入笔记", current: attachmentEntries.length, total: attachmentEntries.length });
            const stats = await shareApi.importNotes(payload);
            if (skipped > 0) {
                onNotify?.(`有 ${skipped} 个附件没能回传（正文里的引用可能还是旧的）`, "warning" as never);
            }
            // 导入是一次数据集级变更：广播给其它标签页 + 当前页立刻重拉
            // （此前只广播，本页要等轮询下个周期才看见 —— 同 2026-10-17 的空窗问题）
            onProgress?.({ phase: "刷新列表", current: 0, total: 0 });
            await onDatasetChanged?.();
            return stats;
        },
        [shareApi, uploadApi, onNotify, onDatasetChanged]
    );

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
    // 2026-10-09 改成 inkstone 同款面板：左列快照 + 右栏与当前正文的行级 diff
    // （原来只是一个 Menu，点了直接恢复，恢复前看不到这一版改了什么）。
    const [revisionsOpen, setRevisionsOpen] = useState(false);
    /** 图片灯箱（inkstone 的 ui.lightbox）：点预览里的图片放大看 */
    const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
    const [imageScale, setImageScale] = useState(1);
    const [imageFailed, setImageFailed] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    useEffect(() => { setImageScale(1); setImageFailed(false); }, [lightbox?.src]);
    const [shareId, setShareId] = useState<number | null>(null);
    const [revisions, setRevisions] = useState<NoteRevision[] | null>(null);
    // ⚠️ 不再需要「正在恢复的版本 id」那份 state：面板自己有 busy 态，
    // 恢复按钮在期间是禁用的（连点重复提交由面板挡住）。

    /** 打开面板时才拉列表：不为一条没打开过的笔记请求历史 */
    const openRevisions = useCallback(async () => {
        setRevisionsOpen(true);
        const noteId = active?.id;
        if (noteId === undefined || !folderTags?.onListRevisions) {
            setRevisions([]);
            return;
        }
        setRevisions(null);
        setRevisions(await folderTags.onListRevisions(noteId));
    }, [active?.id, folderTags]);

    /**
     * 记事本命令面板（N1）的命令列表：用现成的回调拼出来。
     * 不依赖任何新接口 —— 新建/查找/插入/布局切换/分享/导出/删除全都是已有动作。
     * 「当前笔记」类命令只在有 active 时出现（没选中笔记时执行会崩）。
     * ⚠️ 必须放在这里：它引用的 active / setShareId / openRevisions / handleUpload
     * 都在更上面才声明，提到前面会「used before declaration」。
     */
    const notesCommands = useMemo<CommandItem[]>(() => {
        const list: CommandItem[] = [
            { id: "shortcuts", label: "键盘快捷键帮助", section: "帮助", run: () => setShortcutsOpen(true) },
            { id: "new", label: "新建笔记", section: "笔记", keywords: "new create 新建", run: () => void onCreate() },
            { id: "welcome", label: "创建欢迎示例笔记", section: "笔记", keywords: "welcome 教程 示例 帮助", run: () => void onCreate({ title: "欢迎使用记事本", content: "# 从这里开始\n\n用 Markdown 记录想法，编辑与预览会同步滚动。\n\n## 常用语法\n\n- **粗体**与 *斜体*\n- [ ] 点击预览中的复选框完成任务\n- [[我的第一条笔记]] 创建双链，使用图谱查看关系\n- 行内输入 #标签 可以补全标签\n\n## 快捷操作\n\nCtrl/⌘K 打开命令面板；Ctrl/⌘S 保存；图片可以粘贴或上传。\n\n## 数据安全\n\n在设置中导出 ZIP（包含附件），也可配置 WebDAV 备份。" }) },
            { id: "find", label: "查找 / 替换", section: "编辑", keywords: "find search 查找 替换", run: () => textareaRef.current?.openSearch() },
            { id: "insert-frontmatter", label: "插入 front-matter", section: "编辑", keywords: "frontmatter 属性 yaml", run: () => tools.onInsertFrontMatter() },
            { id: "insert-wikilink", label: "插入双链", section: "编辑", keywords: "wikilink 双链 链接", run: () => tools.onInsertWikiLink() },
            { id: "pane-edit", label: "布局：仅编辑", section: "视图", keywords: "edit 编辑", run: () => setPane("edit") },
            { id: "pane-split", label: "布局：分栏", section: "视图", keywords: "split 分栏", run: () => setPane("split") },
            { id: "pane-preview", label: "布局：仅预览", section: "视图", keywords: "preview 预览", run: () => setPane("preview") },
        ];
        if (active) {
            list.push(
                { id: "pin", label: "置顶当前笔记", section: "当前笔记", keywords: "pin 置顶", run: () => void onTogglePin(active) },
                { id: "star", label: "收藏当前笔记", section: "当前笔记", keywords: "star 收藏", run: () => void onToggleStar?.(active) },
                { id: "archive", label: "归档当前笔记", section: "当前笔记", keywords: "archive 归档", run: () => void onToggleArchive(active) },
                { id: "share", label: "分享当前笔记", section: "当前笔记", keywords: "share 分享", run: () => active.id != null && setShareId(active.id) },
                { id: "revisions", label: "版本历史", section: "当前笔记", keywords: "history 版本", run: () => void openRevisions() },
                { id: "graph", label: "关系图谱", section: "当前笔记", keywords: "graph 图谱 双链", run: () => setGraphOpen(true) },
                { id: "todo", label: "全库待办面板", section: "命令", keywords: "todo 任务 待办 checklist", run: () => setTodoOpen(true) },
                { id: "export-md", label: "导出 Markdown", section: "当前笔记", keywords: "export md markdown", run: () => { const t = exportTarget(); void exportNoteAsMarkdown(t.title, t.content); } },
                { id: "export-html", label: "导出 HTML", section: "当前笔记", keywords: "export html", run: () => { const t = exportTarget(); void exportNoteAsHtml(t.title, t.content); } },
                { id: "delete", label: "删除当前笔记", section: "当前笔记", keywords: "delete 删除", run: () => void onDelete(active) },
            );
        }
        return list.filter(command => {
            if (["find", "insert-frontmatter", "insert-wikilink"].includes(command.id)) return !!active && pane !== "preview";
            if (command.id === "star") return !!onToggleStar;
            if (command.id === "share") return !!shareApi;
            if (command.id === "revisions") return !!folderTags?.onGetRevision;
            return true;
        });
    }, [onCreate, tools, active, pane, shareApi, folderTags, onTogglePin, onToggleStar, onToggleArchive, onDelete, setShareId, openRevisions, setGraphOpen, exportTarget]);

    /** 取某一版正文：列表里那份是空串，diff 要真的正文 */
    const loadRevisionContent = useCallback(
        async (revisionId: number): Promise<string | null> => {
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onGetRevision) return null;
            const rev = await folderTags.onGetRevision(noteId, revisionId);
            return rev ? rev.content : null;
        },
        [active?.id, folderTags]
    );

    const doRestoreRevision = useCallback(
        async (revisionId: number): Promise<boolean> => {
            const noteId = active?.id;
            if (noteId === undefined || !folderTags?.onRestoreRevision) return false;
            const restored = await folderTags.onRestoreRevision(noteId, revisionId);
            if (!restored) return false;
            setRevisions(null);
            // ⚠️ 必须显式写回草稿：草稿只在「换了笔记」（active.id 变化）时重置，
            // 而版本恢复 id 是一样的 —— 不塞回去的话界面还停在恢复前的内容，
            // 看着像「点了没反应」。
            setDraft({ title: restored.title || "", content: restored.content || "" });
            onNotify?.("已恢复到该版本（恢复前的内容也存了一份快照）", "success");
            return true;
        },
        [active?.id, folderTags, onNotify]
    );
    /**
     * 灯箱的键盘处理（inkstone 的 Lightbox 同样监听 window）：
     *  Esc 关闭、`+` / `-` 缩放、`0` 回到 100%。
     *
     * ⚠️ 为什么 `+` 同时收 `Equal`：`+` 在多数键盘上要和 Shift 一起按，
     * 而不同的系统/输入法给的 key 值并不一致（有的给 "+"，有的给 "Add"），
     * 只判 "+" 会出现「这台笔记本上放大键没反应」。
     */
    useEffect(() => {
        if (!lightbox) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setLightbox(null);
                return;
            }
            // 输入类按键不要抢：万一将来灯箱里加了输入框
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
            const zoom = (delta: number | "reset") => {
                e.preventDefault();
                setImageScale(s =>
                    delta === "reset" ? 1 : Math.max(0.3, Math.min(6, s + delta))
                );
            };
            if (e.key === "+" || e.key === "Add" || e.code === "Equal") zoom(0.25);
            else if (e.key === "-" || e.key === "Subtract" || e.code === "Minus") zoom(-0.25);
            else if (e.key === "0") zoom("reset");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [lightbox]);

    /**
     * 灯箱打开时：锁背景滚动 + 焦点收口 + 关闭后归还焦点。
     *
     *   ① 滚动锁：灯箱是 fixed 铺满屏的，**不锁的话滚轮会穿透滚到底下的笔记列表**，
     *      关掉之后发现「刚才在看的那条跑没了」—— 这是「灯箱很难用」最常见的来源。
     *   ② 焦点收口：它是 `role=dialog aria-modal`，但自定义 Box 不像 MUI Dialog
     *      自带 FocusTrap，键盘用户连按 Tab 会跑到底下的列表里去。
     *   ③ 焦点归还：关闭后把焦点还给打开它的那张图（拿不到就不动），
     *      否则焦点掉回 body，接着按 Tab 会跳回页面开头，人也「丢位置」了。
     */
    const lightboxRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!lightbox) return;
        const opener = document.activeElement as HTMLElement | null;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        // 焦点交给容器本身（tabIndex=-1 可编程聚焦），Tab 的起点就定了
        lightboxRef.current?.focus();
        const trap = (e: KeyboardEvent) => {
            if (e.key !== "Tab") return;
            const root = lightboxRef.current;
            if (!root) return;
            const focusable = [
                ...root.querySelectorAll<HTMLElement>(
                    "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
                ),
            ].filter(el => !el.hasAttribute("disabled"));
            if (focusable.length === 0) {
                e.preventDefault();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", trap);
        return () => {
            window.removeEventListener("keydown", trap);
            document.body.style.overflow = prevOverflow;
            opener?.focus?.();
        };
    }, [lightbox]);

    /** 当前这条笔记的标题层级（草稿内容变就重算） */
    const outline = useMemo(
        () => extractOutline(draft?.content ?? ""),
        [draft?.content]
    );

    const [outlineActiveLine, setOutlineActiveLine] = useState<number | null>(null);
    useEffect(() => {
        if (!outlineOpen) return;
        const scroller = previewScrollRef.current;
        if (!scroller) return;
        let raf = 0;
        const update = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                const top = scroller.getBoundingClientRect().top + 60;
                let current: number | null = null;
                for (const heading of outline) {
                    const element = scroller.querySelector<HTMLElement>(`[data-line="${heading.line}"]`);
                    if (element && element.getBoundingClientRect().top <= top) current = heading.line;
                }
                setOutlineActiveLine(current);
            });
        };
        update();
        scroller.addEventListener("scroll", update, { passive: true });
        return () => { cancelAnimationFrame(raf); scroller.removeEventListener("scroll", update); };
    }, [outlineOpen, outline, pane]);

    const dirty =
        !!active &&
        !!draft &&
        (draft.title !== (active.title || "") || draft.content !== (active.content || ""));

    const save = useCallback(async () => {
        if (!active?.id || !draft) return true;
        try {
            return (await onUpdate(active.id, { title: draft.title, content: draft.content })) !== false;
        } catch {
            onNotify?.("保存失败，已保留当前草稿，请重试", "error");
            return false;
        }
    }, [active, draft, onUpdate, onNotify]);

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
            if (!(await saveRef.current())) { setSaveState("pending"); return; }
            setSaveState("saved");
            setSavedAt(Date.now());
            setTick(Date.now());
        }, autosaveMs);

        // 失焦立即落盘：防抖放宽到 5 秒（见 AUTO_SAVE_MS 那条注释）之后，
        // 「打完字切走」这一下的等待窗口也变长了 —— 这里是它的补偿。
        // 切标签页 / 点到别的窗口都算失焦，都是低频动作，不会把省下来的往返又花回去。
        const flush = () => {
            clearTimeout(timer);
            void saveRef.current().then(ok => {
                if (!ok) return;
                setSaveState("saved");
                setSavedAt(Date.now());
                setTick(Date.now());
            });
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("blur", flush);
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            clearTimeout(timer);
            window.removeEventListener("blur", flush);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [dirty, draft, active?.id, autosaveMs]);

    // 关掉记事本时把还没落库的草稿刷一次：防抖是 5 秒（见 AUTO_SAVE_MS），
    // 打完字立刻关闭的话那 5 秒还没走完。卸载是同步的，await 不上，
    // 只能 fire-and-forget（api 是模块级的实例，组件没了请求照样发得出去）。
    const flushRef = useRef<{ dirty: boolean; save: () => Promise<unknown> }>({ dirty: false, save: async () => {} });
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
    /**
     * folder_id → 这个文件夹下的笔记（左栏内联显示用）。
     *
     * ⚠️ 必须**一次遍历分组**（2026-10-18 修「文件夹下方置顶笔记等操作卡顿」）：
     * 原来 `notesInFolder(id)` 每次调用都 `filter + sort` 全量 notes，而且 `notes`
     * 一变整个函数就换新引用，把左栏文件夹树连着整棵树一起重渲。现在改成
     * notes 变才重算一次，拿到的数组引用在没有相关改动时保持稳定。
     * ⚠️ 归档的笔记不算 —— 它们只该出现在「归档」视图里。
     */
    const notesByFolder = useMemo(() => {
        const raw = new Map<number, Note[]>();
        for (const n of notes) {
            if (n.archived || n.folder_id === null || n.folder_id === undefined) continue;
            const list = raw.get(n.folder_id);
            if (list) list.push(n);
            else raw.set(n.folder_id, [n]);
        }
        const map = new Map<number, { id: number; title: string }[]>();
        for (const [folderId, list] of raw) {
            list.sort((a, b) =>
                String(b.updated_at || b.created_at || "").localeCompare(
                    String(a.updated_at || a.created_at || "")
                )
            );
            map.set(
                folderId,
                list.map(n => ({ id: n.id!, title: n.title || "" }))
            );
        }
        return map;
    }, [notes]);

    const notesInFolder = useCallback(
        (folderId: number) => notesByFolder.get(folderId) ?? EMPTY_NOTE_LINKS,
        [notesByFolder]
    );

    /** 切换笔记前先把当前这条存掉 —— 草稿只存在内存里，不存就丢了 */
    const switchTo = useCallback(
        async (id: number | null) => {
            if (dirty && !(await save())) return false;
            setActiveId(id);
            return true;
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
            if (!(await switchTo(id))) return false;
            setMobileDetail(true);
            return true;
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
    const startSplitDrag = (e: React.PointerEvent) => {
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
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            // 拖动中 setState 不会回头改 onUp 那个闭包里的 splitRatio
            //（事件处理函数是 mousedown 那一刻挂上去的），所以最新值走 ref。
            splitRatioRef.current = clamped;
            setSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
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
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    /** 侧栏「分栏」那条缝的拖动：与主栏 startSplitDrag 同款，只是量的是 sideSplitBoxRef。 */
    const startSideSplitDrag = (e: React.PointerEvent) => {
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
        const onMove = (ev: PointerEvent) => {
            const ratio = (ev.clientX - contentLeft) / contentWidth;
            const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
            sideSplitRatioRef.current = clamped;
            setSideSplitRatio(clamped);
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
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
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
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
        () =>
            // ⚠️ 同批处理：只在数据面板打开时才扫全部正文（每条笔记都要 replace 出一份
            // 去空白的新字符串 = 按字节数分配一遍内存），置顶/保存时不该付这笔钱。
            settingsOpen
                ? notes.reduce((sum, n) => sum + (n.content ?? "").replace(/\s+/g, "").length, 0)
                : 0,
        [notes, settingsOpen]
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
        <>
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
        {/* 全文检索降级提示：FTS5 不可用时服务端走 LIKE 全表扫（能搜但慢、且不排序）。
            以前只写在服务端日志里，用户看到的是「搜得越来越慢 / 有些搜不到」，
            却不知道是索引没建起来、也不知道能去「设置 → 数据」重建索引。 */}
        {remoteSearch?.mode === "like" ? (
            <Typography
                variant='caption'
                color='text.secondary'
                sx={{ display: "block", mt: 0.5, px: 0.5 }}
            >
                当前数据库不支持全文索引，搜索已降级为逐条匹配（结果不排序，笔记多时会变慢）。
                可在「设置 → 数据」里重建索引试试。
            </Typography>
        ) : null}
        </>
    );

    /** 导航列内容（2026-10-08 抽出）：桌面导航列与 tablet 导航抽屉共用同一份 JSX。
     *  两者互斥挂载（桌面列 !narrowLayout 才挂、抽屉仅 tablet 开），
     *  所以 data-view / searchRef / data-nav-col 都不会出现两份。 */
    const navInner = (
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
                    {/* 全库待办（2026-10-11 阶段②）：不是视图，是弹面板 ——
                        点开一个聚合清单，勾选直接回写原笔记。 */}
                    <NavRow
                        label="待办"
                        count={viewCounts.todo}
                        selected={todoOpen}
                        onClick={() => {
                            setTodoOpen(true);
                            setNavDrawerOpen(false);
                        }}
                        data-view="todo"
                    />
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
                                <Box sx={{ display: "flex", gap: 1, justifyContent: "center", flexWrap: "wrap" }}>
                                {notes.length === 0 && <Button size='small' onClick={() => notesCommands.find(command => command.id === "welcome")?.run()}>
                                    创建欢迎示例笔记
                                </Button>}
                                <Button
                                    size='small'
                                    variant='outlined'
                                    startIcon={<NoteAddIcon fontSize='inherit' />}
                                    onClick={() => void startCreateInFolder(activeFolder)}
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
                                            "&:hover": { bgcolor: "rgba(128,128,128,0.06)" },
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
                                                              bgcolor: "rgba(128,128,128,0.08)",
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
                        borderTop: "1px solid rgba(128,128,128,0.16)",
                        bgcolor: "rgba(128,128,128,0.06)",
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
                            ⚠️ 窄屏（<900px）不渲染（条件渲染，不是 display:none
                            —— 得真的从 DOM 里卸掉）：同一个开关在「更多操作」菜单里
                            有一份（见下面 data-active-op='live-render'）。
                            ⚠️ 2026-10-10 用户明确：分屏（侧边打开）时主栏头部要和
                            侧边栏头部**一模一样**（只是没有关闭键）—— 侧边栏头部
                            常显这个开关，主栏也常显，不再收进菜单。 */}
                        {!narrowLayout && (
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
                        {/* 模式切换：**框起来的一组图标**（inkstone 同款）。
                            ⚠️ 之前是「宽屏文字按钮 + 小屏图标」两套，宽屏下三个
                            「编辑/分栏/预览」文字把标题行撑得很宽，两栏并排时
                            标题与工具栏都对不齐（用户报）。现在统一成图标 +
                            外框，选中项填底色。aria-label 保持中文，测试与读屏不受影响。
                            ⚠️ 2026-10-10 用户明确：分屏时这一组**回到头部常驻**，
                            与侧边栏头部一致（侧边栏那组一直常显，半宽塞得下；
                            之前收进菜单反而造成左右两侧头部不对称）。 */}
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
                            所以只把这两个提成常驻按钮，其余仍留在「⋯」里。
                            ⚠️ 2026-10-09 用户明确：**分屏（侧边打开）时照 inkstone 收进「更多」** ——
                            半宽的两栏塞不下这排，头部只留三档 + 保存状态 + 「⋯」。
                            条件渲染（不是 display:none）：元素要真的从 DOM 卸掉。 */}
                        {sideId === null && (
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
                        {!narrowLayout && sideId === null && (
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
                    {/* 反链右侧常驻面板（N4）：与大纲面板同一列位置。
                        窄屏不渲染（头部那组平铺按钮窄屏本来就不出现，反链仍走「⋯」菜单）。 */}
                    {backlinksOpen && !narrowLayout && (
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

            {/* 全库待办面板（2026-10-11 阶段②）：勾选回写走 onUpdate 链路 */}
            <NotesTodoDialog
                open={todoOpen}
                notes={notes}
                onClose={() => setTodoOpen(false)}
                onToggle={handleTodoToggle}
                onOpenNote={id => {
                    void jumpToNote(id).then(switched => {
                        if (switched) setView("all");
                    });
                }}
                onNotify={onNotify}
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
            <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} fullWidth maxWidth='sm'>
                <DialogTitle>键盘快捷键</DialogTitle>
                <DialogContent>
                    <Typography>Ctrl / ⌘ K：编辑器内插入链接，编辑器外打开命令面板</Typography>
                    <Typography>Ctrl / ⌘ S：保存当前笔记</Typography>
                    {EDITOR_SHORTCUTS.filter(shortcut => shortcut.combo).map(shortcut => (
                        <Box key={shortcut.id} sx={{ display: "flex", justifyContent: "space-between", gap: 2, py: 0.5 }}>
                            <Typography>{shortcut.label}</Typography><Kbd combo={shortcut.combo!} />
                        </Box>
                    ))}
                </DialogContent>
                <DialogActions><Button onClick={() => setShortcutsOpen(false)}>关闭</Button></DialogActions>
            </Dialog>
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
                        bgcolor: "rgba(0,0,0,0.82)",
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
                    <Typography sx={{ position: "absolute", bottom: 16, color: "#fff", maxWidth: "80%" }} noWrap>{lightbox.alt}</Typography>
                    <IconButton
                        aria-label='关闭图片预览'
                        data-lightbox-close='1'
                        onClick={e => {
                            e.stopPropagation();
                            setLightbox(null);
                        }}
                        sx={{ position: "absolute", top: 12, right: 12, color: "#fff" }}
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

            {/* 批量删除的二次确认（2026-10-09）：删的是用户勾的那批，
                数量必须写在弹框里 —— 「确定删除吗」四个字看不出是 1 条还是 37 条 */}
            <ConfirmDialog
                open={bulkDeleteOpen}
                title={`删除选中的 ${checkedNotes.length} 条笔记`}
                description={
                    <>
                        它们会进回收站，之后还能还原回来。
                        <br />
                        {checkedNotes.slice(0, 3).map(n => n.title || "无标题").join("、")}
                        {checkedNotes.length > 3 ? ` 等 ${checkedNotes.length} 条` : ""}
                    </>
                }
                impact={{ object: "笔记", count: checkedNotes.length, undoable: true }}
                danger
                confirmText='删除'
                busyText='删除中…'
                onConfirm={() => void bulkDelete()}
                onClose={() => setBulkDeleteOpen(false)}
            />
        </Box>
    );
}

/**
 * 补全面板里那条笔记的摘要（右侧灰色小字）。
 * 只要「看一眼就认得出是哪篇」，所以——摘掉 front matter、把 Markdown 记号当空格、
 * 压缩空白、砍到 80 字。别让它变成第二个解析流程（大意？自动摘要？都不用）。
 */