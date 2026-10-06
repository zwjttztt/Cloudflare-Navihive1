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
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import ArchiveIcon from "@mui/icons-material/Archive";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChecklistIcon from "@mui/icons-material/Checklist";
import CodeIcon from "@mui/icons-material/Code";
import CalculateIcon from "@mui/icons-material/Calculate";
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
import ImageIcon from "@mui/icons-material/Image";
import LastPageIcon from "@mui/icons-material/LastPage";
import LinkIcon from "@mui/icons-material/Link";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import HistoryIcon from "@mui/icons-material/History";
import ShareIcon from "@mui/icons-material/Share";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import SearchIcon from "@mui/icons-material/Search";
import StrikethroughIcon from "@mui/icons-material/StrikethroughS";
import TableRowsIcon from "@mui/icons-material/TableRows";
import UndoIcon from "@mui/icons-material/Undo";
import type { Note, NoteFolder, NoteRevision, NoteTag } from "../API/http";
import type { TrashedNote } from "../hooks/useNotes";
import { renderMarkdownToReact } from "../utils/markdownToReact";
import { withBlockId, buildTabSource, buildFoldSource } from "../utils/noteBlocks";
import { buildFrontMatter, type FrontMatterEntry } from "../utils/noteFrontMatter";
import type { NoteEmbedTarget } from "./NoteEmbedNode";
import { useScrollLock } from "../hooks/useScrollLock";
// 笔记时间统一走这里：SQLite 的 UTC 无时区串必须按 UTC 解释，
// 直接 `new Date(iso)` 在东八区会差 8 小时（「笔记时间不对」的根因）。
import { formatRelative, formatWhen, formatWhenFull, monthLabel } from "../utils/noteTime";
import { extractOutline, outlineIndent } from "../utils/noteOutline";
import { buildBacklinks, resolveWikiLinks } from "../utils/noteWikiLink";
import { exportNoteAsMarkdown } from "../utils/noteExport";
import { reportError } from "../utils/errorReporter";
import NoteEditor from "./NoteEditor";
import ConfirmDialog from "./ConfirmDialog";
import NamePromptDialog from "./NamePromptDialog";
import type { NoteEditorHandle } from "../utils/noteEditorHandle";
import {
    addColumnRight,
    addRowBelow,
    buildTable,
    removeColumn,
    removeRow,
} from "../utils/markdownTable";

import NoteShareDialog, { type NoteShareApi } from "./NoteShareDialog";

export interface NotesPageProps {
    shareApi?: NoteShareApi;
    notes: Note[];
    onClose: () => void;
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
        onRenameFolder: (id: number, name: string) => Promise<void>;
        onRemoveFolder: (id: number) => Promise<void>;
        onCreateTag: (name: string) => Promise<NoteTag | null>;
        onRenameTag: (id: number, name: string) => Promise<void>;
        onRemoveTag: (id: number) => Promise<void>;
        // 返回值故意留成 `Promise<NoteTag[] | null>` 而不是 `Promise<void>`：
        // `Promise<T>` 不能赋给 `Promise<void>`（void 的那条宽松规则只在函数返回类型上生效，
        // 套一层 Promise 就不认了），写 void 会让调用方的实现没法返回查到的最新清单。
        onAssignTags: (noteId: number, tagIds: number[]) => Promise<NoteTag[] | null>;
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
    ...rest
}: {
    label: string;
    count: number;
    selected: boolean;
    onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <Box
            component='button'
            type='button'
            onClick={onClick}
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
                bgcolor: selected ? "rgba(128,128,128,0.14)" : "transparent",
                color: selected ? "text.primary" : "text.secondary",
                transition: "background-color 120ms ease",
                "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                "&:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: 1 },
            }}
            {...rest}
        >
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
}: {
    title: string;
    items: { id: number; name: string; count: number; parent_id?: number | null }[];
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
}) {
    const [menuId, setMenuId] = useState<number | null>(null);
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
    const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
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
                        draggable={Boolean(onMove)}
                        onDragStart={onMove ? e => {
                            e.dataTransfer.setData("application/navihive-folder", String(item.id));
                            e.dataTransfer.effectAllowed = "move";
                            setDragging(item.id);
                        } : undefined}
                        onDragEnd={onMove ? endDrag : undefined}
                        onClick={() => onSelect(selectedId === item.id ? null : item.id)}
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
                            bgcolor: "background.paper",
                            "&:hover": { opacity: 1 },
                            // 触屏没有 hover：直接常显，否则在那边根本点不到
                            "@media (hover: none)": { opacity: 1 },
                        }}
                    >
                        <MoreVertIcon fontSize='inherit' />
                    </IconButton>
                </Box>
            ))}
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
                {onCreateChild && <MenuItem onClick={() => {
                    const id = menuId; setMenuId(null);
                    if (id !== null) onCreateChild(id);
                }}>新建子文件夹</MenuItem>}
                {onMove && <MenuItem onClick={() => {
                    const id = menuId; setMenuId(null);
                    if (id !== null) onMove(id, null);
                }}>移到根目录</MenuItem>}
                {onAskRename && (
                    <MenuItem
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
                {onAskRemove && (
                    <MenuItem
                        onClick={() => {
                            const id = menuId;
                            setMenuId(null);
                            // 同理，删除的二次确认也走上层的 ConfirmDialog
                            if (id !== null) onAskRemove(id, items.find(i => i.id === id)?.name ?? "");
                        }}
                    >
                        删除
                    </MenuItem>
                )}
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
 * 视觉上几乎看不见（hover 才浮出一条 2px 的竖线），但**命中区有 7px 宽** ——
 * 2px 的细线在笔记本触控板上根本点不中，那是「有分隔条却拖不动」的常见原因。
 */
function ColResizeHandle({
    label,
    onDrag,
    onReset,
}: {
    label: string;
    onDrag: (e: React.MouseEvent) => void;
    onReset: () => void;
}) {
    return (
        <Box
            role='separator'
            aria-orientation='vertical'
            aria-label={label}
            title={`${label}（双击回到默认宽度）`}
            onMouseDown={onDrag}
            onDoubleClick={onReset}
            sx={{
                width: 7,
                flexShrink: 0,
                cursor: "col-resize",
                bgcolor: "transparent",
                transition: "background-color 120ms ease",
                "&:hover": { bgcolor: "var(--accent)" },
                // ⚠️ 下面两条是「拖得动」的关键，不是装饰：
                //   - `alignSelf: stretch` + `minHeight`：父容器是 flex，
                //     不显式拉伸的话这条会**塌成 0 高度**（2026-10-06 的真机 bug：
                //     真机量到 h=0，鼠标点不中；而合成事件绕过命中测试，单测全绿）。
                //   - `touchAction: none`：触屏上浏览器会把手势当成滚动，
                //     拖动直接被滚动手势吃掉。
                alignSelf: "stretch",
                minHeight: 120,
                touchAction: "none",
                userSelect: "none",
            }}
        />
    );
}

/**
 * 自动保存的防抖间隔（阶段四第 14 条）。
 *
 * 3 秒是「打字不被打断」和「关掉不至于丢太多」之间的折中：1 秒太勤（每个停顿都发一次
 * 请求，离线队列里会攒一堆无用 PATCH），10 秒太长（关窗口就丢几秒的字）。
 * 真关窗口还有卸载前那次 flush 兜底，所以 3 秒不会真丢东西。
 */
const AUTO_SAVE_MS = 3000;

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
    notes,
    onClose,
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
    const [rowMenu, setRowMenu] = useState<{ noteId: number; el: HTMLElement } | null>(null);
    /** 正在拖的笔记行（半透明反馈，与文件夹那边同一套观感） */
    const [draggingNoteId, setDraggingNoteId] = useState<number | null>(null);
    /**
     * 大纲跳转：把光标送到那一行并**选中整行**。
     *
     * 只挪光标不选中的话，长笔记里落点在哪一格根本看不见（光标是个 1px 的竖线，
     * 夹在一堆同色文字里找不着）。选中整行当行高亮用，闭着眼也知道跳到了哪。
     */
    const jumpToOffset = useCallback((offset: number) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const from = offset;
        const nl = value.indexOf("\n", from);
        const to = nl === -1 ? value.length : nl;
        el.focus();
        el.setSelectionRange(from, to);
        // CodeMirror 按真实布局滚动选区，包含自动换行，不再估算行高。
    }, []);
    /** 「归入文件夹 / 编辑标签」这两个二级弹窗的锚点（复用同一个 Menu 容器） */
    const [folderPick, setFolderPick] = useState<{
        el: HTMLElement;
        noteId: number;
    } | null>(null);
    const [tagPick, setTagPick] = useState<{ el: HTMLElement; noteId: number } | null>(null);
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
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
            blocking: Boolean(namePrompt || removeTarget || rowMenu || outlineAnchor || backlinkAnchor),
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

    /** 阶段二：搜索框的 ⌘K 快捷键 */
    const searchRef = useRef<HTMLInputElement | null>(null);
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
                searchRef.current?.focus();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

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
    const monthGroups = useMemo(() => {
        const buckets = new Map<string, { label: string; items: Note[] }>();
        for (const n of filtered) {
            const raw = n.updated_at || n.created_at || "";
            const key = raw.slice(0, 7); // "2026-10"
            const list = buckets.get(key);
            if (list) list.items.push(n);
            else buckets.set(key, { label: monthLabel(raw), items: [n] });
        }
        // 月份从新到旧（最近编辑的笔记在最上面）。
        // ⚠️ 不能直接拿「2026 年 10 月」这种中文字面排字典序：`9` > `1`，
        // 会把九月排到十月前面；按 `YYYY-MM` 排才对。
        return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    }, [filtered]);

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

    /** 大纲面板的锚点 */
    const [outlineAnchor, setOutlineAnchor] = useState<HTMLElement | null>(null);

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
        }, AUTO_SAVE_MS);
        return () => clearTimeout(timer);
    }, [dirty, draft, active?.id]);

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

    const startCreate = useCallback(async () => {
        const created = await onCreate({ title: "", content: "" });
        if (created?.id) {
            setActiveId(created.id);
            setDraft({ title: "", content: "" });
            setMobileDetail(true);
        }
    }, [onCreate]);

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

    /**
     * 上一次插入的片段（起止偏移 + 原文 + 是**哪个**按钮插的）。
     * 只靠位置判断取消是不行的：插完后光标落在整段之后，其两侧未必还是
     * 那两枚标记（比如在文末就什么都没有），硬判取消会把用户刚敲的 `**` 删掉。
     * ⚠️ before/after 必须一起记：少了这层校验，点完「粗体」再点「斜体」，
     * 斜体会把上一段粗体当成「同名按钮的第二次点击」给撤掉（浏览器实测抓出来的）。
     */
    const lastInsertRef = useRef<{
        start: number;
        snippet: string;
        /** 插进去的正文（`selected`，可能是占位符） */
        body: string;
        /** 这次插入是「包住一段真实选区」还是「没选东西、只塞了个占位符」 */
        hadSelection: boolean;
        before: string;
        after: string;
    } | null>(null);

    /** 「链接与引用」上一次插入的位置，用于「再点一次撤掉」 */
    const footnoteRefRef = useRef<{
        /** 正文里那个引用所在的位置 */
        refAt: number;
        snippet: string;
        definition: string;
        /** 插入时被引用替换掉的原文，撤掉时要还原回去 */
        body: string;
        /** 插入后光标停在哪。只有用户没动过光标才允许「再点一次撤掉」 */
        caretAfter: number;
    } | null>(null);

    /**
     * 在光标处插入一段 Markdown 语法 —— **同名按钮是开关**：
     * 已经有这层格式就摘掉，没有就包上（点第二下把上一次插入撤掉 = 取消）。
     *
     * 三条路径：
     *   ① 连点同一个按钮，且那段还是上次插的东西：
     *      - 刚才是**包住一段真实选区**插的 → 只拆掉两枚标记，**正文要留着**
     *        （用户原话：「选中输入内容后点击两下粗体会删除内容，应该只取消粗体」）；
     *      - 刚才是没选东西、只塞了个占位符 → 整段撤掉（没什么可留的，才叫「取消」）。
     *   ② 选区已经带标记（`**粗体**`）或正好被两枚标记夹住 → 去掉标记；
     *   ③ 其余 → 包一层（有选区包住选区，没有就放占位符）。
     */
    const insertAtCursor = useCallback(
        (before: string, after: string, placeholder: string) => {
            const el = textareaRef.current;
            if (!el) return;
            // ⚠️ **内容要从 textarea.value 读，不能从 draft（React state）读**。
            // setDraft 是异步的：连点两下按钮时，第二次拿到的 draft 还是**上一次
            // 插入之前**的值，于是又从旧的 selectionStart 插一遍 —— 两次插入
            // 叠在同一处，内容就堆成一团（用户报「多次点击有问题」）。
            // DOM 上的 value 永远是最新且唯一的事实来源。
            const content = el.value;
            const start = el.selectionStart ?? content.length;
            const end = el.selectionEnd ?? start;

            /** 写回：先落 DOM 值 + 光标，再同步 state（顺序反了连点会读到旧值） */
            const writeBack = (next: string, caret: number, selEnd = caret) => {
                el.value = next;
                el.setSelectionRange(caret, selEnd);
                el.focus();
                setDraft(d => (d ? { ...d, content: next } : d));
            };

            // ① 连点**同一个**按钮 → 撤销上一次插入（用户要的「第二下取消」）
            const last = lastInsertRef.current;
            const sameTool = last && last.before === before && last.after === after;
            if (sameTool && content.slice(last.start, last.start + last.snippet.length) === last.snippet) {
                const at = last.start;
                lastInsertRef.current = null;
                if (last.hadSelection) {
                    // ② 只取消这层格式：摘掉 before/after，把选中的正文原样留在原地，
                    //    并顺手选中它，用户马上能接着改。
                    const next =
                        content.slice(0, at) + last.body + content.slice(at + last.snippet.length);
                    writeBack(
                        next,
                        Math.min(at, next.length),
                        Math.min(at + last.body.length, next.length)
                    );
                } else {
                    // ③ 纯占位符插入（当时没选东西），第二下直接把这段撤掉
                    const next =
                        content.slice(0, at) + content.slice(at + last.snippet.length);
                    writeBack(next, Math.min(at, next.length));
                }
                return;
            }

            const seg = content.slice(start, end) || "";
            const pre = content.slice(start - before.length, start);
            const post = content.slice(end, end + after.length);
            // 选区自带两枚标记（整段选中），或选区正好被两枚标记夹住（只选了里面的字）
            const segHasMarks =
                seg.length > before.length + after.length &&
                seg.startsWith(before) &&
                seg.endsWith(after);
            const segBare = !seg.startsWith(before) && !seg.endsWith(after);
            const surrounding = pre === before && post === after;

            // ② 已经有这层格式 → 摘掉（取消加粗/斜体…）
            if (segHasMarks || (segBare && surrounding)) {
                const body = segHasMarks ? seg.slice(before.length, seg.length - after.length) : seg;
                const from = segHasMarks ? start : start - before.length;
                const to = segHasMarks ? end : end + after.length;
                const next = content.slice(0, from) + body + content.slice(to);
                lastInsertRef.current = null;
                writeBack(next, Math.min(from, next.length), Math.min(from + body.length, next.length));
                return;
            }

            // ③ 包一层。⚠️ 光标必须落在**整段**之后（before + selected + after 都算上），
            // 漏掉 after.length 的话光标会落在闭合的 `**` 中间，接着打字就插到标记里头。
            const selected = seg || placeholder;
            const next =
                content.slice(0, start) + before + selected + after + content.slice(end);
            lastInsertRef.current = {
                start,
                snippet: before + selected + after,
                body: selected,
                hadSelection: seg.length > 0,
                before,
                after,
            };
            // ⚠️ 选中一段字点按钮之后，这段字要**继续选着** ——
            // 之前 writeBack 只给了 caret（selEnd 默认 = caret），选区被折叠到末尾，
            // 用户看到的「点了粗体后选择就没了」，再点第二下「取消粗体」也无从判断。
            // 行首前缀类（`# ` `- ` `> `）也一样：把刚包上的正文重新选上。
            if (seg.length > 0) {
                const bodyFrom = start + before.length;
                writeBack(next, bodyFrom, Math.min(bodyFrom + selected.length, next.length));
            } else {
                writeBack(
                    next,
                    Math.min(next.length, start + before.length + selected.length + after.length)
                );
            }
        },
        []
    );

    /**
     * 内容块（inkstone 工具栏「内容块」）：插一个 `> [!NOTE]` 骨架。
     *
     * 做成**下拉**而不是单一按钮：NOTE/TIP/IMPORTANT/WARNING/QUOTE 五种，
     * 一次点一种。这里只负责把行首改成引用 + 加上类型标记，
     * 真正的判定与渲染在 utils/markdownCallout.ts（那边有单测）。
     */
    const insertCallout = useCallback((type: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        // 已经在引用块里就别再套一层 `>`，否则会变成 `>> [!NOTE]`
        const inQuote = value.slice(lineStart, pos).startsWith(">");
        const marker = `> [!${type}] `;
        const insert = inQuote ? `[!${type}] ` : marker;
        const next = value.slice(0, lineStart) + insert + value.slice(lineStart);
        el.value = next;
        const caret = lineStart + insert.length;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /**
     * 「链接与引用」（inkstone 工具栏第 12 项）：把**选中的文字**变成一条脚注引用。
     *
     * 为什么不用 `[[双链]]` 语法实现：双链是「链到另一条**笔记**」，
     * 这里要的是「链到本文的**某一段**」—— 语义不同，落地方式也不同
     * （脚注 `[^n]` + 文末 `[^n]: 原文`，markdown-it-footnote 已经能渲染和跳回）。
     *
     * 三种情形：
     *   - 选中了文字 → **选区被引用替换**（原文搬进文末定义），光标留在文末引用处
     *   - 没选东西    → 文末补一条占位定义，正文插引用
     *   - 连点第二下  → 撤掉刚插入的那一条（含文末定义，不留孤儿）
     *
     * ⚠️ 定义编号取「文末已有脚注最大值 + 1」，不能固定从 1 开始：
     * 同一篇里插第二条时 `[^1]: …` 会被写成两条同名定义，markdown-it 只认第一条。
     */
    const insertFootnoteRef = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        const content = el.value;
        const start = el.selectionStart ?? content.length;
        const end = el.selectionEnd ?? start;
        const writeBack = (next: string, caret: number, selEnd = caret) => {
            el.value = next;
            el.setSelectionRange(caret, selEnd);
            el.focus();
            setDraft(d => (d ? { ...d, content: next } : d));
        };

        // ① 连点第二下 → 撤掉上一次插入的这条引用。
        //    ⚠️ 两个前置条件缺一不可：
        //      - 那段引用还在原位（内容没被别处改过）；
        //      - **光标还停在插入后留下的位置** —— 用户挪过光标就说明他不是想「取消」，
        //        而是要在别处再插一条，这时按「撤掉」会把他刚插的那条也抹掉。
        //      （之前只判位置，插第二条时第一条的引用恰好还在眼前 → 误撤，整段正文消失）
        const last = footnoteRefRef.current;
        const caretNow = el.selectionStart ?? content.length;
        if (
            last &&
            content.slice(last.refAt, last.refAt + last.snippet.length) === last.snippet &&
            caretNow === last.caretAfter
        ) {
            // 引用换回原文，文末那条定义一起去掉（否则留下没人引用的孤儿定义）
            const restored =
                content.slice(0, last.refAt) + last.body + content.slice(last.refAt + last.snippet.length);
            const defAt = restored.indexOf(last.definition);
            const cleaned = (
                defAt >= 0
                    ? restored.slice(0, defAt) + restored.slice(defAt + last.definition.length)
                    : restored
            ).replace(/\s+$/, "");
            footnoteRefRef.current = null;
            writeBack(cleaned, Math.min(last.refAt, cleaned.length));
            return;
        }

        // ② 编号：文末已有脚注的最大序号 + 1
        let max = 0;
        for (const m of content.matchAll(/\[\^(\d+)\]/g)) {
            const n = Number(m[1]);
            if (n > max) max = n;
        }
        const num = max + 1;
        const snippet = `[^${num}]`;
        const body = content.slice(start, end).trim() || "引用内容";

        // 先在正文把选区换成引用，再在文末补定义 —— 顺序反了会让引用落在定义之后
        const withRef =
            content.slice(0, start) + snippet + content.slice(end);
        const trimmedEnd = withRef.replace(/\s+$/, "");
        const definition = `\n\n[^${num}]: ${body}`;
        const next = `${trimmedEnd}${definition}`;
        const caret = trimmedEnd.length + definition.length;
        footnoteRefRef.current = { refAt: start, snippet, definition, body, caretAfter: caret };
        // 光标留在文末：用户多半是要接着写下一条
        writeBack(next, caret);
    }, []);

    /**
     * 行首插入前缀（标题 `# `、引用 `> `、列表 `- `）。
     * 和 insertAtCursor 走两条路：标题必须落在**当前行开头**，不能插在光标中间 ——
     * 否则光标在段落中间点「H1」，得到的不是标题而是半句被 `#` 劈开的话。
     */
    /**
     * 阶段四第 12 条：给代码块定语言。
     *
     * 两种情形分开处理：
     *   - 光标已经在某个 ``` 围栏**里面**（或在围栏行上）→ 只把那一行的语言改掉，
     *     不动代码正文。这是最常用的场景：先敲了围栏，回头想标语言。
     *   - 不在围栏里 → 插一个新围栏；有选中内容就把选中部分当代码体包进去。
     *
     * ⚠️ 判「在不在围栏里」必须**同时**找到开和闭两行，且光标夹在中间：
     * 只找开头会把「围栏之上、围栏之外」的位置也算进去，改到别的块上去。
     * 另外光标就在围栏行上时也算在里面（否则想改语言得先把光标挪进代码块）。
     */
    const applyCodeLanguage = useCallback((lang: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const end = el.selectionEnd ?? pos;

        const lines = value.split("\n");
        const cursorLine = value.slice(0, pos).split("\n").length - 1;
        const isFence = (s: string) => /^\s*```/.test(s);

        let openLine = -1;
        for (let i = Math.min(cursorLine, lines.length - 1); i >= 0; i--) {
            if (isFence(lines[i])) {
                openLine = i;
                break;
            }
        }
        let closeLine = -1;
        if (openLine >= 0) {
            for (let i = openLine + 1; i < lines.length; i++) {
                if (isFence(lines[i])) {
                    closeLine = i;
                    break;
                }
            }
        }
        const insideFence =
            openLine >= 0 && closeLine > openLine && cursorLine >= openLine && cursorLine <= closeLine;

        let next: string;
        let caret: number;
        let caretEnd: number;

        if (insideFence) {
            // 只改围栏行，正文一行不动
            lines[openLine] = "```" + lang;
            next = lines.join("\n");
            // 光标留在原处：按字符位置换算（改的是第 openLine 行，光标在它下面，位置只受那一行长度变化影响）
            const delta = lines[openLine].length - value.split("\n")[openLine].length;
            caret = Math.min(pos + delta, next.length);
            caretEnd = Math.min(end + delta, next.length);
        } else {
            const body = value.slice(pos, end) || "代码";
            const block = "```" + lang + "\n" + body + "\n```";
            // 前后补空行：紧贴上一段文字时 markdown-it 会把围栏并进上一段里
            const head = value.slice(0, pos);
            const tail = value.slice(end);
            const lead = head && !head.endsWith("\n") ? "\n" : "";
            const trail = tail && !tail.startsWith("\n") ? "\n" : "";
            next = head + lead + block + trail + tail;
            const bodyStart = head.length + lead.length + lang.length + 3 + 1; // ```lang + \n
            caret = bodyStart;
            caretEnd = Math.min(bodyStart + body.length, next.length);
        }

        el.value = next;
        el.focus();
        el.setSelectionRange(caret, caretEnd);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /**
     * 阶段四第 12 条：表格的插入 / 增删行列。
     *
     * 具体怎么改字符串全在 utils/markdownTable.ts（那边有单测），这里只负责
     * 拿到光标位置 → 调纯函数 → 写回 textarea 并把光标摆回合理的位置。
     */
    const applyTable = useCallback((op: TableOp) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const lines = value.split("\n");
        const cursorLine = value.slice(0, pos).split("\n").length - 1;
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const cursorCol = pos - lineStart;

        let next: string[];
        switch (op.kind) {
            case "insert": {
                const table = buildTable(op.rows, op.cols);
                // 插到光标所在行**下面**，并保证前后有空行（贴着正文时围栏/表格会被并进上一段）
                const head = lines.slice(0, cursorLine + 1);
                const tail = lines.slice(cursorLine + 1);
                next = [...head, "", ...table, "", ...tail];
                break;
            }
            case "addRow":
                next = addRowBelow(lines, cursorLine);
                break;
            case "delRow":
                next = removeRow(lines, cursorLine);
                break;
            case "addCol":
                next = addColumnRight(lines, cursorLine, cursorCol);
                break;
            case "delCol":
                next = removeColumn(lines, cursorLine, cursorCol);
                break;
        }

        const nextValue = next.join("\n");
        // 光标：增删行列后尽量停在原来那一行（行号不变），列位置夹到新行长度内
        const targetLine = Math.min(cursorLine, next.length - 1);
        const before = next.slice(0, targetLine).join("\n").length + (targetLine > 0 ? 1 : 0);
        const caret = Math.min(before + cursorCol, nextValue.length);

        el.value = nextValue;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: nextValue } : d));
    }, []);

    /**
     * 阶段四第 12c 条：插入公式。
     *
     * 两种规格都直接复用 `insertAtCursor` —— 那套「选中一段 → 包一层；
     * 再点一下摘掉这一层；没选中就插占位符」的开关语义已经在那儿了，
     * 公式没有任何理由再写一遍（写第二遍就迟早跟主逻辑跑偏）。
     *
     * 行内默认 `$…$`，块级默认换行的 `$$\n…\n$$`；另有 LaTeX 原生写法
     * （行内 `\(…\)`、块级 `\[\n…\n\]`）走同一套逻辑，只是换个定界符。
     * 块级必须独占行，否则渲染层（markdown-it）会把定界符当成行首块来解析。
     */
    const applyFormula = useCallback(
        (kind: "inline" | "block" | "inlineTex" | "blockTex") => {
            const tex = kind === "inlineTex" || kind === "blockTex";
            const [open, close] = tex ? ["\\(", "\\)"] : ["$", "$"];
            if (kind === "inline" || kind === "inlineTex") {
                insertAtCursor(open, close, "公式");
                return;
            }
            // 块级公式**必须独占行**（`$$` / `\[` 单独成行才被认成公式块），所以不能套用
            // insertAtCursor 的「就地包一层」—— 它会在光标处紧凑插入，把定界符粘到
            // 上一行末尾，渲染层看到「摘要$$」这种行首就整块不认，公式人间蒸发。
            const fence = tex ? ["\\[", "\\]"] : ["$$", "$$"];
            const el = textareaRef.current;
            if (!el) return;
            const value = el.value;
            const pos = el.selectionStart ?? value.length;
            const end = el.selectionEnd ?? pos;
            const body = value.slice(pos, end) || "公式";
            // 和「插入表格」同一套做法：整块插到光标所在行**下面**，`$$` 各占一行。
            const lines = value.split("\n");
            const cursorLine = value.slice(0, pos).split("\n").length - 1;
            const insertLine = Math.min(cursorLine + 1, lines.length);
            const head = lines.slice(0, insertLine);
            const tail = lines.slice(insertLine);
            const next = [...head, fence[0], body, fence[1], ...tail].join("\n");
            // 光标落进公式正文（并且选中它，一打字就能换掉「公式」这个占位符）
            const caret = head.join("\n").length + fence[0].length + 1;
            el.value = next;
            el.focus();
            // 光标落在公式正文上并选中它，用户直接打字就能替换「公式」这个占位符
            el.setSelectionRange(caret, Math.min(caret + body.length, next.length));
            setDraft(d => (d ? { ...d, content: next } : d));
        },
        [insertAtCursor]
    );

    const insertLinePrefix = useCallback((prefix: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        // ⚠️ lastIndexOf 的第二个参数不能是 pos，要用 pos - 1，且夹到 0：
        // 第 0 个字符前没有行首，传 -1 会命中字符串前面的 "-" 位置。
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
        const caret = lineStart + prefix.length;
        el.value = next;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /**
     * 在光标所在行**下面**插入一整块（嵌入 / 折叠 / 标签页 / 分隔线都走这条）：
     * 前后补空行，避免被 markdown-it 并进上一段；插入后整块选中，方便直接改占位符。
     */
    const insertBlock = useCallback((block: string) => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const lineEnd = value.indexOf("\n", pos);
        const end = lineEnd < 0 ? value.length : lineEnd;
        const head = value.slice(0, lineStart);
        const tail = value.slice(end);
        // 贴着正文时围栏 / 容器会被并进上一段，所以前后各补一个空行
        const lead = head && !head.endsWith("\n") ? "\n" : "";
        const trail = tail && !tail.startsWith("\n") ? "\n" : "";
        const next = head + lead + block + trail + tail;
        const caret = head.length + lead.length;
        el.value = next;
        el.focus();
        el.setSelectionRange(caret, Math.min(caret + block.length, next.length));
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /** 笔记嵌入 `![[标题]]`（块级，单独成行） */
    const onInsertEmbed = useCallback(() => {
        insertBlock("![[笔记标题]]");
    }, [insertBlock]);

    /** 块引用 `![[标题#^块ID]]`（块级，单独成行） */
    const onInsertBlockRef = useCallback(() => {
        insertBlock("![[笔记标题#^块ID]]");
    }, [insertBlock]);

    /** 给当前行追加一个块 ID（` ^abc12`），供 `![[标题#^块ID]]` 引用 */
    const onInsertBlockId = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const pos = el.selectionStart ?? value.length;
        const lineStart = value.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
        const lineEnd = value.indexOf("\n", pos);
        const end = lineEnd < 0 ? value.length : lineEnd;
        const line = value.slice(lineStart, end);
        // 短随机 id（只要符合 `[A-Za-z][A-Za-z0-9_-]` 即可，eng 风格够用）
        const id = Math.random().toString(36).slice(2, 7);
        const newLine = withBlockId(line, id);
        const next = value.slice(0, lineStart) + newLine + value.slice(end);
        const caret = lineStart + newLine.length;
        el.value = next;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /** 在笔记最前面插入 YAML 属性块（已经有的话就在它前面再插一份：极少见，不特殊处理） */
    const onInsertFrontMatter = useCallback(() => {
        const el = textareaRef.current;
        if (!el) return;
        const value = el.value;
        const entries: FrontMatterEntry[] = [{ key: "tags", value: "", list: [] }];
        const fm = buildFrontMatter(entries);
        const next = fm + (value && !value.startsWith("\n") ? "\n" : "") + value;
        const caret = fm.length;
        el.value = next;
        el.focus();
        el.setSelectionRange(caret, caret);
        setDraft(d => (d ? { ...d, content: next } : d));
    }, []);

    /** 插入标签 `#标签`（行内，和前端 `#标签` 解析规则一致） */
    const onInsertTag = useCallback(() => {
        insertAtCursor("#", "", "标签");
    }, [insertAtCursor]);

    /** 插入双链 `[[标题]]`（行内，可点跳转） */
    const onInsertWikiLink = useCallback(() => {
        insertAtCursor("[[", "]]", "笔记标题");
    }, [insertAtCursor]);

    /** 插入隐藏注释 `%%…%%`（预览不显示） */
    const onInsertHiddenComment = useCallback(() => {
        insertAtCursor("%%", "%%", "隐藏注释");
    }, [insertAtCursor]);

    /** 插入折叠块 `> [!FOLD] 标题` */
    const onInsertFold = useCallback(() => {
        insertBlock(buildFoldSource(""));
    }, [insertBlock]);

    /** 插入标签页容器 `:::tabs … :::` */
    const onInsertTabs = useCallback(() => {
        insertBlock(buildTabSource());
    }, [insertBlock]);

    /** 插入分隔线 `---` */
    const onInsertDivider = useCallback(() => {
        insertBlock("---");
    }, [insertBlock]);

    const charCount = draft ? draft.content.length : 0;
    const pinnedCount = notes.filter(n => Boolean(n.pinned)).length;
    const listPane = (
        <Box
            sx={{
                // 阶段二：折叠后收成 44px 的图标轨（平时是【导航列 + 列表列】两列并排）
                // ⚠️ 两条缝（7px 命中区）也算进总宽，否则拖到最宽时右边界会溢出一点。
                width: listCollapsed ? 44 : { xs: "100%", md: navW + listW + 14 },
                flexShrink: 0,
                // 折叠成 44px 轨道时，任何子元素都不许溢出压到右边的编辑区
                overflow: "hidden",
                borderRight: { md: "1px solid var(--card-border, rgba(0,0,0,0.08))" },
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
                <Box sx={{ display: "flex", justifyContent: "center", pt: 1 }}>
                    <Tooltip title='展开笔记列表'>
                        <IconButton
                            aria-label='展开笔记列表'
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
            <Box
                data-nav-col='1'
                sx={{
                    width: navW,
                    flexShrink: 0,
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    borderRight: "1px solid rgba(128,128,128,0.18)",
                    overflowY: "auto",
                    overflowX: "hidden",
                    py: 1,
                }}
            >
            <Box sx={{ px: 1.5, pb: 1 }}>
                {/* 用 TextField + InputAdornment：之前是自己画的绝对定位图标，
                    那个放大镜飘在框外面右下方，对不齐也很难看。 */}
                <TextField
                    fullWidth
                    size='small'
                    inputRef={searchRef}
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
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
            </Box>

            {/* 左栏视图导航：从「三列网格按钮」改成 inkstone 那种纵向条目 ——
                一个入口一行、名字靠左、条数靠右一行（原来六个按钮占两行、条数塞在名字后面
                挤成一团，而且没有地方放文件夹和标签）。 */}
            <Stack sx={{ px: 0.75, gap: 0.25, pb: 1 }}>
                {(
                    [
                        ["search", "搜索", keyword.trim() ? searchHits.length : viewCounts.all],
                        ["all", "全部", viewCounts.all],
                        ["recent", "最近", viewCounts.recent],
                        ["starred", "收藏", viewCounts.starred],
                        ["uncategorized", "未归类", viewCounts.uncategorized],
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
                }))}
                selectedId={activeFolder}
                onSelect={id => {
                    setActiveFolder(id);
                    setActiveTag(null);
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
                onCreateNote={() => void startCreate()}
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
            {/* 导航列 ↔ 列表列之间的可拖缝。
                ⚠️⚠️ 它必须在导航列这个 Box **外面**：里面是 flex-direction: column，
                放进去会被压成 0 高度、贴到 x=0，真实鼠标根本点不中 ——
                而页内 dispatchEvent 合成事件是直接派发给元素的、不做命中测试，
                所以单测和合成事件探针都会「通过」，真机却拖不动（2026-10-06 踩过）。 */}
            <ColResizeHandle
                label='拖动调整导航列宽度'
                onDrag={startDrag('nav')}
                onReset={reset('nav')}
            />

            {/* ================= 第二列：笔记列表 ================= */}
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
                    py: 1,
                }}
            >
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
                sx={{ flex: 1, overflowY: "auto", minHeight: 0, pb: 1 }}
            >
                {view === "trash" ? (
                    // 阶段三：回收站。条目不能点开编辑（它已经不在 notes 表里了），
                    // 只给「还原」和「彻底删除」两个动作。
                    trashPane
                ) : filtered.length === 0 ? (
                    <Typography variant='body2' color='text.secondary' sx={{ p: 2 }}>
                        {notes.length === 0
                            ? "还没有笔记。点右上角 + 新建一条。"
                            : "没有匹配的笔记。"}
                    </Typography>
                ) : (
                    monthGroups.map(([, group]) => (
                        <Box key={group.label}>
                            {/* 阶段二：月份分组标题（「2026 年 10 月」），和 inkstone 一样 */}
                            <Typography
                                variant='caption'
                                color='text.disabled'
                                data-month={group.label}
                                sx={{ display: "block", px: 2, pt: 1, pb: 0.5, fontSize: 11 }}
                            >
                                {group.label}
                            </Typography>
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
                                draggable={note.id !== undefined}
                                onDragStart={e => {
                                    e.dataTransfer.setData("application/navihive-note", String(note.id));
                                    e.dataTransfer.effectAllowed = "move";
                                    setDraggingNoteId(note.id ?? null);
                                }}
                                onDragEnd={() => setDraggingNoteId(null)}
                                role='button'
                                tabIndex={0}
                                onClick={() => (dirty ? void switchTo(note.id ?? null) : openNote(note))}
                                onKeyDown={e => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        openNote(note);
                                    }
                                }}
                                sx={{
                                    mx: 0.75,
                                    mb: 0.25,
                                    px: 1.25,
                                    py: 0.9,
                                    borderRadius: 1.5,
                                    cursor: "pointer",
                                    borderLeft: "3px solid",
                                    borderLeftColor: isActive ? "var(--accent)" : "transparent",
                                    bgcolor: isActive
                                        ? "rgba(128,128,128,0.12)"
                                        : "transparent",
                                    // 拖起来的那一行半透明：告诉用户「手上抓的是这条」
                                    opacity: draggingNoteId === note.id ? 0.45 : 1,
                                    transition: "background-color 120ms ease, opacity 120ms ease",
                                    // 菜单按钮平时藏起来，hover / 聚焦才出 —— 和 inkstone 一致，
                                    // 128px 的窄列里常驻一个按钮会把标题挤没。
                                    "&:hover .note-row-actions, &:focus-within .note-row-actions": {
                                        opacity: 1,
                                    },
                                    "&:hover": { bgcolor: "rgba(128,128,128,0.08)" },
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
                                        sx={{
                                            fontWeight: isActive ? 600 : 400,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            flex: 1,
                                            minWidth: 0,
                                        }}
                                    >
                                        {note.title || "无标题"}
                                    </Typography>
                                    {/* 行内操作菜单。放在标题行右侧、hover 才现形。 */}
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
                                                menuOpen ? null : { noteId: id, el: e.currentTarget }
                                            );
                                        }}
                                        sx={{
                                            opacity: menuOpen ? 1 : 0,
                                            transition: "opacity 120ms ease",
                                            flexShrink: 0,
                                            p: 0.25,
                                            color: "text.secondary",
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
                                        mt: 0.25,
                                    }}
                                >
                                    {summarize(note.content) || "空白笔记"}
                                </Typography>
                                <Typography
                                    variant='caption'
                                    color='text.disabled'
                                    sx={{ display: "block", mt: 0.25, fontSize: 11 }}
                                    // 阶段四第 13 条：改相对时间（「3分钟前」）。
                                    // 精确时刻挂到 title 上 —— 相对时间省事但不精确，
                                    // hover 一下还是得能看到具体几点几分。
                                    title={formatWhen(note.updated_at || note.created_at)}
                                >
                                    {formatRelative(note.updated_at || note.created_at)}
                                </Typography>
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
                                                    border: "1px solid var(--card-border, rgba(128,128,128,0.35))",
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

            {/* ---------- 列表行的操作菜单 ----------
                以前这些动作（置顶 / 归档 / 归入文件夹 / 标签 / 删除）只挂在**底部状态栏**上，
                也就是「只能对当前打开的那条笔记操作」—— 想给列表里第 8 条打标签，
                得先点开它、找到状态栏、点对按钮。
                inkstone 是每行 hover 出「⋯」，这里照抄：
                  - 菜单按钮 stopPropagation，否则点它会顺带打开这条笔记；
                  - 「归入文件夹 / 标签」这两个二级菜单是**唯一**能把笔记归类进去的入口
                    （后端 setNoteTags / folder_id 早就有了，界面上却没有地方调）。 */}
            <Menu
                open={Boolean(rowMenu)}
                anchorEl={rowMenu?.el ?? null}
                onClose={() => setRowMenu(null)}
            >
                {(() => {
                    const note = rowMenu ? notes.find(n => n.id === rowMenu.noteId) : null;
                    if (!note) return null;
                    const done = async (fn: () => Promise<unknown> | void) => {
                        setRowMenu(null);
                        await fn();
                    };
                    return (
                        <>
                            <MenuItem
                                data-row-op='pin'
                                onClick={() =>
                                    void done(() => onTogglePin(note))
                                }
                            >
                                {note.pinned ? "取消收藏" : "收藏"}
                            </MenuItem>
                            <MenuItem
                                data-row-op='archive'
                                onClick={() => void done(() => onToggleArchive(note))}
                            >
                                {note.archived ? "取消归档" : "归档"}
                            </MenuItem>
                            <MenuItem
                                data-row-op='folder'
                                onClick={() => {
                                    // rowMenu 此刻一定非空（菜单能打开就是它给的锚），
                                    // 但 TS 看不穿这层间接，先取局部变量再窄化。
                                    const pick = rowMenu;
                                    const id = note.id;
                                    setRowMenu(null);
                                    if (pick && id !== undefined) {
                                        setFolderPick({ el: pick.el, noteId: id });
                                    }
                                }}
                            >
                                归入文件夹…
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
                                编辑标签…
                            </MenuItem>
                            <MenuItem
                                data-row-op='export'
                                onClick={() => void done(() => exportOne(note))}
                            >
                                导出 Markdown
                            </MenuItem>
                            <Divider />
                            <MenuItem
                                data-row-op='delete'
                                onClick={() => void done(() => onDelete(note))}
                                sx={{ color: "error.main" }}
                            >
                                删除（进回收站）
                            </MenuItem>
                        </>
                    );
                })()}
            </Menu>

            {/* 归入文件夹：列出全部文件夹 + 「移出文件夹」 */}
            <Menu
                open={Boolean(folderPick)}
                anchorEl={folderPick?.el ?? null}
                onClose={() => setFolderPick(null)}
            >
                <MenuItem
                    data-folder-pick='none'
                    onClick={() => {
                        const pick = folderPick;
                        setFolderPick(null);
                        if (pick) void onUpdate(pick.noteId, { folder_id: null });
                    }}
                >
                    未归类（移出文件夹）
                </MenuItem>
                <Divider />
                {folders.length === 0 && (
                    <MenuItem disabled>还没有文件夹（左栏「文件夹」右边 + 新建）</MenuItem>
                )}
                {folders.map(f => (
                    <MenuItem
                        key={f.id}
                        data-folder-pick={f.id}
                        selected={notes.find(n => n.id === folderPick?.noteId)?.folder_id === f.id}
                        onClick={() => {
                            const pick = folderPick;
                            setFolderPick(null);
                            if (pick && f.id !== undefined) {
                                void onUpdate(pick.noteId, { folder_id: f.id });
                            }
                        }}
                    >
                        {f.name}
                    </MenuItem>
                ))}
            </Menu>

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
        </Box>
    );

    const editorPane = (
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            {view === "trash" ? (
                <Box sx={{ flex: 1, display: "grid", placeItems: "center" }}>
                    <Typography variant='body2' color='text.secondary'>
                        回收站里的笔记不能直接编辑。先「还原」回全部笔记，或者「彻底删除」。
                    </Typography>
                </Box>
            ) : !active ? (
                <Box sx={{ flex: 1, display: "grid", placeItems: "center" }}>
                    <Typography variant='body2' color='text.secondary'>
                        左边选一条笔记，或者新建一条。
                    </Typography>
                </Box>
            ) : (
                <>
                    <TextField
                        fullWidth
                        variant='standard'
                        value={draft?.title ?? ""}
                        onChange={e =>
                            setDraft(d => (d ? { ...d, title: e.target.value } : d))
                        }
                        placeholder='无标题'
                        slotProps={{ input: { "aria-label": "笔记标题" } }}
                        sx={{
                            px: 2,
                            pt: 1.5,
                            flexShrink: 0,
                            "& .MuiInputBase-root": { fontSize: 19, fontWeight: 600 },
                            "& .MuiInput-input": { padding: "6px 0" },
                        }}
                    />

                    {/* 格式工具栏：照 inkstone 那一排。放在标题与内容区之间，
                        点一下在光标处插入语法 —— 省得手打 `**` 和 `- [ ]`。 */}
                    <MarkdownToolbar
                        onInsert={insertAtCursor}
                        onInsertLinePrefix={insertLinePrefix}
                        onCodeLanguage={applyCodeLanguage}
                        onTable={applyTable}
                        onFormula={applyFormula}
                        onFootnoteRef={insertFootnoteRef}
                        onCallout={insertCallout}
                        onInsertEmbed={onInsertEmbed}
                        onInsertBlockRef={onInsertBlockRef}
                        onInsertBlockId={onInsertBlockId}
                        onInsertFrontMatter={onInsertFrontMatter}
                        onInsertTag={onInsertTag}
                        onInsertWikiLink={onInsertWikiLink}
                        onInsertHiddenComment={onInsertHiddenComment}
                        onInsertFold={onInsertFold}
                        onInsertTabs={onInsertTabs}
                        onInsertDivider={onInsertDivider}
                    />

                    {/* 内容区：源码 | 预览 */}
                    <Box
                        ref={splitBoxRef}
                        sx={{
                            flex: 1,
                            display: "flex",
                            minHeight: 0,
                            minWidth: 0,
                            // ⚠️ 这里必须有内边距。编辑区是 `flex:1` 吃掉整条剩余宽度的，
                            // 而记事本这层全屏又铺到 100vw —— 不留边距的话源码 / 预览
                            // 两栏会**贴死视口右边缘**：预览的右边框和滚动条被顶出屏幕，
                            // 看起来就是「右边显示不全」。px:2 与标题 / 工具栏 / 状态栏对齐。
                            px: 2,
                            py: 1,
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
                                    // 之前只有一条右边框、背景透明，源码区与预览区糊成一片空白，
                                    // 看着就像「中间那块没内容」。给源码区一个淡底色 + 完整边框，
                                    // 分栏才看得出是两栏而不是一栏。
                                    border:
                                        pane === "split"
                                            ? "1px solid var(--card-border, rgba(128,128,128,0.45))"
                                            : "none",
                                    borderRadius: pane === "split" ? 1.5 : 0,
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
                                    bgcolor:
                                        pane === "split"
                                            ? "rgba(128,128,128,0.05)"
                                            : "transparent",
                                }}
                            >
                                <NoteEditor
                                    key={active.id}
                                    editorRef={textareaRef}
                                    value={draft?.content ?? ""}
                                    onChange={content => setDraft(d => d ? { ...d, content } : d)}
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
                                    width: 8,
                                    flexShrink: 0,
                                    cursor: "col-resize",
                                    "&:hover": { bgcolor: "rgba(128,128,128,0.18)" },
                                    "&:active": { bgcolor: "rgba(128,128,128,0.3)" },
                                }}
                            />
                        )}
                        {pane !== "edit" && (
                            <Box
                                sx={{
                                    // 与源码区同一个 basis（0），两栏才严格对半
                                    flex: 1,
                                    minWidth: 0,
                                    // ⚠️ minHeight:0 不能少：flex 子项默认 min-height:auto，
                                    // Markdown 一长就把这一层撑高、连带整页出现滚动条
                                    //（该滚的只有预览区内部）。之前只给外层容器加了，
                                    // 子项漏掉 → 症状就是「怎么还有滚动条」。
                                    minHeight: 0,
                                    overflowY: "auto",
                                    p: 2.5,
                                    lineHeight: 1.7,
                                    border:
                                        pane === "split"
                                            ? "1px solid var(--card-border, rgba(128,128,128,0.45))"
                                            : "none",
                                    borderRadius: pane === "split" ? 1.5 : 0,
                                    bgcolor:
                                        pane === "split"
                                            ? "rgba(128,128,128,0.03)"
                                            : "transparent",
                                }}
                            >
                                <Box onDoubleClick={e => {
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
                                    source={draft?.content || ""}
                                    resolveNote={resolveNote}
                                    onOpenNote={handleOpenEmbedNote}
                                /></Box>
                            </Box>
                        )}
                    </Box>

                    {/* 状态栏：像 inkstone 那样把「写了多少」摆在脚下 */}
                    <Box
                        sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 2,
                            px: 2,
                            py: 0.75,
                            flexShrink: 0,
                            borderTop: "1px solid rgba(128,128,128,0.25)",
                            fontSize: 12,
                            color: "text.secondary",
                        }}
                    >
                        <span>{charCount} 字</span>
                        <span>{charCount} 字符</span>
                        <span>约 {Math.max(1, Math.ceil(charCount / 400))} 分钟读完</span>
                        <span>
                            {pane === "edit" ? "编辑" : pane === "preview" ? "预览" : "分栏"}
                        </span>
                        <Box sx={{ flex: 1 }} />
                        {/* 「创建于…」跟在保存状态后面（inkstone 把它放在状态栏右端）：
                            左边一串是「这篇现在多长」，右边是「它是什么时候来的」。
                            解析不出时间就整项不显示 —— 宁可少一项，也别给「Invalid Date」。 */}
                        {active.created_at && formatWhenFull(active.created_at) && (
                            <span data-note-created style={{ marginRight: 0.5 }}>
                                创建于 {formatWhenFull(active.created_at)}
                            </span>
                        )}
                        {/* 阶段四第 14 条：原来只有一句「有未保存的改动」，
                            看不出到底存没存。现在把保存过程摊开：
                            待存 / 正在存 / 已存多久。已存的时刻复用相对时间那条。 */}
                        {saveState === "pending" && <span>有改动，即将保存…</span>}
                        {saveState === "saving" && <span>正在保存…</span>}
                        {saveState === "saved" && !dirty && (
                            <span>已保存 · {formatRelative(savedAt, new Date(tick))}</span>
                        )}
                        <Tooltip title='删除这条笔记（可从回收站还原）'>
                            <IconButton
                                aria-label='删除这条笔记'
                                size='small'
                                color='error'
                                onClick={async () => {
                                    await onDelete(active);
                                    setActiveId(null);
                                    setMobileDetail(false);
                                }}
                            >
                                <DeleteOutlineIcon fontSize='small' />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title='置顶 / 取消置顶'>
                            <IconButton
                                aria-label={active.pinned ? "取消置顶" : "置顶"}
                                size='small'
                                onClick={() => onTogglePin(active)}
                            >
                                <PushPinIcon
                                    fontSize='small'
                                    sx={active.pinned ? { color: "var(--accent)" } : undefined}
                                />
                            </IconButton>
                        </Tooltip>
                        {/* 阶段三：归档。归档只是从「全部」里收起来，笔记还在，随时能取回 */}
                        <Tooltip title={active.archived ? "取消归档" : "归档（从全部里收起来）"}>
                            <IconButton
                                aria-label={active.archived ? "取消归档" : "归档"}
                                size='small'
                                onClick={() => void onToggleArchive(active)}
                            >
                                <ArchiveIcon
                                    fontSize='small'
                                    sx={active.archived ? { color: "var(--accent)" } : undefined}
                                />
                            </IconButton>
                        </Tooltip>
                    </Box>
                </>
            )}
        </Box>
    );

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
                flexDirection: "column",
                bgcolor: "background.default",
            }}
        >
            {shareId !== null && shareApi && <NoteShareDialog key={shareId} id={shareId} api={shareApi} onClose={() => setShareId(null)} />}
            {/* Header */}
            <Box
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1.5,
                    py: 1,
                    borderBottom: "1px solid rgba(128,128,128,0.25)",
                }}
            >
                <IconButton aria-label='返回导航站' onClick={onClose} size='small'>
                    <ArrowBackIcon fontSize='small' />
                </IconButton>
                <Typography variant='h6' component='div' sx={{ fontWeight: 600, flex: 1 }}>
                    记事本
                </Typography>

                {/* 阶段二：左栏折叠（照 inkstone 那个 196↔9 的收起动作）。
                    ⚠️ 这个按钮原来紧挨着「返回导航站」，两个都是无文字的箭头，
                    靠太近必误按（用户报过）→ 挪到右侧这一组里，和视图切换、+ 相邻。 */}
                <Tooltip title={listCollapsed ? "展开笔记列表" : "收起笔记列表"}>
                    <IconButton
                        aria-label={listCollapsed ? "展开笔记列表" : "收起笔记列表"}
                        size='small'
                        onClick={() => setListCollapsed(c => !c)}
                    >
                        {listCollapsed ? (
                            <LastPageIcon fontSize='small' />
                        ) : (
                            <FirstPageIcon fontSize='small' />
                        )}
                    </IconButton>
                </Tooltip>

                {/* 版本历史：inkstone 顶栏第二项。改动前的正文由后端自动留档，
                    这里只负责列出来 + 恢复。历史只有一条时按钮仍可用 ——
                    「只有一版」本身就是要让用户知道的事实。 */}
                <Tooltip title='只读分享'><span><IconButton size='small' data-tool='share' aria-label='只读分享'
                    disabled={!shareApi || !active?.id || active.id <= 0 || view === "trash"}
                    onClick={() => { if (active?.id) setShareId(active.id); }}><ShareIcon fontSize='small' /></IconButton></span></Tooltip>
                <Tooltip title='版本历史'>
                    <IconButton
                        size='small'
                        data-tool='revisions'
                        aria-label='版本历史'
                        disabled={!active || !folderTags?.onListRevisions}
                        onClick={e => void openRevisions(e.currentTarget)}
                        sx={{ width: 28, height: 28, color: "text.secondary" }}
                    >
                        <HistoryIcon fontSize='small' />
                    </IconButton>
                </Tooltip>

                {/* 大纲：inkstone 顶栏有「大纲」，长笔记没有它就只能一路往下滚。
                    点一条就把光标送到那行 —— 跳的是**源码里的行首**，
                    顺便把那一行选中，闭着眼也能看得到落点。 */}
                <Tooltip title='大纲'>
                    <IconButton
                        size='small'
                        data-tool='outline'
                        aria-label='大纲'
                        onClick={e => setOutlineAnchor(e.currentTarget)}
                        sx={{ width: 28, height: 28, color: "text.secondary" }}
                    >
                        <ListIcon fontSize='small' />
                    </IconButton>
                </Tooltip>

                {/* 反向链接：inkstone 顶栏的核心卖点之一。哪些笔记用 [[双链]] 指向了这条。
                    数字直接标在图标角上 —— 有 0 条时按钮就灰着，不必点开才知道。 */}
                <Tooltip
                    title={
                        backlinks.length
                            ? `反向链接（${backlinks.length} 条笔记引用了这里）`
                            : "反向链接（还没有笔记链接到这里）"
                    }
                >
                    <span>
                        <IconButton
                            size='small'
                            data-tool='backlinks'
                            aria-label={`反向链接 ${backlinks.length} 条`}
                            disabled={!active || backlinks.length === 0}
                            onClick={e => setBacklinkAnchor(e.currentTarget)}
                            sx={{ width: 28, height: 28, color: "text.secondary" }}
                        >
                            <LinkIcon fontSize='small' />
                            {backlinks.length > 0 && (
                                <Box
                                    component='span'
                                    aria-hidden
                                    sx={{
                                        position: "absolute",
                                        top: -2,
                                        right: -2,
                                        minWidth: 13,
                                        height: 13,
                                        px: 0.25,
                                        borderRadius: 7,
                                        bgcolor: "primary.main",
                                        color: "primary.contrastText",
                                        fontSize: 9,
                                        lineHeight: "13px",
                                        textAlign: "center",
                                    }}
                                >
                                    {backlinks.length}
                                </Box>
                            )}
                        </IconButton>
                    </span>
                </Tooltip>

                {/* 源码/预览切换：像 inkstone 那样给三档。
                    ⚠️ 原来这里是 `display: { xs: "none", sm: "flex" }` —— 小屏直接**整组藏掉**，
                    手机上用户因此永远拿不到「预览模式」，只能被迫在源码态编辑（连写没写错都看不到）。
                    现在改成**收窄成图标**：三个 28px 的小按钮在 375px 上也放得下，
                    文案换成 aria-label（读屏仍读得到），点得到比看得到更重要。 */}
                <Box sx={{ display: "flex", gap: 0.25, flexShrink: 0 }}>
                    {(
                        [
                            ["edit", "编辑", <EditIcon fontSize='inherit' key='i' />],
                            ["split", "分栏", <VerticalSplitIcon fontSize='inherit' key='s' />],
                            ["preview", "预览", <VisibilityIcon fontSize='inherit' key='v' />],
                        ] as const
                    ).map(([key, label, icon]) => (
                        <IconButton
                            key={key}
                            aria-label={label}
                            title={label}
                            size='small'
                            onClick={() => setPane(key)}
                            sx={{
                                width: 28,
                                height: 28,
                                p: 0,
                                color: pane === key ? "primary.main" : "text.secondary",
                                bgcolor:
                                    pane === key ? "rgba(128,128,128,0.12)" : "transparent",
                                display: { xs: "inline-flex", sm: "none" },
                            }}
                        >
                            {icon}
                        </IconButton>
                    ))}
                    {/* sm 及以上仍用文字按钮：宽屏有地方，文字比图标更省解释 */}
                    {(
                        [
                            ["edit", "编辑"],
                            ["split", "分栏"],
                            ["preview", "预览"],
                        ] as const
                    ).map(([key, label]) => (
                        <IconButton
                            key={`wide-${key}`}
                            aria-label={label}
                            size='small'
                            onClick={() => setPane(key)}
                            sx={{
                                fontSize: 12,
                                px: 1,
                                width: "auto",
                                height: 28,
                                display: { xs: "none", sm: "inline-flex" },
                                borderRadius: 1.5,
                                fontWeight: pane === key ? 600 : 400,
                                color: pane === key ? "primary.main" : "text.secondary",
                                bgcolor:
                                    pane === key ? "rgba(128,128,128,0.12)" : "transparent",
                            }}
                        >
                            {label}
                        </IconButton>
                    ))}
                </Box>
            </Box>

            {/* 大纲面板：当前这条笔记的标题层级。没标题时给一句说明，
                别弹一个空框让人以为功能坏了。 */}
            <Menu
                open={Boolean(outlineAnchor)}
                anchorEl={outlineAnchor}
                onClose={() => setOutlineAnchor(null)}
                slotProps={{ paper: { sx: { maxHeight: 320, overflowY: "auto" } } }}
            >
                {outline.length === 0 ? (
                    <MenuItem disabled data-outline='empty'>
                        这条笔记还没有标题（用 # 标题 就能出现在这里）
                    </MenuItem>
                ) : (
                    outline.map(item => (
                        <MenuItem
                            key={`${item.line}-${item.offset}`}
                            data-outline-item={item.line}
                            onClick={() => {
                                setOutlineAnchor(null);
                                jumpToOffset(item.offset);
                            }}
                            sx={{
                                pl: 1 + outlineIndent(item.level) / 8,
                                fontWeight: item.level <= 2 ? 600 : 400,
                                fontSize: 13,
                                minWidth: 200,
                            }}
                        >
                            <Typography
                                component='span'
                                sx={{
                                    display: "block",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                }}
                            >
                                {item.text}
                            </Typography>
                        </MenuItem>
                    ))
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

            {/* 主体：移动端在「列表 / 编辑」之间切，桌面端左右并排 */}
            <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
                {/* 左栏**不能**加 flex:1 —— 它内部已经用 width:300 定宽了（flexShrink:0）。
                    外层再来一个 flex:1，容器会被 flex 撑到约 445px，而里面的列表只有 300px，
                    剩下的 145px 就是「中间那块空白」。宽度只由内层决定：flex: 0 0 auto。 */}
                <Box
                    sx={{
                        display: { xs: mobileDetail ? "none" : "flex", md: "flex" },
                        flex: "0 0 auto",
                        minWidth: 0,
                        minHeight: 0,
                    }}
                >
                    {listPane}
                </Box>
                {/* 右栏占满剩余空间。minHeight:0 同样要加：缺了它，内部内容会把这层
                    撑高、进而把最外层的 fixed 容器顶出视口 —— 表现就是页面级滚动条。 */}
                <Box
                    sx={{
                        display: { xs: mobileDetail ? "flex" : "none", md: "flex" },
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                    }}
                >
                    {editorPane}
                </Box>
            </Box>

            {/* 移动端从编辑态回列表 */}
            {mobileDetail && (
                <Box sx={{ display: { xs: "flex", md: "none" }, p: 1, borderTop: "1px solid rgba(128,128,128,0.25)" }}>
                    <Button
                        startIcon={<EditIcon />}
                        onClick={() => setMobileDetail(false)}
                        size='small'
                    >
                        回到列表
                    </Button>
                </Box>
            )}

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
}: {
    source: string;
    /** 笔记嵌入 `![[标题]]` 按标题找目标 */
    resolveNote?: (title: string) => NoteEmbedTarget | null;
    /** 点嵌入标题跳到那篇笔记 */
    onOpenNote?: (title: string) => void;
}) {
    const [node, setNode] = useState<ReactNode>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!source) {
            setNode(null);
            return;
        }
        void renderMarkdownToReact(source, { resolveNote, onOpenNote }).then(result => {
            if (cancelled) return;
            setNode(result);
            setReady(true);
        });
        return () => {
            // 输入很快时，旧的解析结果要丢掉，否则会闪回上一版内容
            cancelled = true;
        };
    }, [source, resolveNote, onOpenNote]);

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
    return <Box sx={{ wordBreak: "break-word", lineHeight: 1.7 }}>{node}</Box>;
}

/** 一个工具按钮：icon / label 二选一，before/after 是包在选区两侧的语法 */
/** 阶段四第 12 条：工具栏能发出的表格操作（kind 决定走哪条纯函数） */
type TableOp =
    | { kind: "insert"; rows: number; cols: number }
    | { kind: "addRow" }
    | { kind: "delRow" }
    | { kind: "addCol" }
    | { kind: "delCol" };

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
}

/**
 * 工具栏分组（阶段一）：原来是一长串 15 个文字按钮，换行两排、还占地方。
 * 参照 inkstone 收成「标题 | 强调 | 代码 | 列表 | 插入 | 块」六段，
 * 单行走不完就横向滚动，高度锁 40px。
 */
const TOOL_GROUPS: { name: string; tools: ToolSpec[] }[] = [
    {
        name: "强调",
        tools: [
            {
                key: "bold",
                icon: <FormatBoldIcon fontSize='small' />,
                title: "粗体",
                before: "**",
                after: "**",
                placeholder: "粗体",
            },
            {
                key: "italic",
                icon: <FormatItalicIcon fontSize='small' />,
                title: "斜体",
                before: "*",
                after: "*",
                placeholder: "斜体",
            },
            {
                key: "strike",
                icon: <StrikethroughIcon fontSize='small' />,
                title: "删除线",
                before: "~~",
                after: "~~",
                placeholder: "删除",
            },
            { key: "highlight", label: "==", title: "高亮", before: "==", after: "==", placeholder: "高亮" },
        ],
    },
    {
        name: "代码",
        tools: [
            {
                key: "code",
                icon: <CodeIcon fontSize='small' />,
                title: "行内代码",
                before: "`",
                after: "`",
                placeholder: "code",
            },
            { key: "pre", label: "{ }", title: "代码块", before: "```\n", after: "\n```", placeholder: "代码" },
        ],
    },
    {
        name: "列表",
        tools: [
            {
                key: "ul",
                icon: <ListIcon fontSize='small' />,
                title: "无序列表",
                before: "- ",
                placeholder: "列表项",
            },
            { key: "ol", label: "1.", title: "有序列表", before: "1. ", placeholder: "列表项" },
            {
                key: "task",
                icon: <ChecklistIcon fontSize='small' />,
                title: "待办项",
                before: "- [ ] ",
                placeholder: "要做的事",
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

/** 标题层级下拉（H1/H2/H3）—— 标题是「行首加前缀」，走另一条路径 */
const HEADING_LEVELS: { level: string; label: string; prefix: string }[] = [
    { level: "1", label: "H1 一级标题", prefix: "# " },
    { level: "2", label: "H2 二级标题", prefix: "## " },
    { level: "3", label: "H3 三级标题", prefix: "### " },
];

/**
 * Markdown 格式工具栏。
 *
 * 只在「源码」可见时出现 —— 预览模式下没有可编辑的文本，工具栏会让人以为能改。
 * 按钮用 `onMouseDown` 的 preventDefault 保住 textarea 的选区：
 * 默认的 mousedown 会让输入框失焦，selectionStart 就变成了 0，
 * 插入的位置会全跑到开头去。
 */
function MarkdownToolbar({
    onInsert,
    onInsertLinePrefix,
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
    onInsertFold,
    onInsertTabs,
    onInsertDivider,
}: {
    onInsert: (before: string, after: string, placeholder: string) => void;
    onInsertLinePrefix: (prefix: string) => void;
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
}) {
    const [headingAnchor, setHeadingAnchor] = useState<HTMLElement | null>(null);
    const [linkAnchor, setLinkAnchor] = useState<HTMLElement | null>(null);
    const [imageAnchor, setImageAnchor] = useState<HTMLElement | null>(null);
    const [insertAnchor, setInsertAnchor] = useState<HTMLElement | null>(null);
    const [blockAnchor, setBlockAnchor] = useState<HTMLElement | null>(null);
    const [langAnchor, setLangAnchor] = useState<HTMLElement | null>(null);
    const [tableAnchor, setTableAnchor] = useState<HTMLElement | null>(null);
    const [calloutAnchor, setCalloutAnchor] = useState<HTMLElement | null>(null);
    const [formulaAnchor, setFormulaAnchor] = useState<HTMLElement | null>(null);

    return (
        <Box
            role='toolbar'
            aria-label='Markdown 格式'
            sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                px: 1.5,
                height: 40,
                flexShrink: 0,
                overflowX: "auto",
                borderBottom: "1px solid var(--card-border, rgba(128,128,128,0.18))",
            }}
        >
            {/* 标题层级：从两个 H1/H2 文字按钮收成一个下拉 */}
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
                    fontSize: 13,
                    lineHeight: 1,
                    color: "text.secondary",
                    "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                }}
            >
                标题
            </Button>
            <Menu
                open={Boolean(headingAnchor)}
                anchorEl={headingAnchor}
                onClose={() => setHeadingAnchor(null)}
            >
                {HEADING_LEVELS.map(h => (
                    <MenuItem
                        key={h.level}
                        data-heading={h.level}
                        onClick={() => {
                            onInsertLinePrefix(h.prefix);
                            setHeadingAnchor(null);
                        }}
                    >
                        {h.label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 链接下拉（inkstone 式）：链接 / 双链 / 笔记嵌入 / 块引用 四种。
                data-tool='link' 仍挂在触发器上，老的用例按它找按钮不丢。 */}
            <Tooltip title='链接'>
                <IconButton
                    size='small'
                    aria-label='链接'
                    data-tool='link'
                    aria-haspopup='menu'
                    aria-expanded={linkAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setLinkAnchor(e.currentTarget)}
                    sx={{ width: 28, height: 28, color: "text.secondary", flexShrink: 0 }}
                >
                    <LinkIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(linkAnchor)}
                anchorEl={linkAnchor}
                onClose={() => setLinkAnchor(null)}
            >
                <MenuItem
                    data-link-op='external'
                    onClick={() => {
                        onInsert("[", "](https://)", "链接文字");
                        setLinkAnchor(null);
                    }}
                >
                    链接（网页地址）
                </MenuItem>
                <MenuItem
                    data-link-op='wikilink'
                    onClick={() => {
                        onInsertWikiLink();
                        setLinkAnchor(null);
                    }}
                >
                    双链 [[笔记]]
                </MenuItem>
                <MenuItem
                    data-link-op='embed'
                    onClick={() => {
                        onInsertEmbed();
                        setLinkAnchor(null);
                    }}
                >
                    笔记嵌入 ![[笔记]]
                </MenuItem>
                <MenuItem
                    data-link-op='blockref'
                    onClick={() => {
                        onInsertBlockRef();
                        setLinkAnchor(null);
                    }}
                >
                    块引用 ![[笔记#^块ID]]
                </MenuItem>
            </Menu>

            {/* 图片下拉：目前只开放「网络图片」（粘贴链接），上传未做 */}
            <Tooltip title='图片'>
                <IconButton
                    size='small'
                    aria-label='图片'
                    data-tool='image'
                    aria-haspopup='menu'
                    aria-expanded={imageAnchor ? true : undefined}
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setImageAnchor(e.currentTarget)}
                    sx={{ width: 28, height: 28, color: "text.secondary", flexShrink: 0 }}
                >
                    <ImageIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(imageAnchor)}
                anchorEl={imageAnchor}
                onClose={() => setImageAnchor(null)}
            >
                <MenuItem
                    data-image-op='url'
                    onClick={() => {
                        onInsert("![", "](https://)", "图片说明");
                        setImageAnchor(null);
                    }}
                >
                    网络图片（粘贴链接）
                </MenuItem>
                <MenuItem disabled data-image-op='upload'>
                    上传图片（暂未开放）
                </MenuItem>
            </Menu>

            {/* 「链接与引用」：把选中的文字变成脚注引用。单独放（不在链接下拉里），
                因为它要同时改两处（文末定义 + 正文引用），和链接下拉的「包一层」不是一回事。
                测试用例直接按 data-tool='footnote-ref' 点它，不能挪进下拉。 */}
            <Tooltip title='链接与引用（把选中的文字变成脚注引用）'>
                <IconButton
                    size='small'
                    data-tool='footnote-ref'
                    aria-label='链接与引用'
                    onMouseDown={e => e.preventDefault()}
                    onClick={onFootnoteRef}
                    sx={{ width: 28, height: 28, color: "text.secondary", flexShrink: 0 }}
                >
                    <LinkIcon fontSize='small' />
                </IconButton>
            </Tooltip>

            <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />

            {/* 插入下拉：把「高级插入」收进来（块 ID / 属性 / 隐藏注释 / 标签），
                和 inkstone 的「插入」一组对齐。 */}
            <Button
                size='small'
                aria-label='插入'
                aria-haspopup='menu'
                aria-expanded={insertAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setInsertAnchor(e.currentTarget)}
                sx={{
                    width: 40,
                    height: 28,
                    minWidth: 0,
                    p: 0,
                    fontSize: 13,
                    lineHeight: 1,
                    color: "text.secondary",
                    "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                }}
            >
                插入
            </Button>
            <Menu
                open={Boolean(insertAnchor)}
                anchorEl={insertAnchor}
                onClose={() => setInsertAnchor(null)}
            >
                <MenuItem
                    data-insert-op='blockid'
                    onClick={() => {
                        onInsertBlockId();
                        setInsertAnchor(null);
                    }}
                >
                    块 ID（^标识，供引用）
                </MenuItem>
                <MenuItem
                    data-insert-op='frontmatter'
                    onClick={() => {
                        onInsertFrontMatter();
                        setInsertAnchor(null);
                    }}
                >
                    笔记属性（YAML）
                </MenuItem>
                <MenuItem
                    data-insert-op='hidden'
                    onClick={() => {
                        onInsertHiddenComment();
                        setInsertAnchor(null);
                    }}
                >
                    隐藏注释（预览不显示）
                </MenuItem>
                <MenuItem
                    data-insert-op='tag'
                    onClick={() => {
                        onInsertTag();
                        setInsertAnchor(null);
                    }}
                >
                    标签 #标签
                </MenuItem>
            </Menu>

            {/* 块下拉：折叠 / 标签页 / 分隔线（inkstone 的「块」一组） */}
            <Button
                size='small'
                aria-label='块'
                aria-haspopup='menu'
                aria-expanded={blockAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setBlockAnchor(e.currentTarget)}
                sx={{
                    width: 32,
                    height: 28,
                    minWidth: 0,
                    p: 0,
                    fontSize: 13,
                    lineHeight: 1,
                    color: "text.secondary",
                    "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                }}
            >
                块
            </Button>
            <Menu
                open={Boolean(blockAnchor)}
                anchorEl={blockAnchor}
                onClose={() => setBlockAnchor(null)}
            >
                <MenuItem
                    data-block-op='fold'
                    onClick={() => {
                        onInsertFold();
                        setBlockAnchor(null);
                    }}
                >
                    折叠内容（{">"} [!FOLD]）
                </MenuItem>
                <MenuItem
                    data-block-op='tabs'
                    onClick={() => {
                        onInsertTabs();
                        setBlockAnchor(null);
                    }}
                >
                    标签页（:::tabs）
                </MenuItem>
                <MenuItem
                    data-block-op='divider'
                    onClick={() => {
                        onInsertDivider();
                        setBlockAnchor(null);
                    }}
                >
                    分隔线（---）
                </MenuItem>
            </Menu>

            <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />

            {/* 内容块（提示 / 技巧 / 重要 / 警告 / 引用） */}
            <Tooltip title='内容块（提示 / 技巧 / 重要 / 警告 / 引用）'>
                <IconButton
                    size='small'
                    data-tool='callout'
                    aria-label='内容块'
                    aria-haspopup='menu'
                    onMouseDown={e => e.preventDefault()}
                    onClick={e => setCalloutAnchor(e.currentTarget)}
                    sx={{ width: 28, height: 28, color: "text.secondary", flexShrink: 0 }}
                >
                    <InfoOutlinedIcon fontSize='small' />
                </IconButton>
            </Tooltip>
            <Menu
                open={Boolean(calloutAnchor)}
                anchorEl={calloutAnchor}
                onClose={() => setCalloutAnchor(null)}
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
                        data-callout-type={type}
                        onClick={() => {
                            setCalloutAnchor(null);
                            onCallout(type);
                        }}
                    >
                        {label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 引用：行首 `> ` 前缀（独立图标按钮，data-tool='quote' 测试要用） */}
            <Tooltip title='引用'>
                <IconButton
                    size='small'
                    data-tool='quote'
                    aria-label='引用'
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => onInsertLinePrefix("> ")}
                    sx={{ width: 28, height: 28, color: "text.secondary", flexShrink: 0 }}
                >
                    <FormatQuoteIcon fontSize='small' />
                </IconButton>
            </Tooltip>

            {/* 阶段四第 12 条：代码块语言 */}
            <Button
                size='small'
                aria-label='代码块语言'
                aria-haspopup='menu'
                aria-expanded={langAnchor ? true : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={e => setLangAnchor(e.currentTarget)}
                sx={{
                    width: 28,
                    height: 28,
                    minWidth: 0,
                    p: 0,
                    fontSize: 13,
                    lineHeight: 1,
                    color: "text.secondary",
                    "&:hover": { bgcolor: "rgba(128,128,128,0.14)", color: "text.primary" },
                }}
            >
                语言
            </Button>
            <Menu
                open={Boolean(langAnchor)}
                anchorEl={langAnchor}
                onClose={() => setLangAnchor(null)}
            >
                {CODE_LANGUAGES.map(item => (
                    <MenuItem
                        key={item.label}
                        data-code-lang={item.value || "plain"}
                        onClick={() => {
                            onCodeLanguage(item.value);
                            setLangAnchor(null);
                        }}
                    >
                        {item.label}
                    </MenuItem>
                ))}
            </Menu>

            {/* 公式下拉 */}
            <Tooltip title='插入公式'>
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
                <MenuItem
                    data-formula-op='inline'
                    onClick={() => {
                        onFormula("inline");
                        setFormulaAnchor(null);
                    }}
                >
                    行内公式 $ 文本 $
                </MenuItem>
                <MenuItem
                    data-formula-op='block'
                    onClick={() => {
                        onFormula("block");
                        setFormulaAnchor(null);
                    }}
                >
                    独立公式 $$ 另起一段 $$
                </MenuItem>
                <MenuItem
                    data-formula-op='inlineTex'
                    onClick={() => {
                        onFormula("inlineTex");
                        setFormulaAnchor(null);
                    }}
                >
                    行内公式 \( 文本 \)
                </MenuItem>
                <MenuItem
                    data-formula-op='blockTex'
                    onClick={() => {
                        onFormula("blockTex");
                        setFormulaAnchor(null);
                    }}
                >
                    独立公式 \[ 另起一段 \]
                </MenuItem>
            </Menu>

            {/* 表格下拉 */}
            <Tooltip title='插入表格 / 增删行列'>
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

            <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />

            {TOOL_GROUPS.map((group, gi) => (
                <Fragment key={group.name}>
                    {gi > 0 && (
                        <Divider orientation='vertical' flexItem sx={{ mx: 0.25, my: 0.5 }} />
                    )}
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
                        {group.tools.map(tool => (
                            <Tooltip key={tool.key} title={tool.title}>
                                <IconButton
                                    size='small'
                                    onMouseDown={e => e.preventDefault()}
                                    onClick={() =>
                                        onInsert(tool.before, tool.after ?? "", tool.placeholder ?? "")
                                    }
                                    data-tool={tool.key}
                                    aria-label={tool.title}
                                    sx={{
                                        width: 28,
                                        height: 28,
                                        color: "text.secondary",
                                        "&:hover": {
                                            bgcolor: "rgba(128,128,128,0.14)",
                                            color: "text.primary",
                                        },
                                    }}
                                >
                                    {tool.icon ?? tool.label}
                                </IconButton>
                            </Tooltip>
                        ))}
                    </Box>
                </Fragment>
            ))}
        </Box>
    );
}
