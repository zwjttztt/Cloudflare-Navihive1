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
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";

import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";

import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";

import EditIcon from "@mui/icons-material/Edit";

import MenuIcon from "@mui/icons-material/Menu";

import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";

import SearchIcon from "@mui/icons-material/Search";

import NoteGraphDialog from "./NoteGraphDialog";
import AttachmentManager from "./AttachmentManager";
import AttachmentPreviewDialog from "./AttachmentPreviewDialog";
import { AttachmentPreviewProvider, type AttachmentPreviewRequest } from "../utils/attachmentPreview";

// —— 格式工具栏（对齐 inkstone 的 EditorToolbar：7 个下拉 + 独立图标组）——
import NotesShortcutsDialog from "./NotesShortcutsDialog";

import { extractNoteTags } from "../utils/markdownNoteTags";
import { getSiteIndex } from "../utils/siteIndex";
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

import type { NoteEmbedTarget } from "./NoteEmbedNode";
import { useScrollLock } from "../hooks/useScrollLock";
import { usePanelBreakpoint } from "../hooks/usePanelBreakpoint";
// 笔记时间统一走这里：SQLite 的 UTC 无时区串必须按 UTC 解释，
// 直接 `new Date(iso)` 在东八区会差 8 小时（「笔记时间不对」的根因）。
import { extractOutline } from "../utils/noteOutline";
import { buildBacklinks, resolveWikiLinks } from "../utils/noteWikiLink";
import { exportNoteAsMarkdown } from "../utils/noteExport";
import { exportNoteAsHtml, printNoteAsPdf } from "../utils/noteHtmlExport";
import { createScrollSync } from "../utils/syncScroll";
import {
    loadNotesSettings,
    saveNotesSettings,
    type NotesUiSettings,
} from "../utils/notesSettings";
import { reportError } from "../utils/errorReporter";

import NotesCommandPalette from "./NotesCommandPalette";
import type { CommandItem } from "./CommandPalette";
// 空状态：插画 + 标题 + 说明 + 可选动作，对齐 inkstone 的 <Empty>

import NoteVersionHistoryDialog from "./NoteVersionHistoryDialog";
import type { NoteEditorHandle } from "../utils/noteEditorHandle";
import { useEditorTools, type EditorDraft } from "../hooks/useEditorTools";

import NoteShareDialog, { type NoteShareApi } from "./NoteShareDialog";
import { noteExcerpt, resolveImageUpload } from "./notes/markdownToolbar";


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
import { EMPTY_TAG_LINKS, tagNamesOf } from "./notes/sidebarSection";
/**
 * 「引用次数」的空表：模块级常量，别在渲染里 new Map()
 * —— 那会让下游 props 每次都是新引用（2026-10-18 性能批次）。
 */
const EMPTY_REF_COUNTS: ReadonlyMap<string, number> = new Map();
/** 空的内联笔记列表：同上，保证 notesInFolder 返回的引用稳定 */
const EMPTY_NOTE_LINKS: { id: number; title: string }[] = [];
// 记事本五个面板：从本文件拆出去的子组件（2026-10-20）

import NotesNavPanel from "./notes/NotesNavPanel";
import NotesListPane from "./notes/NotesListPane";
import NotesEditorPane from "./notes/NotesEditorPane";
import { useNotesPanels } from "./notes/useNotesPanels";
import { useNoteAutoSave } from "./notes/useNoteAutoSave";
import { useNotesFilters } from "./notes/useNotesFilters";
import { useNotesData } from "./notes/useNotesData";
import { useNotesList } from "./notes/useNotesList";
import { useNotesRowActions } from "./notes/useNotesRowActions";
import NotesSidePane from "./notes/NotesSidePane";
import NotesOverlayLayer from "./notes/NotesOverlayLayer";
import NotesConfirmLayer from "./notes/NotesConfirmLayer";
import NoteTemplateMenu from "./notes/NoteTemplateMenu";
import { noteTemplateDraft, type NoteTemplateId } from "../utils/noteTemplates";
import type { NotesPageCtx } from "./notes/notesPageCtx";
import type { Pane } from "./notes/notesPageCtx";

import { AUTO_SAVE_MS, MAX_RATIO, MIN_RATIO, SPLIT_KEY, ColResizeHandle, readPaneRatio, readSplitRatio, useColumnResize, writePaneRatio } from "./notes/paneChrome";
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
    focusNoteId,
}: NotesPageProps) {
    /** 关系图谱（2026-10-09）：双链关系的全貌，从「更多」里开 */
    // ============ 筛选与排序条件（2026-10-22 抽到 notes/useNotesFilters）============
    // 只搬「用户此刻的筛选意图」（搜索词/视图/排序/选中的文件夹与标签/远端结果/最近打开），
    // 全是纯输入态、不依赖 props，所以放在这里不会影响 hooks 顺序。
    // ⚠️ notes 列表本身与那些派生 useMemo 还留在下面 —— 它们和分组树/拖拽/虚拟列表缠在一起，
    //    要搬得连派生一起搬，是独立一轮的事。
    const filters = useNotesFilters();
    const {
        keyword, setKeyword,
        view, setView,
        sortKey, setSortKey,
        sortAnchor, setSortAnchor,
        activeFolder, setActiveFolder,
        activeTag, setActiveTag,
        remoteSearch, setRemoteSearch,
        recentNoteIds, setRecentNoteIds,
    } = filters;

    const [graphOpen, setGraphOpen] = useState(false);
    /**
     * 附件管理器抽屉（2026-10-19 从左下角进来）。
     *
     * 原来是「全库待办面板」占着这个位置，用户要求那个功能**彻底去掉**、
     * 把附件管理放过来：待办清单的价值全在「勾一下回写原文」，而正文里的
     * `- [ ]` 本来就能点（预览与源码两处都支持），聚合面板属于重复入口；
     * 附件管理器则恰恰缺一个随手可点的入口 —— 之前藏在「设置 → 数据」两级菜单后面。
     */
    const [attManagerOpen, setAttManagerOpen] = useState(false);
    /**
     * 当前要预览的附件（2026-10-19）。两个入口共用同一个弹窗：
     *   - 正文里点附件链接（markdownToReact → context → 这里）
     *   - 附件管理器里点文件名
     * null = 关着。
     */
    const [previewTarget, setPreviewTarget] = useState<AttachmentPreviewRequest | null>(null);
    /**
     * 给 context 的控制器。⚠️ 空依赖 + useMemo：对象引用必须稳定，
     * 否则每次渲染都是新 value，整棵预览子树跟着重渲染（树很大）。
     */
    const previewController = useMemo(
        () => ({ open: (request: AttachmentPreviewRequest) => setPreviewTarget(request) }),
        []
    );
    /**
     * 编辑器里点附件链接时走这里（源码态没有 React context，没法用 AttachmentLink 的
     * useAttachmentPreview）。引用稳定，三个 NoteEditor 共用一份。
     */
    const openAttachmentFromEditor = useCallback(
        (id: string) => previewController.open({ id, filename: "" }),
        [previewController]
    );
    /** 反链右侧常驻面板（N4）：与大纲面板同一位置，桌面头部按钮 / 菜单项共同开关 */
    const [backlinksOpen, setBacklinksOpen] = useState(false);
    /** 多选批量条（2026-10-09）：只在用户主动开了「多选」时才勾人，退出即清空 */
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
    /** 中间栏排序（中栏右上角「排序」菜单）。
     *  default = 置顶优先 + 原始顺序；title/created 按字面排序。 */
    /** 「收起」：中栏右上角把列表收起；切视图 / 选文件夹 / 点搜索框时自动展开 */
    const [middleHidden, setMiddleHidden] = useState(false);
    /**
     * tablet（768~1180）的导航抽屉（2026-10-08 照 inkstone 的 AppShell）：
     * 顶部一条 44px 栏放「导航栏」按钮 + 搜索框，导航列以 272px 左侧抽屉展开；
     * 导航列在窄屏不再内联渲染（desktop 才有），列表列收起后整个左区让给编辑区。
     */
    const [navDrawerOpen, setNavDrawerOpen] = useState(false);
    /** 编辑区头部「导出」下拉（2026-10-08 照 inkstone：Download 按钮 + 三格式菜单） */
    /** 阶段三收尾：导航列里选中的文件夹 / 标签（选中任一个就只看那一份） */
    /**
     * 新建文件夹/标签 —— 走站内的 NamePromptDialog，不再用 window.prompt。
     * `parentId` 有值就是「新建子文件夹」，两个入口共用同一个弹窗，行为一致。
     * ⚠️ namePrompt 这个 state 已搬到 useNotesRowActions（2026-10-22），下面只剩填它的函数。
     */
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
    // ============ 行操作 / 多选 / 删除确认（2026-10-22 抽到 notes/useNotesRowActions）============
    // 零外部依赖：全是开关与锚点，不碰列表数据，所以放在哪儿都不影响 hooks 顺序。
    const rowActions = useNotesRowActions();
    const {
        multiSelect, setMultiSelect, checked, setChecked,
        exportAnchor, setExportAnchor,
        namePrompt, setNamePrompt,
        removeTarget, setRemoveTarget, closeRemove,
        rowMenu, setRowMenu, menuClosing, setMenuClosing,
        rowActionsSuppressed, setRowActionsSuppressed,
        tagPick, setTagPick, exportPick, setExportPick,
        bulkDeleteOpen, setBulkDeleteOpen, bulkBusy, setBulkBusy,
    } = rowActions;
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
    /** 统一的行菜单关闭：置抑制行 + menuClosing（各关闭路径共用，防漏） */
    const closeRowMenu = useCallback(() => {
        setRowActionsSuppressed(rowMenu?.noteId ?? null);
        setRowMenu(null);
        setMenuClosing(true);
    }, [rowMenu]);
    /** 正在拖的笔记行（半透明反馈，与文件夹那边同一套观感） */
    const [draggingNoteId, setDraggingNoteId] = useState<number | null>(null);
    /** 「编辑标签」二级弹窗的锚点 */
    /** 「导出」二级菜单的锚点（2026-10-17 精简右键菜单：三个导出格式收进一个入口） */
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    /** 记事本命令面板（N1）开关 */
    const [notesCmdOpen, setNotesCmdOpen] = useState(false);
    /** 最近打开的笔记 id（命令面板空查询时优先展示） */
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
     * 真·专注模式（A9，2026-10-22）：只留标题与正文。
     *
     * 为什么是页面级 state 而不是又一个 uiSettings 开关：它是「现在想安静写一会儿」
     * 的临时状态，Esc 就该没；存进 localStorage 的话，下次打开记事本莫名其妙少两栏，
     * 而且没有可见的退出提示。与设置里那个「专注模式」（淡化非当前行）是两个东西，
     * 那个管的是**编辑器内部**的注意力，这个管的是**页面外围**的干扰。
     *
     * 触发：标题行「专注模式」按钮 / 「更多操作」菜单同名项；退出：Esc 或退出按钮。
     */
    const [zenMode, setZenMode] = useState(false);
    /**
     * Esc 退出专注模式。
     * ⚠️ 必须让位给浮层：命令面板、设置、灯箱、菜单开着的时候，Esc 是它们的
     * （用户期望 Esc 先关手头那个浮层，不是把整个页面布局掀了）。
     * 所以先探一遍 DOM 上有没有 [role=dialog] / [role=menu] / 灯箱 —— 有就什么都不做。
     */
    useEffect(() => {
        if (!zenMode) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (document.querySelector('[role="dialog"], [role="menu"], [data-lightbox]')) return;
            e.preventDefault();
            setZenMode(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [zenMode]);
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
        (source: string): Promise<ReactNode> =>
            // ⚠️ 即时渲染块是 LiveBlockWidget 里 createRoot 起的**独立 React root**，
            // NotesPage 顶层那个 AttachmentPreviewProvider 穿透不过去；不包一层的话，
            // 块里的 AttachmentLink 读到的 useAttachmentPreview() 是 null，会退回整页
            // 跳走的 <a>。这里把渲染结果整体用 Provider 包起来，编辑器内点链接才开弹窗。
            renderMarkdownToReact(source, {}).then(node =>
                createElement(AttachmentPreviewProvider, { value: previewController }, node)
            ),
        [previewController]
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



    // ---------- 在侧边打开（两个文档同时编辑） ----------
    // sideId / sideDraft / sideRef 已随工具集声明（hooks 顺序要求），这里只有派生状态


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

    // folders/tags/noteTags 只是 folderTags 的空值兜底，零依赖 —— 为满足
    // 「active 必须早于 panels hook（它要 active?.id）」而上移到此处。
    const folders = useMemo(() => folderTags?.folders ?? [], [folderTags]);
    const tags = useMemo(() => folderTags?.tags ?? [], [folderTags]);
    const noteTags = useMemo(() => folderTags?.noteTags ?? EMPTY_TAG_LINKS, [folderTags]);

    // ============ 与筛选无关的纯数据派生（2026-10-22 抽到 notes/useNotesData）============
    // active / 文件夹计数 / 标签计数 / 标签配色 / 每个文件夹下的笔记。
    // ⚠️ filtered/sorted/listGroups/viewCounts/attachmentRefCounts 仍留在下面：
    //    前三个依赖搜索与排序；viewCounts 牵连回收站派生；attachmentRefCounts 依赖两个开关。
    const { active, folderCounts, tagCounts, tagColorByName, notesByFolder } = useNotesData({
        notes,
        folders,
        tags,
        noteTags,
        activeId,
    });



    // ============ 弹层 / 浮层状态（2026-10-22 抽到 notes/useNotesPanels）============
    // 版本历史、灯箱、快捷键、分享、文件夹外观、标签颜色、移动抽屉、大纲开关、顶栏 ⋯ 菜单。
    // 这些状态只影响各自那块 UI，与列表 / 草稿 / 保存无关，所以聚成一个 hook。
    // ⚠️ 放这里是为了满足声明顺序：下面的命令面板（notesCommands）要引用 openRevisions。
    const panels = useNotesPanels({ activeId: active?.id, onListRevisions: folderTags?.onListRevisions });
    const {
        appearanceFolderId, setAppearanceFolderId,
        tagColorId, setTagColorId,
        moveDrawerNoteId, setMoveDrawerNoteId,
        outlineOpen, setOutlineOpen,
        activeMenuAnchor, setActiveMenuAnchor,
        revisionsOpen, setRevisionsOpen,
        revisions, setRevisions,
        openRevisions,
        lightbox, setLightbox,
        imageScale, setImageScale,
        imageFailed, setImageFailed,
        shortcutsOpen, setShortcutsOpen,
        shareId, setShareId,
    } = panels;

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


    // ============ 列表派生链（2026-10-22 抽到 notes/useNotesList）============
    // filtered → sorted → listGroups → visibleIds。
    // ⚠️ searchableText 与 searchHits 都留在上面的搜索子系统里，这里只当入参吃进来
    //    （搜索视图下只要笔记本体，不要高亮区间）。
    const { filtered, lazyListGroups, listGroups, visibleIds } = useNotesList({
        notes,
        view,
        keyword,
        activeFolder,
        activeTag,
        sortKey,
        noteTags,
        searchHits,
        searchableText,
    });

    /**
     * 列表要不要走组级懒挂载（LazyGroup）。条数低于阈值时全量渲染 ——
     * 不改变 DOM 结构，守卫与真机探针在小数据量下的行为与从前完全一致。
     * 占位行高与 CSS content-visibility 的占位估计值同源（56/96 两档）。
     * ⚠️ 这条注释刻意不写行样式那两个驼峰属性名 —— 有守卫拿它们当锚点。
     */

    /** 阶段二：列表按月份分组（「十月」「九月…」），和 inkstone 一样 */
    /** 中栏「排序」的排序键。default = 置顶优先 + 原始顺序（服务端排序） */

    /**
     * 列表分组（照 inkstone 的 `buildGroups`）：**置顶单独一组**，
     * 其余按 `groupLabel` 的相对时间（今天 / 昨天 / 本周 / 本月 / 9 月 / 2026 年 8 月）。
     * ⚠️ 之前是纯按 `YYYY-MM` 分组，列表顶上永远是「2026 年 10 月」这种
     * 又长又没信息量的标题，而「今天动过的几条」被埋在里面看不出来。
     */

    /**
     * 列表**当前渲染顺序**里的 id 序列。
     *
     * Shift 范围选必须按「屏幕上看到的先后」来选，而不是按 `notes` 的库内顺序 ——
     * 列表有分组（置顶 / 今天 / 昨天）和排序键，两者顺序并不一致，
     * 用错的那份会选出一段看起来毫无规律的笔记。
     */

    /** 阶段三：回收站列表。还原是主操作，彻底删除放右边且要二次确认。 */
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
        }),
        [notes, trashedNotes]
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
            // 站点（D2 双向绑定）：`[[站名]]` 写完点了会打开那个站点。
            // 读模块级索引（导航站加载站点时写进去的），读不到就是空数组 ——
            // 少一种补全而已，不报错、也不影响笔记双链。
            sites: () => getSiteIndex().map(s => ({ name: s.name, url: s.url })),
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
     * ⚠️ 只在**面板真的打开**时才算（2026-10-18 修「置顶笔记卡顿」）：
     * 原来无条件扫全部正文，置顶/保存时这一段要跑好几毫秒的正则，而结果
     * 99% 的时间根本没人看。面板一开（settingsOpen 变 true）当帧就会算出来。
     * ⚠️ 每个入口都要算进去：设置 → 数据、以及左下角「附件」（2026-10-19 新增）。
     * 漏一个的后果是那个入口的「引用 N 次 / 未引用」全是 0 —— 看着像全部未引用。
     * ⚠️ 每条笔记先用 `includes` 兜一道：没有附件链接的正文不进正则。
     */
    const attachmentRefCounts = useMemo(() => {
        if (!settingsOpen && !attManagerOpen) return EMPTY_REF_COUNTS;
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
    }, [notes, settingsOpen, attManagerOpen]);

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

    // ============ 自动保存（2026-10-22 抽到 notes/useNoteAutoSave）============
    // ⚠️ dirty 与 save 都不搬进去：dirty 还被「关闭前的未保存确认」用，
    //    save 依赖外层传进来的 onUpdate / onNotify。
    // ⚠️ hook 内部用 saveRef 绕开 save 身份变化（save 依赖 onUpdate → notes，每次保存都换引用），
    //    这样 effect 的依赖数组只认 dirty / draft / active.id 三样，防抖不会被打断。
    const { saveState, savedAt, tick } = useNoteAutoSave({
        dirty,
        draft,
        noteId: active?.id,
        autosaveMs,
        save,
    });


    const openNote = useCallback((note: Note) => {
        setActiveId(note.id ?? null);
        setMobileDetail(true);
    }, []);

    /**
     * 在**当前选中的文件夹**里直接新建（inkstone：文件夹那一栏就是笔记的落点）。
     * 没选中文件夹时 folder_id 留空 —— 落在「未归类」，和之前的行为一致。
     *
     * ⚠️ 这是「不选模板、直接建空白」的那条路：右键菜单「在此新建笔记」、
     * 图谱、命令面板输入建笔记都走它。**有按钮的主入口**（中栏头部、
     * 空态、左栏文件夹标题旁）走 openTemplatePicker —— 那些位置用户
     * 有时间挑模板，快捷通道则一秒都不该多花。
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
     * 「新建笔记」的模板选择（B3，2026-10-22）。
     * state 里存 folderId 而不是把文件夹写进回调闭包 —— 同一个 picker
     * 实例服务多个入口，文件夹以「点开那一刻的选中态」为准。
     */
    const [templatePick, setTemplatePick] = useState<{ folderId: number | null; el: HTMLElement | null } | null>(null);
    const openTemplatePicker = useCallback((anchor: HTMLElement | null, folderId: number | null) => {
        setTemplatePick({ folderId, el: anchor });
    }, []);
    /** 选了模板（或「空白笔记」）→ 建库 + 切成编辑态。草稿与库里同一份内容 */
    const createFromTemplate = useCallback(
        async (templateId: NoteTemplateId | null) => {
            const folderId = templatePick?.folderId ?? null;
            const seeded = templateId ? noteTemplateDraft(templateId) : { title: "", content: "" };
            const created = await onCreate(
                folderId === null
                    ? { title: seeded.title, content: seeded.content }
                    : { title: seeded.title, content: seeded.content, folder_id: folderId }
            );
            if (created?.id) {
                setActiveId(created.id);
                setDraft({ title: seeded.title, content: seeded.content });
                setMobileDetail(true);
            }
        },
        [onCreate, templatePick]
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
     * D2 双向绑定：从站点设置里点「相关笔记」进来时直接跳到那条。
     *
     * ⚠️ 两个「只做一次」的闸门都不能少：
     *   ① ref 记下已处理过的 id —— 否则 notes 一变（3 秒自动保存 / 轮询）就会
     *      把用户后来自己选中的笔记抢回目标那条，表现为「怎么点都跳回去」；
     *   ② 列表里还没有这条时（notes 首帧还没到）什么都不做，等下一帧 ——
     *      不能因为「没找到」就报错，那只是加载时序问题。
     */
    const focusedRef = useRef<number | null>(null);
    useEffect(() => {
        if (focusNoteId == null) return;
        if (focusedRef.current === focusNoteId) return;
        if (!notes.some(n => n.id === focusNoteId)) return;
        focusedRef.current = focusNoteId;
        void jumpToNote(focusNoteId);
    }, [focusNoteId, notes, jumpToNote]);

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
    const sideNote = sideId !== null ? notes.find(n => n.id === sideId) ?? null : null;
    /**
     * 五个面板共享的上下文：这里组装一次，各面板按 Pick 各取所需。
     * 类型在 ./notes/notesPageCtx.ts（由编译器从真实代码导出）。
     *
     * ⚠️ navInner 是**导航列元素**而不是数据：窄屏抽屉里的列表要把它整块渲染进去，
     * 所以先组装不含它的 paneBase，造出 navInner，再合成最终的 paneCtx ——
     * 顺序反了就会变成「自己引用自己」。
     */
    const paneBase = {
        SIDE_SPLIT_KEY,
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
    };
    const navInner = <NotesNavPanel {...paneBase} />;
    const paneCtx: NotesPageCtx = { ...paneBase, navInner };

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

/**
 * 补全面板里那条笔记的摘要（右侧灰色小字）。
 * 只要「看一眼就认得出是哪篇」，所以——摘掉 front matter、把 Markdown 记号当空格、
 * 压缩空白、砍到 80 字。别让它变成第二个解析流程（大意？自动摘要？都不用）。
 */
