// src/components/NotesPanel.tsx
// 记事本面板：从右侧滑出的笔记列表 + 编辑弹窗。
//
// 与 `sites.notes`（每个站点一条、跟着卡片生灭）是两回事，两者并存：
// 这里记的是「临时想法、待办、片段」，卡片删了也还在。
//
// 三处刻意的设计：
//   1. **懒加载**：面板 + Markdown 渲染层都只在点开时才下载（见 App.tsx 的 lazy）。
//   2. **内容存 Markdown 源码**，编辑用 textarea（第一版不上 CodeMirror ——
//      6 个包的体积换不来「写了几个字」这个体验，见 docs/notebook-design.md 4.3）。
//   3. **删除走回收站**（服务端行为），所以这里不做「真的没了」的提示，
//      而是弹撤销 —— 笔记往往比卡片更不可再生。
import { useCallback, useEffect, useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import EditIcon from "@mui/icons-material/Edit";
import PushPinIcon from "@mui/icons-material/PushPin";
import SearchIcon from "@mui/icons-material/Search";
import type { Note } from "../API/http";

export interface NotesPanelProps {
    open: boolean;
    onClose: () => void;
    notes: Note[];
    onCreate: () => Promise<Note | null>;
    onUpdate: (id: number, patch: Partial<Note>) => Promise<void>;
    onDelete: (note: Note) => Promise<void>;
    onTogglePin: (note: Note) => Promise<void>;
    /** 撤销删除用：服务端返回的 recycleId（老服务端可能不给） */
    onUndoDelete?: (recycleId?: number) => void;
}

/** 摘要：把 Markdown 源码压成一行预览（去掉语法符号，不解析） */
function summarize(source: string, max = 80): string {
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

export default function NotesPanel({
    open,
    onClose,
    notes,
    onCreate,
    onUpdate,
    onDelete,
    onTogglePin,
    onUndoDelete,
}: NotesPanelProps) {
    const [keyword, setKeyword] = useState("");
    const [editing, setEditing] = useState<Note | null>(null);
    const [draftTitle, setDraftTitle] = useState("");
    const [draftContent, setDraftContent] = useState("");

    // 面板关掉就把草稿清掉：下次打开不该看到上次的半截字
    useEffect(() => {
        if (!open) {
            setKeyword("");
            setEditing(null);
        }
    }, [open]);

    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return notes;
        return notes.filter(
            n =>
                (n.title || "").toLowerCase().includes(kw) ||
                (n.content || "").toLowerCase().includes(kw)
        );
    }, [notes, keyword]);

    const openEditor = useCallback((note: Note) => {
        setEditing(note);
        setDraftTitle(note.title || "");
        setDraftContent(note.content || "");
    }, []);

    const startCreate = useCallback(async () => {
        const created = await onCreate();
        if (created) openEditor(created);
    }, [onCreate, openEditor]);

    const saveDraft = useCallback(async () => {
        if (!editing?.id) return;
        await onUpdate(editing.id, { title: draftTitle, content: draftContent });
        setEditing(null);
    }, [editing, draftTitle, draftContent, onUpdate]);

    const handleDelete = useCallback(
        async (note: Note) => {
            await onDelete(note);
            if (editing?.id === note.id) setEditing(null);
            onUndoDelete?.();
        },
        [editing, onDelete, onUndoDelete]
    );

    return (
        <>
            {/* 侧边抽屉用 Dialog 撑开，而不是 <Drawer>：
                Drawer 会把整套 slide 动画依赖拉进共享 chunk（进而进首屏），
                而 Dialog 早就被确认框之类用着 —— 同样的视觉，少一份首屏体积。 */}
            <Dialog
                open={open}
                onClose={onClose}
                fullWidth
                maxWidth={false}
                slotProps={{
                    paper: {
                        sx: {
                            m: 0,
                            ml: "auto",
                            width: { xs: "100%", sm: 420 },
                            maxWidth: { xs: "100%", sm: 420 },
                            height: "100%",
                            maxHeight: "100%",
                            borderRadius: 0,
                            p: 0,
                        },
                    },
                }}
            >
                <Box
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        px: 2,
                        pt: 2,
                        pb: 1,
                    }}
                >
                    <Typography variant='h6' component='div' sx={{ fontWeight: 600, flex: 1 }}>
                        记事本
                    </Typography>
                    <Tooltip title='新建笔记'>
                        <IconButton aria-label='新建笔记' size='small' onClick={startCreate}>
                            <AddIcon fontSize='small' />
                        </IconButton>
                    </Tooltip>
                    <IconButton aria-label='关闭记事本' size='small' onClick={onClose}>
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </Box>

                <Box sx={{ px: 2, pb: 1 }}>
                    <TextField
                        fullWidth
                        size='small'
                        value={keyword}
                        onChange={e => setKeyword(e.target.value)}
                        placeholder='搜索标题与内容'
                        slotProps={{
                            input: {
                                startAdornment: (
                                    <InputAdornment position='start'>
                                        <SearchIcon fontSize='small' />
                                    </InputAdornment>
                                ),
                            },
                        }}
                    />
                </Box>

                {filtered.length === 0 ? (
                    <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
                        <Typography variant='body2' color='text.secondary'>
                            {notes.length === 0
                                ? "还没有笔记。点右上角 + 新建一条。"
                                : "没有匹配的笔记。"}
                        </Typography>
                    </Box>
                ) : (
                    <List dense sx={{ px: 1, pb: 2, overflowY: "auto", flex: 1 }}>
                        {filtered.map(note => (
                            <ListItem
                                key={note.id}
                                disablePadding
                                secondaryAction={
                                    <Box sx={{ display: "flex", alignItems: "center" }}>
                                        <IconButton
                                            aria-label={
                                                note.pinned ? "取消置顶" : "置顶"
                                            }
                                            size='small'
                                            onClick={() => onTogglePin(note)}
                                        >
                                            <PushPinIcon
                                                fontSize='small'
                                                sx={
                                                    note.pinned
                                                        ? { color: "var(--accent)" }
                                                        : undefined
                                                }
                                            />
                                        </IconButton>
                                        <IconButton
                                            aria-label={`编辑笔记 ${note.title || "无标题"}`}
                                            size='small'
                                            onClick={() => openEditor(note)}
                                        >
                                            <EditIcon fontSize='small' />
                                        </IconButton>
                                    </Box>
                                }
                            >
                                <ListItemButton onClick={() => openEditor(note)}>
                                    <ListItemText
                                        primary={
                                            note.title || (
                                                <Typography
                                                    variant='body2'
                                                    color='text.disabled'
                                                >
                                                    无标题
                                                </Typography>
                                            )
                                        }
                                        secondary={summarize(note.content)}
                                        slotProps={{
                                            secondary: {
                                                variant: "caption",
                                                sx: {
                                                    display: "-webkit-box",
                                                    WebkitLineClamp: 2,
                                                    WebkitBoxOrient: "vertical",
                                                    overflow: "hidden",
                                                },
                                            },
                                        }}
                                    />
                                </ListItemButton>
                            </ListItem>
                        ))}
                    </List>
                )}
            </Dialog>

            {/* 编辑弹窗：尺寸与「网站设置」那一套刻意保持一致（notesPaper 的下限 + rows 撑大） */}
            <Dialog
                open={Boolean(editing)}
                onClose={() => setEditing(null)}
                fullWidth
                maxWidth='sm'
                slotProps={{
                    paper: { sx: { minHeight: "min(560px, calc(100vh - 104px))" } },
                }}
            >
                <DialogTitle
                    sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 1,
                        px: 3,
                        pt: 2,
                        pb: 1,
                    }}
                >
                    编辑笔记
                    <IconButton
                        aria-label='关闭'
                        onClick={() => setEditing(null)}
                        size='small'
                    >
                        <CloseIcon fontSize='small' />
                    </IconButton>
                </DialogTitle>
                <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
                    <TextField
                        label='标题'
                        value={draftTitle}
                        onChange={e => setDraftTitle(e.target.value)}
                        fullWidth
                        size='small'
                    />
                    <TextField
                        label='内容（Markdown）'
                        value={draftContent}
                        onChange={e => setDraftContent(e.target.value)}
                        fullWidth
                        multiline
                        // 「放大」的实现是行数多，不是硬拉 textarea 高度 ——
                        // 硬拉会让内容垂直居中、光标落在框中间（真踩过）
                        rows={18}
                        sx={{ minWidth: 0 }}
                    />
                    {/* 任务列表的可视化提示：这一版渲染层只做纯文本，
                        但写 `- [ ]` 的人一眼要知道能被认出来 */}
                    <Typography variant='caption' color='text.secondary'>
                        支持 Markdown：# 标题、- 列表、- [ ] 待办、&gt; 引用、
                        `代码`、**粗体**、==高亮==
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2.5, pt: 1, justifyContent: "space-between" }}>
                    <Button
                        color='error'
                        startIcon={<DeleteOutlineIcon />}
                        onClick={() => editing && handleDelete(editing)}
                    >
                        删除
                    </Button>
                    <Box sx={{ display: "flex", gap: 1 }}>
                        <Button onClick={() => setEditing(null)}>取消</Button>
                        <Button variant='contained' onClick={saveDraft}>
                            保存
                        </Button>
                    </Box>
                </DialogActions>
            </Dialog>
        </>
    );
}

/** 供 App 复用的任务列表勾选态：渲染层接入前，先在预览里用得上 */
export { Checkbox };
