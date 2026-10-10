// src/components/NotesCommandPalette.tsx
// 记事本命令面板（N1）：一个输入框打通「打开笔记 / 跳文件夹 / 跳标签 / 执行命令」。
// 照 inkstone 的 CommandPalette 思路，但**只服务记事本上下文**：
//   - 空查询：最近打开的笔记 + 几条常用命令
//   - 普通查询：笔记(本地模糊) + 文件夹 + 标签 + 命令 一起排，远端 /search 命中带摘要并上浮
//   - `>` 前缀：只搜命令
//   - 没有任何命中：用当前输入新建一条笔记
// 方向键选择、回车执行、Esc 关闭。样式复用导航命令面板的毛玻璃 Dialog。
import { useEffect, useMemo, useRef, useState } from "react";
import {
    Dialog,
    Box,
    TextField,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Typography,
    InputAdornment,
    Chip,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import BoltIcon from "@mui/icons-material/Bolt";
import DescriptionIcon from "@mui/icons-material/Description";
import FolderIcon from "@mui/icons-material/Folder";
import LabelIcon from "@mui/icons-material/Label";
import AddIcon from "@mui/icons-material/Add";
import type { Note, NoteFolder, NoteTag, NoteSearchResult, NoteSearchHit } from "../API/types";
import type { CommandItem } from "./CommandPalette";
import { fuzzyFilter } from "../utils/fuzzy";

export interface NotesCommandPaletteProps {
    open: boolean;
    onClose: () => void;
    notes: Note[];
    folders: NoteFolder[];
    tags: NoteTag[];
    /** 记事本内的命令（新建 / 查找 / 插入…），由 NotesPage 用现成回调拼好 */
    commands: CommandItem[];
    onOpenNote: (note: Note) => void;
    onOpenFolder: (folderId: number) => void;
    onOpenTag: (tagId: number) => void;
    onCreateNote: (title: string) => void;
    /** 服务端全文检索（可选）。传了就在输入时拉一次，命中带摘要并上浮 */
    onSearchRemote?: (query: string, limit?: number) => Promise<NoteSearchResult | null>;
    /** 空查询时优先展示的「最近打开」笔记 id（由 NotesPage 维护） */
    recentNoteIds?: number[];
}

type Row =
    | { type: "command"; cmd: CommandItem; score: number; key: string }
    | { type: "note"; note: Note; snippet?: string; score: number; key: string }
    | { type: "folder"; folder: NoteFolder; score: number; key: string }
    | { type: "tag"; tag: NoteTag; score: number; key: string }
    | { type: "create"; title: string; score: number; key: string };

const SECTION_LABEL: Record<Row["type"], string> = {
    command: "命令",
    note: "笔记",
    folder: "文件夹",
    tag: "标签",
    create: "新建",
};
// 同分时分区排序：笔记/文件夹/标签在前，命令其次，新建最后
const TYPE_RANK: Record<Row["type"], number> = {
    note: 0,
    folder: 1,
    tag: 2,
    command: 3,
    create: 9,
};
const MAX_ROWS = 14;

/** 一行预览：压掉 Markdown 语法符号，不解析正文 */
function snippetOf(source: string, max = 80, query = ""): string {
    const matchingLine = query && source.split("\n").find(line => line.toLowerCase().includes(query.toLowerCase()));
    const flat = (matchingLine || source)
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^[-*+]\s+(\[[ xX]\]\s*)?/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function NotesCommandPalette({
    open,
    onClose,
    notes,
    folders,
    tags,
    commands,
    onOpenNote,
    onOpenFolder,
    onOpenTag,
    onCreateNote,
    onSearchRemote,
    recentNoteIds,
}: NotesCommandPaletteProps) {
    const [keyword, setKeyword] = useState("");
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [remoteHits, setRemoteHits] = useState<NoteSearchHit[]>([]);
    const [remoteQuery, setRemoteQuery] = useState("");
    const listRef = useRef<HTMLUListElement | null>(null);

    // 解析 `>` 前缀：只搜命令
    const onlyCommands = keyword.trim().startsWith(">");
    const qText = onlyCommands ? keyword.trim().slice(1).trim() : keyword.trim();

    // 远端全文检索（最佳努力，失败不影响本地结果）
    useEffect(() => {
        if (!open || onlyCommands || !qText || !onSearchRemote) {
            setRemoteHits([]);
            return;
        }
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const res = await onSearchRemote(qText, 12);
                if (!cancelled && res) { setRemoteHits(res.results); setRemoteQuery(qText); }
            } catch {
                if (!cancelled) setRemoteHits([]);
            }
        }, 180);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, onlyCommands, qText, onSearchRemote]);

    const rows = useMemo<Row[]>(() => {
        const out: Row[] = [];
        const noteById = new Map<number, Note>();
        for (const n of notes) if (n.id != null) noteById.set(n.id, n);

        if (onlyCommands && !qText) {
            for (const c of commands) out.push({ type: "command", cmd: c, score: 0, key: `cmd:${c.id}` });
        } else if (!qText) {
            // 空查询：最近打开的笔记 + 几条常用命令
            for (const id of recentNoteIds ?? []) {
                const n = noteById.get(id);
                if (n) out.push({ type: "note", note: n, snippet: snippetOf(n.content), score: 0, key: `note:${n.id}` });
            }
            for (const c of commands.slice(0, 5)) out.push({ type: "command", cmd: c, score: 0, key: `cmd:${c.id}` });
        } else if (onlyCommands) {
            for (const { item } of fuzzyFilter(commands, qText, c => `${c.label} ${c.keywords ?? ""} ${c.section}`, 10))
                out.push({ type: "command", cmd: item, score: 0, key: `cmd:${item.id}` });
        } else {
            for (const { item, match } of fuzzyFilter(notes, qText, n => n.title, 12))
                out.push({ type: "note", note: item, snippet: snippetOf(item.content, 80, qText), score: match.score, key: `note:${item.id}` });
            for (const { item } of fuzzyFilter(folders, qText, f => f.name, 5))
                out.push({ type: "folder", folder: item, score: 0, key: `folder:${item.id}` });
            for (const { item } of fuzzyFilter(tags, qText, t => t.name, 5))
                out.push({ type: "tag", tag: item, score: 0, key: `tag:${item.id}` });
            for (const { item } of fuzzyFilter(commands, qText, c => `${c.label} ${c.keywords ?? ""} ${c.section}`, 6))
                out.push({ type: "command", cmd: item, score: 0, key: `cmd:${item.id}` });
        }

        // 远端命中合并：带摘要、上浮、补漏（本地模糊没排进去的也补一行）
        if (!onlyCommands && remoteQuery === qText && remoteHits.length) {
            const seen = new Set(out.filter(r => r.type === "note").map(r => (r as Extract<Row, { type: "note" }>).note.id));
            for (const hit of remoteHits) {
                const n = hit.id != null ? noteById.get(hit.id) : undefined;
                if (!n) continue;
                const existing = out.find(
                    r => r.type === "note" && (r as Extract<Row, { type: "note" }>).note.id === hit.id
                ) as Extract<Row, { type: "note" }> | undefined;
                if (existing) {
                    existing.snippet = hit.snippet || existing.snippet;
                    existing.score = Math.max(existing.score, 1000 + (hit.score ?? 0));
                } else if (!seen.has(hit.id)) {
                    seen.add(hit.id);
                    out.push({ type: "note", note: n, snippet: hit.snippet, score: 1000 + (hit.score ?? 0), key: `note:${hit.id}` });
                }
            }
        }

        // 没有任何命中（且不是空查询）→ 用输入新建一条笔记
        const hasMatch = out.some(r => r.type !== "create");
        if (qText && !onlyCommands && !hasMatch) {
            out.push({ type: "create", title: qText, score: 0, key: "create" });
        }

        out.sort((a, b) => (TYPE_RANK[a.type] - TYPE_RANK[b.type]) || (b.score - a.score));
        return out.slice(0, MAX_ROWS);
    }, [notes, folders, tags, commands, qText, onlyCommands, remoteHits, remoteQuery, recentNoteIds]);

    const runRow = (row: Row) => {
        onClose();
        if (row.type === "command") row.cmd.run();
        else if (row.type === "note") onOpenNote(row.note);
        else if (row.type === "folder" && row.folder.id != null) onOpenFolder(row.folder.id);
        else if (row.type === "tag" && row.tag.id != null) onOpenTag(row.tag.id);
        else if (row.type === "create") onCreateNote(row.title);
    };

    // 打开时重置 + 聚焦
    useEffect(() => {
        if (!open) return;
        setKeyword("");
        setActive(0);
        setRemoteHits([]);
        const timer = setTimeout(() => inputRef.current?.focus(), 60);
        return () => clearTimeout(timer);
    }, [open]);

    useEffect(() => setActive(0), [keyword]);

    useEffect(() => setActive(i => Math.min(i, Math.max(0, rows.length - 1))), [rows.length]);
    useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-command-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [active]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(i => (i + 1) % Math.max(rows.length, 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(i => (i - 1 + rows.length) % Math.max(rows.length, 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const row = rows[active];
            if (row) runRow(row);
        }
    };

    const iconFor = (row: Row) => {
        switch (row.type) {
            case "note": return <DescriptionIcon fontSize='small' />;
            case "folder": return <FolderIcon fontSize='small' />;
            case "tag": return <LabelIcon fontSize='small' />;
            case "create": return <AddIcon fontSize='small' />;
            default: return <BoltIcon fontSize='small' />;
        }
    };
    const primaryFor = (row: Row): string => {
        switch (row.type) {
            case "note": return row.note.title || "（无标题）";
            case "folder": return row.folder.name || "未命名文件夹";
            case "tag": return `#${row.tag.name}`;
            case "create": return `用「${row.title}」新建笔记`;
            default: return row.cmd.label;
        }
    };
    const secondaryFor = (row: Row): string | undefined => {
        if (row.type === "note") return row.snippet;
        if (row.type === "command") return row.cmd.hint;
        return undefined;
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth='sm'
            className='notes-command-palette'
            slotProps={{
                paper: {
                    sx: {
                        borderRadius: "18px",
                        overflow: "hidden",
                        bgcolor: "var(--glass-bg-hover)",
                        border: "1px solid var(--glass-border)",
                        backdropFilter: "blur(18px) saturate(1.5)",
                        WebkitBackdropFilter: "blur(18px) saturate(1.5)",
                        mt: "8vh",
                        alignSelf: "flex-start",
                    },
                },
            }}
        >
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
                <TextField
                    inputRef={inputRef}
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder='搜索笔记 / 文件夹 / 标签，或执行命令（&gt; 仅命令）…'
                    fullWidth
                    size='small'
                    variant='outlined'
                    sx={{ "& .MuiOutlinedInput-root": { borderRadius: "14px" } }}
                    slotProps={{
                        input: {
                            startAdornment: (
                                <InputAdornment position='start'>
                                    <SearchIcon fontSize='small' />
                                </InputAdornment>
                            ),
                        },
                        htmlInput: { "aria-label": "记事本命令面板搜索" },
                    }} />
            </Box>

            <List ref={listRef} role='listbox' aria-label='搜索结果' dense sx={{ maxHeight: 420, overflowY: "auto", px: 1, pb: 1 }}>
                {rows.length === 0 && (
                    <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                        <Typography variant='body2' sx={{ color: "text.secondary" }}>
                            没有匹配的结果
                        </Typography>
                    </Box>
                )}
                {rows.map((row, idx) => (
                    <ListItemButton
                        key={row.key}
                        role='option'
                        aria-selected={idx === active}
                        data-command-index={idx}
                        selected={idx === active}
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => runRow(row)}
                        sx={{ borderRadius: "12px", mb: 0.25 }}
                    >
                        <ListItemIcon sx={{ minWidth: 34 }}>{iconFor(row)}</ListItemIcon>
                        <ListItemText
                            primary={primaryFor(row)}
                            secondary={secondaryFor(row)}
                            slotProps={{
                                primary: { noWrap: true },
                                secondary: { noWrap: true, sx: { fontSize: 11 } },
                            }} />
                        <Chip
                            label={SECTION_LABEL[row.type]}
                            size='small'
                            variant='outlined'
                            sx={{ ml: 1, fontSize: 10, height: 20 }} />
                    </ListItemButton>
                ))}
            </List>

            <Box
                sx={{
                    px: 2,
                    py: 1,
                    borderTop: "1px solid var(--glass-border)",
                    display: "flex",
                    gap: 1.5,
                    flexWrap: "wrap",
                }}
            >
                <Typography variant='caption' sx={{ color: "text.secondary" }}>
                    ↑↓ 选择 · Enter 打开 · Esc 关闭 · &gt; 仅命令
                </Typography>
            </Box>
        </Dialog>
    );
}
