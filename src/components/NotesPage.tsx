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
import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import PushPinIcon from "@mui/icons-material/PushPin";
import SearchIcon from "@mui/icons-material/Search";
import type { Note } from "../API/http";

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

/** 把编辑区拆成「源码 | 预览」两栏 */
type Pane = "edit" | "split" | "preview";

export default function NotesPage({
    notes,
    onClose,
    onCreate,
    onUpdate,
    onDelete,
    onTogglePin,
}: NotesPageProps) {
    const [keyword, setKeyword] = useState("");
    const [activeId, setActiveId] = useState<number | null>(notes[0]?.id ?? null);
    const [pane, setPane] = useState<Pane>("split");
    /** 草稿：编辑期间不立刻写库（点「保存」或切走才提交） */
    const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
    const [mobileDetail, setMobileDetail] = useState(false);

    const active = useMemo(
        () => notes.find(n => n.id === activeId) || null,
        [notes, activeId]
    );

    // 选中的笔记变了就把草稿换成它的内容（没在编辑时才换，避免打字被冲掉）
    useEffect(() => {
        if (active) setDraft({ title: active.title || "", content: active.content || "" });
    }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return notes;
        return notes.filter(
            n =>
                (n.title || "").toLowerCase().includes(kw) ||
                (n.content || "").toLowerCase().includes(kw)
        );
    }, [notes, keyword]);

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

    const charCount = draft ? draft.content.length : 0;
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
                <Box
                    component='input'
                    value={keyword}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setKeyword(e.target.value)
                    }
                    placeholder='搜索标题与内容'
                    aria-label='搜索笔记'
                    style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "8px 10px 8px 30px",
                        borderRadius: 8,
                        border: "1px solid rgba(128,128,128,0.35)",
                        background: "transparent",
                        color: "inherit",
                        font: "inherit",
                    }}
                />
                <SearchIcon
                    fontSize='small'
                    sx={{ position: "absolute", ml: 1.1, mt: 1.1, pointerEvents: "none", opacity: 0.6 }}
                />
            </Box>

            <Box data-note-list='1' sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
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
                                    px: 1.5,
                                    py: 1,
                                    cursor: "pointer",
                                    borderLeft: "3px solid",
                                    borderLeftColor: isActive ? "var(--accent)" : "transparent",
                                    bgcolor: isActive
                                        ? "rgba(128,128,128,0.10)"
                                        : "transparent",
                                    "&:hover": { bgcolor: "rgba(128,128,128,0.07)" },
                                }}
                            >
                                <Box
                                    sx={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 0.5,
                                    }}
                                >
                                    {note.pinned && (
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
                                    }}
                                >
                                    {summarize(note.content)}
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
                    <Box
                        component='input'
                        value={draft?.title ?? ""}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setDraft(d => (d ? { ...d, title: e.target.value } : d))
                        }
                        placeholder='无标题'
                        aria-label='笔记标题'
                        style={{
                            border: "none",
                            borderBottom: "1px solid rgba(128,128,128,0.25)",
                            background: "transparent",
                            color: "inherit",
                            font: "inherit",
                            fontSize: 18,
                            fontWeight: 600,
                            padding: "12px 16px",
                            outline: "none",
                        }}
                    />

                    {/* 内容区：源码 | 预览。预览这一栏现在先显示纯文本 ——
                        Markdown 渲染层是下一步（它必须走 token→React，
                        不能用 innerHTML，会被 CSP 的 require-trusted-types 拦掉）。 */}
                    <Box sx={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
                        {pane !== "preview" && (
                            <Box
                                component='textarea'
                                value={draft?.content ?? ""}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                    setDraft(d => (d ? { ...d, content: e.target.value } : d))
                                }
                                placeholder={'支持 Markdown：\n# 标题\n- 列表\n- [ ] 待办\n> 引用\n**粗体**'}
                                aria-label='笔记内容'
                                sx={{
                                    flex: pane === "edit" ? 1 : "1 1 50%",
                                    minWidth: 0,
                                    border: "none",
                                    borderRight:
                                        pane === "split"
                                            ? "1px solid rgba(128,128,128,0.25)"
                                            : "none",
                                    outline: "none",
                                    resize: "none",
                                    p: 2,
                                    font: "inherit",
                                    fontFamily: "ui-monospace, monospace",
                                    fontSize: 14,
                                    lineHeight: 1.7,
                                    color: "inherit",
                                    bgcolor: "transparent",
                                }}
                            />
                        )}
                        {pane !== "edit" && (
                            <Box
                                sx={{
                                    flex: 1,
                                    minWidth: 0,
                                    overflowY: "auto",
                                    p: 2,
                                    lineHeight: 1.7,
                                }}
                            >
                                <Typography
                                    variant='caption'
                                    color='text.secondary'
                                    sx={{ display: "block", mb: 1 }}
                                >
                                    预览：Markdown 渲染层还在做，这一栏暂时显示源码
                                </Typography>
                                <Typography
                                    variant='body2'
                                    sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                                >
                                    {draft?.content || "（空）"}
                                </Typography>
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
                            borderTop: "1px solid rgba(128,128,128,0.25)",
                            fontSize: 12,
                            color: "text.secondary",
                        }}
                    >
                        <span>{charCount} 字</span>
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
                <Box sx={{ display: { xs: mobileDetail ? "none" : "flex", md: "flex" }, flex: 1, minWidth: 0 }}>
                    {listPane}
                </Box>
                <Box sx={{ display: { xs: mobileDetail ? "flex" : "none", md: "flex" }, flex: 1, minWidth: 0 }}>
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
