// src/components/BookmarkImportDialog.tsx
// 从浏览器导出的书签 HTML 批量导入：顶层文件夹 → 分组，链接 → 卡片。
// 导入前先体检一遍：每条链接分成 新增 / 重复 / 无效，重复默认跳过，
// 免得把库里已有的卡片再复制一份、或者把 javascript: 书签脚本导成点不动的卡。
import { useMemo, useRef, useState } from "react";
import {
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button,
    Box,
    Typography,
    Checkbox,
    FormControlLabel,
    Switch,
    List,
    ListItem,
    ListItemText,
    Chip,
    LinearProgress,
    Tooltip,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import {
    DUPLICATE_PREVIEW_LIMIT,
    countBookmarkStatus,
    planBookmarkImport,
    type BookmarkEntry,
    type ParsedBookmarkGroup,
} from "../utils/bookmarks";
import type { GroupWithSites } from "../types";
import {
    dialogActionsSx,
    dialogContentSx,
    dialogPaperSx,
    dialogTitleSx,
} from "./dialogShell";

interface BookmarkImportDialogProps {
    open: boolean;
    onClose: () => void;
    onImport: (groups: ParsedBookmarkGroup[]) => Promise<number>;
    /** 现有分组：用来判断哪些链接库里已经有了 */
    groups: GroupWithSites[];
}

export default function BookmarkImportDialog({
    open,
    onClose,
    onImport,
    groups,
}: BookmarkImportDialogProps) {
    const [rawHtml, setRawHtml] = useState("");
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [fileName, setFileName] = useState("");
    const [busy, setBusy] = useState(false);
    const [includeDuplicates, setIncludeDuplicates] = useState(false);
    const [showDuplicates, setShowDuplicates] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    // 判定跟着开关和现有库走：勾上「连重复一起导入」后重新算一遍
    const plan = useMemo(
        () => (rawHtml ? planBookmarkImport(rawHtml, groups, { includeDuplicates }) : null),
        [rawHtml, groups, includeDuplicates]
    );

    const total = useMemo(
        () =>
            (plan?.groups ?? [])
                .filter(g => selected[g.folder] !== false)
                .reduce((sum, g) => sum + g.items.length, 0),
        [plan, selected]
    );

    // 每个文件夹各自的三类数量，勾选行上直接看得见
    const folderStats = useMemo(() => {
        const map = new Map<string, ReturnType<typeof countBookmarkStatus>>();
        if (!plan) return map;
        const byFolder = new Map<string, BookmarkEntry[]>();
        for (const entry of plan.entries) {
            const list = byFolder.get(entry.folder) ?? [];
            list.push(entry);
            byFolder.set(entry.folder, list);
        }
        for (const [folder, list] of byFolder) map.set(folder, countBookmarkStatus(list));
        return map;
    }, [plan]);

    const duplicates = useMemo(
        () => (plan?.entries ?? []).filter(entry => entry.status === "duplicate"),
        [plan]
    );

    const handleFile = async (file?: File | null) => {
        if (!file) return;
        const text = await file.text();
        setFileName(file.name);
        setRawHtml(text);
        setSelected({});
        setShowDuplicates(false);
    };

    const handleImport = async () => {
        const picked = (plan?.groups ?? []).filter(g => selected[g.folder] !== false);
        if (picked.length === 0) return;
        setBusy(true);
        try {
            await onImport(picked);
            reset();
            onClose();
        } finally {
            setBusy(false);
        }
    };

    const reset = () => {
        setRawHtml("");
        setSelected({});
        setFileName("");
        setIncludeDuplicates(false);
        setShowDuplicates(false);
        if (fileRef.current) fileRef.current.value = "";
    };

    const stats = plan?.stats;

    return (
        <Dialog
            open={open}
            onClose={() => {
                reset();
                onClose();
            }}
            fullWidth
            maxWidth='xs'
            slotProps={{ paper: { sx: dialogPaperSx } }}
        >
            <DialogTitle sx={dialogTitleSx}>
                导入浏览器书签
                <Box sx={{ flexGrow: 1 }} />
                <Button
                    size='small'
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                    aria-label='关闭导入书签'
                    sx={{ minWidth: 0, p: 0.5 }}
                >
                    <CloseIcon fontSize='small' />
                </Button>
            </DialogTitle>

            <DialogContent sx={dialogContentSx}>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                    在浏览器书签管理器里选「导出书签」，得到 HTML 文件后在这里选择。
                    顶层文件夹会成为分组，里面的链接成为卡片。已经存在的链接会标为重复、默认不导入。
                </Typography>

                <input
                    ref={fileRef}
                    type='file'
                    accept='.html,.htm,text/html'
                    style={{ display: "none" }}
                    onChange={e => handleFile(e.target.files?.[0])}
                />
                <Button
                    variant='outlined'
                    size='small'
                    startIcon={<FileUploadIcon />}
                    onClick={() => fileRef.current?.click()}
                >
                    选择书签文件
                </Button>
                {fileName && (
                    <Typography variant='caption' color='text.secondary' sx={{ ml: 1 }}>
                        {fileName}
                    </Typography>
                )}

                {plan && stats && (
                    <>
                        <Box
                            sx={{
                                mt: 2,
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                                flexWrap: "wrap",
                            }}
                        >
                            <Typography variant='subtitle2'>
                                共 {stats.total} 条链接
                            </Typography>
                            <Chip
                                size='small'
                                color='primary'
                                label={`新增 ${stats.added}`}
                            />
                            <Chip size='small' label={`重复 ${stats.duplicate}`} />
                            {stats.invalid > 0 && (
                                <Chip size='small' label={`无效 ${stats.invalid}`} />
                            )}
                        </Box>

                        {duplicates.length > 0 && (
                            <Box sx={{ mt: 1 }}>
                                <Button
                                    size='small'
                                    onClick={() => setShowDuplicates(prev => !prev)}
                                    endIcon={showDuplicates ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                                    aria-label='查看重复链接'
                                    sx={{ px: 0, minWidth: 0 }}
                                >
                                    这 {duplicates.length} 条库里已经有了
                                </Button>
                                {showDuplicates && (
                                    <List
                                        dense
                                        sx={{
                                            mt: 0.5,
                                            maxHeight: 200,
                                            overflowY: "auto",
                                            borderRadius: "12px",
                                            border: "1px solid var(--border-hairline)",
                                        }}
                                    >
                                        {duplicates.slice(0, DUPLICATE_PREVIEW_LIMIT).map((entry, idx) => (
                                            <ListItem key={`${entry.url}-${idx}`} disableGutters sx={{ px: 1 }}>
                                                <ListItemText
                                                    primary={entry.title || entry.url}
                                                    secondary={`${entry.note ?? "重复"} · ${entry.folder}`}
                                                    primaryTypographyProps={{
                                                        noWrap: true,
                                                        fontSize: 13,
                                                    }}
                                                    secondaryTypographyProps={{ fontSize: 11 }}
                                                />
                                            </ListItem>
                                        ))}
                                        {duplicates.length > DUPLICATE_PREVIEW_LIMIT && (
                                            <ListItem disableGutters sx={{ px: 1 }}>
                                                <ListItemText
                                                    secondary={`仅列出前 ${DUPLICATE_PREVIEW_LIMIT} 条`}
                                                    secondaryTypographyProps={{ fontSize: 11 }}
                                                />
                                            </ListItem>
                                        )}
                                    </List>
                                )}
                            </Box>
                        )}

                        {plan.groups.length > 0 ? (
                            <List
                                dense
                                sx={{
                                    mt: 1,
                                    maxHeight: 240,
                                    overflowY: "auto",
                                    borderRadius: "12px",
                                    border: "1px solid var(--border-hairline)",
                                }}
                            >
                                {plan.groups.map(group => {
                                    const stat = folderStats.get(group.folder);
                                    const skipped =
                                        (stat?.duplicate ?? 0) + (stat?.invalid ?? 0);
                                    return (
                                        <ListItem key={group.folder} disableGutters sx={{ px: 1 }}>
                                            <FormControlLabel
                                                sx={{ width: "100%", m: 0 }}
                                                control={
                                                    <Checkbox
                                                        size='small'
                                                        checked={selected[group.folder] !== false}
                                                        onChange={e =>
                                                            setSelected(prev => ({
                                                                ...prev,
                                                                [group.folder]: e.target.checked,
                                                            }))
                                                        }
                                                    />
                                                }
                                                label={
                                                    <ListItemText
                                                        primary={group.folder}
                                                        secondary={
                                                            skipped > 0
                                                                ? `${group.items.length} 个将导入 · 跳过 ${skipped} 个`
                                                                : `${group.items.length} 个链接`
                                                        }
                                                        primaryTypographyProps={{ noWrap: true }}
                                                        secondaryTypographyProps={{ fontSize: 11 }}
                                                    />
                                                }
                                            />
                                        </ListItem>
                                    );
                                })}
                            </List>
                        ) : (
                            <Typography
                                variant='body2'
                                color='text.secondary'
                                sx={{ mt: 2 }}
                            >
                                这份文件里没有可导入的新链接 —— 它们要么库里已经有了，要么不是网页链接。
                            </Typography>
                        )}

                        <Tooltip title='重复链接会再建一份卡片，一般不用开'>
                            <FormControlLabel
                                sx={{ mt: 1 }}
                                control={
                                    <Switch
                                        size='small'
                                        checked={includeDuplicates}
                                        onChange={e => setIncludeDuplicates(e.target.checked)}
                                        slotProps={{ input: { "aria-label": "连重复一起导入" } }}
                                    />
                                }
                                label={
                                    <Typography variant='caption' color='text.secondary'>
                                        连重复的也一起导入
                                    </Typography>
                                }
                            />
                        </Tooltip>
                    </>
                )}

                {busy && <LinearProgress sx={{ mt: 2, borderRadius: 1 }} />}
            </DialogContent>

            <DialogActions sx={dialogActionsSx}>
                <Button
                    size='small'
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                >
                    取消
                </Button>
                <Button
                    size='small'
                    variant='contained'
                    disabled={busy || total === 0}
                    onClick={handleImport}
                >
                    导入 {total > 0 ? `${total} 个` : ""}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
