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
import ArchiveIcon from "@mui/icons-material/Archive";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChecklistIcon from "@mui/icons-material/Checklist";
import CodeIcon from "@mui/icons-material/Code";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import EditIcon from "@mui/icons-material/Edit";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import ImageIcon from "@mui/icons-material/Image";
import LastPageIcon from "@mui/icons-material/LastPage";
import LinkIcon from "@mui/icons-material/Link";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import SearchIcon from "@mui/icons-material/Search";
import StrikethroughIcon from "@mui/icons-material/StrikethroughS";
import TableRowsIcon from "@mui/icons-material/TableRows";
import UndoIcon from "@mui/icons-material/Undo";
import type { Note, NoteFolder, NoteTag } from "../API/http";
import type { TrashedNote } from "../hooks/useNotes";
import { renderMarkdownToReact } from "../utils/markdownToReact";
import { useScrollLock } from "../hooks/useScrollLock";
// 笔记时间统一走这里：SQLite 的 UTC 无时区串必须按 UTC 解释，
// 直接 `new Date(iso)` 在东八区会差 8 小时（「笔记时间不对」的根因）。
import { formatWhen, monthLabel } from "../utils/noteTime";

export interface NotesPageProps {
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
        onCreateFolder: (name: string) => Promise<NoteFolder | null>;
        onRenameFolder: (id: number, name: string) => Promise<void>;
        onRemoveFolder: (id: number) => Promise<void>;
        onCreateTag: (name: string) => Promise<NoteTag | null>;
        onRenameTag: (id: number, name: string) => Promise<void>;
        onRemoveTag: (id: number) => Promise<void>;
        // 返回值故意留成 `Promise<NoteTag[] | null>` 而不是 `Promise<void>`：
        // `Promise<T>` 不能赋给 `Promise<void>`（void 的那条宽松规则只在函数返回类型上生效，
        // 套一层 Promise 就不认了），写 void 会让调用方的实现没法返回查到的最新清单。
        onAssignTags: (noteId: number, tagIds: number[]) => Promise<NoteTag[] | null>;
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
type NoteView = "all" | "recent" | "starred" | "archived" | "uncategorized" | "trash";

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
function FolderTagSection({
    title,
    items,
    selectedId,
    onSelect,
    onCreate,
    onRename,
    onRemove,
}: {
    title: string;
    items: { id: number; name: string; count: number }[];
    selectedId: number | null;
    onSelect: (id: number | null) => void;
    onCreate: () => void;
    onRename: (id: number, name: string) => void;
    onRemove: (id: number) => void;
}) {
    const [menuId, setMenuId] = useState<number | null>(null);
    const anchorRef = useRef<HTMLSpanElement | null>(null);
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
            </Box>
            {items.map(item => (
                <Box key={item.id} sx={{ position: "relative" }}>
                    <NavRow
                        label={item.name}
                        count={item.count}
                        selected={selectedId === item.id}
                        // 给一个稳定的测试抓手：文件夹视图的筛选用例和未来的 e2e 都靠它定位，
                        // 别去按文字找（名字是用户自己起的，随时会变）
                        data-folder-id={item.id}
                        onClick={() => onSelect(selectedId === item.id ? null : item.id)}
                    />
                    <IconButton
                        size='small'
                        aria-label={`${item.name} 操作`}
                        onClick={() => {
                            setMenuId(item.id);
                            anchorRef.current = null;
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
                anchorEl={undefined}
                onClose={() => setMenuId(null)}
                slotProps={{ paper: { sx: { minWidth: 140 } } }}
            >
                <MenuItem
                    onClick={() => {
                        const item = items.find(i => i.id === menuId);
                        setMenuId(null);
                        const name = globalThis.prompt?.("重命名" + title, item?.name ?? "");
                        if (name && item) onRename(item.id, name.trim());
                    }}
                >
                    重命名
                </MenuItem>
                <MenuItem
                    onClick={() => {
                        const id = menuId;
                        setMenuId(null);
                        if (id !== null && globalThis.confirm?.("确定删除？")) onRemove(id);
                    }}
                >
                    删除
                </MenuItem>
            </Menu>
        </Box>
    );
}

/** 分栏比例的持久化键。按账号分桶：换账号后各用各的宽度习惯。 */
const SPLIT_KEY = "notes.splitRatio";
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

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
    folderTags,
}: NotesPageProps) {
    const [keyword, setKeyword] = useState("");
    /** 左栏视图：全部 / 最近 / 收藏（回收站要软删字段，留到阶段三） */
    const [view, setView] = useState<NoteView>("all");
    /** 阶段三收尾：导航列里选中的文件夹 / 标签（选中任一个就只看那一份） */
    const [activeFolder, setActiveFolder] = useState<number | null>(null);
    const [activeTag, setActiveTag] = useState<number | null>(null);
    /** 新建文件夹/标签的临时名（写进 prompt 前的占位，避免空名直接建） */
    const promptCreate = useCallback(
        async (kind: "folder" | "tag") => {
            const fallback = kind === "folder" ? "新建文件夹" : "新建标签";
            const name = globalThis.prompt?.(`${fallback}名字`, fallback)?.trim();
            if (!name) return;
            if (kind === "folder") await createFolder(name);
            else await createTag(name);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [folderTags]
    );
    /** 阶段二：左栏可折叠（照 inkstone 的 196↔9，我们这边是 300↔44 的图标轨） */
    const [listCollapsed, setListCollapsed] = useState(false);
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    const [pane, setPane] = useState<Pane>("split");
    /** 分栏比例（源码 : 预览）。可拖拽，记住上一次。 */
    const [splitRatio, setSplitRatio] = useState(readSplitRatio);
    const splitBoxRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    /** 草稿：编辑期间不立刻写库（点「保存」或切走才提交） */
    const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
    const [mobileDetail, setMobileDetail] = useState(false);

    // ⚠️ 这一行不能省。记事本自己是 `position: fixed` 的全屏层，压根不占文档流，
    // 但**底下的导航站主界面还挂载着**（卡片网格一两千像素高），document照样能滚。
    // 于是「记事本页面里」右侧有一条整页滚动条，拖它页面会动，看着像坏了。
    // 关掉记事本（组件卸载）时 hook 会自动把样式还原回去。
    useScrollLock(true);

    /** 阶段二：搜索框的 ⌘K 快捷键 */
    const searchRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
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

    const filtered = useMemo(() => {
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
            // 「未归类」= 没挂在任何站点上的笔记（site_id 为空），不是新加的字段
            return matched.filter(n => n.site_id === null || n.site_id === undefined);
        }
        return matched;
    }, [notes, keyword, view, activeFolder, activeTag, noteTags]);

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
                            <Typography variant='caption' color='text.disabled' sx={{ fontSize: 11 }}>
                                {/* deletedAt 是毫秒时间戳，同样要走统一的解析入口 */}
                                {formatWhen(item.deletedAt)}
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
                n => !n.archived && (n.site_id === null || n.site_id === undefined)
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
        async (name: string) => {
            const created = await folderTags?.onCreateFolder(name);
            if (created?.id !== undefined) setActiveFolder(created.id);
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

    const dirty =
        !!active &&
        !!draft &&
        (draft.title !== (active.title || "") || draft.content !== (active.content || ""));

    const save = useCallback(async () => {
        if (!active?.id || !draft) return;
        await onUpdate(active.id, { title: draft.title, content: draft.content });
    }, [active, draft, onUpdate]);

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
            setSplitRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.userSelect = "";
            try {
                localStorage.setItem(SPLIT_KEY, String(readSplitRatio()));
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
     * 行首插入前缀（标题 `# `、引用 `> `、列表 `- `）。
     * 和 insertAtCursor 走两条路：标题必须落在**当前行开头**，不能插在光标中间 ——
     * 否则光标在段落中间点「H1」，得到的不是标题而是半句被 `#` 劈开的话。
     */
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

    const charCount = draft ? draft.content.length : 0;
    const pinnedCount = notes.filter(n => Boolean(n.pinned)).length;
    const listPane = (
        <Box
            sx={{
                // 阶段二：折叠后收成 44px 的图标轨（平时是【导航列 + 列表列】两列并排）
                width: listCollapsed ? 44 : { xs: "100%", md: NAV_COL_W + LIST_COL_W },
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
                    width: NAV_COL_W,
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
                    count: folderCounts.get(f.id!) ?? 0,
                }))}
                selectedId={activeFolder}
                onSelect={id => {
                    setActiveFolder(id);
                    setActiveTag(null);
                    if (id === null) setView("all");
                }}
                onCreate={() => promptCreate("folder")}
                onRename={(id, name) => void renameFolder(id, name)}
                onRemove={id => void removeFolder(id)}
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
                onCreate={() => promptCreate("tag")}
                onRename={(id, name) => void renameTag(id, name)}
                onRemove={id => void removeTag(id)}
            />

            </Box>
            {/* ================= 第二列：笔记列表 ================= */}
            <Box
                data-list-col='1'
                sx={{
                    width: LIST_COL_W,
                    flex: 1,
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
                    共 {filtered.length} 条
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
                        return (
                            <Box
                                key={note.id}
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
                                    transition: "background-color 120ms ease",
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
                                        }}
                                    >
                                        {note.title || "无标题"}
                                    </Typography>
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
                                >
                                    {formatWhen(note.updated_at || note.created_at)}
                                </Typography>
                            </Box>
                        );
                    })}
                        </Box>
                    ))
                )}
            </Box>
            </Box>
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
                    <MarkdownToolbar onInsert={insertAtCursor} onInsertLinePrefix={insertLinePrefix} />

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
                                component='textarea'
                                ref={textareaRef}
                                value={draft?.content ?? ""}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                    setDraft(d => (d ? { ...d, content: e.target.value } : d))
                                }
                                placeholder={'支持 Markdown：\n# 标题\n- 列表\n- [ ] 待办\n> 引用\n**粗体**'}
                                aria-label='笔记内容'
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
                                    p: 2.5,
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
                            />
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
                                <MarkdownPreview source={draft?.content || ""} />
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
                        {dirty && <span>有未保存的改动</span>}
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

                {/* 源码/预览切换：像 inkstone 那样给三档 */}
                <Box sx={{ display: { xs: "none", sm: "flex" }, gap: 0.5 }}>
                    {(
                        [
                            ["edit", "编辑"],
                            ["split", "分栏"],
                            ["preview", "预览"],
                        ] as const
                    ).map(([key, label]) => (
                        <IconButton
                            key={key}
                            aria-label={label}
                            size='small'
                            onClick={() => setPane(key)}
                            sx={{
                                fontSize: 12,
                                px: 1,
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
                <Tooltip title='新建笔记'>
                    <IconButton aria-label='新建笔记' size='small' onClick={startCreate}>
                        <AddIcon fontSize='small' />
                    </IconButton>
                </Tooltip>
            </Box>

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
        </Box>
    );
}

/**
 * Markdown 预览。
 *
 * 渲染是**异步**的：markdown-it 走动态 import（必须 lazy，否则进首屏）。
 * 所以先渲染一个占位，解析完再替换 —— 免得每次输入都闪一下。
 */
function MarkdownPreview({ source }: { source: string }) {
    const [node, setNode] = useState<ReactNode>(null);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let cancelled = false;
        if (!source) {
            setNode(null);
            return;
        }
        void renderMarkdownToReact(source).then(result => {
            if (cancelled) return;
            setNode(result);
            setReady(true);
        });
        return () => {
            // 输入很快时，旧的解析结果要丢掉，否则会闪回上一版内容
            cancelled = true;
        };
    }, [source]);

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
    {
        name: "插入",
        tools: [
            {
                key: "link",
                icon: <LinkIcon fontSize='small' />,
                title: "链接",
                before: "[",
                after: "](https://)",
                placeholder: "链接文字",
            },
            {
                key: "image",
                icon: <ImageIcon fontSize='small' />,
                title: "图片",
                before: "![",
                after: "](https://)",
                placeholder: "图片说明",
            },
        ],
    },
    {
        name: "块",
        tools: [
            {
                key: "quote",
                icon: <FormatQuoteIcon fontSize='small' />,
                title: "引用",
                before: "> ",
                placeholder: "引用",
            },
            {
                key: "table",
                icon: <TableRowsIcon fontSize='small' />,
                title: "表格",
                before: "| 列1 | 列2 |\n|---|---|\n| ",
                after: " | |",
                placeholder: "内容",
            },
        ],
    },
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
}: {
    onInsert: (before: string, after: string, placeholder: string) => void;
    onInsertLinePrefix: (prefix: string) => void;
}) {
    const [headingAnchor, setHeadingAnchor] = useState<HTMLElement | null>(null);

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
                    // ⚠️ 必须和旁边那些图标按钮**一样大**（28×28）、字号也对齐：
                    // 之前是个「按钮」，自带 padding + 18px 字，比图标高一截也宽一截，
                    // 用户一眼就看出「标题按键和其他大小不一样」。
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
                                    // 关键：阻止默认行为，输入框才不会失焦、选区才不会丢
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
