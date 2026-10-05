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
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChecklistIcon from "@mui/icons-material/Checklist";
import CodeIcon from "@mui/icons-material/Code";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import ImageIcon from "@mui/icons-material/Image";
import LinkIcon from "@mui/icons-material/Link";
import ListIcon from "@mui/icons-material/List";
import PushPinIcon from "@mui/icons-material/PushPin";
import SearchIcon from "@mui/icons-material/Search";
import StrikethroughIcon from "@mui/icons-material/StrikethroughS";
import TableRowsIcon from "@mui/icons-material/TableRows";
import type { Note } from "../API/http";
import { renderMarkdownToReact } from "../utils/markdownToReact";
import { useScrollLock } from "../hooks/useScrollLock";

export interface NotesPageProps {
    notes: Note[];
    onClose: () => void;
    onCreate: (draft?: Partial<Note>) => Promise<Note | null>;
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void>;
    onDelete: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
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

/** 列表里的时间：今天只给时刻，更早给日期（inkstone 同款） */
function formatWhen(iso?: string): string {
    if (!iso) return "";
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return "";
    const now = new Date();
    const sameDay =
        t.getFullYear() === now.getFullYear() &&
        t.getMonth() === now.getMonth() &&
        t.getDate() === now.getDate();
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}`;
    return `${t.getMonth() + 1}月${t.getDate()}日`;
}

/** 把编辑区拆成「源码 | 预览」两栏 */
type Pane = "edit" | "split" | "preview";

/** 左栏视图 */
type NoteView = "all" | "recent" | "starred";

/**
 * 编辑区里那条「能看见的滚动条」。
 *
 * 之前预览区用的是浏览器默认滚动条，Windows 11 默认 overlay —— 不动鼠标时不显示，
 * 用户就以为「预览窗没滚轮 / 内容显示不全」。统一给这两栏定一条 10px 的常显滚动条，
 * inkstone 也是这个调子（细瘦、灰、hover 加深）。
 */
const SCROLLBAR_SX = {
    scrollbarWidth: "thin",
    "&::-webkit-scrollbar": { width: 10, height: 10 },
    "&::-webkit-scrollbar-track": { background: "transparent" },
    "&::-webkit-scrollbar-thumb": {
        bgcolor: "rgba(128,128,128,0.35)",
        borderRadius: 5,
        border: "2px solid transparent",
        backgroundClip: "content-box",
        "&:hover": { bgcolor: "rgba(128,128,128,0.55)" },
    },
} as const;

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
}: NotesPageProps) {
    const [keyword, setKeyword] = useState("");
    /** 左栏视图：全部 / 最近 / 收藏（回收站要软删字段，留到阶段三） */
    const [view, setView] = useState<NoteView>("all");
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

    const active = useMemo(
        () => notes.find(n => n.id === activeId) || null,
        [notes, activeId]
    );

    // 选中的笔记变了就把草稿换成它的内容（没在编辑时才换，避免打字被冲掉）
    useEffect(() => {
        if (active) setDraft({ title: active.title || "", content: active.content || "" });
    }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        const byView = notes.filter(n => {
            if (view === "starred") return Boolean(n.pinned);
            if (view === "recent") {
                // 最近：按更新时间倒序（置顶的在列表里永远排前面，取前 10 条）
                return true;
            }
            return true;
        });
        const bySort = view === "recent"
            ? [...byView].sort((a, b) =>
                  (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                  String(b.updated_at || b.created_at || "").localeCompare(
                      String(a.updated_at || a.created_at || "")
                  )
              )
            : byView;
        const kw = keyword.trim().toLowerCase();
        if (!kw) return bySort;
        return bySort.filter(
            n =>
                (n.title || "").toLowerCase().includes(kw) ||
                (n.content || "").toLowerCase().includes(kw)
        );
    }, [notes, keyword, view]);

    /** 左栏导航上挂的三个数 */
    const viewCounts = useMemo(
        () => ({
            all: notes.length,
            recent: notes.length,
            starred: notes.filter(n => Boolean(n.pinned)).length,
        }),
        [notes]
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
        const onMove = (ev: MouseEvent) => {
            const ratio = (ev.clientX - rect.left) / rect.width;
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
            writeBack(
                next,
                Math.min(next.length, start + before.length + selected.length + after.length)
            );
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
                width: { xs: "100%", md: 300 },
                flexShrink: 0,
                borderRight: { md: "1px solid var(--card-border, rgba(0,0,0,0.08))" },
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
            }}
        >
            <Box sx={{ p: 1.5, pb: 1 }}>
                {/* 用 TextField + InputAdornment：之前是自己画的绝对定位图标，
                    那个放大镜飘在框外面右下方，对不齐也很难看。 */}
                <TextField
                    fullWidth
                    size='small'
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
                        },
                    }}
                />
            </Box>

            {/* 左栏视图导航：像 inkstone 那样，列表顶部先有几个「入口」再是条目 */}
            <Box sx={{ display: "flex", gap: 0.5, px: 1.5, pb: 1, flexShrink: 0 }}>
                {(
                    [
                        ["all", "全部", viewCounts.all],
                        ["recent", "最近", viewCounts.recent],
                        ["starred", "收藏", viewCounts.starred],
                    ] as const
                ).map(([key, label, count]) => (
                    <Button
                        key={key}
                        size='small'
                        aria-pressed={view === key}
                        data-view={key}
                        onClick={() => setView(key)}
                        sx={{
                            flex: 1,
                            minWidth: 0,
                            py: 0.25,
                            fontSize: 12,
                            fontWeight: view === key ? 600 : 400,
                            color: view === key ? "primary.main" : "text.secondary",
                            bgcolor: view === key ? "rgba(128,128,128,0.12)" : "transparent",
                            "&:hover": { bgcolor: "rgba(128,128,128,0.1)" },
                        }}
                    >
                        {label}
                        {count > 0 ? ` ${count}` : ""}
                    </Button>
                ))}
            </Box>

            {notes.length > 0 && (
                <Typography
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
                sx={{ flex: 1, overflowY: "auto", minHeight: 0, pb: 1, ...SCROLLBAR_SX }}
            >
                {filtered.length === 0 ? (
                    <Typography variant='body2' color='text.secondary' sx={{ p: 2 }}>
                        {notes.length === 0
                            ? "还没有笔记。点右上角 + 新建一条。"
                            : "没有匹配的笔记。"}
                    </Typography>
                ) : (
                    filtered.map(note => {
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
                    })
                )}
            </Box>
        </Box>
    );

    const editorPane = (
        <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
            {!active ? (
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
                        sx={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}
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
                                            ? "1px solid var(--card-border, rgba(128,128,128,0.25))"
                                            : "none",
                                    borderRadius: pane === "split" ? 1.5 : 0,
                                    outline: "none",
                                    resize: "none",
                                    // 常显滚动条：默认 overlay 会让人以为「预览窗没滚轮」
                                    ...SCROLLBAR_SX,
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
                                    ...SCROLLBAR_SX,
                                    p: 2.5,
                                    lineHeight: 1.7,
                                    border:
                                        pane === "split"
                                            ? "1px solid var(--card-border, rgba(128,128,128,0.25))"
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
                ...SCROLLBAR_SX,
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
                    minWidth: 0,
                    px: 0.75,
                    py: 0.25,
                    fontSize: 12,
                    lineHeight: 1.4,
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
