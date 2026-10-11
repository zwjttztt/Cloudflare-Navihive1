// src/components/NotesTodoDialog.tsx
// 全库待办面板（2026-10-11 阶段②）：把散在各篇笔记里的任务收进一个清单，
// 勾选直接回写原笔记（走 toggleTaskLine 的同一套判据），点标题跳原文。
//
// ⚠️ 回写走的是父级的 onUpdate（与手动编辑同一条 updateNote 链路）：
// rev 守卫、3s 自动保存、跨标签广播全都自动生效，这里不另写一套保存逻辑。
import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import { collectTodos, todoCounts } from "../utils/noteTodoAgenda";
import type { Note } from "../API/http";

export interface NotesTodoDialogProps {
    open: boolean;
    notes: Note[];
    onClose: () => void;
    /** 勾选回写：line 是 0 基行号；checked 是目标状态 */
    onToggle: (noteId: number, line: number, checked: boolean) => void;
    onOpenNote: (noteId: number) => void;
    /** 回写失败时给用户的提示通道 */
    onNotify?: (message: string, severity?: "success" | "error" | "info") => void;
}

export default function NotesTodoDialog({
    open,
    notes,
    onClose,
    onToggle,
    onOpenNote,
    onNotify,
}: NotesTodoDialogProps) {
    const [includeDone, setIncludeDone] = useState(false);

    const todos = useMemo(
        () => collectTodos(notes, { includeDone: includeDone || false }),
        [notes, includeDone]
    );
    const counts = useMemo(() => todoCounts(notes), [notes]);

    // 按笔记分组（首次出现顺序）：面板里一眼看出「这条待办在哪篇笔记」
    const groups = useMemo(() => {
        const byNote = new Map<number, { title: string; items: typeof todos }>();
        for (const item of todos) {
            let g = byNote.get(item.noteId);
            if (!g) {
                const note = notes.find(n => n.id === item.noteId);
                g = { title: note?.title || "无标题笔记", items: [] };
                byNote.set(item.noteId, g);
            }
            g.items.push(item);
        }
        return [...byNote.entries()];
    }, [todos, notes]);

    const handleToggle = (noteId: number, line: number, checked: boolean) => {
        const note = notes.find(n => n.id === noteId);
        if (!note) return;
        onToggle(noteId, line, checked);
        void onNotify;
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='sm'
            slotProps={{ paper: { sx: { borderRadius: 3, maxHeight: "80vh" } } }}
        >
            <Box data-notes-todo='1' sx={{ px: 2.5, pt: 2, pb: 1, display: "flex", alignItems: "center", gap: 1 }}>
                <Typography variant='subtitle1' sx={{ flex: 1, fontWeight: 600 }}>
                    待办
                    <Typography component='span' variant='caption' color='text.secondary' sx={{ ml: 1 }}>
                        未完成 {counts.open} · 已完成 {counts.done}
                    </Typography>
                </Typography>
                <Button
                    size='small'
                    data-todo-toggle-done='1'
                    onClick={() => setIncludeDone(v => !v)}
                >
                    {includeDone ? "只看未完成" : "显示已完成"}
                </Button>
                <IconButton size='small' aria-label='关闭待办面板' data-todo-close='1' onClick={onClose}>
                    <CloseIcon fontSize='small' />
                </IconButton>
            </Box>
            <Box sx={{ px: 2.5, pb: 2, overflowY: "auto" }}>
                {groups.length === 0 && (
                    <Typography variant='body2' color='text.secondary' sx={{ py: 3, textAlign: "center" }}>
                        {includeDone ? "笔记里还没有任何任务。" : "没有未完成的任务。在笔记里写 `- [ ] 待办` 就会出现在这里。"}
                    </Typography>
                )}
                {groups.map(([noteId, group]) => (
                    <Box key={noteId} sx={{ mb: 1.5 }} data-todo-note={noteId}>
                        <Typography
                            component='button'
                            type='button'
                            onClick={() => {
                                onClose();
                                onOpenNote(noteId);
                            }}
                            sx={{
                                display: "block",
                                border: "none",
                                background: "none",
                                cursor: "pointer",
                                font: "inherit",
                                color: "var(--accent)",
                                fontSize: 13,
                                fontWeight: 600,
                                px: 0,
                                py: 0.5,
                                textAlign: "left",
                            }}
                        >
                            {group.title}
                        </Typography>
                        {group.items.map(item => (
                            <Box
                                key={`${item.line}`}
                                data-todo-item='1'
                                data-todo-line={item.line}
                                sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}
                            >
                                <Checkbox
                                    size='small'
                                    checked={item.done}
                                    onChange={e => handleToggle(item.noteId, item.line, e.target.checked)}
                                    slotProps={{ input: { "aria-label": `切换任务：${item.text || "（空任务）"}` } }}
                                    sx={{ p: 0.25, mt: 0.25 }}
                                />
                                <Typography
                                    variant='body2'
                                    sx={{
                                        flex: 1,
                                        minWidth: 0,
                                        pt: 0.75,
                                        textDecoration: item.done ? "line-through" : "none",
                                        color: item.done ? "text.secondary" : "text.primary",
                                        wordBreak: "break-word",
                                    }}
                                >
                                    {item.text || "（空任务）"}
                                </Typography>
                            </Box>
                        ))}
                    </Box>
                ))}
            </Box>
        </Dialog>
    );
}
